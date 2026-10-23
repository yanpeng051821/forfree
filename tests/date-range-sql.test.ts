import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { CloudDatabase, type CloudRpcClient, type CloudRpcParameters } from '../src/server/cloud-db';
import { CloudRecords } from '../src/server/cloud-records';
import { CloudJobs } from '../src/server/cloud-jobs';
import { CloudAuth } from '../src/server/cloud-auth';
import { CloudUploadBroker } from '../src/server/workbook-upload';
import type { BlobStore } from '../src/server/cloud-blobs';
import { emptyFields } from '../src/lib/types';
import { createApp } from '../src/server/app';
import { parseRuntimeConfig } from '../src/server/config';
import { MarketService } from '../src/server/service';

const bin='/opt/homebrew/bin',quote=(s:string)=>"'"+s.replaceAll("'","''")+"'";
const migrationDir=join(__dirname,'../cloudbase/migrations'),rangeMigration='20261021090000_huoji_date_range.sql';
// Disposable PG16 over a unique Unix socket. No network listener or existing database is used.
class RangePg implements CloudRpcClient {
  root=mkdtempSync('/tmp/huoji-range-pg-'); started=false;
  env={PATH:bin+':/usr/bin:/bin',LANG:'en_US.UTF-8'};
  run(name:string,args:string[],input?:string){const p=spawnSync(join(bin,name),args,{env:this.env,encoding:'utf8',input,maxBuffer:8*1024*1024});if(p.error)throw p.error;assert.equal(p.status,0,p.stderr+p.stdout);return p.stdout.trim();}
  sql(s:string){return this.run('psql',['-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-h',this.root,'-p','55457','-U','huoji_range','-d','postgres'],s);}
  start(){this.run('initdb',['-D',join(this.root,'db'),'-U','huoji_range','-A','trust','--no-locale','-E','UTF8']);this.run('pg_ctl',['-D',join(this.root,'db'),'-l',join(this.root,'log'),'-o',`-k ${this.root} -p 55457 -c listen_addresses='' -c fsync=off`,'-w','start']);this.started=true;this.sql(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA auth;CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$SELECT current_setting('request.jwt.claim.role',true)$$;GRANT USAGE ON SCHEMA auth TO service_role,anon,authenticated;`);for(const file of readdirSync(migrationDir).filter(f=>f.endsWith('.sql')&&f<rangeMigration).sort())this.sql(readFileSync(join(migrationDir,file),'utf8'));}
  stop(){try{if(this.started)this.run('pg_ctl',['-D',join(this.root,'db'),'-m','immediate','-w','stop']);}finally{rmSync(this.root,{recursive:true,force:true});}}
  async rpc(_name:'huoji_command',p:CloudRpcParameters){const output=this.sql(`BEGIN;SET LOCAL ROLE service_role;SELECT set_config('request.jwt.claim.role','service_role',true);SELECT public.huoji_command(${quote(p.p_operation)},${p.p_owner===null?'NULL':quote(p.p_owner)},${p.p_token_hash===null?'NULL':quote(p.p_token_hash)},${quote(JSON.stringify(p.p_payload))}::jsonb);COMMIT;`);return {data:JSON.parse(output.split('\n').at(-1)!),error:null};}
}
class MemoryBlobs implements BlobStore {
  objects=new Map<string,Buffer>();
  async read(k:string){const value=this.objects.get(k);assert.ok(value);return value;}
  async write(k:string,v:Uint8Array){this.objects.set(k,Buffer.from(v));}
  async remove(k:string){this.objects.delete(k);}
  async info(k:string){return {size:(await this.read(k)).length,mime:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',etag:'synthetic'};}
  async signUpload(){return {method:'PUT' as const,url:'https://test.invalid/upload',headers:{},expiresAt:new Date(Date.now()+60000).toISOString()};}
  async signDownload(){return {url:'https://test.invalid/download',expiresAt:new Date(Date.now()+60000).toISOString()};}
}

test('isolated PostgreSQL range migration preserves legacy calls and validates real async HTTP/export jobs', {timeout:60000}, async t=>{
  const pg=new RangePg();let app:Awaited<ReturnType<typeof createApp>>|undefined;
  try {
    pg.start();const db=new CloudDatabase(pg),auth=new CloudAuth(db),blobs=new MemoryBlobs();
    const a=await auth.issue('range-pg-alice'),b=await auth.issue('range-pg-bob');const ctx=await auth.authenticate('Bearer '+a.token),other=await auth.authenticate('Bearer '+b.token);
    const records=new CloudRecords(db,blobs,ctx),range={dateFrom:'2026-10-18',dateTo:'2026-10-20'};
    const config=parseRuntimeConfig({DATA_BACKEND:'cloudbase',APP_DATA_DIR:join(pg.root,'unused')},{identityInjected:true,serviceInjected:true});
    app=await createApp({config,identity:{exchange:async code=>code},service:new MarketService(undefined,{enabled:()=>false,extract:async()=>{throw new Error('unused');}}),cloud:{db,auth,blobs,uploadBroker:(context,registry)=>new CloudUploadBroker(db,blobs,context,registry),jobs:(context,uploads)=>new CloudJobs(db,blobs,uploads,context)}});
    const get=(path:string,query:Record<string,string|number>={})=>app!.inject({method:'GET',url:path+'?'+new URLSearchParams(Object.entries(query).map(([k,v])=>[k,String(v)])),headers:{authorization:'Bearer '+a.token}});
    await t.test('new backend advertises false and blocks ranges until SQL migration is present',async()=>{
      assert.deepEqual((await get('/api/capabilities')).json(),{dateRangeExport:false});
      assert.equal((await get('/api/products',range)).statusCode,409);
      const r=await app!.inject({method:'POST',url:'/api/export-jobs',headers:{authorization:'Bearer '+a.token},payload:range});assert.equal(r.statusCode,409,r.body);
      assert.equal(pg.sql('SELECT count(*) FROM public.huoji_jobs;'),'0');
    });
    const sql=readFileSync(join(migrationDir,rangeMigration),'utf8');pg.sql(sql);pg.sql(sql);
    assert.deepEqual((await get('/api/capabilities')).json(),{dateRangeExport:true});
    const p1=await records.createProject(ctx.owner,{name:'task1',market:'',date:'2026-01-01'},randomUUID()),p2=await records.createProject(ctx.owner,{name:'task2',market:'',date:'2026-01-02'},randomUUID());
    const foreignRecords=new CloudRecords(db,blobs,other),foreign=await foreignRecords.createProject(other.owner,{name:'other',market:'',date:'2026-10-18'},randomUUID());
    const add=async(projectId:string,sku:string,at:string,patch:Partial<typeof emptyFields>={},owner=records)=>{const product=await owner.saveProduct(owner===records?ctx.owner:other.owner,{projectId,requestKey:randomUUID(),fields:{...emptyFields,name:sku,sku,supplier:'同名商家',unitPrice:2,cartons:1,cartonQty:12,cartonCbm:.123,confirmed:true,...patch},photoIds:[]});pg.sql(`UPDATE public.huoji_products SET created_at=${quote(at)},updated_at='2026-11-01T00:00:00Z' WHERE id=${quote(product.id)};`);return product;};
    const first=await add(p1.id,'DUP','2026-10-17T16:00:00Z',{favorite:true}),second=await add(p2.id,'DUP','2026-10-18T16:00:00Z',{favorite:true}),last=await add(p1.id,'LAST','2026-10-20T15:59:59.999Z',{confirmed:false});
    await add(p1.id,'BEFORE','2026-10-17T15:59:59.999Z');await add(p1.id,'AFTER','2026-10-20T16:00:00Z');await add(p1.id,'SIMILAR','2026-10-19T00:00:00Z',{supplier:'同名商家分店',currency:'USD'});
    const trash=await add(p1.id,'TRASH','2026-10-19T00:00:00Z');await records.trashProduct(ctx.owner,trash.id,trash.version);await add(foreign.id,'OTHER','2026-10-19T00:00:00Z',{},foreignRecords);
    const exact={...range,supplier:'同名商家'};
    await t.test('PG applies the identical range to cursor, summary, merchants and exported records',async()=>{
      const a=await records.pageProducts(ctx.owner,undefined,undefined,2,exact),b=await records.pageProducts(ctx.owner,undefined,a.nextCursor!,2,exact);
      assert.equal(a.matchedCount,3);assert.equal(a.summary.total,3);assert.equal(a.summary.confirmed,2);assert.equal(b.summary.total,3);
      assert.deepEqual([...a.items,...b.items].map(p=>p.id).sort(),[first.id,second.id,last.id].sort());
      await assert.rejects(records.pageProducts(ctx.owner,undefined,a.nextCursor!,2,{...exact,dateTo:'2026-10-19'}),{code:'INVALID_CURSOR'});
      assert.equal((await records.listMerchants(ctx.owner,undefined,undefined,false,range)).find(m=>m.supplier==='同名商家')!.total,3);
      assert.equal((await records.recordsForExport(ctx.owner,undefined,undefined,true,'同名商家',range)).length,2);
      assert.equal((await records.recordsForExport(ctx.owner,p1.id,undefined,false,'同名商家',range)).length,2);
      assert.equal((await records.pageProducts(ctx.owner,undefined,undefined,30,{date:'2026-10-18',supplier:'同名商家'})).matchedCount,1);
      await assert.rejects(records.recordsForExport(ctx.owner,foreign.id,undefined,false,undefined,range),{code:'NOT_FOUND'});
    });
    await t.test('raw SQL rejects invalid ranges for product/listExport, page, merchants and persistent job inputs',async()=>{
      for(const input of [{dateFrom:'2026-10-18'},{dateTo:'2026-10-20'},{dateFrom:'2026-02-30',dateTo:'2026-10-20'},{dateFrom:'2026-10-21',dateTo:'2026-10-20'},{...range,date:'2026-10-18'},{dateFrom:null,dateTo:'2026-10-20'}]){
        for(const op of ['product/page','product/listExport','merchant/list']){const r=await pg.rpc('huoji_command',{p_operation:op,p_owner:ctx.owner,p_token_hash:ctx.tokenHash,p_payload:input});assert.equal(r.data.ok,false);assert.equal(r.data.error.code,'VALIDATION');}
        const result=await pg.rpc('huoji_command',{p_operation:'job/create',p_owner:ctx.owner,p_token_hash:ctx.tokenHash,p_payload:{jobId:randomUUID(),kind:'product-export',state:'pending',input}});assert.equal(result.data.ok,false);assert.equal(result.data.error.code,'VALIDATION');
      }
      assert.equal(pg.sql("SELECT has_function_privilege('authenticated','public.huoji_record_date_matches(timestamptz,jsonb)','EXECUTE');"),'f');
    });
    await t.test('async HTTP job persists range and reads back actual XLSX with two same-shop same-SKU products',async()=>{
      const response=await app!.inject({method:'POST',url:'/api/export-jobs',headers:{authorization:'Bearer '+a.token},payload:{...exact,scope:'confirmed',images:'no'}});assert.equal(response.statusCode,202,response.body);const id=response.json().jobId;
      const input=JSON.parse(pg.sql(`SELECT input::text FROM public.huoji_jobs WHERE job_id=${quote(id)};`));assert.equal(input.dateFrom,range.dateFrom);assert.equal(input.dateTo,range.dateTo);assert.equal(input.supplier,'同名商家');
      let state='';for(let i=0;i<100;i++){const result=await get('/api/jobs/'+id);state=result.json().state;if(state==='succeeded'||state==='failed')break;await new Promise(resolve=>setTimeout(resolve,10));}assert.equal(state,'succeeded');
      const jobs=new CloudJobs(db,blobs,new CloudUploadBroker(db,blobs,ctx),ctx);const bytes=await jobs.downloadFile(ctx.owner,id),w=new ExcelJS.Workbook();await w.xlsx.load(bytes as unknown as ExcelJS.Buffer);
      assert.deepEqual(w.worksheets.map(s=>s.name),['同名商家','说明']);const s=w.getWorksheet('同名商家')!;assert.equal(s.getCell('A7').value,'DUP');assert.equal(s.getCell('A8').value,'DUP');assert.equal(s.getCell('D7').value,12);assert.equal(s.getCell('F7').value,24);
      const forbidden=await app!.inject({method:'GET',url:'/api/jobs/'+id,headers:{authorization:'Bearer '+b.token}});assert.equal(forbidden.statusCode,404);
    });
  } finally {if(app)await app.close();pg.stop();}
});
