const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {SaxesParser}=require('saxes');
const domain=require('../miniprogram/utils/domain');
const PROJECT='e8eb64bd-4425-4ad8-b7d5-77a3d518685c',OTHER='c5bf0585-5e12-4465-9777-413eb0be3a1d',DAY='2026-10-18';
const plain=value=>JSON.parse(JSON.stringify(value)),tick=()=>new Promise(resolve=>setImmediate(resolve));
const event=(key,value)=>({currentTarget:{dataset:{[key]:value}},detail:{}});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
function item(id,patch={}){return{...domain.emptyFields,id,projectId:PROJECT,name:'杯子 '+id,supplier:'店甲',version:1,photos:[],createdAt:DAY+'T02:00:00.000Z',...patch};}
function setup(options={}){
 let binding={owner:'synthetic-alice',epoch:1};
 const calls=[],navigations=[],admissions=[],toasts=[],timers=new Map();let timerId=0;
 const state={products:options.products || [item('a'),item('b',{supplier:'店乙'})],drafts:options.drafts || [],active:PROJECT,chosen:options.chosen || {projectId:PROJECT,supplier:'店甲',date:DAY},requested:'task',selection:options.selection || [],...options};
 const session={capture:()=>binding,info:()=>({user:{id:binding.owner}}),valid:b=>b===binding,assert:b=>assert.equal(b,binding)};
 const store={activeProject:()=>state.active,consumeMerchant:()=>{const chosen=state.chosen;state.chosen=null;return chosen;},consumeProductView:()=>{const mode=state.requested;state.requested=null;return mode;},rememberedMerchant:()=>null,comparisonScope:options=>(options.date?'day:'+options.date:options.favorite?'favorites':options.projectId)+(options.supplier!==undefined && options.supplier!==null?':supplier:'+JSON.stringify(options.supplier):''),compareSelection:()=>state.selection.slice(),setCompareSelection:(b,scope,ids)=>{session.assert(b);state.selection=Array.from(ids);},rememberMerchantView:(b,view)=>{session.assert(b);state.remembered=plain(view);},selectMerchant:(b,view)=>{session.assert(b);state.active=view.projectId;state.chosen=view;state.requested='task';},drafts:{list:()=>state.drafts,editorUrl:d=>'/pages/editor/index?resume=yes&projectId='+d.projectId+'&draftId='+d.productId}};
 function records(query){return state.products.filter(p=>!p.deletedAt && (!query.get('projectId') || p.projectId===query.get('projectId')) && (!query.get('date') || domain.chinaLocalDate(p.createdAt)===query.get('date')) && (!query.has('supplier') || p.supplier===query.get('supplier')) && (query.get('favorite')!=='yes' || p.favorite));}
 function summary(items){return{total:items.length,confirmed:items.filter(p=>p.confirmed).length,pending:items.filter(p=>!p.confirmed).length,missingPrice:items.filter(p=>p.unitPrice===null).length};}
 const api={request:async(url,args)=>{
  calls.push({url,args});if(state.request){const value=state.request(url,args);if(value!==undefined)return value;}
  const query=new URL(url,'https://synthetic.invalid').searchParams;
  if(url==='/api/projects'){if(state.failProjects)throw new Error('合成离线');return state.projects || [{id:PROJECT,name:'旧内部任务',date:DAY,market:'市场'}];}
  if(url.startsWith('/api/merchant-visits?'))return state.visits || [];
  if(url==='/api/record-days')return[{date:DAY,count:state.products.length}];
  if(url.startsWith('/api/merchants?')){const groups=new Map();for(const p of records(query)){if(!groups.has(p.supplier))groups.set(p.supplier,[]);groups.get(p.supplier).push(p);}return[...groups].map(([supplier,products])=>({supplier,...summary(products)}));}
  if(url.startsWith('/api/products?')){const scope=records(query),matched=domain.filterProducts(scope,query.get('q') || '',query.get('status') || 'all'),start=Number(query.get('cursor') || 0),limit=Number(query.get('limit') || 30);return{items:plain(matched.slice(start,start+limit)),matchedCount:matched.length,summary:summary(scope),nextCursor:start+limit<matched.length?String(start+limit):null};}
  throw new Error('Unexpected synthetic route '+url);
 },download:async()=>'/synthetic/thumbnail.jpg'};
 const background={refresh:async(b,products)=>state.background?state.background(b,products):products};
 const kit={protectedPage:p=>p,requireLogin:()=>true,start:p=>{p._alive=true;return p._seq=(p._seq || 0)+1;},stop:p=>{p._alive=false;p._seq++;},current:(p,b,seq)=>p._alive && b===binding && p._seq===seq,failure:(p,b,seq,error)=>{if(kit.current(p,b,seq))p.setData({error:error.message});},message:(p,error)=>p.setData({error:error.message}),toast:message=>toasts.push(message),confirm:async()=>true};
 const wx={getStorageSync:()=>'',setStorageSync(){},removeStorageSync(){},navigateTo:o=>{navigations.push(o.url);if(o.complete)o.complete();},switchTab:o=>navigations.push(o.url),showActionSheet:o=>o.success({tapIndex:0}),stopPullDownRefresh(){}};
 const merchants={lookup:()=>null,remember(){},beginCapture:(b,id,merchant)=>{session.assert(b);admissions.push({projectId:id,...merchant});},cancelCapture(){state.cancelledCaptures=(state.cancelledCaptures || 0)+1;}};
 const modules={api,session,store,domain,'page-kit':kit,'background-organize':background,'merchant-context':merchants},context={module:{exports:{}},require:id=>modules[id.slice(2)],wx,setTimeout:(fn,ms)=>{const id=++timerId;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id)};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../miniprogram/utils/product-page.js'),'utf8'),context);
 const definition=context.module.exports(),p={...definition,data:plain(definition.data)};p.setData=patch=>Object.assign(p.data,patch);
 return{p,state,calls,navigations,admissions,toasts,timers,api,background,wx,binding:()=>binding,switchAccount:()=>{binding={owner:'synthetic-bob',epoch:2};},runSearch:async()=>{const task=[...timers.values()].find(t=>t.ms===300);assert.ok(task);task.fn();await tick();}};
}

