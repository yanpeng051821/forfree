const {test,beforeEach}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const session=require('../miniprogram/utils/session');
const api=require('../miniprogram/utils/api');
const hash=require('../miniprogram/utils/sha256');
const cache=require('../miniprogram/utils/file-cache');
const store=require('../miniprogram/utils/store');
const JOB='3f2a1b4c-5d6e-4f70-8a91-2b3c4d5e6f70',CHUNK=655360;
let storage,files,removed,fs;
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
beforeEach(()=>{
  storage=new Map();files=new Map();removed=[];
  fs={
    statSync:p=>{if(!files.has(p))throw new Error('missing');return{size:files.get(p).length};},
    accessSync:p=>{if(!files.has(p))throw new Error('missing');},
    writeFileSync:(p,b)=>files.set(p,Buffer.from(b)),
    appendFileSync:(p,b)=>files.set(p,Buffer.concat([files.get(p),Buffer.from(b)])),
    readFileSync:p=>files.get(p),
    renameSync:(a,b)=>{if(!files.has(a))throw new Error('missing');files.set(b,files.get(a));files.delete(a);},
    unlinkSync:p=>{removed.push(p);files.delete(p);},mkdirSync(){},
    openSync:({filePath})=>filePath,
    readSync:({fd,arrayBuffer,position,length})=>{const bytes=files.get(fd).subarray(position,position+length);new Uint8Array(arrayBuffer).set(bytes);return{bytesRead:bytes.length};},
    closeSync(){},
  };
  global.wx={env:{USER_DATA_PATH:'/synthetic'},getFileSystemManager:()=>fs,getStorageSync:k=>storage.has(k)?structuredClone(storage.get(k)):'',
    setStorageSync:(k,v)=>storage.set(k,structuredClone(v)),removeStorageSync:k=>storage.delete(k),getStorageInfoSync:()=>({keys:[...storage.keys()]})};
  session.clear();session.install({user:{id:'synthetic-owner'},token:'a'.repeat(64),expiresAt:Date.now()+60000});
});

test('incremental SHA matches crypto for empty, boundary, random large and unicode values; cloning keeps original live',()=>{
  for(const length of [0,1,55,56,63,64,65,129,CHUNK*3+17]){
    const bytes=crypto.randomBytes(length),h=new hash.Hash();
    for(let i=0;i<length;i+=137)h.update(bytes.subarray(i,i+137));
    assert.equal(h.clone().digest(),sha(bytes));assert.equal(h.digest(),sha(bytes));
    files.set('/synthetic/input',bytes);assert.equal(hash.fileDigest(fs,'/synthetic/input',length),sha(bytes));
  }
  assert.equal(hash.textDigest('店甲😀'),sha(Buffer.from('店甲😀')));
  const h=new hash.Hash().update(Buffer.from('a'));assert.equal(h.clone().digest(),sha(Buffer.from('a')));h.update(Buffer.from('bc'));assert.equal(h.digest(),sha(Buffer.from('abc')));
});

function fileTransport(bytes,options={}){
  const original={request:api.request,download:api.download,getJob:api.getJob},offsets=[];
  const meta={protocol:2,jobId:JOB,size:bytes.length,chunkSize:CHUNK,chunkCount:Math.ceil(bytes.length/CHUNK),sha256:sha(bytes),
    chunkHashes:Array.from({length:Math.ceil(bytes.length/CHUNK)},(_,i)=>sha(bytes.subarray(i*CHUNK,(i+1)*CHUNK)))};
  api.getJob=async()=>({jobId:JOB,kind:'product-export',state:'succeeded'});
  api.request=async route=>route==='/api/capabilities'?{exportFileV2:options.legacy!==true}:options.legacy?{size:bytes.length,chunkSize:4*1024*1024}:meta;
  api.download=async route=>{
    const offset=Number(new URL(route,'https://synthetic.invalid').searchParams.get('offset'));offsets.push(offset);
    if(options.fail)options.fail(offset);
    const part='/synthetic/block-'+offset,block=Buffer.from(bytes.subarray(offset,offset+(options.legacy?4*1024*1024:CHUNK)));
    if(options.corrupt)block[0]^=255;
    files.set(part,block);return part;
  };
  return{meta,offsets,restore:()=>Object.assign(api,original)};
}

test('v2 downloads more than three blocks, checks whole file, indexes it and removes temporary chunks',async()=>{
  const bytes=crypto.randomBytes(CHUNK*3+19),t=fileTransport(bytes),binding=session.capture();
  try{
    const result=await store.downloadJobFile(JOB,binding,'店甲-2026-10-24.xlsx');
    assert.deepEqual(files.get(result),bytes);assert.deepEqual(t.offsets,[0,CHUNK,CHUNK*2,CHUNK*3]);
    assert.equal(result,'/synthetic/export-'+JOB+'/店甲-2026-10-24.xlsx');
    assert.equal([...files.keys()].filter(p=>p.includes('/block-')).length,0);
    assert.equal(cache.validFile(binding,result),true);
    files.get(result)[0]^=255;assert.equal(cache.validFile(binding,result),false,'same-size corruption cannot reuse');
  }finally{t.restore();}
});

