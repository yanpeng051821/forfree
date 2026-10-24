const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const domain = require('../miniprogram/utils/domain');
const captureTemplate = require('../miniprogram/utils/capture-template');
const TODAY = domain.chinaLocalDate(), FIRST = '2026-10-18';
const PROJECT = 'e8eb64bd-4425-4ad8-b7d5-77a3d518685c';

function setup(options = {}, settings = {}) {
  let binding = { owner:'synthetic-range-owner',epoch:1 }, definition;
  const calls=[],exports=[];
  const metadata = { columns:[{key:'sku',label:'REF.',width:16}],headerRows:[],documentTitle:'合成表格' };
  const merchants=settings.merchants || [{supplier:'店甲',total:3,confirmed:2},{supplier:'店乙',total:2,confirmed:0},{supplier:'',total:1,confirmed:1}];
  const modules={
    api:{request:async(url,args)=>{
      calls.push({url,args});
      if(settings.request){const result=settings.request(url,args);if(result!==undefined)return result;}
      if(url==='/api/capabilities')return settings.capabilities===undefined?{dateRangeExport:true}:settings.capabilities;
      if(url.startsWith('/api/merchants?'))return merchants;
      if(url.startsWith('/api/export-preview?'))return structuredClone(metadata);
      if(url.startsWith('/api/products?'))return{items:[],matchedCount:6,summary:{total:6,confirmed:3,suppliers:2}};
      if(url==='/api/projects')return[{id:PROJECT,name:'原任务',date:FIRST}];
      throw new Error('Unexpected synthetic route '+url);
    }},
    session:{capture:()=>binding,valid:value=>value===binding,assert:value=>{if(value!==binding)throw Object.assign(new Error('账号已变化'),{code:'IDENTITY_CHANGED'});}},
    store:{drafts:{list:()=>[]},hydratePhotos:async()=>[],exportProject:async(...args)=>{exports.push(args);if(args[3].onFileReady)args[3].onFileReady('/synthetic/exact-range.xlsx');}},
    domain,'capture-template':captureTemplate,
    'page-kit':{protectedPage:value=>value,requireLogin:()=>true,start:p=>{p._alive=true;return p._seq=(p._seq||0)+1;},current:(p,b,seq)=>p._alive && b===binding && p._seq===seq,stop:p=>{p._alive=false;p._seq++;},message:(p,error)=>p.setData({error:error.message}),info(){}},
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../miniprogram/pages/export/index.js'),'utf8'),{Page:value=>definition=value,require:id=>modules[id.split('/').at(-1)]},{filename:'export/index.js'});
  const page={...definition,data:structuredClone(definition.data)};page.setData=patch=>Object.assign(page.data,patch);page.onLoad(options);
  return{page,calls,exports,settings,modules,changeAccount:()=>{binding={owner:'other-synthetic-owner',epoch:2};},binding:()=>binding};
}
const mode=value=>({currentTarget:{dataset:{mode:value}}});
const date=(key,value)=>({currentTarget:{dataset:{key}},detail:{value}});
const params=url=>new URL(url,'https://synthetic.invalid').searchParams;

test('bare export starts at today with all products and shops, counts unnamed merchant sheets and makes no range probe',async()=>{
  const h=setup();await h.page.load();
  assert.equal(h.page.data.dateMode,'day');assert.equal(h.page.data.selectedDate,TODAY);assert.equal(h.page.data.scope,'all');assert.equal(h.page._supplier,undefined);
  assert.equal(h.page.data.exportCount,6);assert.equal(h.page.data.merchantCount,3);assert.equal(h.calls.some(c=>c.url==='/api/capabilities'),false);
  for(const call of h.calls){assert.equal(params(call.url).get('date'),TODAY);assert.equal(params(call.url).has('supplier'),false);assert.equal(call.args.identity,h.binding());}
});

test('range admission probes authenticated capability then uses inclusive endpoints consistently and revokes the old file',async()=>{
  const h=setup({date:FIRST});await h.page.load();h.page._file='/synthetic/old.xlsx';h.page._fileBinding=h.binding();h.page.setData({fileReady:true,fileName:'old.xlsx'});
  const start=h.calls.length;await h.page.changeDateMode(mode('range'));
  assert.equal(h.calls[start].url,'/api/capabilities');assert.equal(h.calls[start].args.identity,h.binding());assert.equal(h.page.data.dateMode,'range');assert.equal(h.page._file,null);assert.equal(h.page._fileBinding,null);assert.equal(h.page.data.fileReady,false);assert.equal(h.page.data.fileName,'');
  for(const call of h.calls.slice(start+1)){const query=params(call.url);assert.equal(query.get('dateFrom'),FIRST);assert.equal(query.get('dateTo'),TODAY);assert.equal(query.has('date'),false);}
  assert.equal(h.page.fileName(),'看货记录-'+FIRST+'至'+TODAY+'.xlsx');assert.equal(h.page.data.exportCount,6);assert.equal(h.page.data.merchantCount,3);
  await h.page.dateChange(date('dateTo',FIRST));assert.equal(params(h.page.baseQuery()).get('dateTo'),null);
  assert.equal(h.page.baseQuery(),'dateFrom='+FIRST+'&dateTo='+FIRST);
});

test('old service missing capability or returning 404 never receives range filters and stays on the selected single day',async()=>{
  for(const settings of [{capabilities:{}},{capabilities:{dateRangeExport:false}},{request:url=>{if(url==='/api/capabilities')throw Object.assign(new Error('404'),{code:'NOT_FOUND'});}}]){
    const h=setup({date:FIRST},settings);await h.page.load();await h.page.changeDateMode(mode('range'));
    assert.equal(h.page.data.dateMode,'day');assert.equal(h.page._date,FIRST);assert.equal(h.page.data.rangeChecking,false);assert.match(h.page.data.dateNotice,/暂不支持日期范围/);
    assert.equal(h.calls.some(c=>c.url.includes('dateFrom') || c.url.includes('dateTo')),false);assert.equal(h.exports.length,0);
  }
});

test('unsupported range deep link blocks preview and export until the user explicitly chooses a single day',async()=>{
  const h=setup({dateFrom:FIRST,dateTo:TODAY},{capabilities:{}});await h.page.load();
  assert.equal(h.calls.length,1);assert.equal(h.calls[0].url,'/api/capabilities');assert.match(h.page.data.error,/不支持日期范围/);assert.equal(h.page.data.exportCount,0);
  await h.page.export({currentTarget:{dataset:{}}});assert.equal(h.exports.length,0);
  await h.page.changeDateMode(mode('day'));assert.equal(h.page._date,FIRST);assert.equal(h.page.data.dateMode,'day');assert.equal(h.page.data.exportCount,6);
  assert.equal(h.calls.slice(1).every(c=>params(c.url).get('date')===FIRST),true);
});

test('invalid, incomplete, reversed and conflicting date scopes fail before business requests',async()=>{
  for(const options of [{date:'2026-02-30'},{dateFrom:'2026-02-30',dateTo:TODAY},{dateFrom:TODAY,dateTo:FIRST},{dateFrom:FIRST},{dateTo:TODAY},{date:FIRST,dateFrom:FIRST,dateTo:TODAY},{projectId:PROJECT,dateFrom:FIRST,dateTo:TODAY},{favorite:'yes',dateFrom:FIRST,dateTo:TODAY},{date:'9999-12-31'}]){
    const h=setup(options);await h.page.load();assert.equal(h.calls.length,0,JSON.stringify(options));assert.ok(h.page.data.error);assert.equal(h.page.data.exportCount,0);
  }
});

test('project and favorites entry keep their original scope and do not expose global date controls',async()=>{
  for(const options of [{projectId:PROJECT},{projectId:PROJECT,date:FIRST},{favorite:'yes'}]){
    const h=setup(options);await h.page.load();assert.equal(h.page.data.dateControls,false);
    const before=h.calls.length;await h.page.changeDateMode(mode('range'));await h.page.dateChange(date('date',TODAY));assert.equal(h.calls.length,before);
    assert.equal(h.calls.some(c=>c.url==='/api/capabilities'),false);
    const query=params('/?'+h.page.baseQuery());assert.equal(query.get(options.projectId?'projectId':'favorite'),options.projectId || 'yes');assert.equal(query.has('dateFrom'),false);
  }
});

test('shop preselection stays exact when absent in a new date, and confirmed merchant counts match only nonempty groups',async()=>{
  const h=setup({date:FIRST,supplier:encodeURIComponent('店甲'),scope:'confirmed'});await h.page.load();assert.equal(h.page.data.merchantCount,1);
  h.settings.merchants=[];h.modules.api.request=async(url,args)=>{h.calls.push({url,args});if(url.startsWith('/api/merchants'))return[];if(url.startsWith('/api/export-preview'))return{columns:[],headerRows:[]};return{items:[],matchedCount:0,summary:{total:0,confirmed:0}};};
  await h.page.dateChange(date('date',TODAY));assert.equal(h.page._supplier,'店甲');assert.equal(h.page.data.supplierLabel,'店甲');assert.equal(h.page.data.exportCount,0);assert.equal(h.page.data.merchantCount,0);
  for(const call of h.calls.filter(c=>c.url.startsWith('/api/products?')))assert.equal(params(call.url).get('supplier'),'店甲');
  const all=setup({date:FIRST,scope:'confirmed'});await all.page.load();assert.equal(all.page.data.merchantCount,2);
});

test('a late previous-date response cannot replace current-day counts, preview, merchant selection or filename',async()=>{
  let finish;
  const h=setup({date:FIRST},{request:url=>{if(url.startsWith('/api/products?') && params(url).get('date')===FIRST)return new Promise(resolve=>finish=resolve);}});
  const old=h.page.load();await new Promise(resolve=>setImmediate(resolve));assert.equal(typeof finish,'function');
  await h.page.dateChange(date('date',TODAY));assert.equal(h.page.data.exportCount,6);const filename=h.page.fileName();
  finish({items:[],matchedCount:99,summary:{total:99,confirmed:99}});await old;
  assert.equal(h.page.data.exportCount,6);assert.equal(h.page.fileName(),filename);assert.equal(h.page._date,TODAY);assert.equal(h.page.data.merchantCount,3);
});

test('double range taps share a single probe and cancelling or changing account prevents late mode activation',async()=>{
  for(const cancel of ['none','day','account']){
    let finish;const h=setup({date:FIRST},{request:url=>{if(url==='/api/capabilities')return new Promise(resolve=>finish=resolve);}});await h.page.load();
    const first=h.page.changeDateMode(mode('range'));await h.page.changeDateMode(mode('range'));assert.equal(h.calls.filter(c=>c.url==='/api/capabilities').length,1);
    if(cancel==='day')await h.page.changeDateMode(mode('day'));if(cancel==='account')h.changeAccount();finish({dateRangeExport:true});await first;
    assert.equal(h.page.data.dateMode,cancel==='none'?'range':'day');if(cancel!=='account')assert.equal(h.page.data.rangeChecking,false);
  }
});

test('returning from a hidden capability probe clears its busy state and ignores its result while a new probe runs',async()=>{
  const pending=[];const h=setup({date:FIRST},{request:url=>url==='/api/capabilities'?new Promise(resolve=>pending.push(resolve)):undefined});await h.page.load();
  const old=h.page.changeDateMode(mode('range'));assert.equal(h.page.data.rangeChecking,true);h.page.onHide();assert.equal(h.page.data.rangeChecking,false);
  h.page.onShow();await new Promise(resolve=>setImmediate(resolve));
  const current=h.page.changeDateMode(mode('range'));assert.equal(pending.length,2);assert.equal(h.page.data.rangeChecking,true);
  pending[0]({dateRangeExport:true});await old;assert.equal(h.page.data.dateMode,'day');assert.equal(h.page.data.rangeChecking,true,'旧探测不能清除新探测的加载状态');
  pending[1]({dateRangeExport:true});await current;assert.equal(h.page.data.dateMode,'range');assert.equal(h.page.data.rangeChecking,false);
});

test('range export passes exact endpoints and complete date filename; a rolled-back service cannot silently export another range',async()=>{
  const h=setup({dateFrom:FIRST,dateTo:TODAY,supplier:encodeURIComponent('长商户'.repeat(35))});await h.page.load();await h.page.export({currentTarget:{dataset:{}}});
  assert.equal(h.exports.length,1);const options=h.exports[0][3];assert.equal(options.date,undefined);assert.equal(options.dateFrom,FIRST);assert.equal(options.dateTo,TODAY);assert.equal(options.scope,'all');assert.ok(options.fileName.endsWith('-'+FIRST+'至'+TODAY+'.xlsx'));assert.ok(Array.from(options.fileName.replace(/\.xlsx$/,'')).length<=75);
  h.page._file=null;h.settings.capabilities={};await h.page.export({currentTarget:{dataset:{}}});assert.equal(h.exports.length,1);assert.match(h.page.data.error,/不支持日期范围/);
});

test('range previews retain separately recorded rows with identical product details',async()=>{
  const products=['record-a','record-b'].map(id=>({...domain.emptyFields,id,name:'同款杯',sku:'SAME',photos:[],projectId:PROJECT,createdAt:'2026-10-18T00:00:00Z'}));
  const h=setup({dateFrom:FIRST,dateTo:TODAY},{request:url=>{if(url.startsWith('/api/products?'))return{items:products,matchedCount:2,summary:{total:2,confirmed:0}};}});await h.page.load();assert.equal(h.page.data.exportCount,2);assert.equal(h.page.data.preview.length,2);assert.notEqual(h.page.data.preview[0].id,h.page.data.preview[1].id);
});

test('store sends exactly the same range through container jobs and authenticated direct download and rejects partial dates',async()=>{
  let definition;const calls=[],binding={},files=[];
  const api={usesContainer:()=>false,download:async(url,b)=>{calls.push({url,b});return'/synthetic/download';},request:async(url,args)=>{calls.push({url,args});throw new Error('STOP_AFTER_SYNTHETIC_JOB');}};
  const modules={api,session:{assert:value=>assert.equal(value,binding)},domain,draft:{},jobs:{},sha256:require('../miniprogram/utils/sha256'),'file-cache':{protect(){},release(){},put(){}}};
  const context={module:{exports:{}},require:id=>modules[id.slice(2)],wx:{getStorageSync:()=>'',env:{USER_DATA_PATH:'/synthetic'},getFileSystemManager:()=>({mkdirSync(){},renameSync:(a,b)=>files.push(b)}),openDocument:o=>o.success()}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../miniprogram/utils/store.js'),'utf8'),context);definition=context.module.exports;
  const options={dateFrom:FIRST,dateTo:TODAY,supplier:'',scope:'confirmed',images:false};
  await definition.exportProject(binding,undefined,false,options);const direct=params(calls[0].url);assert.equal(direct.get('dateFrom'),FIRST);assert.equal(direct.get('dateTo'),TODAY);assert.equal(direct.has('date'),false);assert.equal(direct.get('supplier'),'');assert.equal(direct.get('scope'),'confirmed');assert.ok(files[0].endsWith('看货记录-'+FIRST+'至'+TODAY+'.xlsx'));
  await assert.rejects(()=>definition.exportInContainer(binding,undefined,options),/STOP_AFTER_SYNTHETIC_JOB/);const job=calls[1].args.data;for(const [key,value]of Object.entries(job))assert.equal(direct.get(key),String(value));assert.equal(Object.hasOwn(job,'date'),false);
  for(const invalid of [{dateFrom:FIRST},{dateTo:TODAY},{date:FIRST,dateFrom:FIRST,dateTo:TODAY},{dateFrom:'2026-02-30',dateTo:TODAY},{dateFrom:TODAY,dateTo:FIRST}])await assert.rejects(()=>definition.exportInContainer(binding,undefined,invalid),/起止日期/);
  assert.equal(calls.length,2);
});

test('returning keeps generated file and timestamp for same snapshot; changed product version or account invalidates it',async()=>{
  let version=1;
  const h=setup({date:FIRST},{request:url=>url.startsWith('/api/export-preview?')?{columns:[],headerRows:[],templateVersion:1,snapshot:[['synthetic-product',version]]}:undefined});
  await h.page.load();await h.page.export({currentTarget:{dataset:{}}});const file=h.page._file,time=h.page.data.generatedAt;
  assert.equal(h.page.data.fileReady,true);h.page.onHide();await h.page.load(true);
  assert.equal(h.page._file,file);assert.equal(h.page.data.generatedAt,time);assert.equal(h.exports.length,1);
  version++;await h.page.load(true);assert.equal(h.page._file,null);assert.equal(h.page.data.fileReady,false);
  await h.page.export({currentTarget:{dataset:{}}});h.changeAccount();await h.page.load(true);assert.equal(h.page._file,null);
});

test('metadata counts and company footer remain exact; confirmed/format changes revoke the file',async()=>{
  const footer={paymentTerms:'原文条款，不代表下单',shippingMark:'客户唛头',packingRequirements:'标签要求'};
  const h=setup({date:FIRST},{request:url=>url.startsWith('/api/export-preview?')?{columns:[],headerRows:[],counts:{products:2,merchants:1,missingPrice:1,missingQuantity:2,missingVolume:2,photos:6},footer}:undefined});
  await h.page.load();assert.equal(h.page.data.exportCount,2);assert.equal(h.page.data.merchantCount,1);
  assert.equal(h.page.data.templateFooter.paymentTerms,footer.paymentTerms);assert.equal(h.page.data.missingCounts.missingPrice,1);
  await h.page.export({currentTarget:{dataset:{}}});assert.equal(h.page.data.fileReady,true);
  await h.page.format({currentTarget:{dataset:{value:'text'}}});assert.equal(h.page.data.fileReady,false);assert.equal(h.page.data.fileName,'');
  await h.page.export({currentTarget:{dataset:{}}});await h.page.scope({currentTarget:{dataset:{value:'confirmed'}}});assert.equal(h.page.data.fileReady,false);
});