test('explicit merchant workspace uses the chosen day and name across old tasks and keeps unsaved input accessible offline',async()=>{
 const drafts=[{projectId:PROJECT,productId:'draft-a',fields:{supplier:'店甲',name:'草稿一'},photos:[]},{projectId:OTHER,productId:'draft-b',fields:{supplier:'店甲',name:'草稿二'},photos:[]},{projectId:OTHER,productId:'draft-c',fields:{supplier:'店乙'},photos:[]}];
 const h=setup({drafts,products:[item('a'),item('other-task',{projectId:OTHER}),item('b',{supplier:'店乙'})]});await h.p.load();assert.equal(h.p.data.items.length,2);assert.equal(h.p.data.drafts.length,2);assert.equal(h.p.data.project.name,'店甲');
 const query=new URL(h.calls.find(c=>c.url.startsWith('/api/products?')).url,'https://synthetic.invalid').searchParams;assert.equal(query.get('date'),DAY);assert.equal(query.get('supplier'),'店甲');assert.equal(query.has('projectId'),false);
 h.state.failProjects=true;await h.p.load();assert.match(h.p.data.error,/离线/);assert.equal(h.p.data.drafts.length,2);assert.equal(h.p.data.loading,false);h.p.resumeDraft(event('index',1));assert.match(h.navigations.at(-1),/draft-b/);
});

test('date selection from a merchant workspace actually changes to day scope and rejects impossible or future dates',async()=>{
 const h=setup({products:[item('a'),item('old',{createdAt:'2026-10-17T02:00:00.000Z',supplier:'店乙'})]});await h.p.load();await h.p.dateChange({detail:{date:'2026-10-17'}});
 assert.equal(h.p.data.viewMode,'day');assert.equal(h.p.data.supplier,null);assert.equal(h.p.data.merchantDay,false);assert.equal(h.p.data.items[0].id,'old');assert.equal(h.p.scopeQuery(),'date=2026-10-17');
 const count=h.calls.length;for(const date of ['', '2026-02-30','9999-12-31'])await h.p.dateChange({detail:{date}});assert.equal(h.calls.length,count);
});

