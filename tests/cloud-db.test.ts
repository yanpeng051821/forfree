import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from '../src/lib/errors';
import { emptyFields, emptyProfile, type Product } from '../src/lib/types';
import type { Procurement, ProcurementLine } from '../src/lib/procurement';
import { defaultProcurementTemplate } from '../src/lib/procurement-template';
import { CloudDatabase, commandDigest, type CloudBlobStore, type CloudContext, type CloudMedia, type CloudRpcClient, type CloudRpcParameters } from '../src/server/cloud-db';
import { CloudAuth, hashBusinessToken } from '../src/server/cloud-auth';
import { CloudRecords, createCloudRecords } from '../src/server/cloud-records';
import { CloudProcurementStore, CloudTemplateStore } from '../src/server/cloud-procurement';
import type { CloudSession } from '../src/server/cloud-session';
import { modelRecoveryBudget, withinBudget } from '../src/server/request-budget';

const owner = randomUUID(), otherOwner = randomUUID(), tokenHash = 'a'.repeat(64);
const context: CloudContext = { owner, tokenHash };
const projectId = randomUUID(), productId = randomUUID();
const timestamp = '2026-10-16T16:01:00.000Z';
function isError(code: string, status?: number) {
  return (error: unknown) => error instanceof AppError && error.code === code && (status === undefined || error.status === status);
}
class Rpc implements CloudRpcClient {
  readonly calls: CloudRpcParameters[] = [];
  constructor(private readonly handler: (value: CloudRpcParameters) => unknown | Promise<unknown>) {}
  async rpc(name: 'huoji_command', parameters: CloudRpcParameters) {
    assert.equal(name, 'huoji_command'); this.calls.push(structuredClone(parameters));
    try { return { data: { ok: true, data: await this.handler(parameters) }, error: null }; }
    catch (error) {
      if (!(error instanceof AppError)) throw error;
      return { data: { ok: false, error: { code: error.code, message: error.message, status: error.status } }, error: null };
    }
  }
}
class Blobs implements CloudBlobStore {
  readonly objects = new Map<string, Buffer>(); readonly events: string[] = [];
  async read(key: string) { this.events.push('read:' + key); const bytes = this.objects.get(key); if (!bytes) throw new AppError('NOT_FOUND','文件不存在',404); return Buffer.from(bytes); }
  async write(key: string, bytes: Uint8Array, mime: string) { this.events.push('write:' + key); assert.ok(mime === 'image/jpeg' || mime.endsWith('sheet')); this.objects.set(key,Buffer.from(bytes)); }
  async remove(key: string) { this.events.push('remove:' + key); this.objects.delete(key); }
  async info(key: string) { this.events.push('info:' + key); const bytes = this.objects.get(key); if (!bytes) throw new AppError('NOT_FOUND','文件不存在',404); return { size: bytes.length, mime: key.endsWith('.jpg') ? 'image/jpeg' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', etag: 'mock' }; }
}
function product(overrides: Record<string, unknown> = {}): Product {
  return { ...emptyFields, id: productId, projectId, version: 1, createdAt: timestamp, updatedAt: timestamp, photos: [], ...overrides } as Product;
}
function document(): Procurement {
  const line: ProcurementLine = { id: randomUUID(), supplier: '商户', sku: 'A1', description: '', barcode: '', cartons: null, pcsPerCarton: 2, unitPrice: 3, cartonCbm: null, currency: 'CNY', decision: 'pending', note: '', source: '商品', sourceIncluded: false, sourceMark: '', sourceQuantity: null, sourceAmount: null, sourceCbm: null, images: ['data:image/jpeg;base64,' + Buffer.from('JPEG模拟').toString('base64')], warnings: [] };
  return { format: 1, id: randomUUID(), version: 1, name: '采购', sourceName: '源表.xlsx', sourceHash: 'b'.repeat(64), createdAt: timestamp, updatedAt: timestamp, suppliers: [], lines: [line], issues: [], skippedSheets: [] };
}

// 只模拟RPC边界，不把本测试冒充真实PG权限、并发或SQL运行验收。
function authFixture() {
  const users = new Map<string,string>();
  const sessions = new Map<string,{ owner: string; subject: string; expiresAt: string; crypt: string | null }>();
  const rpc = new Rpc(p => {
    const data = p.p_payload;
    if (p.p_operation === 'health') return { healthy: true };
    if (p.p_operation === 'login') {
      const subject = String(data.subject), account = users.get(subject) || randomUUID(); users.set(subject,account);
      sessions.set(String(data.tokenHash),{ owner: account, subject, expiresAt: String(data.expiresAt), crypt: data.cloudEncrypted === null ? null : String(data.cloudEncrypted) });
      return { owner: account, tokenHash: data.tokenHash, expiresAt: data.expiresAt, profile: { ...emptyProfile, version: 0 } };
    }
    const hash = p.p_operation === 'sessionAuthenticate' ? String(data.tokenHash) : p.p_token_hash;
    const row = hash ? sessions.get(hash) : undefined;
    if (!row || Date.parse(row.expiresAt) <= Date.now() || (p.p_operation !== 'sessionAuthenticate' && row.owner !== p.p_owner)) throw new AppError('LOGIN_REQUIRED','登录已过期或退出',401);
    switch (p.p_operation) {
      case 'sessionAuthenticate': return { owner: row.owner, tokenHash: hash, expiresAt: row.expiresAt };
      case 'sessionRevoke': sessions.delete(hash!); return { revoked: true };
      case 'cloudSessionLoad': return { subject: row.subject, encrypted: row.crypt };
      case 'cloudSessionSave': row.crypt = String(data.encrypted); return { saved: true };
      case 'getProfile': return { ...emptyProfile, version: 0 };
      default: throw new AppError('UNKNOWN_OPERATION','未知操作');
    }
  });
  return { rpc, db: new CloudDatabase(rpc), sessions, users };
}
const cloudSession: CloudSession = { accessToken: '机密access', refreshToken: '机密refresh', subject: 'cloud-user', scope: 'binding', expiresAt: Date.now() + 3600000 };
const grant = { subject: 'workbuddy:wx-test:' + cloudSession.subject, cloudSession };

test('RPC映射信封、SDK错误、网络失败与健康探针', async () => {
  const rpc = new Rpc(p => { if (p.p_operation === 'health') return { healthy: true }; throw new AppError('CONFLICT','冲突',409); });
  const db = new CloudDatabase(rpc);
  assert.deepEqual(await db.health(),{ healthy: true });
  assert.equal(rpc.calls[0].p_owner,null); assert.equal(rpc.calls[0].p_token_hash,null);
  await assert.rejects(db.call('getProfile',owner,tokenHash,{}),isError('CONFLICT',409));
  const transport: CloudRpcClient = { rpc: async () => ({ data: null, error: { code: '42501', message: '内部信息' } }) };
  await assert.rejects(new CloudDatabase(transport).health(),isError('FORBIDDEN',403));
  const broken: CloudRpcClient = { rpc: async () => { throw new Error('网络故障'); } };
  await assert.rejects(new CloudDatabase(broken).health(),isError('DB_UNAVAILABLE',503));
});
test('拒绝非JSON、循环、非有限数值、伪造owner及无效响应', async () => {
  const rpc = new Rpc(() => ({ healthy: true })), db = new CloudDatabase(rpc);
  const cyclic: Record<string,unknown> = {}; cyclic.self = cyclic;
  for (const value of [{ owner }, { ownerId: owner }, { owner_id: owner }, { x: NaN }, { x: Infinity }, { x: () => 1 }, { x: 1n }, { x: new Date() }, { x: [undefined] }, cyclic]) {
    await assert.rejects(db.call('health',null,null,value as Record<string,never>),isError('VALIDATION'));
  }
  assert.equal(rpc.calls.length,0);
  await assert.rejects(new CloudDatabase(rpc,5).call('projects/get',owner,tokenHash,{ id: projectId }),isError('PAYLOAD_LIMIT',413));
  for (const value of [null, [], { ok: true }, { ok: true, data: NaN }, { ok: false, error: { code: 'x', message: 'x', status: 200 } }]) {
    const invalid: CloudRpcClient = { rpc: async () => ({ data: value, error: null }) };
    await assert.rejects(new CloudDatabase(invalid).health(),isError('DB_RESPONSE_INVALID',502));
  }
});
test('稳定摘要保留数组顺序，忽略对象键顺序及undefined', () => {
  assert.equal(commandDigest({ z: 1,a: 2,x: undefined }),commandDigest({ a: 2,z: 1 }));
  assert.notEqual(commandDigest(['a','b']),commandDigest(['b','a']));
});
test('认证发放64hex七天业务token、复用持久owner且不泄露云token', async () => {
  const { db,rpc } = authFixture(), auth = new CloudAuth(db,'1'.repeat(64));
  const before = Date.now(), issued = await auth.issue(grant), again = await auth.issue(grant);
  assert.match(issued.token,/^[a-f0-9]{64}$/); assert.notEqual(issued.token,again.token);
  assert.equal(issued.user.id,again.user.id); assert.equal(issued.user.profile.version,0);
  assert.ok(issued.expiresAt >= before + 7 * 86400000 && issued.expiresAt <= Date.now() + 7 * 86400000);
  assert.ok(!JSON.stringify(issued).includes(cloudSession.accessToken));
  assert.ok(!JSON.stringify(rpc.calls).includes(cloudSession.refreshToken));
  const ctx = await auth.authenticate('Bearer ' + issued.token);
  assert.equal(ctx.owner,issued.user.id); assert.equal(ctx.tokenHash,hashBusinessToken(issued.token));
  assert.deepEqual(await auth.load(ctx),cloudSession);
  const renewed = { ...cloudSession, accessToken: '新access' };
  await auth.save(ctx,renewed); assert.deepEqual(await auth.load(ctx),renewed);
});
test('AAD隔离subject和tokenHash，篡改密文无法解密', async () => {
  const { db,sessions } = authFixture(), auth = new CloudAuth(db,'2'.repeat(64));
  const first = await auth.issue(grant), second = await auth.issue(grant);
  const a = await auth.authenticate('Bearer ' + first.token), b = await auth.authenticate('Bearer ' + second.token);
  sessions.get(b.tokenHash)!.crypt = sessions.get(a.tokenHash)!.crypt;
  await assert.rejects(auth.load(b),isError('LOGIN_REQUIRED',401));
  sessions.get(a.tokenHash)!.subject = 'workbuddy:其他绑定:cloud-user';
  await assert.rejects(auth.load(a),isError('LOGIN_REQUIRED',401));
});
test('云身份/scope不能续期换人；纯字符串兼容mock，缺失密钥拒绝云登录', async () => {
  const { db } = authFixture(), auth = new CloudAuth(db,'3'.repeat(64));
  const issued = await auth.issue(grant), ctx = await auth.authenticate('Bearer ' + issued.token);
  await assert.rejects(auth.save(ctx,{ ...cloudSession, subject: 'other' }),isError('LOGIN_REQUIRED',401));
  await assert.rejects(auth.save(ctx,{ ...cloudSession, scope: 'other' }),isError('LOGIN_REQUIRED',401));
  await assert.rejects(auth.issue({ subject: 'workbuddy:wx:other', cloudSession }),isError('LOGIN_FAILED',401));
  await assert.rejects(new CloudAuth(db).issue(grant),isError('AUTH_NOT_CONFIGURED',503));
  const mock = await new CloudAuth(db).issue('mock-user');
  const mockCtx = await auth.authenticate('Bearer ' + mock.token);
  await assert.rejects(auth.load(mockCtx),isError('LOGIN_REQUIRED',401));
});
test('撤销后认证、业务RPC、云会话与运行中模型均失败', async () => {
  const { db } = authFixture(), auth = new CloudAuth(db,'4'.repeat(64));
  const issued = await auth.issue(grant), ctx = await auth.authenticate('Bearer ' + issued.token);
  const op = await auth.beginModelOperation(ctx);
  await assert.rejects(auth.assertLive({ ...ctx,owner: otherOwner }),isError('LOGIN_REQUIRED',401));
  await auth.revoke(ctx.tokenHash); assert.equal(op.signal.aborted,true); op.release();
  await assert.rejects(auth.authenticate('Bearer ' + issued.token),isError('LOGIN_REQUIRED',401));
  await assert.rejects(auth.load(ctx),isError('LOGIN_REQUIRED',401));
  await assert.rejects(db.call('getProfile',ctx.owner,ctx.tokenHash,{}),isError('LOGIN_REQUIRED',401));
  await assert.rejects(auth.authenticate('Bearer bad'),isError('LOGIN_REQUIRED',401));
});
test('所有仓储owner首参必须匹配绑定上下文，拒绝后无RPC或blob访问', async () => {
  const rpc = new Rpc(() => []), db = new CloudDatabase(rpc), blobs = new Blobs();
  const records = new CloudRecords(db,blobs,context), procurement = new CloudProcurementStore(db,blobs,context), templates = new CloudTemplateStore(db,context);
  await assert.rejects(records.listProjects(otherOwner),isError('LOGIN_REQUIRED',401));
  await assert.rejects(records.stagePhoto(otherOwner,{ name: 'x',bytes: Buffer.from('x') }),isError('LOGIN_REQUIRED',401));
  await assert.rejects(records.saveProduct(otherOwner,{ requestKey: randomUUID(),projectId,fields: emptyFields,photoIds: [] }),isError('LOGIN_REQUIRED',401));
  await assert.rejects(procurement.create(otherOwner,document()),isError('LOGIN_REQUIRED',401));
  await assert.rejects(templates.read(otherOwner),isError('LOGIN_REQUIRED',401));
  assert.throws(() => records.forOwner(otherOwner),isError('LOGIN_REQUIRED',401));
  assert.equal(rpc.calls.length,0); assert.equal(blobs.events.length,0);
});
test('十二仓储方法和扩展方法均可异步调用，产品/汇总数字与ISO补齐', async () => {
  const summary = { total: '1', confirmed: '0', pending: '1', missingPrice: '1', suppliers: '0', photos: '1' };
  const row = product({ version: '2', unitPrice: '12.5', extension: { retained: true }, photos: [{ id: randomUUID(),name: '照片',url: '不可信地址' }] });
  const rpc = new Rpc(p => {
    assert.equal(p.p_owner,owner); assert.equal(p.p_token_hash,tokenHash);
    switch (p.p_operation) {
      case 'projects/list': return [{ id: projectId,name: '任务',market: '',date: '2026-10-17',demo: false,createdAt: timestamp,summary }];
      case 'projects/get': case 'projects/create': return { id: projectId,name: '任务',market: '',date: '2026-10-17',demo: false,createdAt: timestamp };
      case 'product/get': case 'product/favorite': return row;
      case 'product/listExport': return [row];
      case 'product/page': return { items: [row],summary,matchedCount: '1',nextCursor: null };
      case 'recordDays': return [{ date: '2026-10-17',count: '1' }];
      case 'getProfile': case 'saveProfile': return { name: '姓名',version: '2' };
      case 'product/delete': return { deleted: true };
      default: throw new Error(p.p_operation);
    }
  });
  const records = new CloudRecords(new CloudDatabase(rpc),new Blobs(),context);
  assert.equal((await records.listProjects(owner))[0].summary?.photos,1);
  await records.getProject(owner,projectId);
  await records.createProject(owner,{ name: '任务',market: '',date: '2026-10-17' },randomUUID());
  const read = await records.getProduct(owner,productId);
  assert.equal(read.version,2); assert.equal(read.unitPrice,12.5); assert.equal(read.rating,null);
  assert.deepEqual((read as Product & { extension: unknown }).extension,{ retained: true });
  assert.equal(read.photos[0].url,'/api/photos/' + read.photos[0].id); assert.equal(read.createdAt,timestamp);
  assert.equal((await records.listProducts(owner,projectId)).length,1);
  assert.equal((await records.recordsForExport(owner,undefined,'2026-10-17',true)).length,1);
  const page = await records.pageProducts(owner,projectId,undefined,1,{ q: '%_\\',date: '2026-10-17',favorite: true,status: 'pending' });
  assert.equal(page.summary.total,1); assert.equal(page.matchedCount,1);
  assert.equal(await records.projectSummary(owner,projectId).then(s => s.pending),1);
  await records.setFavorite(owner,productId,true,2); await records.deleteProduct(owner,productId,2);
  assert.equal((await records.recordDays(owner))[0].count,1);
  assert.equal((await records.getProfile(owner)).version,2);
  assert.equal((await records.saveProfile(owner,emptyProfile,2)).version,2);
  const facade = createCloudRecords(new CloudDatabase(rpc),new Blobs(),context);
  assert.equal(typeof facade.readPhoto,'function'); assert.equal(typeof facade.saveProduct,'function');
});
test('stagePhoto先写对象再登记，SQL失败孤儿不立即删除', async () => {
  const blobs = new Blobs();
  const rpc = new Rpc(p => {
    if (p.p_operation === 'getProfile') return { ...emptyProfile,version: 0 };
    assert.equal(p.p_operation,'media/stage');
    assert.equal(blobs.objects.has(String(p.p_payload.objectKey)),true);
    assert.equal(p.p_payload.objectKey,`${owner}/photos/${p.p_payload.id}.jpg`);
    throw new AppError('MEDIA_QUOTA','暂存过多',429);
  });
  await assert.rejects(new CloudRecords(new CloudDatabase(rpc),blobs,context).stagePhoto(owner,{ name: '图',bytes: Buffer.from('jpeg') }),isError('MEDIA_QUOTA',429));
  assert.equal(blobs.objects.size,1); assert.ok(blobs.events.every(x => !x.startsWith('remove:')));
});
test('saveProduct回执优先，预检对象存在后最终RPC；不丢未知字段', async () => {
  const blobs = new Blobs(), photoId = randomUUID(), key = `${owner}/photos/${photoId}.jpg`;
  blobs.objects.set(key,Buffer.from('jpeg'));
  const command = { requestKey: randomUUID(),projectId,fields: { ...emptyFields,name: '产品',future: { v: 1 } },photoIds: [photoId] };
  const rpc = new Rpc(p => {
    if (p.p_operation === 'media/get') return { id: photoId,name: '照片',objectKey: key,productId: null,expiresAt: timestamp };
    assert.equal(p.p_operation,'product/save');
    if (p.p_payload.checkOnly) return null;
    assert.ok(blobs.events.includes('info:' + key));
    assert.deepEqual((p.p_payload.fields as Record<string,unknown>).future,{ v: 1 }); return product();
  });
  await new CloudRecords(new CloudDatabase(rpc),blobs,context).saveProduct(owner,command);
  assert.deepEqual(rpc.calls.map(x => x.p_operation),['product/save','media/get','product/save']);
  const replay = new Rpc(() => product()), empty = new Blobs();
  await new CloudRecords(new CloudDatabase(replay),empty,context).saveProduct(owner,command);
  assert.equal(replay.calls.length,1); assert.equal(empty.events.length,0);
  await assert.rejects(new CloudRecords(new CloudDatabase(rpc),blobs,context).saveProduct(owner,{ ...command,photoIds: [photoId,photoId] }),isError('INVALID_PHOTO'));
});
test('readPhoto对象读取期间的退出或删除会阻止返回', async () => {
  const blobs = new Blobs(), id = randomUUID(), key = `${owner}/photos/${id}.jpg`; blobs.objects.set(key,Buffer.from('jpeg'));
  let reads = 0;
  const rpc = new Rpc(() => { if (++reads === 2) throw new AppError('LOGIN_REQUIRED','已退出',401); return { id,name: '',objectKey: key,productId,expiresAt: null } satisfies CloudMedia; });
  await assert.rejects(new CloudRecords(new CloudDatabase(rpc),blobs,context).readPhoto(owner,id),isError('LOGIN_REQUIRED',401));
});
test('采购原表和图片先持久化，数据库仅存cloud引用，read可选展开', async () => {
  const blobs = new Blobs(), input = document(); let saved: { document: Procurement;originalKey: string | null } | undefined;
  const rpc = new Rpc(p => {
    switch (p.p_operation) {
      case 'getProfile': return { ...emptyProfile,version: 0 };
      case 'procurement/create': {
        const doc = p.p_payload.document as Procurement, originalKey = p.p_payload.originalKey as string;
        assert.ok(!JSON.stringify(doc).includes('base64')); assert.ok(blobs.objects.has(originalKey));
        assert.ok(doc.lines[0].images[0].startsWith('cloud:' + owner + '/pictures/'));
        saved = { document: structuredClone(doc),originalKey }; return saved;
      }
      case 'procurement/get': return saved;
      case 'procurement/list': return [saved!.document];
      case 'procurement/delete': saved = undefined; return { deleted: true,objectKeys: [] };
      default: throw new Error(p.p_operation);
    }
  });
  const store = new CloudProcurementStore(new CloudDatabase(rpc),blobs,context);
  const created = await store.create(owner,input,Buffer.from('xlsx'));
  assert.ok(input.lines[0].images[0].startsWith('data:'));
  const metadata = await store.read(owner,input.id); assert.ok(metadata.lines[0].images[0].startsWith('cloud:'));
  const full = await store.read(owner,input.id,true); assert.equal(full.lines[0].images[0],input.lines[0].images[0]);
  assert.deepEqual(await store.original(owner,input.id),Buffer.from('xlsx'));
  assert.deepEqual(await store.resolveImage(owner,input.id,input.lines[0].id,0),Buffer.from('JPEG模拟'));
  assert.equal((await store.list(owner))[0].summary.lines,1);
  await store.delete(owner,created.id,created.version);
  assert.ok(blobs.events.every(x => !x.startsWith('remove:')));
});
test('采购CAS回调同步执行，不允许更换来源或跨owner图片', async () => {
  const blobs = new Blobs(), input = document(); input.lines[0].images = [];
  let doc = structuredClone(input);
  const rpc = new Rpc(p => {
    if (p.p_operation === 'procurement/get') return { document: doc,originalKey: null };
    if (p.p_operation === 'procurement/update') {
      assert.equal(p.p_payload.version,1); const next = p.p_payload.document as Procurement;
      doc = { ...next,version: 2 }; return { document: doc,originalKey: null };
    }
    throw new Error(p.p_operation);
  });
  const store = new CloudProcurementStore(new CloudDatabase(rpc),blobs,context);
  const saved = await store.update(owner,input.id,1,value => { value.lines[0].note = '已核对'; });
  assert.equal(saved.version,2); assert.equal(saved.lines[0].note,'已核对');
  await assert.rejects(store.update(owner,input.id,1,value => { value.sourceHash = ''; }),isError('VALIDATION'));
  await assert.rejects(store.update(owner,input.id,1,async () => {}),isError('INVALID_CHANGE'));
  await assert.rejects(store.update(owner,input.id,1,value => { value.lines[0].images = [`cloud:${otherOwner}/pictures/${randomUUID()}.jpg`]; }),isError('INVALID_PHOTO'));
});
test('模板使用旧schema规范化与版本RPC', async () => {
  const template = defaultProcurementTemplate(), rpc = new Rpc(p => {
    if (p.p_operation === 'template/get') return null;
    assert.equal(p.p_operation,'template/save'); assert.equal(p.p_payload.version,0);
    return { ...(p.p_payload.fields as Record<string,unknown>),version: 1 };
  });
  const store = new CloudTemplateStore(new CloudDatabase(rpc),context);
  assert.deepEqual(await store.read(owner),template);
  const { version,...fields } = template;
  assert.equal((await store.save(owner,version,fields)).version,1);
});
test('回执mock验证同owner同键重放、异内容409、不同owner独立', async () => {
  const receipts = new Map<string,{ digest: string;value: unknown }>();
  const rpc = new Rpc(p => {
    const key = p.p_owner + ':' + p.p_payload.requestKey, digest = String(p.p_payload.digest);
    const prior = receipts.get(key);
    if (prior) { if (prior.digest !== digest) throw new AppError('CONFLICT','内容变化',409); return prior.value; }
    const value = { id: randomUUID(),name: p.p_payload.name,market: '',date: '2026-10-17',demo: false,createdAt: timestamp };
    receipts.set(key,{ digest,value }); return value;
  });
  const db = new CloudDatabase(rpc), first = new CloudRecords(db,new Blobs(),context);
  const second = new CloudRecords(db,new Blobs(),{ owner: otherOwner,tokenHash });
  const value = { name: '任务',market: '',date: '2026-10-17' }, key = randomUUID();
  const saved = await first.createProject(owner,value,key);
  assert.deepEqual(await first.createProject(owner,value,key),saved);
  await assert.rejects(first.createProject(owner,{ ...value,name: '不同内容' },key),isError('CONFLICT',409));
  assert.notEqual((await second.createProject(otherOwner,value,key)).id,saved.id);
  assert.equal(receipts.size,2);
});
test('照片对象缺失时不发送最终保存RPC', async () => {
  const id = randomUUID(), rpc = new Rpc(p => p.p_operation === 'product/save' ? null : { id,name: '',objectKey: `${owner}/photos/${id}.jpg`,productId: null,expiresAt: timestamp });
  await assert.rejects(new CloudRecords(new CloudDatabase(rpc),new Blobs(),context).saveProduct(owner,{ requestKey: randomUUID(),projectId,fields: emptyFields,photoIds: [id] }),isError('NOT_FOUND',404));
  assert.deepEqual(rpc.calls.map(p => p.p_operation),['product/save','media/get']);
});
test('SQL契约覆盖全部操作、服务角色、会话锁、跨owner关联、回执和配额', () => {
  const sql = readFileSync(join(__dirname,'../cloudbase/migrations/20261017030424_huoji_core.sql'),'utf8');
  for (const op of ['health','login','sessionAuthenticate','sessionRevoke','cloudSessionLoad','cloudSessionSave','getProfile','saveProfile','projects/list','projects/get','projects/create','product/get','product/page','product/listExport','product/save','product/delete','product/favorite','recordDays','media/stage','media/get','media/listExpired','media/retire','procurement/list','procurement/get','procurement/create','procurement/update','procurement/delete','template/get','template/save']) assert.ok(sql.includes(`'${op}'`),op);
  assert.match(sql,/auth\.role\(\) IS DISTINCT FROM 'service_role'/);
  assert.match(sql,/SECURITY DEFINER SET search_path = pg_catalog/);
  assert.match(sql,/REVOKE ALL ON FUNCTION public\.huoji_command\(text,text,text,jsonb\) FROM PUBLIC, anon, authenticated/);
  assert.match(sql,/GRANT EXECUTE ON FUNCTION public\.huoji_command\(text,text,text,jsonb\) TO service_role/);
  assert.match(sql,/ENABLE ROW LEVEL SECURITY/); assert.doesNotMatch(sql,/GRANT .* ON TABLE .* TO (?:anon|authenticated)/);
  assert.match(sql,/PRIMARY KEY\(owner_id, request_key\)/);
  assert.match(sql,/FOREIGN KEY\(owner_id, project_id\) REFERENCES public\.huoji_projects\(owner_id, id\)/);
  assert.match(sql,/FOREIGN KEY\(owner_id, product_id\) REFERENCES public\.huoji_products\(owner_id, id\)/);
  assert.match(sql,/UNIQUE INDEX huoji_procurement_source.*\(owner_id, source_hash\)/);
  assert.match(sql,/SELECT \* INTO u.*FOR UPDATE/);
  const lock = sql.indexOf('WHERE huoji_users.id = p_owner FOR UPDATE');
  const auth = sql.indexOf('WHERE owner_id = p_owner AND token_hash = p_token_hash AND expires_at > clock_timestamp()',lock);
  const receipt = sql.indexOf('SELECT * INTO receipt',auth);
  assert.ok(lock > 0 && auth > lock && receipt > auth);
  assert.match(sql,/p_payload - 'digest' - 'checkOnly'/);
  assert.match(sql,/receipt\.digest <> digest_value/);
  assert.match(sql,/INSERT INTO public\.huoji_receipts\(owner_id,request_key,digest,result\)/);
  assert.match(sql,/photo_count > 6/); assert.match(sql,/count\(DISTINCT value\)/);
  assert.match(sql,/m\.product_id IS DISTINCT FROM id/); assert.match(sql,/expires_at > clock_timestamp\(\)/);
  assert.match(sql,/>= 100/); assert.match(sql,/>= 30/);
  assert.match(sql,/AND version = version_value/);
  assert.match(sql,/Asia\/Shanghai/); assert.match(sql,/ESCAPE E'\\\\'/);
  assert.doesNotMatch(sql,/\b(?:storage\.objects|storage\.buckets|DROP TABLE|TRUNCATE)\b/);
  const cursor = createHash('sha256').update(projectId).update('\0').update(productId).digest('base64url');
  assert.match(cursor,/^[A-Za-z0-9_-]{43}$/); assert.match(sql,/decode\('00','hex'\)/);
});


test('AI恢复共用截止时间，过期预算不发RPC，慢读取不能在超时后写凭据', async () => {
  let calls = 0;
  const rpc: CloudRpcClient = { rpc: async () => { calls++; await new Promise(resolve => setTimeout(resolve, 35)); return { data: { ok: true, data: { healthy: true } }, error: null }; } };
  const db = new CloudDatabase(rpc), expired = modelRecoveryBudget(1);
  await new Promise(resolve => setTimeout(resolve, 5));
  await assert.rejects(db.call('health', null, null, {}, expired), isError('MODEL_RECOVERY_TIMEOUT', 504));
  assert.equal(calls, 0);
  await assert.rejects(db.call('health', null, null, {}, modelRecoveryBudget(10)), isError('MODEL_RECOVERY_TIMEOUT', 504));
  assert.equal(calls, 1);
  const f = authFixture(), auth = new CloudAuth(f.db, '1'.repeat(64));
  const issued = await auth.issue(grant), ctx = await auth.authenticate('Bearer ' + issued.token);
  const encrypted = f.sessions.get(ctx.tokenHash)!.crypt;
  const slowRpc: CloudRpcClient = { rpc: async (name, parameters) => { await new Promise(resolve => setTimeout(resolve, 30)); return f.rpc.rpc(name, parameters); } };
  const slowAuth = new CloudAuth(new CloudDatabase(slowRpc), '1'.repeat(64));
  await assert.rejects(slowAuth.reauthorizeModel(ctx, grant, modelRecoveryBudget(10)), isError('MODEL_RECOVERY_TIMEOUT', 504));
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(f.sessions.get(ctx.tokenHash)!.crypt, encrypted);
  assert.equal(f.rpc.calls.filter(p => p.p_operation === 'cloudSessionSave').length, 0);
  await assert.rejects(withinBudget(async () => { await new Promise(resolve => setTimeout(resolve, 20)); return true; }, modelRecoveryBudget(5)), isError('MODEL_RECOVERY_TIMEOUT', 504));
});
