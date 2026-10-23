import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { createApp, type CloudDependencies } from '../src/server/app';
import { parseRuntimeConfig } from '../src/server/config';
import type { IdentityProvider } from '../src/server/auth';
import { CloudDatabase, type CloudProcurement, type CloudRpcClient, type CloudRpcParameters } from '../src/server/cloud-db';
import { CloudAuth } from '../src/server/cloud-auth';
import type { BlobInfo, BlobStore, SignedDownload, SignedUpload } from '../src/server/cloud-blobs';
import type { JobRecord, UploadKind, UploadState, UploadTicket } from '../src/server/cloud-tasks';
import { CloudUploadBroker } from '../src/server/workbook-upload';
import { CloudJobs } from '../src/server/cloud-jobs';
import { AppError } from '../src/lib/errors';
import { emptyProfile, type UserProfile } from '../src/lib/types';
import { defaultProcurementTemplate, type ProcurementTemplate } from '../src/lib/procurement-template';
import type { Procurement, ProcurementLine } from '../src/lib/procurement';

// 只模拟 RPC 信封与对象存储边界；本测试不宣称真实云端桶、网关或权限已通过验收。
const root = mkdtempSync(join(tmpdir(), 'huoji-upload-route-'));
after(() => rmSync(root, { recursive: true, force: true }));
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const SIGN_TOKEN = 'signed-url-secret-token';
const NOW = '2026-10-17T00:00:00.000Z';
const env = {
  DATA_BACKEND: 'cloudbase', APP_DATA_DIR: root, MODEL_PROVIDER: 'openai', ALLOW_DEV_LOGIN: 'true',
  HOST: '127.0.0.1', TCB_ENV: 'mock-cloud-env', CLOUDBASE_APIKEY: 'mock-private-key',
  CLOUD_STORAGE_BUCKET: 'huoji-private', WB_SESSION_ENCRYPTION_KEY: 'c'.repeat(64),
};
const config = parseRuntimeConfig(env);