test('a merchant aggregation delayed by search still supplies the rail without resetting search results',async()=>{
 const wait=deferred();const h=setup({request:url=>url.startsWith('/api/merchants?')?wait.promise:undefined});await h.p.load();h.p.search({detail:{value:'不存在'}});await h.runSearch();assert.equal(h.p.data.items.length,0);
 wait.resolve([{supplier:'店甲',total:1}]);await tick();assert.equal(h.p.data.merchants[0].supplier,'店甲');assert.equal(h.p.data.query,'不存在');assert.equal(h.p.data.items.length,0);assert.equal(h.p.data.matchedCount,0);
});

test('old-day merchant aggregation and product responses cannot overwrite the next date or another account',async()=>{
 const wait=deferred();const h=setup({request:url=>url.startsWith('/api/merchants?') && url.includes('date='+DAY)?wait.promise:undefined,products:[item('a'),item('old',{createdAt:'2026-10-17T02:00:00.000Z',supplier:'店乙'})]});await h.p.load();await h.p.dateChange({detail:{date:'2026-10-17'}});wait.resolve([{supplier:'迟到旧店',total:99}]);await tick();assert.equal(h.p.data.merchants[0].supplier,'店乙');assert.equal(h.p.data.items[0].id,'old');
 const result=deferred(),seq=h.p._seq,binding=h.binding();h.api.request=()=>result.promise;const pending=h.p.fetchPage('',false,binding,seq);h.switchAccount();result.resolve({items:[item('private-old-account')],matchedCount:1});await pending;assert.equal(h.p.data.items[0].id,'old');
});

test('restoring an unfinished comparison restores the selection mode and blocks capture, favorite and export side actions',async()=>{
 const h=setup({selection:['a'],products:[item('a'),item('c')]});await h.p.load();assert.equal(h.p.data.compareMode,true);h.p.edit(event('id','c'));assert.deepEqual(plain(h.p.data.selectedIds),['a','c']);assert.equal(h.navigations.length,0);
 const calls=h.calls.length;await h.p.add();await h.p.toggleFavorite(event('id','a'));h.p.export();assert.equal(h.calls.length,calls);assert.equal(h.navigations.length,0);assert.equal(h.admissions.length,0);
 h.p.clearCompare();assert.equal(h.p.data.compareMode,false);h.p.edit(event('id','a'));assert.match(h.navigations.at(-1),/editor\/index.*id=a/);
});

test('long pressing a comparison card never opens deletion actions; cancelling comparison restores the ordinary menu',async()=>{
 const h=setup({selection:['a'],products:[item('a'),item('c')]});await h.p.load();let menus=0;
 h.wx.showActionSheet=options=>{menus++;options.fail({errMsg:'showActionSheet:fail cancel'});};
 const calls=h.calls.length;await h.p.productActions(event('id','c'));
 assert.equal(menus,0);assert.equal(h.calls.length,calls);assert.deepEqual(plain(h.p.data.selectedIds),['a']);assert.equal(h.p.data.menuId,'');
 h.p.clearCompare();await h.p.productActions(event('id','c'));assert.equal(menus,1);assert.equal(h.calls.length,calls);assert.equal(h.p.data.menuId,'');
});

test('entering management clears comparison in memory and storage for merchant, day and favorites views',async()=>{
 for(const mode of ['task','day','favorites']){
  const h=setup({selection:['a'],requested:mode,chosen:mode==='task'?{projectId:PROJECT,supplier:'店甲',date:DAY}:null,products:[item('a',{favorite:true}),item('c',{favorite:true})]});await h.p.load();if(mode==='day')await h.p.dateChange({detail:{date:DAY}});
  assert.equal(h.p.data.viewMode,mode);assert.equal(h.p.data.compareMode,true);const scope=h.p.scopeQuery();
  h.p.toggleManageMode();assert.equal(h.p.data.manageMode,true);assert.equal(h.p.data.compareMode,false);assert.deepEqual(plain(h.p.data.selectedIds),[]);assert.deepEqual(h.state.selection,[]);assert.equal(h.p.scopeQuery(),scope);
  h.p.edit(event('id','c'));assert.deepEqual(plain(h.p.data.manageIds),['c']);assert.equal(h.navigations.length,0);
  h.p.toggleManageMode();assert.equal(h.p.data.manageMode,false);assert.deepEqual(plain(h.p.data.manageIds),[]);h.p.edit(event('id','a'));assert.match(h.navigations.at(-1),/editor\/index.*id=a/);
  await h.p.load();assert.equal(h.p.data.viewMode,mode);assert.equal(h.p.data.compareMode,false);assert.deepEqual(plain(h.p.data.selectedIds),[]);assert.equal(h.p.scopeQuery(),scope);
 }
});

