import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import sharp from 'sharp';
import { createApp } from '../src/server/app';
import { issueSession } from '../src/server/auth';
import { parseRuntimeConfig } from '../src/server/config';
import { MarketService } from '../src/server/service';
import { closeDB, createProject, db, repository, saveProduct, stagePhoto, trashProduct, recordDateRangeBounds } from '../src/lib/db';
import { emptyFields, type ProductFields } from '../src/lib/types';
import { CloudDatabase, type CloudBlobStore } from '../src/server/cloud-db';
import { CloudRecords } from '../src/server/cloud-records';
import { productExportInputSchema } from '../src/server/cloud-tasks';

test('range APIs use first saved China dates consistently, retain cross-task duplicates, isolate owners and trash', async () => {
  const previous=process.env.APP_DATA_DIR, root=mkdtempSync(join(tmpdir(),'huoji-date-range-')); process.env.APP_DATA_DIR=root;
  const service=new MarketService(repository,{enabled:()=>false,extract:async()=>{throw new Error('unused');}});
  const config=parseRuntimeConfig({APP_DATA_DIR:root},{identityInjected:true,serviceInjected:true});
  const app=await createApp({config,identity:{exchange:async code=>code},service});
  try {
    const a=issueSession('range-alice'),b=issueSession('range-bob');
    const task=createProject(a.user.id,{name:'一',market:'',date:'2026-01-01'},randomUUID());
    const another=createProject(a.user.id,{name:'二',market:'',date:'2026-01-02'},randomUUID());
    const foreign=createProject(b.user.id,{name:'他人',market:'',date:'2026-10-18'},randomUUID());
    const add=async (id:string,sku:string,at:string,fields:Partial<ProductFields>={},owner=a.user.id,photo=false)=>{
      const photos=photo?[stagePhoto(owner,{name:'synthetic.jpg',bytes:await sharp({create:{width:8,height:8,channels:3,background:'#abcabc'}}).jpeg().toBuffer()}).id]:[];
      const product=saveProduct(owner,{requestKey:randomUUID(),projectId:id,fields:{...emptyFields,name:sku,sku,supplier:'同名商家',unitPrice:2,cartons:1,cartonQty:12,cartonCbm:.123,confirmed:true,...fields},photoIds:photos});
      db().prepare('UPDATE products SET created_at=?,updated_at=? WHERE id=?').run(at,'2026-11-01T00:00:00.000Z',product.id);
      return product;
    };
    const early=await add(task.id,'DUP','2026-10-17T16:00:00.000Z',{favorite:true},a.user.id,true);
    const mid=await add(another.id,'DUP','2026-10-18T16:00:00.000Z',{favorite:true},a.user.id,true);
    const late=await add(task.id,'LAST','2026-10-20T15:59:59.999Z',{confirmed:false});
    await add(task.id,'SIMILAR','2026-10-19T01:00:00.000Z',{supplier:'同名商家分店',currency:'USD'});
    await add(task.id,'BEFORE','2026-10-17T15:59:59.999Z');
    await add(task.id,'AFTER','2026-10-20T16:00:00.000Z');
    const trash=await add(task.id,'TRASH','2026-10-18T00:00:00.000Z');trashProduct(a.user.id,trash.id,trash.version);
    await add(foreign.id,'FOREIGN','2026-10-18T00:00:00.000Z',{},b.user.id);
    const range={dateFrom:'2026-10-18',dateTo:'2026-10-20'},exact={...range,supplier:'同名商家'};
    const get=(route:string,query:Record<string,string|number|undefined>={},token=a.token)=>app.inject({method:'GET',url:route+'?'+new URLSearchParams(Object.entries(query).flatMap(([k,v])=>v===undefined?[]:[[k,String(v)]])),headers:{authorization:'Bearer '+token}});
    assert.equal((await app.inject({method:'GET',url:'/api/capabilities'})).statusCode,401);
    assert.deepEqual((await get('/api/capabilities')).json(),{dateRangeExport:true,exportFileV2:false});
    const first=(await get('/api/products',{...exact,limit:2})).json();
    assert.equal(first.matchedCount,3);assert.equal(first.summary.total,3);assert.equal(first.summary.confirmed,2);assert.ok(first.nextCursor);
    const last=(await get('/api/products',{...exact,limit:2,cursor:first.nextCursor})).json();
    assert.deepEqual([...first.items,...last.items].map((p:{id:string})=>p.id).sort(),[early.id,mid.id,late.id].sort());
    for(const changed of [{...exact,dateTo:'2026-10-19'},{...range},{...exact,dateFrom:'2026-10-19'}]){
      const response=await get('/api/products',{...changed,cursor:first.nextCursor});assert.equal(response.statusCode,400);assert.equal(response.json().error.code,'INVALID_CURSOR');
    }
    const merchants=(await get('/api/merchants',range)).json();assert.equal(merchants.length,2);assert.equal(merchants.find((m:{supplier:string})=>m.supplier==='同名商家').total,3);
    assert.equal((await get('/api/products',{...exact,favorite:'yes'})).json().matchedCount,2);
    assert.equal((await get('/api/projects/'+task.id+'/summary',range)).json().total,3);
    assert.equal((await get('/api/products',{...range,projectId:foreign.id})).statusCode,404);
    assert.equal((await get('/api/products',exact,b.token)).json().matchedCount,1);
    const preview=(await get('/api/export-preview',{...exact,scope:'confirmed'})).json();
    assert.ok(preview.columns.find((c:{key:string})=>c.key==='unitPrice').label.includes('RMB'),'unrelated USD records do not contaminate preview currency');
    const response=await get('/api/export',{...exact,scope:'confirmed',images:'yes'});assert.equal(response.statusCode,200,response.body);
    const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(response.rawPayload as unknown as ExcelJS.Buffer);
    assert.deepEqual(workbook.worksheets.map(s=>s.name),['同名商家','说明']);
    const sheet=workbook.getWorksheet('同名商家')!;assert.equal(sheet.getCell('A7').value,'DUP');assert.equal(sheet.getCell('A8').value,'DUP');assert.equal(sheet.getImages().length,2);
    assert.equal(sheet.getCell('D7').result,12);assert.equal(sheet.getCell('F7').result,24);assert.equal(sheet.getCell('J7').result,.123);
    const legacy=(await get('/api/products',{date:'2026-10-18',supplier:'同名商家'})).json();assert.equal(legacy.matchedCount,1);assert.equal(legacy.items[0].id,early.id);
    for(const invalid of [{dateFrom:'2026-10-18'},{dateTo:'2026-10-20'},{dateFrom:'2026-10-21',dateTo:'2026-10-20'},{dateFrom:'2026-02-30',dateTo:'2026-10-20'},{...range,date:'2026-10-18'}]) for(const route of ['/api/products','/api/merchants','/api/export-preview','/api/export']) assert.equal((await get(route,invalid,issueSession('range-validation-'+randomUUID()).token)).statusCode,400,route+JSON.stringify(invalid));
    assert.deepEqual(recordDateRangeBounds(undefined,{dateFrom:'2024-02-29',dateTo:'2024-03-01'}),['2024-02-28T16:00:00.000Z','2024-03-01T16:00:00.000Z']);
  } finally {await app.close();closeDB();rmSync(root,{recursive:true,force:true});if(previous===undefined)delete process.env.APP_DATA_DIR;else process.env.APP_DATA_DIR=previous;}
});

