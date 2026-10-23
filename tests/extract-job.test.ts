import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type CloudDependencies } from '../src/server/app';
import { parseRuntimeConfig } from '../src/server/config';
import { CloudDatabase, type CloudMedia, type CloudRpcClient, type CloudRpcParameters } from '../src/server/cloud-db';
import { CloudAuth } from '../src/server/cloud-auth';
import { CloudJobs } from '../src/server/cloud-jobs';
import { CloudUploadBroker, UploadRegistry } from '../src/server/workbook-upload';
import type { BlobInfo, BlobStore, SignedDownload, SignedUpload } from '../src/server/cloud-blobs';
import { MarketService, type ExtractionProvider } from '../src/server/service';
import type { JobRecord } from '../src/server/cloud-tasks';
import { repository } from '../src/lib/db';
import { AppError } from '../src/lib/errors';
import { emptyProfile, type Extraction } from '../src/lib/types';

const root = mkdtempSync(join(tmpdir(), 'huoji-extract-job-'));
const forbidden = join(root, 'sqlite-forbidden');
writeFileSync(forbidden, '禁止云模式访问本机数据');
const previous = process.env.APP_DATA_DIR;
process.env.APP_DATA_DIR = forbidden;
after(() => { rmSync(root, { recursive: true, force: true }); if (previous === undefined) delete process.env.APP_DATA_DIR; else process.env.APP_DATA_DIR = previous; });

const env = { DATA_BACKEND: 'cloudbase', APP_DATA_DIR: forbidden, MODEL_PROVIDER: 'openai', TCB_ENV: 'mock-env', CLOUDBASE_APIKEY: 'mock-key', CLOUD_STORAGE_BUCKET: 'huoji-private' };
const config = parseRuntimeConfig(env);
const KEY = 'c'.repeat(64);
const NOW = '2026-10-17T00:00:00.000Z';
const JPEG = 'image/jpeg';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface Session { owner: string; expiresAt: string }
interface State {
  users: Map<string, string>;
  sessions: Map<string, Session>;
  jobs: Map<string, JobRecord>;
  media: Map<string, { owner: string; value: CloudMedia }>;
}
/** 任务按账号隔离存放：模拟 RLS，别的账号取不到本账号的任务。 */
function jobKey(owner: string | null, jobId: string): string { return `${owner}/${jobId}`; }