class Rpc implements CloudRpcClient {
  readonly calls: CloudRpcParameters[] = [];
  readonly users = new Map<string, string>();
  readonly sessions = new Map<string, { owner: string; expiresAt: string }>();
  readonly profiles = new Map<string, UserProfile>();
  readonly tickets = new Map<string, { owner: string; ticket: UploadTicket }>();
  readonly jobRecords = new Map<string, { owner: string; record: JobRecord }>();
  readonly procurements = new Map<string, { owner: string; value: CloudProcurement }>();
  readonly templates = new Map<string, ProcurementTemplate>();
  async rpc(name: 'huoji_command', parameters: CloudRpcParameters) {
    assert.equal(name, 'huoji_command');
    this.calls.push(structuredClone(parameters));
    try { return { data: { ok: true, data: structuredClone(await this.execute(parameters)) }, error: null }; }
    catch (error) {
      if (!(error instanceof AppError)) throw error;
      return { data: { ok: false, error: { code: error.code, message: error.message, status: error.status } }, error: null };
    }
  }
  private async execute(p: CloudRpcParameters): Promise<unknown> {
    const payload = p.p_payload as Record<string, unknown>;
    if (p.p_operation === 'health') return { healthy: true };
    if (p.p_operation === 'login') {
      const subject = String(payload.subject), tokenHash = String(payload.tokenHash);
      const owner = this.users.get(subject) || randomUUID();
      this.users.set(subject, owner);
      if (!this.profiles.has(owner)) this.profiles.set(owner, { ...emptyProfile, version: 0 });
      this.sessions.set(tokenHash, { owner, expiresAt: String(payload.expiresAt) });
      return { owner, tokenHash, expiresAt: payload.expiresAt, profile: this.profiles.get(owner) };
    }
    // 鉴权请求自带 tokenHash 且不带 owner；其余操作必须携带本账号会话。
    const tokenHash = p.p_operation === 'sessionAuthenticate' ? String(payload.tokenHash) : p.p_token_hash;
    const session = tokenHash ? this.sessions.get(tokenHash) : undefined;
    if (!session || Date.parse(session.expiresAt) <= Date.now() || (p.p_operation !== 'sessionAuthenticate' && session.owner !== p.p_owner)) throw new AppError('LOGIN_REQUIRED', '登录已退出或过期', 401);
    const owner = session.owner;
    switch (p.p_operation) {
      case 'sessionAuthenticate': return { owner, tokenHash, expiresAt: session.expiresAt };
      case 'getProfile': return this.profiles.get(owner);
      case 'template/get': return this.templates.get(owner) || null;
      case 'upload/prepare': {
        if (payload.lookup === true) {
          const stored = this.tickets.get(String(payload.uploadId));
          if (!stored || stored.owner !== owner) throw new AppError('UPLOAD_NOT_FOUND', '上传凭证不存在', 404);
          return stored.ticket;
        }
        const ticket: UploadTicket = {
          uploadId: String(payload.uploadId), objectKey: String(payload.objectKey), kind: payload.kind as UploadKind,
          sizeBytes: Number(payload.sizeBytes), sha256: (payload.sha256 as string | null) ?? null,
          state: 'prepared' as UploadState, createdAt: NOW, expiresAt: new Date(Date.now() + 600_000).toISOString(),
        };
        this.tickets.set(ticket.uploadId, { owner, ticket });
        return ticket;
      }
      case 'upload/commit':
      case 'upload/abandon': {
        const stored = this.tickets.get(String(payload.uploadId));
        if (!stored || stored.owner !== owner) throw new AppError('NOT_FOUND', '上传凭证不存在', 404);
        stored.ticket.state = p.p_operation === 'upload/commit' ? 'committed' : 'abandoned';
        return stored.ticket;
      }
      case 'job/create': {
        const record: JobRecord = { jobId: String(payload.jobId), kind: payload.kind as JobRecord['kind'], state: 'pending', resultReference: null, error: null, createdAt: NOW, updatedAt: NOW, version: 0, expiresAt: new Date(Date.now() + 300_000).toISOString() };
        this.jobRecords.set(record.jobId, { owner, record });
        return record;
      }
      case 'job/get': {
        const stored = this.jobRecords.get(String(payload.jobId));
        if (!stored || stored.owner !== owner) throw new AppError('NOT_FOUND', '任务不存在', 404);
        return stored.record;
      }
      case 'job/start': {
        const stored = this.jobRecords.get(String(payload.jobId));
        if (!stored || stored.owner !== owner) throw new AppError('NOT_FOUND', '任务不存在', 404);
        stored.record = { ...stored.record, state: 'running', version: stored.record.version + 1 }; return stored.record;
      }
      case 'job/finish': {
        const stored = this.jobRecords.get(String(payload.jobId));
        if (!stored || stored.owner !== owner) throw new AppError('NOT_FOUND', '任务不存在', 404);
        stored.record = { ...stored.record, version: stored.record.version + 1, state: payload.state as JobRecord['state'], resultReference: (payload.resultReference as string | null) ?? null, error: (payload.error as JobRecord['error']) ?? null };
        return stored.record;
      }
      case 'procurement/list': return [...this.procurements.values()].filter(row => row.owner === owner).map(row => row.value.document);
      case 'procurement/get': {
        const stored = this.procurements.get(String(payload.id));
        if (!stored || stored.owner !== owner) throw new AppError('NOT_FOUND', '记录不存在', 404);
        return stored.value;
      }
      case 'procurement/create': {
        const document = payload.document as Procurement;
        this.procurements.set(document.id, { owner, value: { document, originalKey: (payload.originalKey as string | null) ?? null } });
        return { document, originalKey: (payload.originalKey as string | null) ?? null };
      }
      case 'procurement/delete': {
        const stored = this.procurements.get(String(payload.id));
        if (!stored || stored.owner !== owner) throw new AppError('NOT_FOUND', '记录不存在', 404);
        this.procurements.delete(String(payload.id)); return { deleted: true, objectKeys: [] };
      }
      default: throw new AppError('UNKNOWN_OPERATION', '未模拟的操作 ' + p.p_operation, 503);
    }
  }
  operations(): string[] { return this.calls.map(call => call.p_operation); }
  lastPayload(operation: string): Record<string, unknown> {
    const call = this.calls.filter(value => value.p_operation === operation).at(-1);
    assert.ok(call, '缺少操作 ' + operation);
    return call.p_payload as Record<string, unknown>;
  }
}
class Blobs implements BlobStore {
  readonly objects = new Map<string, Buffer>();
  readonly signed: string[] = [];
  async write(key: string, bytes: Uint8Array) { this.objects.set(key, Buffer.from(bytes)); }
  async read(key: string) {
    const value = this.objects.get(key);
    if (!value) throw new AppError('NOT_FOUND', '文件不存在', 404);
    return Buffer.from(value);
  }
  async remove(key: string) { this.objects.delete(key); }
  async info(key: string): Promise<BlobInfo> {
    const value = this.objects.get(key);
    if (!value) throw new AppError('NOT_FOUND', '文件不存在', 404);
    return { size: value.length, mime: key.endsWith('.jpg') ? 'image/jpeg' : XLSX, etag: 'mock-etag' };
  }
  async signUpload(key: string, mime?: string): Promise<SignedUpload> {
    // 模拟签名地址不含对象路径，便于断言响应与错误都不回显内部路径。
    const url = `https://storage.test.example/put?token=${SIGN_TOKEN}`;
    this.signed.push(url);
    return { url, method: 'PUT', headers: mime ? { 'Content-Type': mime } : {}, expiresAt: new Date(Date.now() + 60_000).toISOString() };
  }
  async signDownload(key: string): Promise<SignedDownload> {
    const url = `https://storage.test.example/get?token=${SIGN_TOKEN}`;
    this.signed.push(url);
    return { url, expiresAt: new Date(Date.now() + 60_000).toISOString() };
  }
}
function fixture() {
  const rpc = new Rpc(), db = new CloudDatabase(rpc), blobs = new Blobs();
  const auth = new CloudAuth(db, env.WB_SESSION_ENCRYPTION_KEY);
  const cloud: CloudDependencies = {
    db, blobs, auth, storageHealth: async () => true,
    // 与 index.ts 云分支一致的注入方式：按请求会话构造，owner/tokenHash 不共享。
    uploadBroker: (context, registry) => new CloudUploadBroker(db, blobs, context, registry),
    jobs: (context, uploads) => new CloudJobs(db, blobs, uploads, context),
  };
  const identity: IdentityProvider = { exchange: async code => code };
  return { rpc, blobs, cloud, app: () => createApp({ config, cloud, identity }) };
}
type App = Awaited<ReturnType<typeof createApp>>;
const headers = (token: string) => ({ authorization: 'Bearer ' + token });
async function login(app: App, code: string) {
  const response = await app.inject({ method: 'POST', url: '/api/auth/wechat', payload: { code } });
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as { token: string; user: { id: string } };
}
const post = async (app: App, url: string, payload: object, token: string) => app.inject({ method: 'POST', url, headers: headers(token), payload });
const get = async (app: App, url: string, token: string) => app.inject({ method: 'GET', url, headers: headers(token) });
function multipart(bytes: Buffer, field: string, name: string) {
  const boundary = 'upload-route-boundary';
  return { headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`), bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]) };
}
/** 合成受支持的商户采购表：含模板抬头与一行明细，仅供解析链路使用。 */
async function workbookBytes(): Promise<Buffer> {
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('商户甲');
  ['云模板公司', 'CLOUD TEMPLATE CO.', '测试地址', 'TEL 000', '采购记录'].forEach((text, index) => { sheet.getCell(index + 1, 1).value = text; });
  sheet.getRow(6).values = ['REF.', 'CTNS（箱数）', 'PCS/CTN', 'QUANTITY', 'PRICE (RMB)', 'AMOUNT(RMB)', '备注'];
  sheet.getRow(7).values = ['00123', 2, 24, { formula: 'B7*C7', result: 48 }, 2.5, { formula: 'D7*E7', result: 120 }, '合成测试'];
  sheet.getRow(9).values = ['TOTAL', { formula: 'SUM(B7:B8)', result: 2 }, '', '', '', { formula: 'SUM(F7:F8)', result: 120 }];
  return Buffer.from(await book.xlsx.writeBuffer());
}
function line(index: number): ProcurementLine {
  return { id: randomUUID(), supplier: '商户甲', sku: 'SKU' + index, description: '商品' + index, barcode: '', cartons: 2, pcsPerCarton: 12, unitPrice: 10, cartonCbm: null, currency: 'CNY', decision: 'pending', note: '', source: `商户甲!A${index + 2}:K${index + 2}`, sourceIncluded: false, sourceMark: '', sourceQuantity: 24, sourceAmount: 240, sourceCbm: null, images: [], warnings: [] };
}
function document(lines: number): Procurement {
  return { format: 1, id: randomUUID(), version: 1, name: '大表', sourceName: '大表.xlsx', sourceHash: '', createdAt: NOW, updatedAt: NOW,
    suppliers: [{ name: '商户甲', source: '商户甲', sourceCartons: null, sourceAmount: null, sourceCbm: null, freight: null, freightSource: '', information: '', warnings: [] }],
    lines: Array.from({ length: lines }, (_, index) => line(index)), issues: [], skippedSheets: [], template: defaultProcurementTemplate() };
}
/** 客户端直传的模拟：把字节直接落到对象键上，绕开签名地址（签名地址不参与本测试断言）。 */
function putObject(blobs: Blobs, objectKey: string, bytes: Buffer) { blobs.objects.set(objectKey, bytes); }
async function prepare(app: App, rpc: Rpc, token: string, bytes: Buffer) {
  const response = await post(app, '/api/uploads/prepare', { kind: 'workbook', filename: '采购表.xlsx', sizeBytes: bytes.length, contentType: XLSX }, token);
  assert.equal(response.statusCode, 200, response.body);
  const grant = response.json() as { uploadId: string; method: string; uploadUrl: string; headers: Record<string, string>; expiresAt: string };
  return { grant, objectKey: String(rpc.lastPayload('upload/prepare').objectKey) };
}
async function settle(app: App, token: string, jobId: string) {
  for (let attempt = 0; attempt < 600; attempt++) {
    const response = await get(app, '/api/jobs/' + jobId, token);
    assert.equal(response.statusCode, 200, response.body);
    const view = response.json() as { jobId: string; kind: string; state: string; procurementId: string | null; error: { code: string } | null };
    if (view.state === 'succeeded' || view.state === 'failed') return view;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('任务未在超时前结束');
}

test('prepare/commit 契约：只回直传所需字段，未提交不能导入，abandon 后凭证作废', async () => {
  const f = fixture(), app = await f.app();
  try {
    const a = await login(app, 'alice'), b = await login(app, 'bob');
    assert.equal((await app.inject({ method: 'POST', url: '/api/uploads/prepare', payload: { kind: 'workbook', filename: 'x.xlsx', sizeBytes: 1024, contentType: XLSX } })).statusCode, 401);
    const bytes = await workbookBytes();
    const first = await prepare(app, f.rpc, a.token, bytes);
    assert.deepEqual(Object.keys(first.grant).sort(), ['expiresAt', 'headers', 'method', 'uploadId', 'uploadUrl']);
    assert.equal(first.grant.method, 'PUT');
    assert.match(first.grant.uploadUrl, /^https:\/\//);
    assert.ok(Date.parse(first.grant.expiresAt) > Date.now());
    assert.ok(!JSON.stringify(first.grant).includes('/uploads/'), '响应不暴露对象路径');
    // 只登记不提交：导入被拒绝，且不创建任务与采购记录。
    putObject(f.blobs, first.objectKey, bytes);
    const rejected = await post(app, '/api/procurement/import', { uploadId: first.grant.uploadId }, a.token);
    assert.equal(rejected.statusCode, 409, rejected.body);
    assert.equal(rejected.json().error.code, 'UPLOAD_NOT_COMMITTED');
    assert.ok(!rejected.body.includes(first.objectKey) && !rejected.body.includes(SIGN_TOKEN), '错误不回显对象路径或签名细节');
    assert.ok(!f.rpc.operations().includes('job/create'));
    assert.equal(f.rpc.procurements.size, 0);
    // 另一账号看不到该凭证，也不能提交。
    const crossCommit = await post(app, '/api/uploads/commit', { uploadId: first.grant.uploadId }, b.token);
    assert.equal(crossCommit.statusCode, 404, crossCommit.body);
    // commit 后拿到对象键。
    const committed = await post(app, '/api/uploads/commit', { uploadId: first.grant.uploadId }, a.token);
    assert.equal(committed.statusCode, 200, committed.body);
    assert.deepEqual(Object.keys(committed.json()), ['objectKey']);
    assert.equal(committed.json().objectKey, first.objectKey);
    // abandon 的持久票据仍可查询，但不可用于导入。
    const second = await prepare(app, f.rpc, a.token, bytes);
    putObject(f.blobs, second.objectKey, bytes);
    assert.equal((await post(app, '/api/uploads/abandon', { uploadId: second.grant.uploadId }, a.token)).statusCode, 200);
    const abandoned = await post(app, '/api/procurement/import', { uploadId: second.grant.uploadId }, a.token);
    assert.equal(abandoned.statusCode, 409, abandoned.body);
    assert.equal(abandoned.json().error.code, 'UPLOAD_NOT_COMMITTED');
    assert.ok(!f.rpc.operations().includes('job/create'));
    assert.deepEqual(readdirSync(root), [], '云模式不写本机数据目录');
  } finally { await app.close(); }
});

test('直传导入返回任务号并在后台解析：任务视图可查询且不暴露对象路径', async () => {
  const f = fixture(), app = await f.app();
  try {
    const a = await login(app, 'alice'), b = await login(app, 'bob');
    const bytes = await workbookBytes();
    const upload = await prepare(app, f.rpc, a.token, bytes);
    putObject(f.blobs, upload.objectKey, bytes);
    assert.equal((await post(app, '/api/uploads/commit', { uploadId: upload.grant.uploadId }, a.token)).statusCode, 200);
    const accepted = await post(app, '/api/procurement/import', { uploadId: upload.grant.uploadId }, a.token);
    assert.equal(accepted.statusCode, 202, accepted.body);
    const { jobId, state } = accepted.json() as { jobId: string; state: string };
    assert.match(jobId, /^[0-9a-f-]{36}$/);
    assert.equal(state, 'pending');
    const view = await settle(app, a.token, jobId);
    assert.equal(view.state, 'succeeded');
    assert.match(view.procurementId ?? '', /^[0-9a-f-]{36}$/);
    assert.equal(view.error, null);
    assert.ok(!JSON.stringify(view).includes(upload.objectKey) && !JSON.stringify(view).includes('/uploads/'), '任务视图不含对象路径');
    assert.equal((await get(app, '/api/procurement/' + view.procurementId, a.token)).statusCode, 200);
    assert.equal((await get(app, '/api/procurement', a.token)).json().length, 1);
    // 跨账号：任务与记录都当不存在；未登录一律401。
    assert.equal((await get(app, '/api/jobs/' + jobId, b.token)).statusCode, 404);
    assert.equal((await get(app, '/api/procurement/' + view.procurementId, b.token)).statusCode, 404);
    assert.equal((await get(app, '/api/jobs/' + jobId, 'f'.repeat(64))).statusCode, 401);
    assert.equal((await get(app, '/api/jobs/' + jobId, a.token)).statusCode, 200);
  } finally { await app.close(); }
});

test('大导出走持久任务并返回短期下载，小导出仍同步返回', async () => {
  const f = fixture(), app = await f.app();
  try {
    const a = await login(app, 'alice'), b = await login(app, 'bob');
    const big = document(201), small = document(2);
    f.rpc.procurements.set(big.id, { owner: a.user.id, value: { document: big, originalKey: null } });
    f.rpc.procurements.set(small.id, { owner: a.user.id, value: { document: small, originalKey: null } });
    const accepted = await get(app, '/api/procurement/' + big.id + '/export', a.token);
    assert.equal(accepted.statusCode, 202, accepted.body);
    const { jobId } = accepted.json() as { jobId: string };
    assert.match(jobId, /^[0-9a-f-]{36}$/);
    const view = await settle(app, a.token, jobId);
    assert.equal(view.kind, 'workbook-export');
    assert.equal(view.state, 'succeeded');
    const download = await get(app, '/api/jobs/' + jobId + '/download', a.token);
    assert.equal(download.statusCode, 200, download.body);
    const grant = download.json() as { url: string; expiresAt: string };
    assert.match(grant.url, /^https:\/\//);
    assert.ok(Date.parse(grant.expiresAt) > Date.now());
    assert.deepEqual([...f.blobs.objects.keys()].filter(key => key.includes('/exports/')).length, 1);
    assert.equal((await get(app, '/api/jobs/' + jobId + '/download', b.token)).statusCode, 404);
    // 未成功的任务不签发下载：任务号不存在即404。
    assert.equal((await get(app, '/api/jobs/' + randomUUID() + '/download', a.token)).statusCode, 404);
    // 小表沿用同步下载。
    const sync = await get(app, '/api/procurement/' + small.id + '/export', a.token);
    assert.equal(sync.statusCode, 200, sync.body);
    assert.equal(sync.headers['content-type'], XLSX);
    assert.ok(!f.rpc.operations().includes('job/finish') || f.rpc.jobRecords.size === 1, '小导出不创建任务');
    assert.equal(f.rpc.jobRecords.size, 1);
  } finally { await app.close(); }
});

test('小文件 multipart 导入与模板导入仍然可用，直传分支同样可用于模板', async () => {
  const f = fixture(), app = await f.app();
  try {
    const a = await login(app, 'alice');
    const bytes = await workbookBytes(), form = multipart(bytes, 'workbook', '采购.xlsx');
    const imported = await app.inject({ method: 'POST', url: '/api/procurement/import', headers: { ...headers(a.token), ...form.headers }, payload: form.payload });
    assert.equal(imported.statusCode, 201, imported.body);
    const created = imported.json() as { id: string; version: number; lines: unknown[] };
    assert.ok(created.lines.length >= 1);
    const suggestion = await app.inject({ method: 'POST', url: '/api/procurement-template/import', headers: { ...headers(a.token), ...form.headers }, payload: form.payload });
    assert.equal(suggestion.statusCode, 200, suggestion.body);
    assert.equal(suggestion.json().company, '云模板公司');
    // 直传分支的模板导入。
    const upload = await prepare(app, f.rpc, a.token, bytes);
    putObject(f.blobs, upload.objectKey, bytes);
    assert.equal((await post(app, '/api/uploads/commit', { uploadId: upload.grant.uploadId }, a.token)).statusCode, 200);
    const direct = await post(app, '/api/procurement-template/import', { uploadId: upload.grant.uploadId }, a.token);
    assert.equal(direct.statusCode, 200, direct.body);
    assert.equal(direct.json().company, '云模板公司');
    // 提交一次后重复导入同一凭证仍然允许（票据未作废），但对象已不存在时读取失败。
    f.blobs.objects.delete(upload.objectKey);
    const missing = await post(app, '/api/procurement-template/import', { uploadId: upload.grant.uploadId }, a.token);
    assert.equal(missing.statusCode, 404, missing.body);
    assert.ok(!missing.body.includes(upload.objectKey));
  } finally { await app.close(); }
});

test('载荷不含 owner 字段，签名地址不进入日志载荷，跨账号任务与记录互不可见', async () => {
  const f = fixture(), app = await f.app();
  try {
    const a = await login(app, 'alice'), b = await login(app, 'bob');
    const bytes = await workbookBytes();
    const upload = await prepare(app, f.rpc, a.token, bytes);
    putObject(f.blobs, upload.objectKey, bytes);
    assert.equal((await post(app, '/api/uploads/commit', { uploadId: upload.grant.uploadId }, a.token)).statusCode, 200);
    const accepted = await post(app, '/api/procurement/import', { uploadId: upload.grant.uploadId }, a.token);
    await settle(app, a.token, (accepted.json() as { jobId: string }).jobId);
    for (const call of f.rpc.calls) {
      assert.ok(!Object.keys(call.p_payload).some(key => /^owner/i.test(key)), call.p_operation);
      assert.ok(!JSON.stringify(call.p_payload).includes(SIGN_TOKEN));
      if (call.p_owner) assert.equal(call.p_owner, a.user.id === call.p_owner ? a.user.id : b.user.id);
    }
    assert.equal((await post(app, '/api/procurement/import', { uploadId: randomUUID() }, b.token)).statusCode, 404);
    assert.equal((await post(app, '/api/uploads/commit', { uploadId: randomUUID() }, a.token)).statusCode, 404);
  } finally { await app.close(); }
});
