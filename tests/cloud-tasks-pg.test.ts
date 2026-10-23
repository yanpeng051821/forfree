import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { CloudDatabase, type CloudRpcClient, type CloudRpcParameters } from '../src/server/cloud-db';
import { CloudJobs } from '../src/server/cloud-jobs';
import { CloudUploadBroker, UploadRegistry } from '../src/server/workbook-upload';
import { WORKBOOK_MIME, parseJobRecord, type JobRecord } from '../src/server/cloud-tasks';
import type { BlobStore } from '../src/server/cloud-blobs';
import { AppError } from '../src/lib/errors';
import { CloudRecords } from '../src/server/cloud-records';
import { MarketService } from '../src/server/service';
import { applyProductOrganization, productFields } from '../src/server/product-organize';
import { emptyFields, type Product, type ProductFields } from '../src/lib/types';
import { defaultProcurementTemplate } from '../src/lib/procurement-template';
import { quotationExportMetadata } from '../src/lib/quotation-export';

const bin = '/opt/homebrew/bin';
const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
const tokenA = 'a'.repeat(64), tokenB = 'b'.repeat(64);
const migration = readFileSync(join(__dirname, '../cloudbase/migrations/20261018090000_huoji_cloud_tasks.sql'), 'utf8');

/** A fresh Unix-socket-only PG16 cluster. No existing server, dotenv, credentials or user data. */
class IsolatedPg implements CloudRpcClient {
  readonly root = mkdtempSync(join(tmpdir(), 'huoji-pg16-'));
  readonly env: NodeJS.ProcessEnv = { PATH: `${bin}:/usr/bin:/bin`, LANG: 'en_US.UTF-8', TMPDIR: tmpdir() };
  readonly args = ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-h', this.root, '-p', '55439', '-U', 'huoji_test', '-d', 'postgres'];
  failFinish = false;
  private started = false;
  private command(name: string, args: string[]) {
    const output = spawnSync(join(bin, name), args, { env: this.env, encoding: 'utf8' });
    if (output.error) throw output.error;
    assert.equal(output.status, 0, output.stderr + output.stdout);
    return output.stdout;
  }
  async start() {
    assert.match(this.command('pg_ctl', ['--version']), /PostgreSQL\) 16\./);
    this.command('initdb', ['-D', join(this.root, 'data'), '-U', 'huoji_test', '-A', 'trust', '--no-locale', '-E', 'UTF8']);
    this.command('pg_ctl', ['-D', join(this.root, 'data'), '-l', join(this.root, 'postgres.log'), '-o', `-k ${this.root} -p 55439 -c listen_addresses='' -c fsync=off`, '-w', 'start']);
    this.started = true;
    await this.sql(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA auth; CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS
      $$ SELECT current_setting('request.jwt.claim.role',true) $$;
      GRANT USAGE ON SCHEMA auth TO service_role,anon,authenticated;
      CREATE TABLE public.huoji_health_fixture(value text PRIMARY KEY); INSERT INTO public.huoji_health_fixture VALUES('preserve');`);
    const core = readFileSync(join(__dirname, '../cloudbase/migrations/20261017030424_huoji_core.sql'), 'utf8');
    await this.sql(core.replace('UPDATE public.huoji_media photo_row SET product_id = command.id', 'UPDATE public.huoji_media m SET product_id = id').replace('WHERE photo_row.owner_id = p_owner AND photo_row.id = photo.photo_id', 'WHERE m.owner_id = p_owner AND m.id = photo.photo_id'));
    const repair = readFileSync(join(__dirname, '../cloudbase/migrations/20261018091500_huoji_photo_attachment.sql'), 'utf8');
    await this.sql(repair); await this.sql(repair);
  }
  stop() {
    try { if (this.started) this.command('pg_ctl', ['-D', join(this.root, 'data'), '-m', 'immediate', '-w', 'stop']); }
    finally { rmSync(this.root, { recursive: true, force: true }); }
  }
  sql(sql: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(join(bin, 'psql'), this.args, { env: this.env });
      let stdout = '', stderr = '';
      child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr)));
      child.stdin.end(sql);
    });
  }
  async raw(operation: string, owner: string | null, token: string | null, payload: unknown, role = 'service_role'): Promise<unknown> {
    const output = await this.sql(`BEGIN; SET LOCAL ROLE ${role};
      SELECT set_config('request.jwt.claim.role',${quote(role)},true);
      SELECT public.huoji_command(${quote(operation)},${owner === null ? 'NULL' : quote(owner)},${token === null ? 'NULL' : quote(token)},${quote(JSON.stringify(payload))}::jsonb); COMMIT;`);
    return JSON.parse(output.split('\n').at(-1) ?? 'null');
  }
  async rpc(_name: 'huoji_command', parameters: CloudRpcParameters) {
    if (this.failFinish && parameters.p_operation === 'job/finish') return { data: null, error: { code: 'NETWORK' } };
    return { data: await this.raw(parameters.p_operation, parameters.p_owner, parameters.p_token_hash, parameters.p_payload), error: null };
  }
}
class Blobs implements BlobStore {
  readonly values = new Map<string, Buffer>();
  readonly signed: string[] = [];
  afterRead?: (key: string) => Promise<void>;
  async write(key: string, bytes: Uint8Array) { this.values.set(key, Buffer.from(bytes)); }
  async read(key: string) { const bytes = this.values.get(key); if (!bytes) throw new AppError('NOT_FOUND', '文件不存在', 404); await this.afterRead?.(key); return bytes; }
  async remove(key: string) { this.values.delete(key); }
  async info(key: string) { return { size: (await this.read(key)).length, mime: key.endsWith('.jpg') ? 'image/jpeg' : WORKBOOK_MIME, etag: 'test' }; }
  async signUpload(key: string) { return { method: 'PUT' as const, url: 'https://test.invalid/upload', headers: {}, expiresAt: new Date(Date.now() + 60_000).toISOString() }; }
  async signDownload(key: string) { this.signed.push(key); return { url: 'https://test.invalid/download', expiresAt: new Date(Date.now() + 60_000).toISOString() }; }
}
function errorCode(code: string) { return (error: unknown) => error instanceof AppError && error.code === code; }
async function settle(jobs: CloudJobs, owner: string, jobId: string) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const record = await jobs.get(owner, jobId);
    if (record.state === 'succeeded' || record.state === 'failed') return record;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Job did not settle');
}

test('isolated PG16 executes task migration, preserved core, permissions, CAS, expiry and import/export', { timeout: 60_000 }, async t => {
  const pg = new IsolatedPg();
  try {
    await pg.start();
    const db = new CloudDatabase(pg);
    const login = async (subject: string, tokenHash: string) => db.call('login', null, null, { subject, tokenHash, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), cloudEncrypted: null });
    const a = await login('fixture-alice', tokenA), b = await login('fixture-bob', tokenB);
    const project = await db.call('projects/create', a.owner, tokenA, { name: 'preserve project', market: '', date: '2026-10-18', requestKey: randomUUID(), digest: '0'.repeat(64) });
    await t.test('real PG attaches staged photos, retries and preserves another product', async () => {
      const photoId = randomUUID(), secondPhotoId = randomUUID();
      await db.call('media/stage', a.owner, tokenA, { id: photoId, objectKey: a.owner+'/photos/'+photoId+'.jpg', name:'first.jpg' });
      await db.call('media/stage', a.owner, tokenA, { id: secondPhotoId, objectKey: a.owner+'/photos/'+secondPhotoId+'.jpg', name:'second.jpg' });
      const fields = { name:'test cup', unitPrice:12, currency:'CNY' };
      const command = { projectId:project.id, requestKey:randomUUID(), fields, photoIds:[photoId], digest:'0'.repeat(64) };
      const result = await db.call('product/save', a.owner, tokenA, command as never);
      assert.equal(result!.photos.length,1);
      assert.equal((await db.call('product/save', a.owner, tokenA, command as never))!.id,result!.id);
      const other = await db.call('product/save', a.owner, tokenA, { ...command,requestKey:randomUUID(),photoIds:[secondPhotoId] } as never);
      assert.equal(other!.photos.length,1);
      assert.equal((await db.call('product/get', a.owner, tokenA,{id:result!.id})).photos.length,1);
    });
    const originalBody = await pg.sql("SELECT prosrc FROM pg_proc WHERE oid = 'public.huoji_command(text,text,text,jsonb)'::regprocedure");
    const snapshot = () => pg.sql("SELECT jsonb_build_object('users',(SELECT jsonb_agg(to_jsonb(u) ORDER BY id) FROM public.huoji_users u),'sessions',(SELECT jsonb_agg(to_jsonb(s) ORDER BY token_hash) FROM public.huoji_sessions s),'projects',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.huoji_projects p),'health',(SELECT jsonb_agg(to_jsonb(h)) FROM public.huoji_health_fixture h))");
    const before = await snapshot();
    await pg.sql(migration);
    await pg.sql(migration);
    assert.equal(await snapshot(), before);
    assert.equal(await pg.sql("SELECT prosrc FROM pg_proc WHERE oid = 'public.huoji_command_core_20261018(text,text,text,jsonb)'::regprocedure"), originalBody);
    const modelCas = readFileSync(join(__dirname, '../cloudbase/migrations/20261018164500_huoji_model_session_cas.sql'), 'utf8');
    const withoutCas = (await pg.sql("SELECT pg_get_functiondef('public.huoji_command_core_20261018(text,text,text,jsonb)'::regprocedure)")).replace("      IF p_payload ? 'expectedEncrypted' AND s.cloud_encrypted IS DISTINCT FROM p_payload->>'expectedEncrypted' THEN\n        PERFORM public.huoji_fail('MODEL_SESSION_CHANGED','AI登录已更新，请重试整理',409);\n      END IF;", '');
    await pg.sql(withoutCas);
    await pg.sql(modelCas); await pg.sql(modelCas);
    assert.equal(await snapshot(), before);
    await t.test('model session CAS rejects stale writes and preserves the current credentials', async () => {
      const hash = 'd'.repeat(64), old = Buffer.alloc(40, 1).toString('base64'), fresh = Buffer.alloc(40, 2).toString('base64');
      const account = await db.call('login', null, null, { subject:'fixture-cas',tokenHash:hash,expiresAt:new Date(Date.now()+3600000).toISOString(),cloudEncrypted:old });
      await assert.rejects(db.call('cloudSessionSave',account.owner,hash,{encrypted:fresh,expectedEncrypted:old,deadlineAt:new Date(Date.now()-1000).toISOString()}),errorCode('MODEL_RECOVERY_TIMEOUT'));
      assert.equal((await db.call('cloudSessionLoad',account.owner,hash,{})).encrypted,old);
      await db.call('cloudSessionSave', account.owner, hash, { encrypted:fresh,expectedEncrypted:old });
      await assert.rejects(db.call('cloudSessionSave',account.owner,hash,{encrypted:old,expectedEncrypted:old}),errorCode('MODEL_SESSION_CHANGED'));
      assert.equal((await db.call('cloudSessionLoad',account.owner,hash,{})).encrypted,fresh);
      await db.call('sessionRevoke',account.owner,hash,{});
      await assert.rejects(db.call('cloudSessionSave',account.owner,hash,{encrypted:old,expectedEncrypted:fresh}),errorCode('LOGIN_REQUIRED'));
    });
    assert.equal((await db.call('projects/get', a.owner, tokenA, { id: project.id })).name, 'preserve project');
    assert.deepEqual(await db.health(), { healthy: true });
    await t.test('ACL, RLS and owner/session checks', async () => {
      for (const role of ['anon', 'authenticated']) {
        await assert.rejects(() => pg.raw('job/get', a.owner, tokenA, { jobId: randomUUID() }, role), /permission denied/);
      }
      for (const role of ['anon', 'authenticated', 'service_role']) {
        await assert.rejects(() => pg.sql(`SET ROLE ${role}; SELECT * FROM public.huoji_jobs;`), /permission denied/);
        await assert.rejects(() => pg.sql(`SET ROLE ${role}; SELECT public.huoji_command_core_20261018('health',NULL,NULL,'{}');`), /permission denied/);
      }
      assert.equal(await pg.sql("SELECT bool_and(relrowsecurity) FROM pg_class WHERE relname IN ('huoji_jobs','huoji_uploads')"), 't');
      await assert.rejects(() => db.call('job/create', a.owner, tokenB, { jobId: randomUUID(), kind: 'extraction', state: 'pending', input: {} }), errorCode('LOGIN_REQUIRED'));
    });
    const create = async () => parseJobRecord(await db.call('job/create', a.owner, tokenA, { jobId: randomUUID(), kind: 'extraction', state: 'pending', input: {} }));
    const claim = async (job: JobRecord, runToken = randomUUID()) => ({ record: await db.call('job/start', a.owner, tokenA, { jobId: job.jobId, expectedVersion: job.version, runToken }), runToken });
    const result = JSON.stringify({ fields: { name: '杯子', unitPrice: 12, currency: 'CNY' }, mode: 'model', warning: '请核对' });
    await t.test('job create/read isolation, concurrent claim CAS and immutable terminal receipt', async () => {
      const job = await create();
      assert.equal(job.state, 'pending');
      await assert.rejects(() => db.call('job/get', b.owner, tokenB, { jobId: job.jobId }), errorCode('NOT_FOUND'));
      await assert.rejects(() => db.call('job/create', b.owner, tokenB, { jobId: job.jobId, kind: 'extraction', state: 'pending', input: {} }), errorCode('NOT_FOUND'));
      const raced = await Promise.allSettled([claim(job), claim(job)]);
      assert.equal(raced.filter(x => x.status === 'fulfilled').length, 1);
      const winner = raced.find(x => x.status === 'fulfilled');
      assert.ok(winner && winner.status === 'fulfilled');
      const { runToken, record } = winner.value;
      const finish = { jobId: job.jobId, expectedVersion: record.version, runToken, state: 'succeeded' as const, resultReference: result, error: null };
      await assert.rejects(() => db.call('job/finish', b.owner, tokenB, finish), errorCode('NOT_FOUND'));
      await assert.rejects(() => db.call('job/finish', a.owner, tokenA, { ...finish, runToken: randomUUID() }), errorCode('CONFLICT'));
      const finished = await db.call('job/finish', a.owner, tokenA, finish);
      assert.equal(finished.state, 'succeeded');
      assert.equal(finished.version, 2);
      assert.deepEqual(await db.call('job/finish', a.owner, tokenA, finish), finished);
      await assert.rejects(() => db.call('job/finish', a.owner, tokenA, { ...finish, resultReference: result.replace('杯子', '其他') }), errorCode('CONFLICT'));
      assert.ok(!JSON.stringify(finished).includes(runToken));
      assert.ok(!('input' in finished));
    });
    await t.test('extraction result/input validation rejects binary, unknown fields and invalid primitives', async () => {
      const job = await create(), running = await claim(job);
      for (const invalid of ['null', '{', JSON.stringify({ fields: { photos: ['bytes'] }, mode: 'model', warning: '' }), JSON.stringify({ fields: { unitPrice: -1 }, mode: 'model', warning: '' }), JSON.stringify({ fields: [], mode: 'model', warning: '' }), JSON.stringify({ fields: {}, mode: 'other', warning: '' }), JSON.stringify({ fields: {}, mode: 'model', warning: '', trace: 'secret' })]) {
        await assert.rejects(() => db.call('job/finish', a.owner, tokenA, { jobId: job.jobId, expectedVersion: running.record.version, runToken: running.runToken, state: 'succeeded', resultReference: invalid, error: null }), errorCode('VALIDATION'));
      }
      const invalidInput = await pg.raw('job/create', a.owner, tokenA, { jobId: randomUUID(), kind: 'extraction', state: 'pending', input: { description: 'must not persist' } });
      assert.deepEqual(invalidInput, { ok: false, error: { code: 'VALIDATION', message: '整理任务不能存原始输入', status: 400 } });
    });
    await t.test('failed result requires safe error and is immutable with replay', async () => {
      const job = await create(), running = await claim(job);
      const finish = { jobId: job.jobId, expectedVersion: running.record.version, runToken: running.runToken,
        state: 'failed' as const, resultReference: null, error: { code: 'JOB_FAILED', message: '任务执行失败' } };
      const failed = await db.call('job/finish', a.owner, tokenA, finish);
      assert.equal(failed.state, 'failed'); assert.equal(failed.resultReference, null);
      assert.deepEqual(await db.call('job/finish', a.owner, tokenA, finish), failed);
      await assert.rejects(() => db.call('job/finish', a.owner, tokenA, { ...finish, error: { code: 'DIFFERENT', message: '变化' } }), errorCode('CONFLICT'));
      await assert.rejects(() => db.call('job/finish', a.owner, tokenA, { ...finish, error: null }), errorCode('VALIDATION'));
    });
    await t.test('pending and running deadlines persist failed state and fence late finish', async () => {
      for (const running of [false, true]) {
        const job = await create(); const claimed = running ? await claim(job) : null;
        await pg.sql(`UPDATE public.huoji_jobs SET expires_at = clock_timestamp() - interval '1 second' WHERE job_id = ${quote(job.jobId)}`);
        const expired = await db.call('job/get', a.owner, tokenA, { jobId: job.jobId });
        assert.equal(expired.state, 'failed'); assert.equal(expired.error?.code, 'JOB_EXPIRED');
        if (claimed) await assert.rejects(() => db.call('job/finish', a.owner, tokenA, { jobId: job.jobId, expectedVersion: claimed.record.version, runToken: claimed.runToken, state: 'succeeded', resultReference: result, error: null }), errorCode('CONFLICT'));
        assert.equal(await pg.sql(`SELECT state FROM public.huoji_jobs WHERE job_id = ${quote(job.jobId)}`), 'failed');
      }
    });
    const blobs = new Blobs();
    const broker = (owner = a.owner, tokenHash = tokenA) => new CloudUploadBroker(db, blobs, { owner, tokenHash }, new UploadRegistry());
    const jobs = (owner = a.owner, tokenHash = tokenA) => new CloudJobs(db, blobs, broker(owner, tokenHash), { owner, tokenHash });
    await t.test('trash migration is idempotent, hides selected records, preserves dates and photos on restore, and rejects stale or foreign edits',async()=>{
      const sql=readFileSync(join(__dirname,'../cloudbase/migrations/20261018194000_huoji_product_trash.sql'),'utf8');await pg.sql(sql);await pg.sql(sql);
      await pg.sql(`SELECT public.huoji_check_extraction('${JSON.stringify({fields:{cartons:2,quantity:48,barcode:'000012',exportRemarks:'客户标签'},mode:'model',warning:'请核对'})}')`);
      await assert.rejects(pg.sql(`SELECT public.huoji_check_extraction('${JSON.stringify({fields:{quantity:1.5},mode:'model',warning:'请核对'})}')`));
      const records=new CloudRecords(db,blobs,{owner:a.owner,tokenHash:tokenA}),photoId=randomUUID();
      await db.call('media/stage',a.owner,tokenA,{id:photoId,objectKey:a.owner+'/photos/'+photoId+'.jpg',name:'synthetic.jpg'});blobs.values.set(a.owner+'/photos/'+photoId+'.jpg',Buffer.from('fixture'));
      const value=await records.saveProduct(a.owner,{requestKey:randomUUID(),projectId:project.id,fields:{...emptyFields,name:'回收演示',custom:{client_ref:'00012'},quantity:48,cartons:2,cartonQty:24},photoIds:[photoId]});
      const before=(await records.pageProducts(a.owner,project.id,undefined,100)).summary.total;
      const moved=await records.trashProduct(a.owner,value.id,value.version);assert.ok(moved.deletedAt);assert.equal(moved.createdAt,value.createdAt);assert.equal(moved.projectId,value.projectId);assert.equal(moved.photos[0].id,photoId);
      assert.equal((await records.pageProducts(a.owner,project.id,undefined,100)).summary.total,before-1);assert.ok(!(await records.recordsForExport(a.owner,project.id)).some(p=>p.id===value.id));assert.equal((await records.pageTrash(a.owner,undefined,1)).items[0].id,value.id);
      await assert.rejects(records.saveProduct(a.owner,{requestKey:randomUUID(),id:value.id,projectId:project.id,version:moved.version,fields:{...emptyFields,name:'不能编辑'},photoIds:[]}),errorCode('PRODUCT_TRASHED'));
      await assert.rejects(records.trashProduct(b.owner,value.id,moved.version,true),errorCode('LOGIN_REQUIRED'));
      await assert.rejects(records.trashProduct(a.owner,value.id,value.version,true),errorCode('CONFLICT'));
      const restored=await records.trashProduct(a.owner,value.id,moved.version,true);assert.equal(restored.deletedAt,null);assert.equal(restored.createdAt,value.createdAt);assert.equal(restored.custom.client_ref,'00012');assert.equal(restored.photos[0].id,photoId);assert.equal((await records.pageProducts(a.owner,project.id,undefined,100)).summary.total,before);
      const again=await records.trashProduct(a.owner,value.id,restored.version);await records.deleteProduct(a.owner,value.id,again.version);await assert.rejects(records.getProduct(a.owner,value.id),errorCode('NOT_FOUND'));assert.equal((await records.pageTrash(a.owner,undefined,30)).matchedCount,0);
    });
    await t.test('real PG persists background organization and rejects a result after a manual edit',async()=>{
      const context={owner:a.owner,tokenHash:tokenA},records=new CloudRecords(db,blobs,context);
      let editing=false;
      const model={enabled:()=>true,extract:async()=>{
        if(editing){const latest=await records.getProduct(a.owner,queued.id);await records.saveProduct(a.owner,{requestKey:randomUUID(),id:latest.id,projectId:latest.projectId,version:latest.version,fields:{...productFields(latest),name:'人工改名'},photoIds:[]});}
        return {fields:{name:'图文杯子',supplier:'合成商户',supplierContact:'合成联系人',notes:'待确认包装',unitPrice:12},mode:'model' as const,warning:'请核对'};
      }};
      const service=new MarketService(records,model);
      const create=()=>records.saveProduct(a.owner,{requestKey:randomUUID(),projectId:project.id,fields:{...emptyFields,name:'未命名商品',description:'合成现场文字'},photoIds:[]});
      let product=await create(),queued=await records.saveProduct(a.owner,{requestKey:randomUUID(),id:product.id,projectId:project.id,version:product.version,fields:Object.assign(productFields(product),{organizeState:'queued',organizeJobId:randomUUID()}),photoIds:[]});
      const job=await jobs().startExtraction(a.owner,{description:queued.description,photoIds:[]},checkpoint=>applyProductOrganization(service,a.owner,queued,context,checkpoint),undefined,queued.organizeJobId);
      assert.equal((await settle(jobs(),a.owner,job.jobId)).state,'succeeded');
      const saved=await records.getProduct(a.owner,product.id);assert.equal(saved.organizeState,'done');assert.equal(saved.supplierContact,'合成联系人');assert.equal(saved.notes,'待确认包装');assert.equal(saved.description,'合成现场文字');
      editing=true;product=await create();queued=await records.saveProduct(a.owner,{requestKey:randomUUID(),id:product.id,projectId:project.id,version:product.version,fields:Object.assign(productFields(product),{organizeState:'queued',organizeJobId:randomUUID()}),photoIds:[]});
      const conflicted=await jobs().startExtraction(a.owner,{description:queued.description,photoIds:[]},checkpoint=>applyProductOrganization(service,a.owner,queued,context,checkpoint),undefined,queued.organizeJobId);
      assert.equal((await settle(jobs(),a.owner,conflicted.jobId)).state,'failed');
      const manual=await records.getProduct(a.owner,product.id);assert.equal(manual.name,'人工改名');assert.equal(manual.unitPrice,null);
    });
    await t.test('uploads recover across brokers, isolation, commit/abandon CAS and expiry', async () => {
      const first = broker();
      const grant = await first.prepare(a.owner, { kind: 'workbook', filename: '采购.xlsx', sizeBytes: 16, contentType: WORKBOOK_MIME });
      blobs.values.set(grant.objectKey, Buffer.alloc(16));
      await assert.rejects(() => broker(b.owner, tokenB).commit(b.owner, grant.uploadId, 16), errorCode('UPLOAD_NOT_FOUND'));
      assert.equal((await broker().ticket(a.owner, grant.uploadId)).objectKey, grant.objectKey);
      await broker().commit(a.owner, grant.uploadId, 16);
      assert.equal((await broker().committed(a.owner, grant.objectKey)).state, 'committed');
      await assert.rejects(() => first.abandon(a.owner, grant.uploadId), errorCode('CONFLICT'));
      await assert.rejects(() => jobs().startWorkbookImport(a.owner, grant.objectKey.replace('/uploads/', '/exports/'), 'x.xlsx'), errorCode('UPLOAD_NOT_COMMITTED'));
      await pg.sql(`UPDATE public.huoji_uploads SET expires_at = clock_timestamp() - interval '1 second' WHERE upload_id = ${quote(grant.uploadId)}`);
      assert.equal((await broker().committed(a.owner, grant.objectKey)).state, 'committed');
      const race = await first.prepare(a.owner, { kind: 'workbook', filename: '竞争.xlsx', sizeBytes: 16, contentType: WORKBOOK_MIME });
      const results = await Promise.allSettled([
        db.call('upload/commit', a.owner, tokenA, { uploadId: race.uploadId, sizeBytes: 16, sha256: null }),
        db.call('upload/abandon', a.owner, tokenA, { uploadId: race.uploadId, reason: 'race' }),
      ]);
      assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
      const rejected = results.find(value => value.status === 'rejected');
      assert.ok(rejected && rejected.status === 'rejected' && errorCode('CONFLICT')(rejected.reason));
      const exp = await first.prepare(a.owner, { kind: 'workbook', filename: '过期.xlsx', sizeBytes: 16, contentType: WORKBOOK_MIME });
      await pg.sql(`UPDATE public.huoji_uploads SET expires_at = clock_timestamp() - interval '1 second' WHERE upload_id = ${quote(exp.uploadId)}`);
      await assert.rejects(() => db.call('upload/commit', a.owner, tokenA, { uploadId: exp.uploadId, sizeBytes: 16, sha256: null }), errorCode('UPLOAD_EXPIRED'));
      assert.equal(await pg.sql(`SELECT state FROM public.huoji_uploads WHERE upload_id = ${quote(exp.uploadId)}`), 'abandoned');
    });
    await t.test('extraction survives new CloudJobs instance; invalid read never returns succeeded', async () => {
      const started = await jobs().startExtraction(a.owner, { description: '杯子', photoIds: [] }, async () => ({ fields: { name: '杯子' }, mode: 'model', warning: '', estimates: ['unitPrice', 'cartonQty'] }));
      const finished = await settle(jobs(), a.owner, started.jobId);
      assert.equal(finished.state, 'succeeded'); assert.deepEqual(finished.result?.fields, { name: '杯子' });
      assert.deepEqual(finished.result?.estimates, ['unitPrice', 'cartonQty']);
      const persisted = await db.call('job/get', a.owner, tokenA, { jobId: started.jobId });
      assert.deepEqual(JSON.parse(persisted.resultReference!).estimates, ['unitPrice', 'cartonQty']);
      await pg.sql(`UPDATE public.huoji_jobs SET result_reference = 'null' WHERE job_id = ${quote(started.jobId)}`);
      await assert.rejects(() => jobs().get(a.owner, started.jobId), errorCode('DB_RESPONSE_INVALID'));
    });
    await t.test('finish outage yields no memory success and expires persistently', async () => {
      pg.failFinish = true;
      const instance = jobs();
      const started = await instance.startExtraction(a.owner, { description: '杯子', photoIds: [] }, async () => ({ fields: { name: '杯子' }, mode: 'model', warning: '' }));
      for (let i = 0; i < 50; i++) {
        if ((await instance.get(a.owner, started.jobId)).state === 'running') break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.equal((await instance.get(a.owner, started.jobId)).state, 'running');
      assert.equal((await jobs().get(a.owner, started.jobId)).state, 'running');
      pg.failFinish = false;
      await pg.sql(`UPDATE public.huoji_jobs SET expires_at = clock_timestamp() - interval '1 second' WHERE job_id = ${quote(started.jobId)}`);
      assert.equal((await instance.get(a.owner, started.jobId)).error?.code, 'JOB_EXPIRED');
    });
    await t.test('real SQL import/export round trip and owner-safe download', async () => {
      const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('商户A');
      sheet.getRow(1).values = ['REF', 'CTNS', 'PCS/CTN', 'QTY', 'PRICE(RMB)', 'AMOUNT', 'DESCRIPTION'];
      sheet.getRow(2).values = ['A1', 2, 12, 24, 10.5, 252, '陶瓷杯'];
      const bytes = Buffer.from(await book.xlsx.writeBuffer());
      const upload = await broker().prepare(a.owner, { kind: 'workbook', filename: '采购.xlsx', sizeBytes: bytes.length, contentType: WORKBOOK_MIME });
      blobs.values.set(upload.objectKey, bytes);
      await broker().commit(a.owner, upload.uploadId, bytes.length);
      const importing = await jobs().startWorkbookImport(a.owner, upload.objectKey, '采购.xlsx');
      const imported = await settle(jobs(), a.owner, importing.jobId);
      assert.equal(imported.state, 'succeeded', JSON.stringify(imported)); assert.ok(imported.procurementId);
      await assert.rejects(() => jobs(b.owner, tokenB).startWorkbookExport(b.owner, imported.procurementId!), errorCode('NOT_FOUND'));
      const exporting = await jobs().startWorkbookExport(a.owner, imported.procurementId);
      const exported = await settle(jobs(), a.owner, exporting.jobId);
      assert.equal(exported.state, 'succeeded', JSON.stringify(exported));
      await jobs().download(a.owner, exporting.jobId);
      assert.equal(blobs.signed.length, 1); assert.ok(blobs.signed[0].startsWith(`${a.owner}/exports/`));
      await assert.rejects(() => jobs(b.owner, tokenB).download(b.owner, exporting.jobId), errorCode('NOT_FOUND'));
      const output = new ExcelJS.Workbook(); await output.xlsx.load(new Uint8Array(await blobs.read(blobs.signed[0])).buffer);
      assert.ok(output.worksheets.length > 0);
    });
    await t.test('product-export scope validation, exports path, byte download and post-read revalidation', async () => {
      const book = new ExcelJS.Workbook(); book.addWorksheet('选品').addRow(['杯子']);
      const bytes = Buffer.from(await book.xlsx.writeBuffer());
      const instance = jobs();
      const started = await instance.startProductExport(a.owner, { projectId: project.id, scope: 'confirmed', audience: 'selection', images: false, favorite: true, date: '2026-10-18' }, async () => bytes);
      const completed = await settle(jobs(), a.owner, started.jobId);
      assert.equal(completed.kind, 'product-export'); assert.equal(completed.state, 'succeeded');
      assert.equal(completed.result, null); assert.equal(completed.procurementId, null);
      assert.deepEqual(await instance.downloadFile(a.owner, started.jobId), bytes);
      await assert.rejects(() => jobs(b.owner, tokenB).downloadFile(b.owner, started.jobId), errorCode('NOT_FOUND'));
      await assert.rejects(() => instance.startProductExport(a.owner, {}, async () => bytes), errorCode('VALIDATION'));
      await assert.rejects(() => instance.startProductExport(a.owner, { date: '2026-02-30' }, async () => bytes), errorCode('VALIDATION'));
      await assert.rejects(() => instance.startProductExport(a.owner, { projectId: randomUUID() }, async () => bytes), errorCode('NOT_FOUND'));
      for (const invalid of [{}, { favorite: false }, { date: '2026-02-30' }, { favorite: true, images: 'yes' }, { favorite: true, audience: 'unknown' }, { favorite: true, photoBytes: 'secret' }]) {
        const envelope = await pg.raw('job/create', a.owner, tokenA, { jobId: randomUUID(), kind: 'product-export', state: 'pending', input: invalid });
        assert.ok(envelope && typeof envelope === 'object' && 'ok' in envelope && envelope.ok === false, JSON.stringify(envelope));
      }
      const dateOnly = await instance.startProductExport(a.owner, { date: '2026-10-18', audience: 'internal' }, async () => bytes);
      assert.equal((await settle(jobs(), a.owner, dateOnly.jobId)).state, 'succeeded');
      const failed = await instance.startProductExport(a.owner, { favorite: true }, async () => { throw new AppError('UPSTREAM_FAILURE', 'internal secret', 502); });
      const failure = await settle(jobs(), a.owner, failed.jobId);
      assert.equal(failure.error?.code, 'JOB_FAILED'); assert.ok(!JSON.stringify(failure).includes('internal secret'));
      await assert.rejects(() => instance.downloadFile(a.owner, failed.jobId), errorCode('NOT_FOUND'));
      blobs.afterRead = async () => {
        await pg.sql(`UPDATE public.huoji_jobs SET result_reference = ${quote(a.owner + '/exports/' + randomUUID() + '.xlsx')},version = version + 1 WHERE job_id = ${quote(started.jobId)}`);
      };
      try { await assert.rejects(() => instance.downloadFile(a.owner, started.jobId), errorCode('CONFLICT')); }
      finally { blobs.afterRead = undefined; }
    });
    await t.test('late product export runner cannot write a blob after deadline', async () => {
      let release: (value: Buffer) => void = () => { throw new Error('runner not started'); };
      const bytes = new Promise<Buffer>(resolve => { release = resolve; });
      const instance = jobs();
      const started = await instance.startProductExport(a.owner, { favorite: true }, () => bytes);
      for (let i = 0; i < 50; i++) {
        if ((await instance.get(a.owner, started.jobId)).state === 'running') break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      const before = blobs.values.size;
      await pg.sql(`UPDATE public.huoji_jobs SET expires_at = clock_timestamp() - interval '1 second' WHERE job_id = ${quote(started.jobId)}`);
      release(Buffer.from('late export'));
      assert.equal((await settle(instance, a.owner, started.jobId)).state, 'failed');
      assert.equal(blobs.values.size, before);
    });
    await t.test('download byte reread denies session revoked while reading blob', async () => {
      const c = await login('fixture-charlie', 'c'.repeat(64));
      const instance = jobs(c.owner, 'c'.repeat(64));
      const started = await instance.startProductExport(c.owner, { favorite: true }, async () => Buffer.from('xlsx fixture'));
      await settle(instance, c.owner, started.jobId);
      blobs.afterRead = async () => { await db.call('sessionRevoke', c.owner, 'c'.repeat(64), {}); };
      try { await assert.rejects(() => instance.downloadFile(c.owner, started.jobId), errorCode('LOGIN_REQUIRED')); }
      finally { blobs.afterRead = undefined; }
    });
    await pg.sql(migration);
    assert.equal((await db.call('projects/get', a.owner, tokenA, { id: project.id })).name, 'preserve project');
  } finally { pg.stop(); }
});

test('isolated PG16 merchant migration preserves data and scopes aggregates, pages and export jobs', { timeout: 60_000 }, async t => {
  const pg = new IsolatedPg();
  try {
    await pg.start();
    await pg.sql(migration);
    await pg.sql(readFileSync(join(__dirname, '../cloudbase/migrations/20261018194000_huoji_product_trash.sql'), 'utf8'));
    const db = new CloudDatabase(pg), blobs = new Blobs();
    const login = (subject: string, tokenHash: string) => db.call('login', null, null, {
      subject, tokenHash, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), cloudEncrypted: null,
    });
    const a = await login('merchant-fixture-alice', tokenA), b = await login('merchant-fixture-bob', tokenB);
    const records = new CloudRecords(db, blobs, { owner: a.owner, tokenHash: tokenA });
    const foreignRecords = new CloudRecords(db, blobs, { owner: b.owner, tokenHash: tokenB });
    const task = await records.createProject(a.owner, { name: '合成任务一', market: '', date: '2026-10-01' }, randomUUID());
    const otherTask = await records.createProject(a.owner, { name: '合成任务二', market: '', date: '2026-10-02' }, randomUUID());
    const foreignTask = await foreignRecords.createProject(b.owner, { name: '合成他人任务', market: '', date: '2026-10-18' }, randomUUID());
    const day = '2026-10-18', shop = '同名商家', similarShop = '同名商家分店';
    const fixture: (Product & { owner: string })[] = [];
    const add = (projectId: string, sku: string, supplier: string, patch: Partial<ProductFields> = {}, at = '2026-10-18T04:00:00.000Z', owner = a.owner, deletedAt: string | null = null) => {
      const product = { ...emptyFields, name: sku, sku, supplier, supplierContact: supplier ? '合成联系人' : '',
        unitPrice: 1.2345, cartons: 3, cartonQty: 12, cartonCbm: .012345, ...patch,
        id: randomUUID(), projectId, version: 1, createdAt: at, updatedAt: at, photos: [], deletedAt, owner };
      fixture.push(product); return product;
    };
    const primary = Array.from({ length: 36 }, (_, index) => add(task.id, 'A-' + index, shop,
      { confirmed: index % 2 === 0, favorite: index % 4 === 0, unitPrice: index % 3 === 0 ? null : 1.2345, ...(index === 1 ? { quantity: 7 } : {}) },
      index === 0 ? '2026-10-17T16:00:00.000Z' : index === 35 ? '2026-10-18T15:59:59.999Z' : undefined));
    const crossTask = [add(otherTask.id, 'A-cross-1', shop, { confirmed: true, favorite: true }), add(otherTask.id, 'A-cross-2', shop, { unitPrice: null })];
    const similar = [add(task.id, 'similar-1', similarShop, { name: shop + ' 搜索命中', currency: 'USD', confirmed: true }), add(otherTask.id, 'similar-2', similarShop, { currency: 'USD' })];
    const unnamed = [add(task.id, 'unnamed-1', '', { currency: 'EUR', confirmed: true }), add(otherTask.id, 'unnamed-2', '', { currency: 'EUR', unitPrice: null })];
    const discarded = add(task.id, 'discarded', shop, { currency: 'USD', confirmed: true }, undefined, a.owner, '2026-10-18T08:00:00.000Z');
    add(task.id, 'previous-day', shop, { currency: 'USD' }, '2026-10-17T15:59:59.999Z');
    add(task.id, 'next-day', shop, { currency: 'EUR' }, '2026-10-18T16:00:00.000Z');
    const foreign = add(foreignTask.id, 'foreign', shop, { currency: 'USD' }, undefined, b.owner);
    await pg.sql(fixture.map(product => {
      const fields = Object.fromEntries(Object.keys(emptyFields).map(key => [key, product[key as keyof ProductFields]]));
      return `INSERT INTO public.huoji_products(id,owner_id,project_id,fields,created_at,updated_at,deleted_at) VALUES (${quote(product.id)},${quote(product.owner)},${quote(product.projectId)},${quote(JSON.stringify(fields))}::jsonb,${quote(product.createdAt)},${quote(product.updatedAt)},${product.deletedAt ? quote(product.deletedAt) : 'NULL'});`;
    }).join('\n'));
    const photoId = randomUUID();
    await pg.sql(`INSERT INTO public.huoji_media(id,owner_id,product_id,name,object_key) VALUES (${quote(photoId)},${quote(a.owner)},${quote(primary[1].id)},'synthetic.jpg',${quote(a.owner + '/photos/' + photoId + '.jpg')});`);
    const exact = [...primary, ...crossTask], activeDay = [...exact, ...similar, ...unnamed];
    const ids = (products: { id: string }[]) => products.map(product => product.id).sort();
    const expectedSummary = { total: 38, confirmed: 19, pending: 19, missingPrice: 13, suppliers: 1, photos: 1 };
    const merchantMigration = readFileSync(join(__dirname, '../cloudbase/migrations/20261018211500_huoji_merchant_scope.sql'), 'utf8');
    const snapshot = () => pg.sql(`SELECT jsonb_build_object(
      'users',(SELECT jsonb_agg(to_jsonb(v) ORDER BY id) FROM public.huoji_users v),
      'sessions',(SELECT jsonb_agg(to_jsonb(v) ORDER BY token_hash) FROM public.huoji_sessions v),
      'projects',(SELECT jsonb_agg(to_jsonb(v) ORDER BY id) FROM public.huoji_projects v),
      'products',(SELECT jsonb_agg(to_jsonb(v) ORDER BY id) FROM public.huoji_products v),
      'media',(SELECT jsonb_agg(to_jsonb(v) ORDER BY id) FROM public.huoji_media v),
      'receipts',(SELECT jsonb_agg(to_jsonb(v) ORDER BY owner_id,request_key) FROM public.huoji_receipts v),
      'health',(SELECT jsonb_agg(to_jsonb(v)) FROM public.huoji_health_fixture v))`);
    await t.test('latest migration applies twice without changing persisted rows or function definitions on replay', async () => {
      const before = await snapshot();
      await pg.sql(merchantMigration);
      const definitions = await pg.sql(`SELECT pg_get_functiondef('public.huoji_command_core_20261018(text,text,text,jsonb)'::regprocedure) || pg_get_functiondef('public.huoji_command(text,text,text,jsonb)'::regprocedure)`);
      await pg.sql(merchantMigration);
      assert.equal(await snapshot(), before);
      assert.equal(await pg.sql(`SELECT pg_get_functiondef('public.huoji_command_core_20261018(text,text,text,jsonb)'::regprocedure) || pg_get_functiondef('public.huoji_command(text,text,text,jsonb)'::regprocedure)`), definitions);
      assert.deepEqual(await db.health(), { healthy: true });
    });

    await t.test('exact merchant pages cross 30 rows with scope counts and cursor isolation', async () => {
      const first = await records.pageProducts(a.owner, undefined, undefined, 30, { date: day, supplier: shop });
      assert.equal(first.items.length, 30); assert.equal(first.matchedCount, 38); assert.ok(first.nextCursor);
      assert.deepEqual(first.summary, expectedSummary);
      const second = await records.pageProducts(a.owner, undefined, first.nextCursor, 30, { date: day, supplier: shop });
      assert.equal(second.items.length, 8); assert.equal(second.nextCursor, null); assert.equal(second.matchedCount, 38);
      assert.deepEqual(second.summary, expectedSummary); assert.deepEqual(ids([...first.items, ...second.items]), ids(exact));
      assert.equal(new Set([...first.items, ...second.items].map(p => p.id)).size, 38);
      const scoped = await records.pageProducts(a.owner, task.id, undefined, 100, { date: day, supplier: shop });
      assert.deepEqual(ids(scoped.items), ids(primary));
      assert.deepEqual(scoped.summary, { total: 36, confirmed: 18, pending: 18, missingPrice: 12, suppliers: 1, photos: 1 });
      for (const filter of [{ date: day, supplier: similarShop }, { date: day, supplier: '' }, { date: day }, { date: '2026-10-17', supplier: shop }, { date: day, supplier: shop, favorite: true }]) {
        await assert.rejects(records.pageProducts(a.owner, undefined, first.nextCursor, 30, filter), errorCode('INVALID_CURSOR'));
      }
      await assert.rejects(records.pageProducts(a.owner, task.id, first.nextCursor, 30, { date: day, supplier: shop }), errorCode('INVALID_CURSOR'));
      await assert.rejects(foreignRecords.pageProducts(b.owner, undefined, first.nextCursor, 30, { date: day, supplier: shop }), errorCode('INVALID_CURSOR'));
      await assert.rejects(foreignRecords.pageProducts(b.owner, task.id, undefined, 30, { supplier: shop }), errorCode('NOT_FOUND'));
      assert.deepEqual(ids((await foreignRecords.pageProducts(b.owner, undefined, undefined, 30, { date: day, supplier: shop })).items), [foreign.id]);
    });

    await t.test('empty merchant, text search, status and favorite filters preserve exact shop scope', async () => {
      const empty = await records.pageProducts(a.owner, undefined, undefined, 100, { date: day, supplier: '' });
      assert.deepEqual(ids(empty.items), ids(unnamed));
      assert.deepEqual(empty.summary, { total: 2, confirmed: 1, pending: 1, missingPrice: 1, suppliers: 0, photos: 0 });
      assert.deepEqual(ids((await records.pageProducts(a.owner, undefined, undefined, 100, { date: day })).items), ids(activeDay));
      assert.deepEqual(ids((await records.pageProducts(a.owner, undefined, undefined, 100, { date: day, supplier: shop, q: 'A-cross' })).items), ids(crossTask));
      const confirmed = await records.pageProducts(a.owner, undefined, undefined, 100, { date: day, supplier: shop, status: 'confirmed' });
      assert.equal(confirmed.matchedCount, 19); assert.deepEqual(confirmed.summary, expectedSummary);
      assert.deepEqual(ids(confirmed.items), ids(exact.filter(p => p.confirmed)));
      const missing = await records.pageProducts(a.owner, undefined, undefined, 100, { date: day, supplier: shop, status: 'missingPrice' });
      assert.deepEqual(ids(missing.items), ids(exact.filter(p => p.unitPrice === null)));
      const favorites = await records.pageProducts(a.owner, undefined, undefined, 100, { date: day, supplier: shop, favorite: true });
      assert.deepEqual(ids(favorites.items), ids(exact.filter(p => p.favorite))); assert.equal(favorites.summary.total, 10);
      for (const supplier of [null, 123, 'x'.repeat(201)]) {
        await assert.rejects(db.call('product/page', a.owner, tokenA, { date: day, limit: 30, supplier } as never), errorCode('VALIDATION'));
      }
    });

    await t.test('merchant/list aggregates all active rows with task, day, owner and favorite isolation', async () => {
      const groups = await records.listMerchants(a.owner, undefined, day);
      assert.equal(groups.length, 3);
      assert.deepEqual(groups.find(m => m.supplier === shop), { supplier: shop, supplierContact: '合成联系人', total: 38, confirmed: 19, pending: 19, missingPrice: 13 });
      assert.deepEqual(groups.find(m => m.supplier === similarShop), { supplier: similarShop, supplierContact: '合成联系人', total: 2, confirmed: 1, pending: 1, missingPrice: 0 });
      assert.deepEqual(groups.find(m => m.supplier === ''), { supplier: '', supplierContact: '', total: 2, confirmed: 1, pending: 1, missingPrice: 1 });
      assert.equal(groups.reduce((sum, group) => sum + group.total, 0), 42);
      assert.equal((await records.listMerchants(a.owner, task.id, day)).find(m => m.supplier === shop)!.total, 36);
      assert.deepEqual(await foreignRecords.listMerchants(b.owner, undefined, day), [{ supplier: shop, supplierContact: '合成联系人', total: 1, confirmed: 0, pending: 1, missingPrice: 0 }]);
      await assert.rejects(foreignRecords.listMerchants(b.owner, task.id), errorCode('NOT_FOUND'));
      assert.equal((await records.listMerchants(a.owner, undefined, day, true))[0].total, 10);
      assert.deepEqual((await records.recordDays(a.owner)).find(row => row.date === day), { date: day, count: 42 });
    });

    await t.test('source-filtered exports and persistent jobs preserve exact rows, empty merchant and numeric precision', async () => {
      assert.deepEqual(ids(await records.recordsForExport(a.owner, undefined, day, false, shop)), ids(exact));
      assert.deepEqual(ids(await records.recordsForExport(a.owner, undefined, day, false, '')), ids(unnamed));
      const settings = defaultProcurementTemplate(); settings.layout.moneyDecimals = 4; settings.layout.volumeDecimals = 6;
      settings.columns.filter(column => ['supplier', 'currency'].includes(column.key)).forEach(column => { column.enabled = true; });
      const service = new MarketService(records, { enabled: () => false, extract: async () => { throw new Error('unused model'); } });
      const checkWorkbook = async (bytes: Buffer, expected: Product[], metadata: ReturnType<typeof quotationExportMetadata>) => {
        const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(bytes as unknown as ExcelJS.Buffer);
        const header = metadata.headerRows.filter(row => row.enabled).length + 1;
        const rows: { supplier: string; sku: string; cell: (key: string) => ExcelJS.Cell }[] = [];
        for (const sheet of workbook.worksheets.filter(sheet => sheet.name !== '说明')) {
          assert.deepEqual((sheet.getRow(header).values as string[]).slice(1), metadata.columns.map(column => column.label));
          const column = (key: string) => { const index = metadata.columns.findIndex(c => c.key === key) + 1; assert.ok(index > 0, key); return index; };
          for (let row = header + 1; row <= sheet.rowCount && sheet.getCell(row, column('sku')).text; row++) {
            rows.push({ supplier: sheet.getCell(row, column('supplier')).text, sku: sheet.getCell(row, column('sku')).text, cell: key => sheet.getCell(row, column(key)) });
          }
        }
        assert.deepEqual(rows.map(row => row.sku).sort(), expected.map(p => p.sku).sort());
        return rows;
      };
      for (const [supplier, expected] of [[shop, exact], ['', unnamed], [undefined, activeDay]] as const) {
        const output = await service.export(a.owner, undefined, { date: day, supplier, images: false, template: settings });
        assert.ok(output.metadata);
        const rows = await checkWorkbook(output.bytes, [...expected], output.metadata);
        assert.equal(output.metadata.columns.find(c => c.key === 'unitPrice')!.label.includes('原币种'), supplier !== shop);
        if (supplier === shop) {
          assert.deepEqual([...new Set(rows.map(row => row.supplier))], [shop]);
          const precise = rows.find(row => row.sku === 'A-1')!;
          assert.equal(precise.cell('unitPrice').value, 1.2345); assert.equal(precise.cell('unitPrice').numFmt, '#,##0.0000');
          assert.equal(precise.cell('quantity').value, 7); assert.ok(Math.abs(Number(precise.cell('amount').value) - 8.6415) < 1e-10);
          assert.equal(precise.cell('cartonCbm').value, .012345); assert.equal(precise.cell('cartonCbm').numFmt, '0.000000');
          assert.ok(Math.abs(Number(precise.cell('cbm').value) - .037035) < 1e-10);
          assert.equal(rows.find(row => row.sku === 'A-0')!.cell('unitPrice').value, null);
        }
      }
      const makeJobs = (owner = a.owner, tokenHash = tokenA) => new CloudJobs(db, blobs, new CloudUploadBroker(db, blobs, { owner, tokenHash }, new UploadRegistry()), { owner, tokenHash });
      for (const supplier of [shop, '']) {
        const instance = makeJobs();
        const input = { date: day, supplier, scope: 'all' as const, images: false, audience: 'selection' as const };
        const started = await instance.startProductExport(a.owner, input, async () => (await service.export(a.owner, undefined, { ...input, template: settings })).bytes);
        assert.equal((await settle(instance, a.owner, started.jobId)).state, 'succeeded');
        assert.deepEqual(JSON.parse(await pg.sql(`SELECT input FROM public.huoji_jobs WHERE job_id=${quote(started.jobId)}`)), input);
        await checkWorkbook(await makeJobs().downloadFile(a.owner, started.jobId), supplier === shop ? exact : unnamed,
          quotationExportMetadata(settings, { images: false }, [supplier === shop ? 'CNY' : 'EUR']));
        await assert.rejects(makeJobs(b.owner, tokenB).downloadFile(b.owner, started.jobId), errorCode('NOT_FOUND'));
      }
      for (const supplier of [null, 123, 'x'.repeat(201)]) {
        const result = await pg.raw('job/create', a.owner, tokenA, { jobId: randomUUID(), kind: 'product-export', state: 'pending', input: { date: day, supplier } }) as { ok: boolean; error: { code: string } };
        assert.equal(result.ok, false); assert.equal(result.error.code, 'VALIDATION');
      }
    });

    await t.test('trash/restore changes shop counts and fences a trashed cursor while preserving original day', async () => {
      const first = await records.pageProducts(a.owner, undefined, undefined, 30, { date: day, supplier: shop });
      const target = first.items.at(-1)!;
      const moved = await records.trashProduct(a.owner, target.id, target.version);
      assert.equal((await records.pageProducts(a.owner, undefined, undefined, 30, { date: day, supplier: shop })).matchedCount, 37);
      assert.equal((await records.listMerchants(a.owner, undefined, day)).find(m => m.supplier === shop)!.total, 37);
      assert.equal((await records.recordsForExport(a.owner, undefined, day, false, shop)).some(p => p.id === target.id), false);
      await assert.rejects(records.pageProducts(a.owner, undefined, first.nextCursor!, 30, { date: day, supplier: shop }), errorCode('INVALID_CURSOR'));
      const restored = await records.trashProduct(a.owner, target.id, moved.version, true);
      assert.equal(restored.createdAt, target.createdAt); assert.equal(restored.projectId, target.projectId);
      assert.equal((await records.pageProducts(a.owner, undefined, undefined, 30, { date: day, supplier: shop })).matchedCount, 38);
      assert.ok(!(await records.recordsForExport(a.owner, undefined, day)).some(p => p.id === discarded.id));
    });

    await t.test('merchant visits migration replays safely and creates owned named or empty shops alongside legacy tasks', async () => {
      const sql = readFileSync(join(__dirname, '../cloudbase/migrations/20261018214500_huoji_merchant_visits.sql'), 'utf8');
      const before = await pg.sql("SELECT jsonb_build_object('products',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.huoji_products p),'receipts',(SELECT jsonb_agg(to_jsonb(r) ORDER BY owner_id,request_key) FROM public.huoji_receipts r))");
      await pg.sql(sql);
      const definition = await pg.sql("SELECT pg_get_functiondef('public.huoji_command_core_20261018(text,text,text,jsonb)'::regprocedure) || pg_get_functiondef('public.huoji_project(text,text,bool)'::regprocedure)");
      await pg.sql(sql);
      assert.equal(await pg.sql("SELECT pg_get_functiondef('public.huoji_command_core_20261018(text,text,text,jsonb)'::regprocedure) || pg_get_functiondef('public.huoji_project(text,text,bool)'::regprocedure)"), definition);
      assert.equal(await pg.sql("SELECT jsonb_build_object('products',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.huoji_products p),'receipts',(SELECT jsonb_agg(to_jsonb(r) ORDER BY owner_id,request_key) FROM public.huoji_receipts r))"), before);
      const requestKey = randomUUID(), fields = { name: '新建看货商家', market: '合成市场', date: day, supplier: '明确商家', supplierContact: '合成微信' };
      const named = await records.createProject(a.owner, fields, requestKey);
      assert.equal(named.supplier, fields.supplier); assert.equal(named.supplierContact, fields.supplierContact);
      assert.equal((await records.createProject(a.owner, fields, requestKey)).id, named.id);
      const empty = await records.createProject(a.owner, { name: '未填写商家看货', market: '', date: day, supplier: '', supplierContact: '' }, randomUUID());
      assert.equal(empty.supplier, ''); assert.equal(empty.supplierContact, '');
      const tomorrow = await records.createProject(a.owner, { name: '隔日看货', market: '', date: '2026-10-19', supplier: '隔日店' }, randomUUID());
      const visits = await records.listMerchantVisits(a.owner, day);
      const namedVisit = visits.find(v => v.projectId === named.id)!;
      assert.deepEqual(namedVisit, { projectId: named.id, date: day, market: fields.market, demo: false, supplier: fields.supplier, supplierContact: fields.supplierContact, total: 0, confirmed: 0, pending: 0, missingPrice: 0 });
      assert.equal(visits.filter(v => v.projectId === named.id).length, 1);
      assert.deepEqual(visits.find(v => v.projectId === empty.id), { projectId: empty.id, date: day, market: '', demo: false, supplier: '', supplierContact: '', total: 0, confirmed: 0, pending: 0, missingPrice: 0 });
      assert.ok(!visits.some(v => v.projectId === tomorrow.id || v.projectId === foreignTask.id));
      assert.deepEqual(visits.filter(v => v.projectId === task.id).map(v => [v.supplier, v.total]).sort(), [['', 1], [shop, 36], [similarShop, 1]].sort());
      assert.deepEqual(visits.filter(v => v.projectId === otherTask.id).map(v => [v.supplier, v.total]).sort(), [['', 1], [shop, 2], [similarShop, 1]].sort());
      assert.equal(visits.reduce((sum, v) => sum + v.total, 0), 42);
      const foreignVisits = await foreignRecords.listMerchantVisits(b.owner, day);
      assert.equal(foreignVisits.length, 1); assert.equal(foreignVisits[0].projectId, foreignTask.id); assert.equal(foreignVisits[0].total, 1);
      assert.deepEqual(ids(await records.recordsForExport(a.owner, undefined, day, false, shop)), ids(exact));
      assert.deepEqual((await records.pageProducts(a.owner, undefined, undefined, 30, { date: day, supplier: shop })).summary, expectedSummary);
    });

    await t.test('merchant contact uses latest nonempty active record instead of lexical MAX', async () => {
      const supplier = '联系人时序商家';
      const contacts = [['z-old-contact', '2026-10-18T05:00:00.000Z', false], ['a-new-contact', '2026-10-18T06:00:00.000Z', false], ['', '2026-10-18T07:00:00.000Z', false], ['trashed-contact', '2026-10-18T08:00:00.000Z', true]] as const;
      for (const [supplierContact, at, trashed] of contacts) {
        const product = await records.saveProduct(a.owner, { requestKey: randomUUID(), projectId: task.id, fields: { ...emptyFields, name: 'contact fixture', supplier, supplierContact }, photoIds: [] });
        await pg.sql(`UPDATE public.huoji_products SET created_at=${quote(at)} WHERE id=${quote(product.id)}`);
        if (trashed) await records.trashProduct(a.owner, product.id, product.version);
      }
      assert.deepEqual((await records.listMerchants(a.owner, undefined, day)).find(m => m.supplier === supplier),
        { supplier, supplierContact: 'a-new-contact', total: 3, confirmed: 0, pending: 3, missingPrice: 3 });
    });
  } finally { pg.stop(); }
});