test('AI filling a missing price refreshes the active filter and authoritative totals instead of retaining a nonmatching card',async()=>{
 const h=setup({products:[item('a')]});await h.p.load();await h.p.status(event('value','missingPrice'));await tick();assert.equal(h.p.data.items.length,1);
 h.state.products=[item('a',{unitPrice:12,version:2})];h.state.background=async(b,products)=>products.map(p=>({...h.state.products.find(x=>x.id===p.id)}));await h.p.refreshOrganization(h.binding(),h.p._seq);await tick();
 assert.equal(h.p.data.status,'missingPrice');assert.equal(h.p.data.items.length,0);assert.equal(h.p.data.matchedCount,0);assert.equal(h.p.data.summary.total,1);assert.equal(h.p.data.summary.missingPrice,0);assert.equal(h.p.data.loading,false);
});

test('AI updates refresh unfiltered totals without collapsing already loaded pages',async()=>{
 const h=setup({chosen:{projectId:PROJECT,supplier:null,date:DAY},products:Array.from({length:40},(_,n)=>item(String(n)))});await h.p.load();await h.p.loadMore();assert.equal(h.p.data.items.length,40);
 h.state.products[0]=item('0',{unitPrice:12,version:2});h.state.background=async(b,products)=>products.map(p=>({...h.state.products.find(x=>x.id===p.id)}));await h.p.refreshOrganization(h.binding(),h.p._seq);await tick();
 assert.equal(h.p.data.items.length,40);assert.equal(h.p.data.summary.missingPrice,39);assert.equal(h.p.data.matchedCount,40);assert.equal(h.p.data.items[0].unitPrice,12);
});

test('AI completion during a management or comparison selection does not erase selected goods or switch the list underneath the user',async()=>{
 for(const mode of ['manageMode','compareMode']){
  const h=setup({products:[item('a')]});await h.p.load();await h.p.status(event('value','missingPrice'));await tick();h.p.setData({[mode]:true,manageIds:['a'],selectedIds:['a']});
  h.state.products=[item('a',{unitPrice:12,version:2})];h.state.background=async(b,products)=>products.map(p=>({...h.state.products.find(x=>x.id===p.id)}));await h.p.refreshOrganization(h.binding(),h.p._seq);
  assert.equal(h.p.data.items[0].id,'a');assert.equal(h.p.data.items[0].unitPrice,null);assert.deepEqual(plain(h.p.data.manageIds),['a']);assert.deepEqual(plain(h.p.data.selectedIds),['a']);
  h.p.setData({manageMode:false,compareMode:false});await h.p.refreshOrganization(h.binding(),h.p._seq);await tick();assert.equal(h.p.data.items.length,0);assert.equal(h.p.data.matchedCount,0);
 }
});

test('returning from editing within the same selected merchant keeps the current search and status',async()=>{
 const h=setup({products:[item('a'),item('b',{supplier:'店乙',confirmed:true})]});await h.p.load();await h.p.merchant(event('supplier','店乙'));await h.p.status(event('value','confirmed'));await tick();h.p.search({detail:{value:'杯子'}});await h.runSearch();
 await h.p.load();assert.equal(h.p.data.supplier,'店乙');assert.equal(h.p.data.query,'杯子');assert.equal(h.p.data.status,'confirmed');assert.equal(h.p.data.items[0].id,'b');
});

