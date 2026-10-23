import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
const root=mkdtempSync(join(tmpdir(),'huoji-trash-api-'));process.env.APP_DATA_DIR=root;
test('local API trash/restore preserves original date, custom and photos, filters counts/export, and fences stale/foreign edits',async()=>{
 const {createApp}=await import('../src/server/app');const {issueSession}=await import('../src/server/auth');
 const {createProject,saveProduct,stagePhoto,closeDB,db}=await import('../src/lib/db');const {emptyFields}=await import('../src/lib/types');const sharp=(await import('sharp')).default;
 const a=issueSession('trash-test-a'),b=issueSession('trash-test-b'),app=await createApp({identity:{exchange:async()=>''}});
 const auth=(token=a.token)=>({authorization:'Bearer '+token});
 try{
  const project=createProject(a.user.id,{name:'synthetic',market:'market',date:'2026-10-01'},randomUUID());
  const photo=stagePhoto(a.user.id,{name:'synthetic.jpg',bytes:await sharp({create:{width:10,height:10,channels:3,background:'#ffffff'}}).jpeg().toBuffer()});
  const product=saveProduct(a.user.id,{requestKey:randomUUID(),projectId:project.id,fields:{...emptyFields,name:'cup',quantity:48,cartons:2,cartonQty:24,custom:{client_ref:'00012'},favorite:true},photoIds:[photo.id]});
  db().prepare('UPDATE products SET created_at=? WHERE id=?').run('2026-09-30T16:00:00.000Z',product.id);
  const move=await app.inject({method:'POST',url:'/api/products/'+product.id+'/trash',headers:auth(),payload:{version:product.version}});assert.equal(move.statusCode,200,move.body);const moved=move.json();assert.ok(moved.deletedAt);
  for(const url of ['/api/products?projectId='+project.id,'/api/products?date=2026-10-01','/api/products?favorite=yes']){const page=(await app.inject({method:'GET',url,headers:auth()})).json();assert.equal(page.items.length,0);assert.equal(page.summary.total,0);}
  assert.equal((await app.inject({method:'GET',url:'/api/export?projectId='+project.id,headers:auth()})).statusCode,400);
  const bin=(await app.inject({method:'GET',url:'/api/trash?limit=1',headers:auth()})).json();assert.equal(bin.items[0].id,product.id);assert.equal(bin.matchedCount,1);
  assert.equal((await app.inject({method:'POST',url:'/api/products/'+product.id+'/restore',headers:auth(b.token),payload:{version:moved.version}})).statusCode,404);
  assert.equal((await app.inject({method:'POST',url:'/api/products/'+product.id+'/restore',headers:auth(),payload:{version:product.version}})).statusCode,409);
  const restored=(await app.inject({method:'POST',url:'/api/products/'+product.id+'/restore',headers:auth(),payload:{version:moved.version}})).json();assert.equal(restored.deletedAt,null);assert.equal(restored.projectId,project.id);assert.equal(restored.createdAt,'2026-09-30T16:00:00.000Z');assert.equal(restored.photos[0].id,photo.id);assert.equal(restored.custom.client_ref,'00012');assert.equal(restored.favorite,true);
  const finalMove=(await app.inject({method:'POST',url:'/api/products/'+product.id+'/trash',headers:auth(),payload:{version:restored.version}})).json();
  const removed=await app.inject({method:'DELETE',url:'/api/products/'+product.id,headers:auth(),payload:{version:finalMove.version}});assert.equal(removed.statusCode,200);assert.equal(removed.json().deleted,true);
  assert.equal((await app.inject({method:'GET',url:'/api/products/'+product.id,headers:auth()})).statusCode,404);
 }finally{await app.close();closeDB();rmSync(root,{recursive:true,force:true});}
});
