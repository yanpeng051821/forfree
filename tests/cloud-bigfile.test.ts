import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { AppError } from '../src/lib/errors';
import { emptyProfile } from '../src/lib/types';
import type { Procurement, ProcurementLine } from '../src/lib/procurement';
import { defaultProcurementTemplate } from '../src/lib/procurement-template';
import { CloudDatabase, type CloudContext, type CloudRpcClient, type CloudRpcParameters } from '../src/server/cloud-db';
import type { BlobInfo, BlobStore, SignedDownload, SignedUpload } from '../src/server/cloud-blobs';
import type { JobRecord, UploadKind, UploadTicket } from '../src/server/cloud-tasks';
import { CloudUploadBroker, UploadRegistry } from '../src/server/workbook-upload';
import { CloudJobs, type JobView } from '../src/server/cloud-jobs';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const JPEG = 'image/jpeg';
const OWNER = randomUUID(), OTHER = randomUUID(), TOKEN = 'a'.repeat(64);
const SIGN_TOKEN = 'signed-url-secret-token';
const NOW = '2026-10-17T00:00:00.000Z';

function isError(code: string, status?: number) {
  return (error: unknown) => error instanceof AppError && error.code === code && (status === undefined || error.status === status);
}

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
  readonly signed: string[] = [];
  async write(key: string, bytes: Uint8Array) { this.objects.set(key, Buffer.from(bytes)); }
  async read(key: string) {
    const bytes = this.objects.get(key);
    if (!bytes) throw new AppError('NOT_FOUND', '文件不存在', 404);
    return Buffer.from(bytes);
  }
  async remove(key: string) { this.objects.delete(key); }
  async info(key: string): Promise<BlobInfo> {
    const bytes = this.objects.get(key);
    if (!bytes) throw new AppError('NOT_FOUND', '文件不存在', 404);
    return { size: bytes.length, mime: key.endsWith('.jpg') ? JPEG : XLSX, etag: 'mock-etag' };
  }
  async signUpload(key: string, mime?: string): Promise<SignedUpload> {
    const url = `https://storage.test.example/upload/${encodeURIComponent(key)}?token=${SIGN_TOKEN}`;
    this.signed.push(url);
    return { url, method: 'PUT', headers: mime ? { 'Content-Type': mime } : {}, expiresAt: new Date(Date.now() + 60_000).toISOString() };
  }
  async signDownload(key: string): Promise<SignedDownload> {
    const url = `https://storage.test.example/download/${encodeURIComponent(key)}?token=${SIGN_TOKEN}`;
    this.signed.push(url);
    return { url, expiresAt: new Date(Date.now() + 60_000).toISOString() };
  }
}
interface State {
  tickets: Map<string, UploadTicket>;
  records: Map<string, JobRecord>;
  procurements: Map<string, Procurement>;
}
function handler(value: CloudRpcParameters, state: State): unknown {
  const payload = value.p_payload as Record<string, unknown>;
  const jobId = String(payload.jobId ?? '');
  switch (value.p_operation) {
    case 'upload/prepare': {
      if (payload.lookup === true) {
        const ticket = state.tickets.get(String(payload.uploadId));
        if (!ticket) throw new AppError('UPLOAD_NOT_FOUND', '上传凭证不存在', 404);
        return ticket;
      }
      const ticket: UploadTicket = {
        uploadId: String(payload.uploadId), objectKey: String(payload.objectKey), kind: payload.kind as UploadKind,
        sizeBytes: Number(payload.sizeBytes), sha256: (payload.sha256 as string | null) ?? null, state: 'prepared', createdAt: NOW, expiresAt: new Date(Date.now() + 600_000).toISOString(),
      };
      state.tickets.set(ticket.uploadId, ticket);
      return ticket;
    }
    case 'upload/commit':
    case 'upload/abandon': {
      const ticket = state.tickets.get(String(payload.uploadId));
      if (!ticket) throw new AppError('NOT_FOUND', '上传凭证不存在', 404);
      ticket.state = value.p_operation === 'upload/commit' ? 'committed' : 'abandoned';
      return ticket;
    }
    case 'job/create': {
      const record: JobRecord = { jobId, kind: payload.kind as JobRecord['kind'], state: 'pending', resultReference: null, error: null, createdAt: NOW, updatedAt: NOW, version: 0, expiresAt: new Date(Date.now() + 300_000).toISOString() };
      state.records.set(jobId, record);
      return record;
    }
    case 'job/get': {
      const record = state.records.get(jobId);
      if (!record) throw new AppError('NOT_FOUND', '任务不存在', 404);
      return record;
    }
    case 'job/start': {
      const record = state.records.get(jobId);
      if (!record) throw new AppError('NOT_FOUND', '任务不存在', 404);
      record.state = 'running'; record.version++; return record;
    }
    case 'job/finish': {
      const record = state.records.get(jobId);
      if (!record) throw new AppError('NOT_FOUND', '任务不存在', 404);
      record.version++;
      record.state = payload.state as JobRecord['state'];
      record.resultReference = (payload.resultReference as string | null) ?? null;
      record.error = (payload.error as JobRecord['error']) ?? null;
      return record;
    }
    case 'getProfile': return { ...emptyProfile, version: 0 };
    case 'template/get': return null;
    case 'procurement/create': {
      const document = payload.document as Procurement;
      state.procurements.set(document.id, document);
      return { document, originalKey: (payload.originalKey as string | null) ?? null };
    }
    case 'procurement/get': {
      const document = state.procurements.get(String(payload.id));
      if (!document) throw new AppError('NOT_FOUND', '记录不存在', 404);
      return { document, originalKey: null };
    }
    default: throw new AppError('DB_UNAVAILABLE', '测试未实现的操作 ' + value.p_operation, 503);
  }
}
function fixture() {
  const state: State = { tickets: new Map(), records: new Map(), procurements: new Map() };
  const rpc = new Rpc(value => handler(value, state));
  const db = new CloudDatabase(rpc), blobs = new Blobs(), registry = new UploadRegistry();
  const auth: CloudContext = { owner: OWNER, tokenHash: TOKEN };
  const broker = new CloudUploadBroker(db, blobs, auth, registry);
  const otherBroker = new CloudUploadBroker(db, blobs, { owner: OTHER, tokenHash: TOKEN }, registry);
  return { rpc, blobs, broker, otherBroker, state, jobs: new CloudJobs(db, blobs, broker, auth) };
}
async function workbookBytes(): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('商户A');
  sheet.getRow(1).values = ['REF', 'CTNS', 'PCS/CTN', 'QTY', 'PRICE(RMB)', 'AMOUNT', 'DESCRIPTION'];
  sheet.getRow(2).values = ['A1', 2, 12, 24, 10.5, 252, '陶瓷杯'];
  sheet.getRow(3).values = ['A2', 3, 6, 18, 20, 360, '玻璃杯'];
  return Buffer.from(await book.xlsx.writeBuffer());
}
function document(): Procurement {
  const line: ProcurementLine = { id: randomUUID(), supplier: '商户A', sku: 'A1', description: '陶瓷杯', barcode: '', cartons: 2, pcsPerCarton: 12, unitPrice: 10.5, cartonCbm: null, currency: 'CNY', decision: 'pending', note: '', source: '商户A!A2:K2', sourceIncluded: false, sourceMark: '', sourceQuantity: 24, sourceAmount: 252, sourceCbm: null, images: [], warnings: [] };
  return { format: 1, id: randomUUID(), version: 1, name: '采购', sourceName: '采购表.xlsx', sourceHash: '', createdAt: NOW, updatedAt: NOW,
    suppliers: [{ name: '商户A', source: '商户A', sourceCartons: null, sourceAmount: null, sourceCbm: null, freight: null, freightSource: '', information: '', warnings: [] }],
    lines: [line], issues: [], skippedSheets: [], template: defaultProcurementTemplate() };
}
async function settle(jobs: CloudJobs, owner: string, jobId: string): Promise<JobView> {
  for (let attempt = 0; attempt < 600; attempt++) {
    const current = await jobs.get(owner, jobId);
    if (current.state === 'succeeded' || current.state === 'failed') return current;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('任务未在超时前结束');
}
function operations(rpc: Rpc): string[] { return rpc.calls.map(call => call.p_operation); }

test('超过40MB的采购表与超过8MB的照片在登记阶段被拒绝，不签发也不落库', async () => {
  const f = fixture();
  await assert.rejects(() => f.broker.prepare(OWNER, { kind: 'workbook', filename: 'big.xlsx', sizeBytes: 40 * 1024 * 1024 + 1, contentType: XLSX }), isError('WORKBOOK_LIMIT', 413));
  await assert.rejects(() => f.broker.prepare(OWNER, { kind: 'photo', filename: 'big.jpg', sizeBytes: 8 * 1024 * 1024 + 1, contentType: JPEG }), isError('PHOTO_LIMIT', 413));
  assert.equal(f.rpc.calls.length, 0);
  assert.equal(f.blobs.signed.length, 0);
  // 边界：正好40MB允许登记，进入签名直传流程。
  const grant = await f.broker.prepare(OWNER, { kind: 'workbook', filename: 'big.xlsx', sizeBytes: 40 * 1024 * 1024, contentType: XLSX });
  assert.equal(grant.method, 'PUT');
  assert.match(grant.objectKey, new RegExp(`^${OWNER}/uploads/[0-9a-f-]{36}\\.xlsx$`));
  assert.equal(f.rpc.calls.length, 1);
  assert.equal(f.rpc.calls[0].p_operation, 'upload/prepare');
});

test('类型白名单、文件名清洗与账号格式校验', async () => {
  const f = fixture();
  const base = { filename: 'x.xlsx', sizeBytes: 1024, contentType: XLSX };
  await assert.rejects(() => f.broker.prepare(OWNER, { ...base, kind: 'zip' as UploadKind }), isError('INVALID_UPLOAD', 400));
  await assert.rejects(() => f.broker.prepare(OWNER, { ...base, kind: 'workbook', contentType: 'text/plain' }), isError('INVALID_UPLOAD', 415));
  await assert.rejects(() => f.broker.prepare(OWNER, { ...base, kind: 'workbook', filename: 'x.pdf' }), isError('INVALID_WORKBOOK', 400));
  await assert.rejects(() => f.broker.prepare(OWNER, { ...base, kind: 'workbook', filename: 'x.xlsx', sha256: 'abc' }), isError('INVALID_UPLOAD', 400));
  await assert.rejects(() => f.broker.prepare(OWNER, { kind: 'photo', filename: 'p.png', sizeBytes: 1024, contentType: JPEG }), isError('INVALID_PHOTO', 400));
  await assert.rejects(() => f.broker.prepare('not-a-uuid', { ...base, kind: 'workbook' }), isError('LOGIN_REQUIRED', 401));
  await assert.rejects(() => f.broker.prepare(OWNER, { ...base, kind: 'workbook', sizeBytes: 0 }), isError('INVALID_UPLOAD', 400));
  const grant = await f.broker.prepare(OWNER, { kind: 'workbook', filename: '../../等保/采购\n表.xlsx', sizeBytes: 2048, contentType: XLSX });
  const payload = f.rpc.calls[0].p_payload as Record<string, unknown>;
  const name = String(payload.filename);
  assert.ok(grant.objectKey.endsWith('.xlsx'));
  assert.match(name, /^[^/\\]+$/);
  assert.match(name, /\.xlsx$/);
  assert.ok(!name.startsWith('.'));
  assert.ok(!/[\x00-\x1f\x7f]/.test(name));
  assert.ok(name.includes('采购表') && !name.includes('\n'));
  assert.ok(name.length <= 160);
  // 照片走暂存目录，键归属本账号。
  const photo = await f.broker.prepare(OWNER, { kind: 'photo', filename: 'p.jpg', sizeBytes: 4096, contentType: JPEG });
  assert.match(photo.objectKey, new RegExp(`^${OWNER}/photos/[0-9a-f-]{36}\\.jpg$`));
});

test('commit 以对象实际大小和类型为准，伪造大小被拒绝并作废票据', async () => {
  const f = fixture();
  const grant = await f.broker.prepare(OWNER, { kind: 'workbook', filename: 'x.xlsx', sizeBytes: 1024, contentType: XLSX });
  f.blobs.objects.set(grant.objectKey, Buffer.alloc(2048));
  const error = await f.broker.commit(OWNER, grant.uploadId, 1024).catch(value => value);
  assert.ok(isError('UPLOAD_MISMATCH', 400)(error));
  assert.ok(!String(error).includes(SIGN_TOKEN));
  assert.equal(f.state.tickets.get(grant.uploadId)!.state, 'abandoned');
  assert.ok(!operations(f.rpc).includes('upload/commit'));
  assert.ok(operations(f.rpc).includes('upload/abandon'));
  // 客户端自报大小与对象实际大小不一致同样拒绝。
  const second = await f.broker.prepare(OWNER, { kind: 'workbook', filename: 'y.xlsx', sizeBytes: 2048, contentType: XLSX });
  f.blobs.objects.set(second.objectKey, Buffer.alloc(2048));
  await assert.rejects(() => f.broker.commit(OWNER, second.uploadId, 4096), isError('UPLOAD_MISMATCH', 400));
  // 对象不存在时作废并拒绝。
  const missing = await f.broker.prepare(OWNER, { kind: 'workbook', filename: 'z.xlsx', sizeBytes: 512, contentType: XLSX });
  await assert.rejects(() => f.broker.commit(OWNER, missing.uploadId, 512), isError('NOT_FOUND', 404));
  assert.equal(f.state.tickets.get(missing.uploadId)!.state, 'abandoned');
  // 一致时通过，并只回传对象键。
  const ok = await f.broker.prepare(OWNER, { kind: 'workbook', filename: 'w.xlsx', sizeBytes: 2048, contentType: XLSX });
  f.blobs.objects.set(ok.objectKey, Buffer.alloc(2048));
  const committed = await f.broker.commit(OWNER, ok.uploadId, 2048);
  assert.equal(committed.objectKey, ok.objectKey);
  assert.equal(f.state.tickets.get(ok.uploadId)!.state, 'committed');
  await assert.rejects(() => f.broker.commit(OWNER, ok.uploadId, 2048), isError('CONFLICT', 409));
});

test('未完成commit的对象不能导入，也不会创建采购记录或任务', async () => {
  const f = fixture();
  const grant = await f.broker.prepare(OWNER, { kind: 'workbook', filename: 'x.xlsx', sizeBytes: 1024, contentType: XLSX });
  f.blobs.objects.set(grant.objectKey, await workbookBytes());
  await assert.rejects(() => f.jobs.startWorkbookImport(OWNER, grant.objectKey, 'x.xlsx'), isError('UPLOAD_NOT_COMMITTED', 409));
  assert.ok(!operations(f.rpc).includes('job/create'));
  assert.equal(f.state.procurements.size, 0);
  // 另一个账号既不能提交也不能导入。
  await assert.rejects(() => f.otherBroker.commit(OWNER, grant.uploadId, 1024), isError('LOGIN_REQUIRED', 401));
  await assert.rejects(() => f.jobs.startWorkbookImport(OTHER, grant.objectKey, 'x.xlsx'), isError('LOGIN_REQUIRED', 401));
});

test('异步导入在后台解析并持久化任务结果与采购记录', async () => {
  const f = fixture();
  const bytes = await workbookBytes();
  const grant = await f.broker.prepare(OWNER, { kind: 'workbook', filename: '采购表.xlsx', sizeBytes: bytes.length, contentType: XLSX });
  f.blobs.objects.set(grant.objectKey, bytes);
  const committed = await f.broker.commit(OWNER, grant.uploadId, bytes.length);
  const job = await f.jobs.startWorkbookImport(OWNER, committed.objectKey, '采购表.xlsx');
  assert.equal(job.state, 'pending');
  assert.equal(job.procurementId, null);
  const settled = await settle(f.jobs, OWNER, job.jobId);
  assert.equal(settled.state, 'succeeded');
  assert.match(settled.procurementId ?? '', /^[0-9a-f-]{36}$/);
  assert.equal(f.state.procurements.size, 1);
  const finish = f.rpc.calls.filter(call => call.p_operation === 'job/finish').at(-1)!;
  assert.equal(finish.p_payload.state, 'succeeded');
  assert.equal(finish.p_payload.resultReference, settled.procurementId);
  assert.equal(finish.p_payload.error, null);
  // 任务视图不暴露对象路径。
  assert.ok(!JSON.stringify(settled).includes(committed.objectKey));
});

test('异步导入失败保留输入对象并持久化错误码', async () => {
  const f = fixture();
  const bytes = Buffer.from('这不是一个xlsx');
  const grant = await f.broker.prepare(OWNER, { kind: 'workbook', filename: '坏表.xlsx', sizeBytes: bytes.length, contentType: XLSX });
  f.blobs.objects.set(grant.objectKey, bytes);
  const committed = await f.broker.commit(OWNER, grant.uploadId, bytes.length);
  const job = await f.jobs.startWorkbookImport(OWNER, committed.objectKey, '坏表.xlsx');
  const settled = await settle(f.jobs, OWNER, job.jobId);
  assert.equal(settled.state, 'failed');
  assert.equal(settled.error?.code, 'INVALID_WORKBOOK');
  assert.ok(settled.error?.message.length);
  assert.equal(settled.procurementId, null);
  assert.equal(f.state.procurements.size, 0);
  assert.ok(f.blobs.objects.has(grant.objectKey), '失败必须保留输入对象');
  const finish = f.rpc.calls.filter(call => call.p_operation === 'job/finish').at(-1)!;
  assert.equal(finish.p_payload.state, 'failed');
  assert.equal((finish.p_payload.error as { code: string }).code, 'INVALID_WORKBOOK');
});

test('导出在后台写入exports对象并按需签发短期下载', async () => {
  const f = fixture();
  const doc = document();
  f.state.procurements.set(doc.id, doc);
  const job = await f.jobs.startWorkbookExport(OWNER, doc.id);
  assert.equal(job.state, 'pending');
  const settled = await settle(f.jobs, OWNER, job.jobId);
  assert.equal(settled.state, 'succeeded');
  const keys = [...f.blobs.objects.keys()].filter(key => key.startsWith(`${OWNER}/exports/`));
  assert.equal(keys.length, 1);
  assert.match(keys[0], new RegExp(`^${OWNER}/exports/[0-9a-f-]{36}\\.xlsx$`));
  const finish = f.rpc.calls.filter(call => call.p_operation === 'job/finish').at(-1)!;
  assert.equal(finish.p_payload.resultReference, keys[0]);
  assert.ok(f.blobs.objects.get(keys[0])!.length > 0);
  const download = await f.jobs.download(OWNER, job.jobId);
  assert.match(download.url, /^https:\/\//);
  assert.ok(Date.parse(download.expiresAt) > Date.now());
  assert.ok(!JSON.stringify(settled).includes(keys[0]));
  // 其他账号不能取到下载。
  await assert.rejects(() => f.jobs.download(OTHER, job.jobId), isError('LOGIN_REQUIRED', 401));
});

test('所有RPC载荷不含owner字段，签名凭据不进入错误与载荷', async () => {
  const f = fixture();
  const grant = await f.broker.prepare(OWNER, { kind: 'workbook', filename: 'x.xlsx', sizeBytes: 1024, contentType: XLSX });
  await f.broker.commit(OWNER, grant.uploadId, 1024).catch(() => {});
  const bytes = await workbookBytes();
  const second = await f.broker.prepare(OWNER, { kind: 'workbook', filename: 'y.xlsx', sizeBytes: bytes.length, contentType: XLSX });
  f.blobs.objects.set(second.objectKey, bytes);
  const committed = await f.broker.commit(OWNER, second.uploadId, bytes.length);
  const job = await f.jobs.startWorkbookImport(OWNER, committed.objectKey, 'y.xlsx');
  await settle(f.jobs, OWNER, job.jobId);
  for (const call of f.rpc.calls) {
    assert.equal(call.p_owner, OWNER);
    assert.equal(call.p_token_hash, TOKEN);
    assert.ok(!Object.keys(call.p_payload).some(key => /^owner/i.test(key)));
    assert.ok(!JSON.stringify(call.p_payload).includes(SIGN_TOKEN));
  }
  assert.ok(f.blobs.signed.length > 0);
  for (const url of f.blobs.signed) assert.ok(!JSON.stringify(f.rpc.calls).includes(url));
});