test('unnamed and all-merchant contexts choose a merchant rather than using a previous capture, and a named camera carries only that shop',async()=>{
 for(const supplier of [null,'']){const h=setup({chosen:{projectId:PROJECT,supplier,date:DAY}});await h.p.load();await h.p.add();assert.equal(h.admissions.length,0);assert.equal(h.navigations.at(-1),'/pages/projects/index');}
 const h=setup();await h.p.load();h.p.setData({merchantDay:false});await h.p.add();assert.equal(h.admissions[0].supplier,'店甲');assert.equal(h.admissions[0].projectId,PROJECT);assert.match(h.navigations.at(-1),/editor\/index\?projectId=/);
});

test('after changing the date and choosing a merchant, capture resolves its exact owned visit without borrowing the active project',async()=>{
 const visit={supplier:'店乙',supplierContact:'乙店电话',projectId:OTHER,date:DAY};
 const h=setup({products:[item('b',{supplier:'店乙',projectId:OTHER})],visits:[{...visit,date:'2026-10-17',projectId:PROJECT},{...visit,supplier:'店乙分店',projectId:PROJECT},visit],projects:[{id:PROJECT},{id:OTHER}]});await h.p.load();await h.p.dateChange({detail:{date:DAY}});await h.p.merchant(event('supplier','店乙'));
 h.p.search({detail:{value:'杯子'}});await h.runSearch();const before={scope:h.p.scopeQuery(),query:h.p.data.query,status:h.p.data.status,ids:h.p.data.items.map(p=>p.id)};await h.p.add();
 assert.equal(h.admissions.length,1);assert.equal(h.admissions[0].projectId,OTHER);assert.equal(h.admissions[0].supplier,'店乙');assert.equal(h.admissions[0].supplierContact,'乙店电话');assert.match(h.navigations.at(-1),new RegExp('projectId='+OTHER));assert.deepEqual(h.toasts,['新品将记录在今天']);
 assert.equal(h.state.active,PROJECT);assert.equal(h.state.chosen,null);assert.equal(h.p.data.viewMode,'day');assert.deepEqual({scope:h.p.scopeQuery(),query:h.p.data.query,status:h.p.data.status,ids:h.p.data.items.map(p=>p.id)},before);
 const preflight=h.calls.filter(c=>c.url.startsWith('/api/merchant-visits?') || c.url==='/api/projects').slice(-2);assert.equal(preflight[0].url,'/api/merchant-visits?date='+DAY);assert.equal(preflight[1].url,'/api/projects');assert.ok(preflight.every(c=>c.args.identity===h.binding()));
});

test('day capture rejects failed or changed visit and project loads without altering the selected date, filter, or merchant',async()=>{
 const visit={supplier:'店甲',projectId:PROJECT,date:DAY};
 for(const failure of ['visits-offline','wrong-name','wrong-date','bad-project','missing-project','projects-offline']){
  const h=setup({requested:'day',chosen:null,products:[item('a')],visits:[visit]});await h.p.load();await h.p.dateChange({detail:{date:DAY}});await h.p.merchant(event('supplier','店甲'));await h.p.status(event('value','missingPrice'));await tick();
  if(failure==='visits-offline')h.state.request=url=>url.startsWith('/api/merchant-visits?')?Promise.reject(new Error('商户加载失败')):undefined;
  if(failure==='wrong-name')h.state.visits=[{...visit,supplier:'店甲分店'}];if(failure==='wrong-date')h.state.visits=[{...visit,date:'2026-10-17'}];if(failure==='bad-project')h.state.visits=[{...visit,projectId:'invalid'}];if(failure==='missing-project')h.state.projects=[{id:OTHER}];if(failure==='projects-offline')h.state.failProjects=true;
  const before={date:h.p.data.date,scope:h.p.scopeQuery(),status:h.p.data.status,ids:h.p.data.items.map(p=>p.id)};await h.p.add();
  assert.equal(h.admissions.length,0,failure);assert.equal(h.navigations.length,0,failure);assert.equal(h.state.chosen,null);assert.equal(h.p._captureOpening,false);assert.ok(h.p.data.error);assert.deepEqual({date:h.p.data.date,scope:h.p.scopeQuery(),status:h.p.data.status,ids:h.p.data.items.map(p=>p.id)},before,failure);
 }
});