// 只模拟 RPC 与对象存储边界，不把本测试冒充真实云端桶、网关或权限验收。
class Rpc implements CloudRpcClient {
  readonly calls: CloudRpcParameters[] = [];
  constructor(private readonly handler: (value: CloudRpcParameters) => unknown) {}
  async rpc(name: 'huoji_command', parameters: CloudRpcParameters) {
    assert.equal(name, 'huoji_command');
    this.calls.push(structuredClone(parameters));
    try { return { data: { ok: true, data: this.handler(parameters) }, error: null }; }
    catch (error) {
      if (!(error instanceof AppError)) throw error;
      return { data: { ok: false, error: { code: error.code, message: error.message, status: error.status } }, error: null };
    }
  }
}
class Blobs implements BlobStore {
  readonly objects = new Map<string, Buffer>();
  readonly writes: string[] = [];
  async write(key: string, bytes: Uint8Array) { this.writes.push(key); this.objects.set(key, Buffer.from(bytes)); }
  async read(key: string) {
    const bytes = this.objects.get(key);
    if (!bytes) throw new AppError('NOT_FOUND', '文件不存在', 404);
    return Buffer.from(bytes);
  }
  async remove(key: string) { this.objects.delete(key); }
  async info(key: string): Promise<BlobInfo> {
    const bytes = this.objects.get(key);
    if (!bytes) throw new AppError('NOT_FOUND', '文件不存在', 404);
    return { size: bytes.length, mime: JPEG, etag: 'mock-etag' };
  }
  async signUpload(): Promise<SignedUpload> { throw new Error('整理任务不使用签名上传'); }
  async signDownload(): Promise<SignedDownload> { throw new Error('整理任务不使用签名下载'); }
}
function handler(p: CloudRpcParameters, state: State): unknown {
  const payload = p.p_payload as Record<string, unknown>;
  const owner = String(p.p_owner);
  switch (p.p_operation) {
    case 'health': return { healthy: true };
    case 'login': {
      const subject = String(payload.subject), tokenHash = String(payload.tokenHash);
      const account = state.users.get(subject) || randomUUID();
      state.users.set(subject, account);
      state.sessions.set(tokenHash, { owner: account, expiresAt: String(payload.expiresAt) });
      return { owner: account, tokenHash, expiresAt: payload.expiresAt, profile: { ...emptyProfile, version: 0 } };
    }
    case 'sessionAuthenticate': {
      const session = state.sessions.get(String(payload.tokenHash));
      if (!session) throw new AppError('LOGIN_REQUIRED', '登录已退出或过期', 401);
      return { owner: session.owner, tokenHash: String(payload.tokenHash), expiresAt: session.expiresAt };
    }
    case 'sessionRevoke': state.sessions.delete(String(p.p_token_hash)); return { revoked: true };
    case 'media/get': {
      const row = state.media.get(String(payload.id));
      if (!row || row.owner !== owner) throw new AppError('NOT_FOUND', '照片不存在', 404);
      return row.value;
    }
    case 'job/create': {
      const record: JobRecord = { jobId: String(payload.jobId), kind: payload.kind as JobRecord['kind'], state: 'pending', resultReference: null, error: null, createdAt: NOW, updatedAt: NOW, version: 0, expiresAt: new Date(Date.now() + 300_000).toISOString() };
      state.jobs.set(jobKey(owner, record.jobId), record);
      return record;
    }
    case 'job/get': {
      const record = state.jobs.get(jobKey(owner, String(payload.jobId)));
      if (!record) throw new AppError('NOT_FOUND', '任务不存在', 404);
      return { ...record };
    }
    case 'job/start': {
      const record = state.jobs.get(jobKey(owner, String(payload.jobId)));
      if (!record) throw new AppError('NOT_FOUND', '任务不存在', 404);
      record.state = 'running'; record.version++; return { ...record };
    }
    case 'job/finish': {
      const record = state.jobs.get(jobKey(owner, String(payload.jobId)));
      if (!record) throw new AppError('NOT_FOUND', '任务不存在', 404);
      record.version++;
      record.state = payload.state as JobRecord['state'];
      record.resultReference = (payload.resultReference as string | null) ?? null;
      record.error = (payload.error as JobRecord['error']) ?? null;
      return { ...record };
    }
    default: throw new AppError('DB_UNAVAILABLE', '测试未实现的操作 ' + p.p_operation, 503);
  }
}
interface JobViewResponse {
  jobId: string; kind: string; state: string; procurementId: string | null;
  result: Extraction | null; error: { code: string; message: string } | null;
}
function fixture(model?: ExtractionProvider) {
  const state: State = { users: new Map(), sessions: new Map(), jobs: new Map(), media: new Map() };
  const rpc = new Rpc(value => handler(value, state));
  const db = new CloudDatabase(rpc), blobs = new Blobs(), images: string[] = [];
  const provider: ExtractionProvider = model || {
    enabled: () => true,
    extract: async (_description, given) => { given.forEach(image => images.push(image)); return { fields: { name: '整理杯子', unitPrice: 12 }, mode: 'model', warning: '请核对' }; },
  };
  const cloud: CloudDependencies = {
    db, blobs, auth: new CloudAuth(db, KEY), storageHealth: async () => true,
    uploadBroker: (context, registry) => new CloudUploadBroker(db, blobs, context, registry),
    jobs: (context, uploads) => new CloudJobs(db, blobs, uploads, context),
  };
  const app = () => createApp({ config, cloud, identity: { exchange: async code => code }, service: new MarketService(repository, provider) });
  return { state, rpc, db, blobs, cloud, images, app };
}
const headers = (token: string) => ({ authorization: 'Bearer ' + token });
async function login(app: Awaited<ReturnType<ReturnType<typeof fixture>['app']>>, code: string) {
  const response = await app.inject({ method: 'POST', url: '/api/auth/wechat', payload: { code } });
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as { token: string; user: { id: string } };
}
function seedPhoto(state: State, blobs: Blobs, owner: string): { id: string; objectKey: string } {
  const id = randomUUID(), objectKey = `${owner}/photos/${id}.jpg`;
  blobs.objects.set(objectKey, Buffer.from('ffd8ffe000104a464946', 'hex'));
  state.media.set(id, { owner, value: { id, name: '照片.jpg', objectKey, productId: null, expiresAt: null } });
  return { id, objectKey };
}
function submit(app: Awaited<ReturnType<ReturnType<typeof fixture>['app']>>, token: string, description: string, photoIds: string[]) {
  return app.inject({ method: 'POST', url: '/api/extract', headers: headers(token), payload: { description, photoIds } });
}
async function settle(app: Awaited<ReturnType<ReturnType<typeof fixture>['app']>>, token: string, jobId: string): Promise<JobViewResponse> {
  for (let attempt = 0; attempt < 600; attempt++) {
    const response = await app.inject({ method: 'GET', url: '/api/jobs/' + jobId, headers: headers(token) });
    assert.equal(response.statusCode, 200, response.body);
    const view = response.json() as JobViewResponse;
    if (view.state === 'succeeded' || view.state === 'failed') return view;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('任务未在超时前结束');
}

test('AI 整理转持久任务：请求立即返回任务号，后台写回字段，任务表不存输入明文', async () => {
  const f = fixture(), app = await f.app();
  try {
    const a = await login(app, 'alice'), photo = seedPhoto(f.state, f.blobs, a.user.id);
    const submitted = await submit(app, a.token, '陶瓷杯，12元一个', [photo.id]);
    assert.equal(submitted.statusCode, 202, submitted.body);
    const { jobId, state } = submitted.json() as { jobId: string; state: string };
    assert.match(jobId, UUID);
    assert.equal(state, 'pending');
    const view = await settle(app, a.token, jobId);
    assert.equal(view.state, 'succeeded');
    assert.equal(view.kind, 'extraction');
    assert.equal(view.result?.fields.name, '整理杯子');
    assert.equal(view.result?.fields.unitPrice, 12);
    assert.equal(view.result?.mode, 'model');
    assert.equal(view.procurementId, null);
    assert.equal(view.error, null);
    // 任务视图不含对象路径，也不含照片字节。
    assert.ok(!JSON.stringify(view).includes('/photos/'));
    assert.equal(f.blobs.writes.length, 0, '整理不写入任何对象');
    assert.equal(f.images.length, 1);
    assert.match(f.images[0], /^data:image\/jpeg;base64,/);
    // 描述原文与照片号都不进任务表：job/create 的输入为空对象。
    const created = f.rpc.calls.filter(call => call.p_operation === 'job/create');
    assert.equal(created.length, 1);
    assert.deepEqual(created[0].p_payload.input, {});
    // 任务表只存任务号与结果：描述原文与照片号都不写进 job/* 载荷。
    for (const call of f.rpc.calls.filter(value => value.p_operation.startsWith('job/'))) {
      assert.ok(!JSON.stringify(call.p_payload).includes('陶瓷杯'), '描述原文不落库');
      assert.ok(!JSON.stringify(call.p_payload).includes(photo.id), '照片号不落库');
    }
    assert.deepEqual(readdirSync(root), ['sqlite-forbidden']);
  } finally { await app.close(); }
});

test('整理失败保留输入并写入错误码，任务视图不返回假成功', async () => {
  const f = fixture({ enabled: () => true, extract: async () => { throw new AppError('UPSTREAM_FAILED', '智能整理服务暂不可用，原始记录已保留', 502); } });
  const app = await f.app();
  try {
    const a = await login(app, 'alice'), photo = seedPhoto(f.state, f.blobs, a.user.id);
    const submitted = await submit(app, a.token, '玻璃杯', [photo.id]);
    assert.equal(submitted.statusCode, 202, submitted.body);
    const view = await settle(app, a.token, (submitted.json() as { jobId: string }).jobId);
    assert.equal(view.state, 'failed');
    assert.equal(view.result, null);
    assert.equal(view.error?.code, 'JOB_FAILED');
    assert.equal(view.error?.message, '任务执行失败，请稍后重试');
    // 输入保留：照片对象仍在，客户端可原样重试。
    assert.ok(f.blobs.objects.has(photo.objectKey));
    assert.equal(f.blobs.writes.length, 0);
    const finish = f.rpc.calls.filter(call => call.p_operation === 'job/finish').at(-1)!;
    assert.equal(finish.p_payload.state, 'failed');
    assert.equal((finish.p_payload.error as { code: string }).code, 'JOB_FAILED');
    assert.equal(finish.p_payload.resultReference, null);
  } finally { await app.close(); }
});

test('跨账号隔离：他人任务号不可见，他人照片整理失败，整理任务没有下载', async () => {
  const f = fixture(), app = await f.app();
  try {
    const a = await login(app, 'alice'), b = await login(app, 'bob');
    const mine = seedPhoto(f.state, f.blobs, a.user.id), foreign = seedPhoto(f.state, f.blobs, b.user.id);
    const submitted = await submit(app, a.token, '陶瓷杯', [mine.id]);
    assert.equal(submitted.statusCode, 202, submitted.body);
    const jobId = (submitted.json() as { jobId: string }).jobId;
    const view = await settle(app, a.token, jobId);
    assert.equal(view.state, 'succeeded');
    // 别的账号拿不到任务，也拿不到下载。
    assert.equal((await app.inject({ method: 'GET', url: '/api/jobs/' + jobId, headers: headers(b.token) })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: '/api/jobs/' + jobId + '/download', headers: headers(b.token) })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: '/api/jobs/' + jobId + '/download', headers: headers(a.token) })).statusCode, 404, '整理结果不是文件，不签发下载');
    // 用别人的照片整理：后台按本账号读取，读不到就失败，不会读到别人的字节。
    const stolen = await submit(app, a.token, '陶瓷杯', [foreign.id]);
    assert.equal(stolen.statusCode, 202, stolen.body);
    const failed = await settle(app, a.token, (stolen.json() as { jobId: string }).jobId);
    assert.equal(failed.state, 'failed');
    assert.equal(failed.error?.code, 'NOT_FOUND');
  } finally { await app.close(); }
});

