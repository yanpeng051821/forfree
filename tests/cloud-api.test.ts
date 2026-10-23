import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import sharp from 'sharp';
import { createApp, checkReadiness, type CloudDependencies } from '../src/server/app';
import { parseRuntimeConfig } from '../src/server/config';
import { CloudDatabase, type CloudCommands, type CloudMedia, type CloudProcurement, type CloudRpcClient, type CloudRpcParameters } from '../src/server/cloud-db';
import { CloudAuth } from '../src/server/cloud-auth';
import { CloudJobs } from '../src/server/cloud-jobs';
import { CloudUploadBroker, UploadRegistry } from '../src/server/workbook-upload';
import type { BlobStore } from '../src/server/cloud-blobs';
import { MarketService } from '../src/server/service';
import { WorkBuddyIdentityProvider, WorkBuddyModelProvider } from '../src/server/workbuddy';
import { repository } from '../src/lib/db';
import { AppError } from '../src/lib/errors';
import { emptyFields, emptyProfile, type Product, type Project, type UserProfile } from '../src/lib/types';
import { defaultProcurementTemplate, type ProcurementTemplate } from '../src/lib/procurement-template';

const root = mkdtempSync(join(tmpdir(), 'huoji-cloud-api-'));
const forbidden = join(root, 'sqlite-forbidden');
writeFileSync(forbidden, '禁止云模式访问本机数据');
const previous = process.env.APP_DATA_DIR;
process.env.APP_DATA_DIR = forbidden;
after(() => { rmSync(root, { recursive: true, force: true }); if (previous === undefined) delete process.env.APP_DATA_DIR; else process.env.APP_DATA_DIR = previous; });
const env = {
  DATA_BACKEND: 'cloudbase', APP_DATA_DIR: forbidden, MODEL_PROVIDER: 'workbuddy',
  TCB_ENV: 'mock-cloud-env', CLOUDBASE_APIKEY: 'mock-private-key', CLOUD_STORAGE_BUCKET: 'huoji-private',
  WECHAT_APP_ID: 'mock-app', WB_CLOUD_ENDPOINT: 'https://gateway.example.test', WB_CLOUD_PUBLISHABLE_KEY: 'mock-publishable', WB_SESSION_ENCRYPTION_KEY: 'c'.repeat(64),
};
const config = parseRuntimeConfig(env);
const mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
class MemoryBlobs implements BlobStore {
  objects = new Map<string, { bytes: Buffer; mime: string }>();
  events: string[] = [];
  afterRead?: (key: string) => void;
  async write(key: string, bytes: Uint8Array, mime: string) { this.events.push('write:' + key); this.objects.set(key, { bytes: Buffer.from(bytes), mime }); }
  async read(key: string) { this.events.push('read:' + key); const value = this.objects.get(key); if (!value) throw new AppError('NOT_FOUND', '文件不存在', 404); this.afterRead?.(key); return Buffer.from(value.bytes); }
  async info(key: string) { const value = this.objects.get(key); if (!value) throw new AppError('NOT_FOUND', '文件不存在', 404); return { size: value.bytes.length, mime: value.mime, etag: 'mock' }; }
  async remove(key: string) { this.objects.delete(key); }
  async signUpload(): Promise<never> { throw new Error('当前路由不应使用签名上传'); }
  async signDownload(): Promise<never> { throw new Error('当前路由不应使用签名下载'); }
}
// 仅模拟 RPC 信封；不模拟、也不宣称真实 SQL/RLS 已通过验收。
class MockCloudDatabase implements CloudRpcClient {
  calls: CloudRpcParameters[] = [];
  healthy = true;
  failDatabase = false;
  users = new Map<string, string>();
  profiles = new Map<string, UserProfile>();
  sessions = new Map<string, { owner: string; subject: string; expiresAt: string; encrypted: string | null }>();
  projects = new Map<string, { owner: string; value: Project }>();
  products = new Map<string, { owner: string; value: Product }>();
  media = new Map<string, { owner: string; value: CloudMedia }>();
  procurements = new Map<string, { owner: string; value: CloudProcurement }>();
  templates = new Map<string, ProcurementTemplate>();
  jobs = new Map<string, { jobId: string; kind: string; state: string; resultReference: string | null; error: { code: string; message: string } | null; createdAt: string; updatedAt: string; version: number; expiresAt: string }>();
  receipts = new Map<string, { digest: string; data: unknown }>();
  authenticationGate?: Promise<void>;
  private owned<T>(map: Map<string, { owner: string; value: T }>, id: string, owner: string): T {
    const row = map.get(id); if (!row || row.owner !== owner) throw new AppError('NOT_FOUND', '记录不存在', 404); return row.value;
  }
  private replay(owner: string, payload: Record<string, unknown>, work: () => unknown, checkOnly = false): unknown {
    const key = owner + ':' + String(payload.requestKey), prior = this.receipts.get(key);
    if (prior) { if (prior.digest !== payload.digest) throw new AppError('CONFLICT', '请求内容已变化', 409); return prior.data; }
    if (checkOnly) return null;
    const data = work(); this.receipts.set(key, { digest: String(payload.digest), data: structuredClone(data) }); return data;
  }
  async rpc(name: 'huoji_command', p: CloudRpcParameters) {
    assert.equal(name, 'huoji_command'); this.calls.push(structuredClone(p));
    if (this.failDatabase) return { data: null, error: { code: 'NETWORK', message: '机密内部数据库地址' } };
    try { return { data: { ok: true, data: structuredClone(await this.execute(p)) }, error: null }; }
    catch (error) {
      if (!(error instanceof AppError)) throw error;
      return { data: { ok: false, error: { code: error.code, message: error.message, status: error.status } }, error: null };
    }
  }
  private async execute(p: CloudRpcParameters): Promise<unknown> {
    const payload = p.p_payload;
    if (p.p_operation === 'health') return { healthy: this.healthy };
    if (p.p_operation === 'login') {
      const data = payload as CloudCommands['login']['payload'];
      const owner = this.users.get(data.subject) || randomUUID(); this.users.set(data.subject, owner);
      if (!this.profiles.has(owner)) this.profiles.set(owner, { ...emptyProfile, version: 0 });
      this.sessions.set(data.tokenHash, { owner, subject: data.subject, expiresAt: data.expiresAt, encrypted: data.cloudEncrypted });
      return { owner, tokenHash: data.tokenHash, expiresAt: data.expiresAt, profile: this.profiles.get(owner) };
    }
    if (p.p_operation === 'sessionAuthenticate') await this.authenticationGate;
    const tokenHash = p.p_operation === 'sessionAuthenticate' ? String(payload.tokenHash) : p.p_token_hash;
    const session = tokenHash ? this.sessions.get(tokenHash) : undefined;
    if (!session || Date.parse(session.expiresAt) <= Date.now() || (p.p_operation !== 'sessionAuthenticate' && session.owner !== p.p_owner)) throw new AppError('LOGIN_REQUIRED', '登录已退出或过期', 401);
    const owner = session.owner;
    switch (p.p_operation) {
      case 'sessionAuthenticate': return { owner, tokenHash, expiresAt: session.expiresAt };
      case 'sessionRevoke': this.sessions.delete(tokenHash!); return { revoked: true };
      case 'cloudSessionLoad': return { subject: session.subject, encrypted: session.encrypted };
      case 'cloudSessionSave': session.encrypted = String(payload.encrypted); return { saved: true };
      case 'getProfile': return this.profiles.get(owner);
      case 'saveProfile': {
        const data = payload as CloudCommands['saveProfile']['payload'], current = this.profiles.get(owner)!;
        if (current.version !== data.version) throw new AppError('CONFLICT', '资料版本已变化', 409);
        const next = { ...data.fields, version: data.version + 1 }; this.profiles.set(owner, next); return next;
      }
      case 'projects/list': return [...this.projects.values()].filter(row => row.owner === owner).map(row => row.value);
      case 'projects/get': return this.owned(this.projects, String(payload.id), owner);
      case 'projects/create': return this.replay(owner, payload, () => {
        const data = payload as CloudCommands['projects/create']['payload'];
        const value: Project = { id: randomUUID(), name: data.name, market: data.market, date: data.date, demo: false, createdAt: new Date().toISOString() };
        this.projects.set(value.id, { owner, value }); return value;
      });
      case 'media/stage': {
        const data = payload as CloudCommands['media/stage']['payload'];
        const value = { ...data, productId: null, expiresAt: null }; this.media.set(data.id, { owner, value }); return value;
      }
      case 'media/get': return this.owned(this.media, String(payload.id), owner);
      case 'product/save': return this.replay(owner, payload, () => {
        const data = payload as CloudCommands['product/save']['payload'];
        this.owned(this.projects, data.projectId, owner);
        const current = data.id ? this.owned(this.products, data.id, owner) : undefined;
        if (current && current.version !== data.version) throw new AppError('CONFLICT', '商品版本已变化', 409);
        const value: Product = { ...emptyFields, ...data.fields, id: data.id || randomUUID(), projectId: data.projectId, version: (current?.version || 0) + 1, createdAt: current?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString(), photos: data.photoIds.map(id => { const media = this.owned(this.media, id, owner); return { id, name: media.name, url: '/api/photos/' + id }; }) };
        this.products.set(value.id, { owner, value }); return value;
      }, payload.checkOnly === true);
      case 'product/get': return this.owned(this.products, String(payload.id), owner);
      case 'product/delete': {
        const value = this.owned(this.products, String(payload.id), owner);
        if (value.version !== payload.version) throw new AppError('CONFLICT', '商品版本已变化', 409);
        this.products.delete(value.id); value.photos.forEach(photo => this.media.delete(photo.id)); return { deleted: true };
      }
      case 'product/favorite': {
        const data = payload as CloudCommands['product/favorite']['payload'], current = this.owned(this.products, data.id, owner);
        if (current.favorite === data.favorite && current.version === data.version + 1) return current;
        if (current.version !== data.version) throw new AppError('CONFLICT', '商品版本已变化', 409);
        current.favorite = data.favorite; current.version++; return current;
      }
      case 'merchant/list': {
        if(payload.projectId)this.owned(this.projects,String(payload.projectId),owner);
        const groups=new Map<string,{supplier:string;supplierContact:string;total:number;confirmed:number;pending:number;missingPrice:number}>();
        for(const {owner:productOwner,value:v} of this.products.values())if(productOwner===owner && (!payload.projectId || v.projectId===payload.projectId) && !v.deletedAt){const g=groups.get(v.supplier)||{supplier:v.supplier,supplierContact:v.supplierContact,total:0,confirmed:0,pending:0,missingPrice:0};g.total++;if(v.confirmed)g.confirmed++;else g.pending++;if(v.unitPrice===null)g.missingPrice++;groups.set(v.supplier,g);}return [...groups.values()];
      }
      case 'product/listExport':
      case 'product/page': {
        if (payload.projectId) this.owned(this.projects, String(payload.projectId), owner);
        const values = [...this.products.values()].filter(row => row.owner === owner && !row.value.deletedAt && (!payload.projectId || row.value.projectId === payload.projectId) && (payload.supplier===undefined || row.value.supplier===payload.supplier)).map(row => row.value);
        if (p.p_operation === 'product/listExport') return values.filter(product => !payload.favorite || product.favorite);
        const items = values.filter(product => (!payload.favorite || product.favorite) && (!payload.q || product.name.includes(String(payload.q))));
        return { items: items.slice(0, Number(payload.limit)), nextCursor: null, matchedCount: items.length, summary: { total: values.length, confirmed: values.filter(p => p.confirmed).length, pending: values.filter(p => !p.confirmed).length, missingPrice: values.filter(p => p.unitPrice === null).length, suppliers: new Set(values.map(p => p.supplier)).size, photos: values.reduce((sum, p) => sum + p.photos.length, 0) } };
      }
      case 'recordDays': return [{ date: '2026-10-17', count: [...this.products.values()].filter(row => row.owner === owner).length }];
      case 'procurement/list': return [...this.procurements.values()].filter(row => row.owner === owner).map(row => row.value.document);
      case 'procurement/get': return this.owned(this.procurements, String(payload.id), owner);
      case 'procurement/create': {
        const data = payload as CloudCommands['procurement/create']['payload'];
        const value = { document: data.document, originalKey: data.originalKey }; this.procurements.set(data.document.id, { owner, value }); return value;
      }
      case 'procurement/update': {
        const data = payload as CloudCommands['procurement/update']['payload'], current = this.owned(this.procurements, data.id, owner);
        if (current.document.version !== data.version) throw new AppError('CONFLICT', '采购版本已变化', 409);
        current.document = { ...data.document, version: data.version + 1, updatedAt: new Date().toISOString() }; return current;
      }
      case 'procurement/delete': {
        const current = this.owned(this.procurements, String(payload.id), owner);
        if (current.document.version !== payload.version) throw new AppError('CONFLICT', '采购版本已变化', 409);
        this.procurements.delete(String(payload.id)); return { deleted: true, objectKeys: [] };
      }
      case 'template/get': return this.templates.get(owner) || null;
      case 'template/save': {
        const data = payload as CloudCommands['template/save']['payload'];
        if ((this.templates.get(owner)?.version || 0) !== data.version) throw new AppError('CONFLICT', '模板版本已变化', 409);
        const value = { ...data.fields, version: data.version + 1 }; this.templates.set(owner, value); return value;
      }
      // 任务同样按账号隔离存放，别的账号取不到本账号的任务。
      case 'job/create': {
        const data = payload as CloudCommands['job/create']['payload'];
        const record = { jobId: String(data.jobId), kind: data.kind, state: data.state, resultReference: null, error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), version: 0, expiresAt: new Date(Date.now() + 300_000).toISOString() };
        this.jobs.set(`${owner}/${record.jobId}`, record); return record;
      }
      case 'job/get': {
        const record = this.jobs.get(`${owner}/${String(payload.jobId)}`);
        if (!record) throw new AppError('NOT_FOUND', '任务不存在', 404);
        return { ...record };
      }
      case 'job/start': {
        const record = this.jobs.get(`${owner}/${String(payload.jobId)}`);
        if (!record) throw new AppError('NOT_FOUND', '任务不存在', 404);
        record.state = 'running'; record.version++; return { ...record };
      }
      case 'job/finish': {
        const data = payload as CloudCommands['job/finish']['payload'];
        const record = this.jobs.get(`${owner}/${String(data.jobId)}`);
        if (!record) throw new AppError('NOT_FOUND', '任务不存在', 404);
        record.version++; record.state = data.state; record.resultReference = data.resultReference; record.error = data.error;
        return { ...record };
      }
      default: throw new AppError('UNKNOWN_OPERATION', '未模拟的操作');
    }
  }
}
function fixture() {
  const rpc = new MockCloudDatabase(), db = new CloudDatabase(rpc), blobs = new MemoryBlobs(), auth = new CloudAuth(db, env.WB_SESSION_ENCRYPTION_KEY);
  // AI 整理与大表导入一样走持久任务：请求只回任务号，结果在后台写回。
  const cloud: CloudDependencies = {
    db, blobs, auth, storageHealth: async () => true,
    uploadBroker: (context, registry) => new CloudUploadBroker(db, blobs, context, registry),
    jobs: (context, uploads) => new CloudJobs(db, blobs, uploads, context),
  };
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input); calls.push(url);
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (url.endsWith('/login-wechat')) return Response.json({ sub: String(body.code), access_token: 'opaque-cloud-access', refresh_token: 'opaque-refresh', expires_in: 1 });
    if (url.endsWith('/token')) return Response.json({ sub: String(body.refresh_token).replace('refresh:', ''), access_token: 'opaque-renewed-access', refresh_token: 'opaque-renewed-refresh', expires_in: 3600 });
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer opaque-renewed-access');
    if (url.endsWith('/models')) return Response.json({ data: [{ id: 'vision', supportsImages: true }] });
    // 与真实提示词契约一致：未知字段显式为 null，后端会过滤掉。
    const text = JSON.stringify({ name: '云整理杯子', colors: null, material: null, dimensions: null, weightG: null, unitPrice: 12, currency: 'CNY', moq: null, cartonQty: null });
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  };
  const identity = new WorkBuddyIdentityProvider(async (input, init) => {
    const response = await fetcher(input, init), raw = await response.json() as Record<string, unknown>;
    raw.refresh_token = 'refresh:' + String(raw.sub); return Response.json(raw);
  }, config);
  const service = new MarketService(repository, new WorkBuddyModelProvider(fetcher, config, auth));
  return { rpc, db, blobs, auth, cloud, calls, identity, service, app: () => createApp({ config, cloud, identity, service }) };
}
const headers = (token: string) => ({ authorization: 'Bearer ' + token });
async function login(app: Awaited<ReturnType<typeof createApp>>, code: string) {
  const response = await app.inject({ method: 'POST', url: '/api/auth/wechat', payload: { code } });
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as { token: string; user: { id: string }; expiresAt: number };
}
test('background organization acknowledges once, persists without polling, and recovers submission failure and missing task',async()=>{
  const f=fixture();let unblock!:()=>void,started!:()=>void;
  const entered=new Promise<void>(r=>{started=r;});
  f.service.model={enabled:()=>true,extract:async()=>{started();await new Promise<void>(r=>{unblock=r;});return{fields:{name:'后台杯子',supplier:'合成商户'},mode:'model',warning:'请核对'};}};
  const app=await f.app();
  try{
    const a=await login(app,'background-alice'),auth=headers(a.token);
    const post=(url:string,payload:unknown)=>app.inject({method:'POST',url,headers:auth,payload:payload as never});
    const project=(await post('/api/projects',{requestKey:randomUUID(),name:'后台演示',market:'',date:'2026-10-18'})).json();
    const product=(await post('/api/products',{requestKey:randomUUID(),projectId:project.id,fields:{...emptyFields,name:'未命名商品',description:'合成现场记录'},photoIds:[]})).json();
    const response=await post('/api/products/'+product.id+'/organize',{version:product.version});assert.equal(response.statusCode,202,response.body);
    await entered;
    const duplicate=await post('/api/products/'+product.id+'/organize',{version:product.version});assert.equal(duplicate.statusCode,202);assert.equal(duplicate.json().jobId,response.json().jobId);
    unblock();
    // Read the product directly; no /api/jobs polling triggers execution or persistence.
    let current:Product|undefined;
    for(let n=0;n<100;n++){current=f.rpc.products.get(product.id)?.value;if(current?.organizeState==='done')break;await new Promise(r=>setTimeout(r,5));}
    assert.equal(current?.name,'后台杯子');assert.equal(current?.supplier,'合成商户');assert.equal(current?.description,'合成现场记录');assert.equal(current?.organizeState,'done');
    const broken=(await post('/api/products',{requestKey:randomUUID(),projectId:project.id,fields:{...emptyFields,name:'未命名商品',description:'不会丢失的文字'},photoIds:[]})).json();
    const jobs=f.cloud.jobs!;
    f.cloud.jobs=(context,uploads)=>{const value=jobs(context,uploads);value.startExtraction=async()=>{throw new AppError('BUSY','提交失败',503);};return value;};
    assert.equal((await post('/api/products/'+broken.id+'/organize',{version:broken.version})).statusCode,503);
    const retained=f.rpc.products.get(broken.id)!.value;assert.equal(retained.organizeState,'failed');assert.equal(retained.description,'不会丢失的文字');
    f.cloud.jobs=jobs;f.service.model.extract=async()=>({fields:{name:'恢复杯子'},mode:'model',warning:''});
    retained.organizeState='queued';retained.organizeJobId=randomUUID();
    assert.equal((await post('/api/products/'+broken.id+'/organize',{version:retained.version})).statusCode,202);
    for(let n=0;n<100&&f.rpc.products.get(broken.id)!.value.organizeState!=='done';n++)await new Promise(r=>setTimeout(r,5));
    assert.equal(f.rpc.products.get(broken.id)!.value.name,'恢复杯子');
  }finally{unblock?.();await app.close();}
});
test('list thumbnail stays within 480px and keeps photo owner authentication',async()=>{
  const f=fixture(),app=await f.app();
  try{
    const a=await login(app,'thumb-alice'),b=await login(app,'thumb-bob');
    const bytes=await sharp({create:{width:1600,height:1000,channels:3,background:'#909a8f'}}).jpeg().toBuffer(),form=upload(bytes,'photo','synthetic.jpg');
    const created=await app.inject({method:'POST',url:'/api/photos',headers:{...headers(a.token),...form.headers},payload:form.payload});assert.equal(created.statusCode,201,created.body);
    const path='/api/photos/'+created.json().id+'/thumbnail';
    const thumb=await app.inject({url:path,headers:headers(a.token)});assert.equal(thumb.statusCode,200);
    const metadata=await sharp(thumb.rawPayload).metadata();assert.equal(metadata.width,480);assert.equal(metadata.height,300);assert.ok(thumb.rawPayload.length<bytes.length);
    assert.equal((await app.inject({url:path,headers:headers(b.token)})).statusCode,404);assert.equal((await app.inject({url:path})).statusCode,401);
  }finally{await app.close();}
});

