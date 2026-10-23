import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {emptyFields,type Product} from '../src/lib/types';
import {extractText} from '../src/lib/extraction';
import {mergeOrganizedProduct,ProductOrganizeQueue} from '../src/server/product-organize';
import {createApp} from '../src/server/app';
import {MarketService} from '../src/server/service';
import {repository,closeDB} from '../src/lib/db';

const fixture=()=>({...emptyFields,id:randomUUID(),projectId:randomUUID(),version:1,photos:[],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),name:'未命名商品'}) as Product;
test('automatic organization fills explicit product, merchant and notes, preserving human values and evaluation',()=>{
 const value=fixture();value.supplier='手填商户';value.unitPrice=0;value.rating=4;value.evaluation='手填判断';
 const result=extractText('品名：陶瓷杯，报价12元，起订100件，商户：义乌陶瓷，联系方式：微信 a123，备注：问包装');
 const fields=mergeOrganizedProduct(value,result);
 assert.equal(fields.name,'陶瓷杯');assert.equal(fields.supplier,'手填商户');assert.equal(fields.unitPrice,0);assert.equal(fields.moq,100);assert.equal(fields.supplierContact,'微信 a123');assert.equal(fields.notes,'问包装');assert.equal(fields.rating,4);assert.equal(fields.evaluation,'手填判断');assert.equal(fields.confirmed,false);
});
test('same owner jobs execute sequentially; different owners progress; queue is bounded and slots release once',async()=>{
 const q=new ProductOrganizeQueue(), release=Array.from({length:4},()=>q.reserve('a'));assert.throws(()=>q.reserve('a'),/队列已满/);
 let unblock!:()=>void;const order:string[]=[];
 const first=q.run('a',async()=>{order.push('first');await new Promise<void>(r=>{unblock=r;});order.push('finish');});
 const next=q.run('a',async()=>{order.push('second');});
 await q.run('b',async()=>{order.push('other');});assert.deepEqual(order,['first','other']);unblock();await Promise.all([first,next]);assert.deepEqual(order,['first','other','finish','second']);
 release.forEach(r=>{r();r();});q.reserve('a')();
});
test('saved record survives AI failure; background completion saves once and a concurrent manual edit wins',async()=>{
 const root=mkdtempSync(join(tmpdir(),'huoji-capture-')),previous=process.env.APP_DATA_DIR;process.env.APP_DATA_DIR=root;
 let rejectAI=false, wait=false, unblock!:()=>void;
 const model={enabled:()=>true,extract:async()=>{if(rejectAI)throw new Error('model down');if(wait)await new Promise<void>(r=>{unblock=r;});return{fields:{name:'识别陶瓷杯',unitPrice:12,supplier:'图文商户'},mode:'model' as const,warning:'核对'};}};
 const app=await createApp({identity:{exchange:async()=> 'capture-fixture'},service:new MarketService(repository,model)});
 try{
  const grant=(await app.inject({method:'POST',url:'/api/auth/wechat',payload:{code:'fixture'}})).json();const headers={authorization:'Bearer '+grant.token};
  const project=(await app.inject({method:'POST',url:'/api/projects',headers,payload:{requestKey:randomUUID(),name:'fixture',market:'',date:'2026-10-18'}})).json();
  const create=async()=> (await app.inject({method:'POST',url:'/api/products',headers,payload:{requestKey:randomUUID(),projectId:project.id,fields:{...emptyFields,name:'未命名商品',description:'品名陶瓷杯'},photoIds:[]}})).json();
  const p=await create();const result=await app.inject({method:'POST',url:'/api/products/'+p.id+'/organize',headers,payload:{version:p.version}});assert.equal(result.statusCode,200,result.body);assert.equal(result.json().product.name,'识别陶瓷杯');assert.equal(result.json().product.organizeState,'done');
  rejectAI=true;const failed=await create();assert.equal((await app.inject({method:'POST',url:'/api/products/'+failed.id+'/organize',headers,payload:{version:1}})).statusCode,500);const retained=(await app.inject({url:'/api/products/'+failed.id,headers})).json();assert.equal(retained.description,'品名陶瓷杯');assert.equal(retained.organizeState,'failed');
  rejectAI=false;wait=true;const edited=await create();const running=app.inject({method:'POST',url:'/api/products/'+edited.id+'/organize',headers,payload:{version:1}});
  while(!unblock)await new Promise(r=>setTimeout(r,1));const snapshot=(await app.inject({url:'/api/products/'+edited.id,headers})).json();
  await app.inject({method:'POST',url:'/api/products',headers,payload:{requestKey:randomUUID(),id:edited.id,version:snapshot.version,projectId:project.id,fields:{...emptyFields,name:'手动改名',description:'新描述'},photoIds:[]}});unblock();const finish=await running;assert.equal(finish.statusCode,409,finish.body);const actual=(await app.inject({url:'/api/products/'+edited.id,headers})).json();assert.equal(actual.name,'手动改名');assert.equal(actual.unitPrice,null);
 }finally{await app.close();closeDB();rmSync(root,{recursive:true,force:true});if(previous===undefined)delete process.env.APP_DATA_DIR;else process.env.APP_DATA_DIR=previous;}
});