test('CloudJobs.startExtraction：先返回 pending，后台完成后回传字段，上下文账号不符一律拒绝', async () => {
  const f = fixture();
  const alice = await (async () => {
    const app = await f.app(); const account = await login(app, 'unit-alice'); await app.close(); return account;
  })();
  const tokenHash = f.rpc.calls.filter(call => call.p_operation === 'login').at(-1)!.p_payload.tokenHash as string;
  const owner = alice.user.id;
  const registry = new UploadRegistry();
  const broker = new CloudUploadBroker(f.db, f.blobs, { owner, tokenHash }, registry);
  const jobs = new CloudJobs(f.db, f.blobs, broker, { owner, tokenHash });
  const photo = seedPhoto(f.state, f.blobs, owner);
  const job = await jobs.startExtraction(owner, { description: '陶瓷杯', photoIds: [photo.id] }, async () => ({ fields: { name: '直连杯子' }, mode: 'model', warning: '请核对' }));
  assert.equal(job.state, 'pending');
  assert.equal(job.kind, 'extraction');
  assert.equal(job.result, null);
  assert.equal(job.procurementId, null);
  let settled = await jobs.get(owner, job.jobId);
  for (let attempt = 0; attempt < 600 && settled.state !== 'succeeded' && settled.state !== 'failed'; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
    settled = await jobs.get(owner, job.jobId);
  }
  assert.equal(settled.state, 'succeeded');
  assert.equal(settled.result?.fields.name, '直连杯子');
  // 身份不一致的上下文不能提交，也不能读取别人的任务。
  const stranger = new CloudJobs(f.db, f.blobs, broker, { owner: randomUUID(), tokenHash });
  await assert.rejects(() => stranger.startExtraction(owner, { description: 'x', photoIds: [] }, async () => ({ fields: {}, mode: 'rules', warning: '' })), (error: unknown) => error instanceof AppError && error.code === 'LOGIN_REQUIRED');
  await assert.rejects(() => stranger.get(owner, job.jobId), (error: unknown) => error instanceof AppError && error.code === 'LOGIN_REQUIRED');
  // 非法照片号在登记阶段就被拒绝，不会创建任务。
  const before = f.rpc.calls.filter(call => call.p_operation === 'job/create').length;
  await assert.rejects(() => jobs.startExtraction(owner, { description: 'x', photoIds: ['../etc/passwd'] }, async () => ({ fields: {}, mode: 'rules', warning: '' })), (error: unknown) => error instanceof AppError && error.code === 'INVALID_PHOTO');
  await assert.rejects(() => jobs.startExtraction(owner, { description: 'x', photoIds: [photo.id, photo.id] }, async () => ({ fields: {}, mode: 'rules', warning: '' })), (error: unknown) => error instanceof AppError && error.code === 'INVALID_PHOTO');
  assert.equal(f.rpc.calls.filter(call => call.p_operation === 'job/create').length, before);
});