test('interruption retains verified prefix and same job resumes without fetching the first block again',async()=>{
  const bytes=crypto.randomBytes(CHUNK*2+11),binding=session.capture();let interrupt=true;
  const t=fileTransport(bytes,{fail:offset=>{if(interrupt && offset===CHUNK)throw session.error('TEST_INTERRUPTED','synthetic interruption');}});
  try{
    await assert.rejects(()=>store.downloadJobFile(JOB,binding,'恢复.xlsx'),e=>e.code==='TEST_INTERRUPTED');
    const checkpoint=storage.get('huoji.download.'+encodeURIComponent(binding.owner)+'.'+JOB);
    assert.equal(checkpoint.offset,CHUNK);assert.equal(files.get(checkpoint.file).length,CHUNK);
    interrupt=false;const result=await store.downloadJobFile(JOB,binding,'恢复.xlsx');
    assert.deepEqual(t.offsets,[0,CHUNK,CHUNK,CHUNK*2]);assert.deepEqual(files.get(result),bytes);
    assert.equal(storage.has('huoji.download.'+encodeURIComponent(binding.owner)+'.'+JOB),false);
  }finally{t.restore();}
});

test('bad chunk rejects before opening and removes partial; forged metadata is not accepted',async()=>{
  const t=fileTransport(crypto.randomBytes(CHUNK+5),{corrupt:true});
  try{
    await assert.rejects(()=>store.downloadJobFile(JOB,session.capture()),e=>e.code==='FILE_CORRUPT');
    assert.equal(files.size,0);t.meta.jobId='other';
    await assert.rejects(()=>store.downloadJobFile(JOB,session.capture()),e=>e.code==='BAD_RESPONSE');
  }finally{t.restore();}
});

test('old large-file protocol and malformed job paths fail closed without fetching bytes',async()=>{
  const t=fileTransport(Buffer.alloc(CHUNK+1),{legacy:true});
  try{
    await assert.rejects(()=>store.downloadJobFile(JOB,session.capture()),e=>e.code==='EXPORT_PROTOCOL');assert.deepEqual(t.offsets,[]);
    await assert.rejects(()=>store.downloadJobFile('../other',session.capture()),e=>e.code==='BAD_RESPONSE');
  }finally{t.restore();}
});

test('a page that left during metadata download does not fetch or return a file',async()=>{
  const t=fileTransport(Buffer.alloc(CHUNK+1));
  try{await assert.rejects(()=>store.downloadJobFile(JOB,session.capture(),undefined,{isCurrent:()=>false}),e=>e.code==='IDENTITY_CHANGED');assert.deepEqual(t.offsets,[]);}
  finally{t.restore();}
});

test('photo downloads deduplicate within account; cache never reuses another account entry',async()=>{
  const binding=session.capture();let requests=0,finish;const route='/api/photos/'+JOB;
  const fetch=()=>{requests++;return new Promise(resolve=>{finish=resolve;});};
  const a=cache.photo(binding,route,fetch),b=cache.photo(binding,route,fetch);
  files.set('/synthetic/source',Buffer.from('image'));finish('/synthetic/source');
  const [first,second]=await Promise.all([a,b]);assert.equal(first,second);assert.equal(requests,1);
  assert.equal(cache.get(binding,route),first);
  session.clear();session.install({user:{id:'other-owner'},token:'b'.repeat(64),expiresAt:Date.now()+60000});
  assert.equal(cache.get(session.capture(),route),null);
});

test('LRU preserves active files and all-account drafts; corrupt references stop cleanup; only indexed app files removed',()=>{
  const binding=session.capture(),paths=['huoji-cache-111.jpg','huoji-cache-222.jpg','huoji-cache-333.jpg'].map(p=>'/synthetic/'+p),holder={};
  paths.forEach((p,i)=>{files.set(p,Buffer.alloc(5));cache.put(binding,'photo:'+i,p);});
  files.set('/synthetic/unrelated.xlsx',Buffer.alloc(20));
  cache.protect(holder,[paths[0]]);storage.set('huoji.draft.v1.other-account.record',{photos:[{path:paths[1]}]});
  try{
    assert.equal(cache.prune(cache.BUDGET-10),true);assert.deepEqual(removed,[paths[2]]);
    assert.equal(files.has('/synthetic/unrelated.xlsx'),true);
    storage.set('huoji.draft.v1.broken',{photos:'broken'});
    assert.equal(cache.prune(cache.BUDGET),false);assert.equal(files.has(paths[0]),true);assert.equal(files.has(paths[1]),true);
  }finally{cache.release(holder);}
});

test('expired indexed exports are cleaned but active exported documents remain until released',()=>{
  const binding=session.capture(),p='/synthetic/export-'+JOB+'.xlsx',holder={};files.set(p,Buffer.alloc(8));cache.put(binding,'export:'+JOB,p,'export');
  const entries=storage.get('huoji.files.v1');entries[0].usedAt=Date.now()-cache.RETENTION-1;storage.set('huoji.files.v1',entries);
  cache.protect(holder,[p]);try{assert.equal(cache.prune(),true);assert.equal(files.has(p),true);}finally{cache.release(holder);}
  assert.equal(cache.prune(),true);assert.equal(files.has(p),false);
});

test('download retry uses same durable job and never submits a duplicate export',async()=>{
  const bytes=Buffer.from('synthetic-xlsx'),t=fileTransport(bytes);const request=api.request;let submissions=0,failed=true;
  api.request=async(route,args)=>{if(route==='/api/export-jobs'){submissions++;return{jobId:JOB};}return request(route,args);};
  const download=api.download;api.download=async route=>{if(failed)throw session.error('TEST_INTERRUPTED','synthetic');return download(route);};
  try{
    await assert.rejects(()=>store.exportInContainer(session.capture(),undefined,{date:'2026-10-24'}),e=>e.code==='TEST_INTERRUPTED');
    failed=false;await store.exportInContainer(session.capture(),undefined,{date:'2026-10-24'});
    assert.equal(submissions,1);
  }finally{t.restore();}
});