test('old cloud SQL cannot silently ignore date ranges; job input keeps and validates the whole range', async () => {
  const calls:string[]=[];
  const sql=new CloudDatabase({rpc:async(_name,p)=>{calls.push(p.p_operation);return {data:{ok:false,error:{code:'UNKNOWN_OPERATION',message:'旧服务',status:400}},error:null};}});
  const records=new CloudRecords(sql,{} as CloudBlobStore,{owner:'alice',tokenHash:'a'.repeat(64)});
  assert.deepEqual(await records.capabilities('alice'),{dateRangeExport:false});
  const range={dateFrom:'2026-10-18',dateTo:'2026-10-20'};
  for(const request of [()=>records.recordsForExport('alice',undefined,undefined,false,undefined,range),()=>records.pageProducts('alice',undefined,undefined,30,range),()=>records.listMerchants('alice',undefined,undefined,false,range)])await assert.rejects(request(),{code:'DATE_RANGE_UNSUPPORTED'});
  assert.ok(calls.every(c=>c==='capabilities'),'no unscoped list/export query is sent to the old database');
  assert.deepEqual(productExportInputSchema.parse({...range,scope:'confirmed',supplier:'同名商家'}),{...range,scope:'confirmed',supplier:'同名商家'});
  for(const invalid of [{dateFrom:range.dateFrom},{dateTo:range.dateTo},{...range,date:'2026-10-18'},{dateFrom:'2026-02-29',dateTo:'2026-10-20'},{dateFrom:'0000-01-01',dateTo:'2026-10-20'}])assert.equal(productExportInputSchema.safeParse(invalid).success,false);
});