test('模型重新授权保留业务会话与资料，拒绝其他微信账号和已退出会话', async () => {
  const f = fixture(), app = await f.app();
  try {
    const a = await login(app, 'reauth-alice');
    const context = await f.auth.authenticate('Bearer ' + a.token);
    const before = f.rpc.sessions.get(context.tokenHash)!.encrypted;
    const restored = await app.inject({ method: 'POST', url: '/api/auth/model-session', headers: headers(a.token), payload: { code: 'reauth-alice' } });
    assert.equal(restored.statusCode, 200, restored.body); assert.deepEqual(restored.json(), { restored: true });
    assert.equal(f.rpc.sessions.size, 1); assert.notEqual(f.rpc.sessions.get(context.tokenHash)!.encrypted, before);
    assert.equal((await f.auth.authenticate('Bearer ' + a.token)).owner, a.user.id);
    assert.ok(!restored.body.includes('opaque-cloud-access')); assert.ok(!restored.body.includes('refresh:'));
    const current = f.rpc.sessions.get(context.tokenHash)!.encrypted;
    const wrong = await app.inject({ method: 'POST', url: '/api/auth/model-session', headers: headers(a.token), payload: { code: 'reauth-bob' } });
    assert.equal(wrong.statusCode, 409); assert.equal(wrong.json().error.code, 'MODEL_IDENTITY_CHANGED');
    assert.equal(f.rpc.sessions.get(context.tokenHash)!.encrypted, current);
    await f.auth.revoke(context);
    const out = await app.inject({ method: 'POST', url: '/api/auth/model-session', headers: headers(a.token), payload: { code: 'reauth-alice' } });
    assert.equal(out.statusCode, 401); assert.equal(f.rpc.sessions.size, 0);
  } finally { await app.close(); }
});
/** 轮询持久任务直到结束：容器通道单次请求有15秒硬上限，长耗时操作一律改成任务号轮询。 */
async function settleJob(request: (url: string, token?: string) => Promise<{ json(): unknown }>, jobId: string, token: string) {
  for (let attempt = 0; attempt < 600; attempt++) {
    const view = (await request('/api/jobs/' + jobId, token)).json() as { jobId: string; kind: string; state: string; procurementId: string | null; result: { fields: Record<string, unknown>; mode: string } | null };
    if (view.state === 'succeeded' || view.state === 'failed') return view;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('任务未在超时前结束');
}
function upload(bytes: Buffer, field: string, name: string) {
  const boundary = 'cloud-smoke-boundary';
  return { headers: { 'content-type': 'multipart/form-data; boundary=' + boundary }, payload: Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`), bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]) };
}

test('云模式缺少注入拒绝启动，SQLite 模式不隐式切云，就绪探针不碰本机', async () => {
  await assert.rejects(createApp({ config }), error => error instanceof AppError && error.code === 'CLOUD_CONFIG');
  const f = fixture();
  await assert.rejects(createApp({ config: { ...config, dataBackend: 'sqlite' }, cloud: f.cloud }), /显式启用/);
  assert.throws(() => checkReadiness(config), /异步云就绪检查/);
  const app = await f.app();
  try {
    assert.equal((await app.inject('/health')).statusCode, 200);
    assert.equal((await app.inject('/livez')).statusCode, 200);
    const response = await app.inject('/readyz'); assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(Object.keys(response.json().checks).sort(), ['authentication', 'database', 'model', 'storage']);
    assert.equal(response.body.includes(forbidden), false); assert.equal(response.body.includes(env.CLOUDBASE_APIKEY), false);
    f.rpc.healthy = false; assert.equal((await app.inject('/readyz')).statusCode, 503);
    f.rpc.healthy = true; delete f.cloud.storageHealth;
    const unchecked = await app.inject('/readyz'); assert.equal(unchecked.statusCode, 503); assert.deepEqual(unchecked.json().checks.storage, { ok: false, checked: false });
    f.cloud.storageHealth = async () => { throw new Error('不能泄漏内部密钥'); };
    const broken = await app.inject('/readyz'); assert.equal(broken.statusCode, 503); assert.ok(!broken.body.includes('内部密钥'));
    assert.deepEqual(readdirSync(root), ['sqlite-forbidden']);
  } finally { await app.close(); }
});

test('云 API 真实 CloudRecords 闭环：鉴权资料任务商品照片收藏模型导出与退出', async () => {
  const f = fixture(), app = await f.app();
  try {
    assert.equal((await app.inject('/api/projects')).statusCode, 401);
    const a = await login(app, 'alice'), b = await login(app, 'bob');
    assert.match(a.token, /^[a-f0-9]{64}$/); assert.ok(!JSON.stringify(a).includes('opaque'));
    const request = (url: string, token = a.token) => app.inject({ method: 'GET', url, headers: headers(token) });
    const post = (url: string, payload: object, token = a.token) => app.inject({ method: 'POST', url, headers: headers(token), payload });
    const before = f.rpc.calls.length;
    assert.equal((await request('/api/auth/me')).json().user.id, a.user.id);
    assert.equal(f.rpc.calls.slice(before).filter(p => p.p_operation === 'sessionAuthenticate').length, 1, '每请求只鉴权一次，限流键复用缓存');
    const savedProfile = await post('/api/profile', { ...emptyProfile, name: '云采购员', version: 0 });
    assert.equal(savedProfile.statusCode, 200, savedProfile.body); assert.equal(savedProfile.json().version, 1);
    assert.equal((await request('/api/auth/me')).json().user.profile.name, '云采购员');
    assert.equal((await post('/api/profile', { ...emptyProfile, name: '云采购员', version: 0 })).statusCode, 409);
    const command = { requestKey: randomUUID(), name: '云看货', market: '测试市场', date: '2026-10-17' };
    const created = await post('/api/projects', command); assert.equal(created.statusCode, 201, created.body);
    const project = created.json() as Project;
    assert.deepEqual((await post('/api/projects', command)).json(), project);
    assert.equal((await post('/api/projects', { ...command, name: '变更' })).statusCode, 409);
    assert.deepEqual((await request('/api/projects', b.token)).json(), []);
    const bytes = await sharp({ create: { width: 36, height: 48, channels: 3, background: '#349877' } }).png().toBuffer();
    const form = upload(bytes, 'photo', 'sample.png');
    const imageResponse = await app.inject({ method: 'POST', url: '/api/photos', headers: { ...headers(a.token), ...form.headers }, payload: form.payload });
    assert.equal(imageResponse.statusCode, 201, imageResponse.body);
    const photo = imageResponse.json() as { id: string; url: string };
    const photoResponse = await request(photo.url); assert.equal(photoResponse.statusCode, 200); assert.equal(photoResponse.headers['content-type'], 'image/jpeg');
    const fields = { ...emptyFields, name: '云杯子', supplier: '云商户', unitPrice: 12, cartonQty: 24, confirmed: true };
    const save = { requestKey: randomUUID(), projectId: project.id, fields, photoIds: [photo.id] };
    const response = await post('/api/products', save); assert.equal(response.statusCode, 201, response.body);
    const product = response.json() as Product;
    assert.deepEqual((await post('/api/products', save)).json(), product);
    assert.equal((await request('/api/products/' + product.id)).json().name, fields.name);
    const page = await request('/api/products?projectId=' + project.id); assert.equal(page.json().items[0].id, product.id);
    assert.equal((await request('/api/projects/' + project.id + '/summary')).json().photos, 1);
    assert.equal((await request('/api/record-days')).json()[0].count, 1);
    assert.deepEqual((await request('/api/suppliers?projectId=' + project.id)).json(), ['云商户']);
    for (const path of [photo.url, '/api/products/' + product.id, '/api/export?projectId=' + project.id, '/api/suppliers?projectId=' + project.id]) assert.equal((await request(path, b.token)).statusCode, 404, path);
    const favorite = await post('/api/products/' + product.id + '/favorite', { version: 1, favorite: true }); assert.equal(favorite.statusCode, 200); assert.equal(favorite.json().version, 2);
    assert.equal((await request('/api/products?favorite=yes')).json().items[0].id, product.id);
    // 容器通道15秒硬上限：整理只回任务号，客户端凭任务号轮询结果。
    const extracted = await post('/api/extract', { description: '云标签', photoIds: [photo.id] });
    assert.equal(extracted.statusCode, 202, extracted.body);
    const settled = await settleJob(request, (extracted.json() as { jobId: string }).jobId, a.token);
    assert.equal(settled.state, 'succeeded');
    assert.equal(settled.kind, 'extraction');
    assert.equal(settled.result?.mode, 'model');
    assert.equal(settled.result?.fields.name, '云整理杯子');
    assert.equal(settled.procurementId, null);
    assert.ok(!JSON.stringify(settled).includes(photo.id), '任务视图不含照片引用');
    assert.equal(f.calls.filter(url => url.endsWith('/token')).length, 1);
    assert.ok(f.rpc.calls.some(p => p.p_operation === 'cloudSessionSave'));
    assert.equal(JSON.stringify(f.rpc.calls).includes('opaque-renewed-access'), false);
    const edited = await post('/api/products', { ...save, requestKey: randomUUID(), id: product.id, version: 2, fields: { ...fields, unitPrice: 15 } }); assert.equal(edited.json().version, 3);
    const exported = await request('/api/export?projectId=' + project.id); assert.equal(exported.statusCode, 200, exported.body);
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(exported.rawPayload as unknown as ExcelJS.Buffer);
    const sheet = workbook.worksheets.find(s => s.name !== '说明')!; assert.equal(sheet.getImages().length, 1);
    const reference = defaultProcurementTemplate().columns.filter(column => column.enabled);
    const frozen = sheet.views.find(view => view.state === 'frozen'); assert.ok(frozen && 'ySplit' in frozen && typeof frozen.ySplit === 'number');
    const header = sheet.getRow(frozen.ySplit), columns = header.values as string[];
    assert.deepEqual(columns.slice(1), reference.map(column => column.label));
    const value = (key: string) => { const column = reference.find(column => column.key === key); assert.ok(column); const index = columns.indexOf(column.label); assert.ok(index > 0); return sheet.getRow(header.number + 1).getCell(index).value; };
    assert.equal(value('unitPrice'), 15); assert.equal(value('description'), fields.name);
    assert.equal(value('quantity'), null); assert.equal(value('amount'), null); assert.equal(value('pcsPerCarton'), 24);
    for (const label of ['商品名称', '现场记录单价', '选品评价', '选品评分', '商户联系方式', '现场备注']) assert.ok(!columns.includes(label));
    const submit = await post('/api/export-jobs', { projectId: project.id, audience: 'selection' });
    assert.equal(submit.statusCode, 202, submit.body);
    assert.equal((await settleJob(request, submit.json().jobId, a.token)).state, 'succeeded');
    const route = '/api/jobs/' + submit.json().jobId + '/file';
    assert.equal((await request(route, b.token)).statusCode, 404);
    const metadata = await request(route); assert.equal(metadata.json().chunkSize, 4 * 1024 * 1024);
    const downloaded = await request(route + '?offset=0'); assert.equal(downloaded.statusCode, 200);
    assert.equal(downloaded.rawPayload.length, metadata.json().size);
    const generated = new ExcelJS.Workbook(); await generated.xlsx.load(downloaded.rawPayload as unknown as ExcelJS.Buffer); assert.equal(generated.worksheets.filter(s => s.name !== '说明').length, 1);
    const generatedSheet = generated.worksheets.find(s => s.name !== '说明')!;
    assert.deepEqual((generatedSheet.getRow(header.number).values as string[]).slice(1), reference.map(column => column.label));
    assert.equal(generatedSheet.getRow(header.number + 1).getCell(columns.indexOf(reference.find(column => column.key === 'unitPrice')!.label)).value, 15);
    assert.equal(generatedSheet.getImages().length, 1);
    f.rpc.failDatabase = true;
    const failed = await request('/api/projects'); assert.equal(failed.statusCode, 503); assert.equal(failed.json().error.code, 'DB_UNAVAILABLE'); assert.ok(!failed.body.includes('机密内部'));
    f.rpc.failDatabase = false;
    assert.equal((await app.inject({ method: 'DELETE', url: '/api/products/' + product.id, headers: headers(a.token), payload: { version: 3 } })).statusCode, 200);
    assert.equal((await request(photo.url)).statusCode, 404);
    assert.equal((await post('/api/auth/logout', {})).statusCode, 200);
    assert.equal((await request('/api/projects')).statusCode, 401);
    assert.equal(existsSync(join(forbidden, 'market.sqlite')), false);
    assert.deepEqual(readdirSync(root), ['sqlite-forbidden']);
  } finally { await app.close(); }
});

test('云采购从任务生成、模板同步应用、图片二次校验、原表导入和小文件导出', async () => {
  const f = fixture(), app = await f.app();
  try {
    const a = await login(app, 'purchase'), b = await login(app, 'other');
    const request = (url: string, token = a.token) => app.inject({ method: 'GET', url, headers: headers(token) });
    const post = (url: string, payload: object) => app.inject({ method: 'POST', url, headers: headers(a.token), payload });
    const project = (await post('/api/projects', { requestKey: randomUUID(), name: '采购云任务', market: '', date: '2026-10-17' })).json() as Project;
    const bytes = await sharp({ create: { width: 24, height: 24, channels: 3, background: '#a99887' } }).jpeg().toBuffer();
    const photoForm = upload(bytes, 'photo', 'photo.jpg');
    const photo = (await app.inject({ method: 'POST', url: '/api/photos', headers: { ...headers(a.token), ...photoForm.headers }, payload: photoForm.payload })).json() as { id: string };
    assert.equal((await post('/api/products', { requestKey: randomUUID(), projectId: project.id, fields: { ...emptyFields, name: '采购杯', supplier: '商户甲', cartonQty: 24, unitPrice: 2 }, photoIds: [photo.id] })).statusCode, 201);
    const templateResponse = await request('/api/procurement-template');
    const { version, ...templateFields } = templateResponse.json();
    templateFields.company = '云模板公司';
    assert.equal((await post('/api/procurement-template', { version, fields: templateFields })).statusCode, 200);
    const created = await post('/api/procurement/from-project', { projectId: project.id }); assert.equal(created.statusCode, 201, created.body);
    const doc = created.json() as { id: string; version: number; lines: { id: string; imageUrls: string[]; images?: string[] }[] };
    assert.equal(doc.lines[0].images, undefined);
    assert.equal((await request(doc.lines[0].imageUrls[0])).statusCode, 200);
    assert.equal((await request('/api/procurement')).json().length, 1);
    assert.equal((await request('/api/procurement/' + doc.id, b.token)).statusCode, 404);
    const applied = await post('/api/procurement/' + doc.id + '/template', { version: 1 }); assert.equal(applied.statusCode, 200, applied.body); assert.equal(applied.json().template.company, '云模板公司');
    const updated = await post('/api/procurement/' + doc.id + '/lines/' + doc.lines[0].id, { version: 2, fields: { decision: 'include', cartons: 2, pcsPerCarton: 24, unitPrice: 2, cartonCbm: .1, note: '核对' } }); assert.equal(updated.statusCode, 200, updated.body);
    const exported = await request('/api/procurement/' + doc.id + '/export'); assert.equal(exported.statusCode, 200, exported.body);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(exported.rawPayload as unknown as ExcelJS.Buffer); assert.equal(wb.getWorksheet('商品明细')!.getImages().length, 1);
    // 导入使用受支持的商户采购表结构（合成数据），而不是整理后的导出视图。
    const source = new ExcelJS.Workbook(), sheet = source.addWorksheet('商户甲');
    ['云模板公司', 'CLOUD TEMPLATE CO.', '测试地址', 'TEL 000', '采购记录'].forEach((text, index) => { sheet.getCell(index + 1, 1).value = text; });
    sheet.getRow(6).values = ['REF.', 'CTNS（箱数）', 'PCS/CTN', 'QUANTITY', 'PRICE (RMB)', 'AMOUNT(RMB)', '备注'];
    sheet.getRow(7).values = ['00123', 2, 24, { formula: 'B7*C7', result: 48 }, 2.5, { formula: 'D7*E7', result: 120 }, '合成测试'];
    sheet.getRow(9).values = ['TOTAL', { formula: 'SUM(B7:B8)', result: 2 }, '', '', '', { formula: 'SUM(F7:F8)', result: 120 }];
    const importedBytes = Buffer.from(await source.xlsx.writeBuffer()), form = upload(importedBytes, 'workbook', '采购.xlsx');
    const imported = await app.inject({ method: 'POST', url: '/api/procurement/import', headers: { ...headers(a.token), ...form.headers }, payload: form.payload }); assert.equal(imported.statusCode, 201, imported.body);
    const importedId = (imported.json() as { id: string }).id;
    const original = await request('/api/procurement/' + importedId + '/original'); assert.equal(original.statusCode, 200); assert.deepEqual(original.rawPayload, importedBytes);
    const expanded = await request('/api/procurement/' + importedId + '/export'); assert.equal(expanded.statusCode, 200, expanded.body); assert.equal(expanded.headers['content-type'], mime);
    const suggestion = await app.inject({ method: 'POST', url: '/api/procurement-template/import', headers: { ...headers(a.token), ...form.headers }, payload: form.payload }); assert.equal(suggestion.statusCode, 200, suggestion.body); assert.equal(suggestion.json().version, 1);
    assert.equal((await request('/api/procurement/' + importedId + '/original', b.token)).statusCode, 404);
    f.blobs.afterRead = key => { if (key.includes('/pictures/')) f.rpc.procurements.get(doc.id)!.value.document.lines[0].images = []; };
    assert.equal((await request(doc.lines[0].imageUrls[0])).statusCode, 404, '读取图片期间引用被删除必须失败');
    f.blobs.afterRead = undefined;
    assert.equal((await app.inject({ method: 'DELETE', url: '/api/procurement/' + doc.id, headers: headers(a.token), payload: { version: 3 } })).statusCode, 200);
    assert.equal((await request('/api/procurement/' + doc.id)).statusCode, 404);
    assert.ok(f.blobs.events.some(event => event.includes('/pictures/'))); assert.ok(f.blobs.events.some(event => event.includes('/procurement/')));
    assert.deepEqual(readdirSync(root), ['sqlite-forbidden']);
  } finally { await app.close(); }
});

test('异步鉴权完成后才生成限流键，同 IP 不同云会话互不占用整理配额', async () => {
  const f = fixture();
  const rules = new MarketService(repository, { enabled: () => false, extract: async () => { throw new Error('不调用模型'); } });
  const app = await createApp({ config, cloud: f.cloud, identity: { exchange: async code => code }, service: rules });
  try {
    const a = await login(app, 'rate-a'), b = await login(app, 'rate-b');
    const post = (token: string) => app.inject({ method: 'POST', url: '/api/extract', headers: headers(token), payload: { description: '杯子' } });
    let release!: () => void;
    f.rpc.authenticationGate = new Promise<void>(resolve => { release = resolve; });
    const pending = post(a.token);
    release(); assert.equal((await pending).statusCode, 202);
    f.rpc.authenticationGate = undefined;
    for (let i = 1; i < 10; i++) assert.equal((await post(a.token)).statusCode, 202);
    assert.equal((await post(a.token)).statusCode, 429);
    assert.equal((await post(b.token)).statusCode, 202);
    for (let i = 0; i < 8; i++) assert.equal((await login(app, 'ip-login-' + i)).token.length, 64);
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/wechat', headers: headers(b.token), payload: { code: 'limited' } })).statusCode, 429, '公开登录不使用业务 token 规避 IP 配额');
  } finally { await app.close(); }
});