test('day capture double taps and late visits cannot authorize after date, merchant, search, owner or visibility changes',async()=>{
 for(const change of ['date','merchant','search','owner','hide']){
  const wait=deferred(),h=setup({requested:'day',chosen:null,products:[item('a')]});await h.p.load();await h.p.dateChange({detail:{date:DAY}});await h.p.merchant(event('supplier','店甲'));
  h.state.request=url=>url.startsWith('/api/merchant-visits?')?wait.promise:undefined;const start=h.p.add();await h.p.add();assert.equal(h.calls.filter(c=>c.url.startsWith('/api/merchant-visits?')).length,1);
  if(change==='date')await h.p.dateChange({detail:{date:'2026-10-17'}});if(change==='merchant')await h.p.allMerchants();if(change==='search'){h.p.search({detail:{value:'x'}});await h.runSearch();}if(change==='owner')h.switchAccount();if(change==='hide')h.p.onHide();
  wait.resolve([{supplier:'店甲',projectId:PROJECT,date:DAY}]);await start;assert.equal(h.admissions.length,0,change);assert.equal(h.navigations.length,0,change);assert.equal(h.state.chosen,null);assert.equal(h.state.cancelledCaptures || 0,0);assert.equal(h.p._captureOpening,false);
 }
});

test('late project preparation is discarded across owners and navigation failure retires its admission',async()=>{
 const visit={supplier:'店甲',projectId:PROJECT,date:DAY},wait=deferred(),h=setup({requested:'day',chosen:null,visits:[visit]});await h.p.load();await h.p.dateChange({detail:{date:DAY}});await h.p.merchant(event('supplier','店甲'));h.state.request=url=>url==='/api/projects'?wait.promise:undefined;
 const pending=h.p.add();await tick();h.switchAccount();wait.resolve([{id:PROJECT}]);await pending;assert.equal(h.admissions.length,0);assert.equal(h.navigations.length,0);assert.equal(h.p.data.error,'');
 const retry=setup({requested:'day',chosen:null,visits:[visit]});await retry.p.load();await retry.p.dateChange({detail:{date:DAY}});await retry.p.merchant(event('supplier','店甲'));retry.wx.navigateTo=o=>{o.fail();o.complete();};await retry.p.add();assert.equal(retry.admissions.length,1);assert.equal(retry.state.cancelledCaptures,1);assert.equal(retry.p._captureOpening,false);assert.equal(retry.p.data.viewMode,'day');assert.equal(retry.state.chosen,null);
});

test('all or unnamed day contexts select a merchant and a failed historical task reload never authorizes capture',async()=>{
 for(const supplier of [null,'']){const h=setup({requested:'day',chosen:null});await h.p.load();if(supplier!==null)await h.p.merchant(event('supplier',supplier));await h.p.add();assert.equal(h.admissions.length,0);assert.equal(h.navigations.at(-1),'/pages/projects/index');assert.equal(h.calls.some(c=>c.url.startsWith('/api/merchant-visits?')),false);}
 const h=setup();await h.p.load();h.state.failProjects=true;await h.p.add();assert.equal(h.admissions.length,0);assert.equal(h.navigations.length,0);assert.match(h.p.data.error,/离线/);assert.equal(h.p._captureOpening,false);
});

test('product markup exposes one direct export and consistent date navigation without duplicate single-shop headers or capture during comparison',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../miniprogram/pages/products/index.wxml'),'utf8'),errors=[],parser=new SaxesParser({xmlns:false});parser.on('error',e=>errors.push(e.message));parser.write(source.replace(/\s(scroll-x|enhanced|wx:else)(?=\s|\/?>)/g,' $1="true"').replace(/&/g,'&amp;')).close();assert.deepEqual(errors,[]);
 assert.doesNotMatch(source,/class="review-return|class="review-heading|bindtap="exportMerchant"/);assert.match(source,/wx:if="\{\{supplier === null\}\}" class="merchant-heading/);assert.match(source,/viewMode === 'day' \|\| merchantDay/);assert.match(source,/class="product-export" bindtap="export"/);assert.match(source,/\(viewMode === 'task' \|\| viewMode === 'day'\) && !manageMode && !compareMode\}\}" class="capture-strip/);assert.match(source,/drafts.length && !project && viewMode === 'task'/);
});
