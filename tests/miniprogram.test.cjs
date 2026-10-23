const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
// These page lifecycle tests mock the explicit desktop loopback API. Cloud-only
// production behavior is independently exercised by container-transport.test.cjs.
const configPath=require.resolve('../miniprogram/config');
const productionConfig=require(configPath);
require.cache[configPath].exports=Object.freeze({...productionConfig,USE_LOCAL_API:true});
const session = require('../miniprogram/utils/session');
const domain = require('../miniprogram/utils/domain');
const draft = require('../miniprogram/utils/draft');
const api = require('../miniprogram/utils/api');
const store = require('../miniprogram/utils/store');
const gate = require('../miniprogram/utils/auth-gate');
const PROJECT = 'e8eb64bd-4425-4ad8-b7d5-77a3d518685c';
const PRODUCT = 'c5bf0585-5e12-4465-9777-413eb0be3a1d';
let storage, files, removed, requests, navigations, currentPages, launches, tabChanges;
function install(owner = 'alice', letter = 'a') { session.install({ user: { id: owner }, token: letter.repeat(64), expiresAt: Date.now() + 60000 }); return session.capture(); }
function page(relative) {
  let definition;
  global.Page = value => { definition = value; };
  const filename = require.resolve('../miniprogram/' + relative); delete require.cache[filename]; require(filename);
  const instance = Object.assign({}, definition, { data: structuredClone(definition.data) });
  instance.route = relative.replace(/\.js$/, ''); currentPages = [instance];
  instance.setData = patch => Object.entries(patch).forEach(([key, value]) => {
    const keys = key.split('.'); let target = instance.data;
    for (const part of keys.slice(0, -1)) target = target[part];
    target[keys.at(-1)] = value;
  });
  return instance;
}
function editor() {
  const p = page('pages/editor/index.js');
  p.onLoad({ projectId: PROJECT }); p._draftProductId='';p.setData({autoOrganize:false});p._alive = true; p._initialized = true; p._binding = session.capture();
  p.setData({ ready: true, fields: { ...domain.emptyFields, name: '杯子', supplier:'测试商户' }, modelKnown: true });
  return p;
}
test('fast capture saves original text before enqueue; failure still continues without duplicate draft',async()=>{
  const p=editor();p.setData({autoOrganize:true,fields:{...domain.emptyFields,supplier:'演示',description:'品名：陶瓷杯，商户：演示'}});
  const original=api.request,order=[];let saved;
  api.request=async(url,options)=>{
    order.push(url);
    if(url==='/api/products'){saved=options.data;return{...saved.fields,id:PRODUCT,projectId:PROJECT,version:1,photos:[]};}
    if(url.endsWith('/organize'))throw new Error('暂不可用');
    throw new Error(url);
  };
  wx.pageScrollTo=()=>{};
  try{
    await p.saveNext();assert.deepEqual(order,['/api/products','/api/products/'+PRODUCT+'/organize']);
    assert.equal(saved.fields.description,'品名：陶瓷杯，商户：演示');assert.equal(saved.fields.name,'未命名商品');
    assert.equal(p.data.ready,true);assert.equal(p.data.fields.name,'');assert.equal(p.data.editing,false);
    assert.equal(draft.list(session.capture()).length,0);
  }finally{api.request=original;}
});
test('product text renders before slow thumbnail downloads; late organization cannot roll back manual edits',async()=>{
  const p=page('pages/products/index.js');p._alive=true;p._seq=1;p._coverCache=new Map();p.setData({project:{id:PROJECT}});
  const binding=session.capture(),original=api.request,download=api.download,background=require('../miniprogram/utils/background-organize'),refresh=background.refresh;
  const product={...domain.emptyFields,id:PRODUCT,projectId:PROJECT,name:'即时文字',version:1,photos:[{id:domain.uuid()}]};
  let complete,finish;
  api.request=async()=>({items:[product],nextCursor:null});api.download=()=>new Promise(r=>{complete=r;});background.refresh=async(_,items)=>items;
  try{
    await p.fetchPage('',false,binding,1);assert.equal(p.data.items[0].name,'即时文字');assert.equal(p.data.products[0].cover,'');
    complete('/temp/thumbnail.jpg');await new Promise(r=>setImmediate(r));assert.equal(p.data.products[0].cover,'/temp/thumbnail.jpg');
    background.refresh=()=>new Promise(r=>{finish=r;});const running=p.refreshOrganization(binding,1);
    p.setData({products:[{...product,name:'刚刚修改',version:4}]});finish([{...product,name:'迟到旧值',version:3}]);await running;
    assert.equal(p.data.products[0].name,'刚刚修改');assert.equal(p.data.products[0].version,4);
  }finally{api.request=original;api.download=download;background.refresh=refresh;clearTimeout(p._organizeTimer);}
});
test('background status resolves missing jobs and discards stale local state after manual edits',async()=>{
  const background=require('../miniprogram/utils/background-organize'),original=api.getJob;
  const binding=session.capture(),product={...domain.emptyFields,id:PRODUCT,projectId:PROJECT,version:2,photos:[],organizeJobId:domain.uuid(),organizeState:'queued'};
  api.getJob=async()=>{throw session.error('NOT_FOUND','任务不存在');};
  try{
    const result=await background.refresh(binding,[product]);assert.equal(result[0].organizePending,false);assert.match(result[0].organizeLabel,/未完成/);
    const done=await background.refresh(binding,[{...product,organizeState:'done',version:3}]);assert.equal(done[0].organizeLabel,'');
    const changed={...product,version:4};delete changed.organizeJobId;delete changed.organizeState;
    const edited=await background.refresh(binding,[changed]);assert.equal(edited[0].organizePending,false);assert.equal(edited[0].organizeLabel,'');
  }finally{api.getJob=original;}
});
test('background model login recovers once and retries the same saved product without creating another',async()=>{
  const background=require('../miniprogram/utils/background-organize'),binding=session.capture();
  const saved={...domain.emptyFields,id:PRODUCT,projectId:PROJECT,name:'已保存原始记录',version:3,photos:[],organizeJobId:domain.uuid(),organizeState:'failed'};
  const getJob=api.getJob,request=api.request,restore=api.restoreModelSession;let recoveries=0,submits=0;
  api.getJob=async id=>({jobId:id,state:'failed',error:{code:'MODEL_LOGIN_REQUIRED',message:'需重新验证微信身份'}});
  api.restoreModelSession=async()=>{recoveries++;};
  api.request=async(url,options)=>{
    if(url.endsWith('/organize')){submits++;assert.equal(options.data.version,3);return{jobId:domain.uuid(),state:'pending',product:{...saved,version:4,organizeState:'queued'}};}
    return saved;
  };
  try{
    const result=await background.refresh(binding,[saved]);assert.equal(recoveries,1);assert.equal(submits,1);assert.equal(result[0].organizePending,true);
    await background.refresh(binding,[saved]);assert.equal(recoveries,1);assert.equal(submits,1);
  }finally{api.getJob=getJob;api.request=request;api.restoreModelSession=restore;}
});
beforeEach(() => {
  gate.hide();
  storage = new Map(); files = new Set(); removed = []; requests = []; navigations = 0;
  currentPages = []; launches = []; tabChanges = [];
  global.getCurrentPages = () => currentPages;
  global.wx = {
    getStorageSync: k => storage.has(k) ? structuredClone(storage.get(k)) : '',
    setStorageSync: (k, v) => storage.set(k, JSON.parse(JSON.stringify(v))),
    removeStorageSync: k => storage.delete(k), getStorageInfoSync: () => ({ keys: [...storage.keys()] }),
    saveFile: o => { const file = '/saved/' + files.size; files.add(file); o.success({ savedFilePath: file }); },
    removeSavedFile: o => { files.delete(o.filePath); removed.push(o.filePath); },
    getFileSystemManager: () => ({ accessSync: p => { if (!files.has(p)) throw new Error('missing'); } }),
    showModal: o => o.success({ confirm: true }), showToast() {}, navigateBack() { navigations++; }, switchTab() {}, navigateTo() {},
    reLaunch: o => { launches.push(o.url); currentPages = [{ route: o.url.slice(1) }]; if (o.complete) o.complete(); },
    hideTabBar: () => tabChanges.push('hide'), showTabBar: () => tabChanges.push('show'),
    getAccountInfoSync: () => ({ miniProgram: { envVersion: 'develop' } }), getDeviceInfo: () => ({ platform: 'devtools' }),
    request: o => { requests.push(o); o.success({ statusCode: 200, data: o.url.endsWith('/api/config') ? { modelEnabled: false } : [] }); },
    uploadFile: o => o.success({ statusCode: 201, data: JSON.stringify({ id: domain.uuid(), name: '照片', url: '/api/photos/x' }) }),
    downloadFile: o => o.success({ statusCode: 200, tempFilePath: '/temp/download' }),
    openDocument: o => o.success(), shareFileMessage: o => o.success(),
    login: o => o.success({ code: 'mock-code' })
  };
  session.clear(); install();
});

test('numeric contract keeps unknowns null and rejects guessed or invalid quantities', () => {
  assert.equal(domain.validateFields({ name: '杯', unitPrice: '' }).unitPrice, null);
  assert.equal(domain.validateFields({ name: '杯', weightG: '0.3', moq: '100' }).moq, 100);
  for (const change of [{ unitPrice: -1 }, { moq: 1.5 }, { cartonQty: 0 }, { weightG: 'abc' }, { unitPrice: true }]) assert.throws(() => domain.validateFields({ name: '杯', ...change }));
});

function procurementDoc() {
  return { id: PRODUCT, version: 1, name: '测试采购', suppliers: [], lines: [], summary: { sourceAmount: 0, amount: null } };
}
test('采购选择Excel后回到页面仍可导入，返回不会重复加载或丢失结果', async () => {
  const p = page('pages/procurement/index.js'); p.onLoad({}); p._alive = true; p._owner = 'alice';
  let picker, uploads = 0; wx.chooseMessageFile = options => { picker = options; };
  wx.uploadFile = options => { uploads++; assert.equal(options.name, 'workbook'); options.success({ statusCode: 201, data: JSON.stringify(procurementDoc()) }); };
  const work = p.importFile(); p.onHide(); p.onShow();
  assert.equal(p._picking, true); assert.equal(requests.length, 0);
  picker.success({ tempFiles: [{ name: '测试.xlsx', path: '/temp/test.xlsx', size: 100 }] });
  await work; assert.equal(uploads, 1); assert.equal(p.data.doc.id, PRODUCT); assert.equal(p.data.busy, false);
});
test('采购页面关闭或换账号后，文件选择回调不会上传上个账号的文件', async () => {
  for (const unload of [true, false]) {
    install(); const p = page('pages/procurement/index.js'); p.onLoad({}); p._alive = true; p._owner = 'alice';
    let picker, uploads = 0; wx.chooseMessageFile = options => { picker = options; }; wx.uploadFile = () => { uploads++; };
    const work = p.importFile(); if (unload) p.onUnload(); else install('bob', 'b');
    picker.success({ tempFiles: [{ name: 'test.xlsx', path: '/temp', size: 100 }] });
    await work; assert.equal(uploads, 0); assert.equal(p.data.doc, null);
  }
});
test('采购编辑弹层在重新显示时保留同账号表单，换账号立即清除私有内容', async () => {
  const p = page('pages/procurement/index.js'); p.onLoad({ id: PRODUCT }); p._alive = true; p._owner = 'alice';
  p.setData({ doc: procurementDoc(), editing: { id: 'line', supplier: '私人商户' }, form: { cartons: '3' } });
  p.onHide(); p.onShow(); assert.equal(p.data.form.cartons, '3'); assert.equal(p.data.editing.supplier, '私人商户');
  install('bob', 'b'); p.onHide(); p.onShow(); await Promise.resolve();
  assert.equal(p.data.editing, null); assert.equal(p.data.doc, null); assert.equal(p._id, '');
});
function tableForm() {
  return { version: 1, company: '公司', companyEnglish: 'COMPANY', address: '', contact: '', documentTitle: '采购记录', paymentTerms: '', shippingMark: '', packingRequirements: '',
    columns: [{ key: 'sku', label: '货号', enabled: true, width: 12 }, { key: 'image', label: '图片', enabled: true, width: 22 }], customFields: [],
    layout: { headerRows: [{ key: 'company', label: '中文公司名', enabled: true, font: '宋体', size: 26, height: 33, bold: true, align: 'center' }], latinFont: 'Times New Roman', chineseFont: '宋体', alignment: 'center', border: 'thin', orientation: 'landscape', paper: 'A4', printMode: 'fit' } };
}
test('表格设置保存多行样式、列宽和顺序，临时隐藏保留未保存设置', async () => {
  const p = page('pages/table-settings/index.js'); p._alive = true; p._seq = 1; p._owner = 'alice'; p._binding = session.capture(); p._version = 1;
  const form = tableForm(); form.columns[0].width = 11.4666666666667;
  form.customFields = [{ key: 'client_ref', label: '客户编号', width: 20 }, { key: 'inspection', label: '验货要求', width: 24 }];
  p.setData({ form, fields: form.columns }); p.refresh();
  assert.equal(p.data.fields[0].widthText, 11.47); assert.equal(p.data.fields[0].width, 11.4666666666667);
  p.moveCustom({ currentTarget: { dataset: { index: 0, direction: 1 } } });
  p.headerInput({ currentTarget: { dataset: { key: 'size' } }, detail: { value: '24' } });
  p.columnWidth({ currentTarget: { dataset: { index: 0 } }, detail: { value: '18' } });
  p.moveColumn({ currentTarget: { dataset: { index: 0, direction: 1 } } });
  p.onHide(); p.onShow(); assert.equal(requests.length, 0); assert.equal(p.data.rowEditor.size, 24);
  let command; wx.request = o => { command = o.data; o.success({ statusCode: 200, data: { ...o.data.fields, version: 2 } }); };
  await p.save(); assert.equal(command.fields.layout.headerRows[0].size, 24); assert.equal(command.fields.columns[1].width, 18); assert.equal(command.fields.columns[0].key, 'image'); assert.equal(command.fields.customFields[0].key, 'inspection'); assert.equal(p._dirty, false);
});
test('从Excel读取公司模板不会创建采购记录或自动保存，换账号清除模板', async () => {
  const p = page('pages/table-settings/index.js'); p._alive = true; p._owner = 'alice';
  let picker, destination; wx.chooseMessageFile = o => { picker = o; };
  wx.uploadFile = o => { destination = o.url; o.success({ statusCode: 200, data: JSON.stringify(tableForm()) }); };
  const work = p.importReference(); p.onHide(); p.onShow(); picker.success({ tempFiles: [{ name: '公司.xlsx', path: '/temp/company.xlsx', size: 50 }] }); await work;
  assert.ok(destination.endsWith('/api/procurement-template/import')); assert.equal(p.data.form.company, '公司'); assert.equal(p._dirty, true); assert.equal(requests.length, 0);
  install('bob', 'b'); p.onHide(); p.onShow(); assert.equal(p.data.form, null);
});
test('AI merge never overwrites user values or converts unknowns into estimates', () => {
  const result = domain.mergeExtraction({ ...domain.emptyFields, name: '人工名称', unitPrice: 12 }, { name: 'AI名称', unitPrice: 15, weightG: null, moq: 100, supplier: '明确商户' });
  assert.equal(result.fields.name, '人工名称'); assert.equal(result.fields.unitPrice, 12); assert.equal(result.fields.weightG, null); assert.equal(result.fields.moq, 100); assert.equal(result.fields.supplier, '明确商户');
  assert.deepEqual(result.conflicts, ['name', 'unitPrice']);
});
test('request key is stable for identical semantic payload and changes for edited values', () => {
  const a = domain.requestFor({ name: '杯', price: 12 });
  assert.equal(domain.requestFor({ price: 12, name: '杯' }, a).requestKey, a.requestKey);
  assert.notEqual(domain.requestFor({ price: 15, name: '杯' }, a).requestKey, a.requestKey);
  assert.match(a.requestKey, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
});
test('drafts isolate account and project and preserve only persistent photo paths', () => {
  const a = session.capture();
  draft.write(a, PROJECT, '', { fields: { name: '杯' }, photos: [{ id: 'cloud', path: '/temp', persistent: false }], pendingCommand: { requestKey: 'same' } });
  assert.equal(draft.read(a, PROJECT, '').photos[0].path, '');
  const b = install('bob', 'b'); assert.equal(draft.read(b, PROJECT, ''), null); assert.equal(draft.list(b).length, 0);
  assert.throws(() => draft.read(a, PROJECT, ''), /登录状态/);
  const again = install('alice'); assert.equal(draft.read(again, PROJECT, '').fields.name, '杯'); assert.equal(draft.read(again, 'other', ''), null);
});
test('persistent photo failure rolls back newly created files without deleting existing draft', async () => {
  const binding = session.capture(); let count = 0;
  draft.write(binding, PROJECT, '', { fields: { name: '已有草稿' }, photos: [] });
  wx.saveFile = o => { count++; if (count === 2) return o.fail(); files.add('/saved/one'); o.success({ savedFilePath: '/saved/one' }); };
  await assert.rejects(() => draft.persistPhotos([{ tempFilePath: '/a', size: 10 }, { tempFilePath: '/b', size: 10 }], binding), /保存在本机/);
  assert.deepEqual(removed, ['/saved/one']); assert.equal(draft.read(binding, PROJECT, '').fields.name, '已有草稿');
});
test('late photo persistence after logout cannot enter another account draft', async () => {
  const binding = session.capture(); let pending;
  wx.saveFile = o => { pending = o; };
  const result = draft.persistPhotos([{ tempFilePath: '/a', size: 10 }], binding);
  install('bob', 'b'); pending.success({ savedFilePath: '/saved/old-user' });
  await assert.rejects(() => result, /登录状态/); assert.ok(removed.includes('/saved/old-user'));
});
test('late API result is rejected after identity changes and token is never in URL', async () => {
  let pending; wx.request = o => { pending = o; };
  const result = api.request('/api/projects');
  assert.equal(pending.header.Authorization, 'Bearer ' + 'a'.repeat(64)); assert.ok(!pending.url.includes('a'.repeat(64)));
  install('bob', 'b'); pending.success({ statusCode: 200, data: [{ name: 'alice-private' }] });
  await assert.rejects(() => result, e => e.code === 'IDENTITY_CHANGED');
});
test('download and upload carry session headers and expired media is distinguished from network errors', async () => {
  const binding = session.capture(); let downloaded;
  wx.downloadFile = o => { downloaded = o; o.success({ statusCode: 404 }); };
  await assert.rejects(() => api.download('/api/photos/id', binding), e => e.code === 'NOT_FOUND');
  assert.equal(downloaded.header.Authorization, 'Bearer ' + binding.token);
  let uploaded; wx.uploadFile = o => { uploaded = o; o.success({ statusCode: 201, data: '{"id":"photo"}' }); };
  await api.upload('/saved/image', binding); assert.equal(uploaded.name, 'photo'); assert.equal(uploaded.header.Authorization, 'Bearer ' + binding.token);
});
test('restore detects missing unsaved photos instead of silently discarding them', async () => {
  const result = await store.hydratePhotos([{ id: '', path: '/saved/missing', persistent: true }], session.capture());
  assert.equal(result.length, 1); assert.equal(result[0].error, true); assert.equal(result[0].path, '');
});
test('unknown save replays original command before updating same product with later changes', async () => {
  const p = editor(); const sent = [];
  wx.request = o => {
    sent.push(structuredClone(o.data));
    if (sent.length === 1) return o.fail();
    o.success({ statusCode: 201, data: { id: PRODUCT, version: sent.length === 2 ? 1 : 2, ...o.data.fields, photos: [] } });
  };
  await p.save(); assert.equal(p.data.pending, true); assert.equal(navigations, 0);
  const stored = draft.read(p._binding, PROJECT, ''); assert.equal(stored.pendingCommand.requestKey, sent[0].requestKey);
  p.input({ currentTarget: { dataset: { key: 'name' } }, detail: { value: '修改后的杯子' } });
  await p.save(); assert.equal(sent[1].requestKey, sent[0].requestKey); assert.equal(sent[1].fields.name, '杯子');
  assert.equal(p.data.fields.name, '修改后的杯子'); assert.equal(p._productId, PRODUCT); assert.equal(p.data.pending, false);
  await p.save(); assert.equal(sent[2].id, PRODUCT); assert.equal(sent[2].version, 1); assert.notEqual(sent[2].requestKey, sent[0].requestKey); assert.equal(sent[2].fields.name, '修改后的杯子'); assert.equal(navigations, 1);
  assert.equal(draft.read(p._binding, PROJECT, ''), null);
});
test('AI late result does not overwrite fields edited while request is in flight', async () => {
  const p = editor(); p.setData({ 'fields.description': '杯子，起订10件' }); let pending;
  wx.request = o => { pending = o; };
  const result = p.organize(); await Promise.resolve();
  p.input({ currentTarget: { dataset: { key: 'name' } }, detail: { value: '我刚修改的名称' } });
  pending.success({ statusCode: 200, data: { fields: { name: '旧AI结果', moq: 10 }, mode: 'rules', warning: '' } });
  await result; assert.equal(p.data.fields.name, '我刚修改的名称'); assert.equal(p.data.fields.moq, null); assert.match(p.data.notice, /结果未写入/);
});
test('upload completion preserves photos edited while recognition is running', async () => {
  const p = editor(); files.add('/saved/one'); files.add('/saved/two');
  p.setData({ photos: [{ id: '', name: 'one', path: '/saved/one', persistent: true }] });
  let pending; wx.uploadFile = o => { pending = o; };
  const uploading = p.ensureUploads();
  p.removePhoto({ currentTarget: { dataset: { index: 0 } } });
  p.setData({ photos: [{ id: '', name: 'two', path: '/saved/two', persistent: true }] });
  pending.success({ statusCode: 201, data: '{"id":"uploaded-one","name":"one"}' });
  await uploading;
  assert.equal(p.data.photos.length, 1); assert.equal(p.data.photos[0].path, '/saved/two'); assert.equal(p.data.photos[0].id, '');
  assert.equal(draft.read(p._binding, PROJECT, '').photos[0].path, '/saved/two');
});
test('draft storage failure prevents sending an unrecorded save request', async () => {
  const p = editor(); let sent = false;
  wx.setStorageSync = () => { throw new Error('quota'); }; wx.request = () => { sent = true; };
  await p.save(); assert.equal(sent, false); assert.equal(p.data.ready, true); assert.match(p.data.error, /存储空间/);
});
test('version conflict keeps local fields and draft instead of blind retry', async () => {
  const p = editor(); p._productId = PRODUCT; p._version = 1;
  wx.request = o => o.success({ statusCode: 409, data: { error: { code: 'CONFLICT', message: '版本已更新' } } });
  await p.save(); assert.equal(p.data.fields.name, '杯子'); assert.equal(navigations, 0); assert.equal(p._version, 1); assert.match(p.data.notice, /较新版本/); assert.ok(draft.read(p._binding, PROJECT, ''));
});
test('corrupt draft can be discarded without crossing account file ownership', () => {
  const binding = session.capture(), storageKey = draft.key(binding.owner, PROJECT, '');
  storage.set(storageKey, { format: 99, owner: binding.owner, projectId: PROJECT, photos: [{ persistent: true, path: '/saved/corrupt' }] });
  files.add('/saved/corrupt');
  assert.throws(() => draft.read(binding, PROJECT, ''), e => e.code === 'DRAFT_CORRUPT');
  draft.discard(binding, PROJECT, '');
  assert.equal(storage.has(storageKey), false); assert.equal(files.has('/saved/corrupt'), false);
  storage.set(storageKey, { format: 99, owner: 'bob', projectId: PROJECT, photos: [{ persistent: true, path: '/saved/bob' }] });
  files.add('/saved/bob'); draft.discard(binding, PROJECT, '');
  assert.equal(files.has('/saved/bob'), true, 'cannot delete a corrupt value whose owner cannot be verified');
});
test('corrupt retired list is unblocked without touching unknown files', () => {
  const binding = session.capture(), storageKey = draft.key(binding.owner, PROJECT, '');
  storage.set(storageKey, { format: 1, owner: binding.owner, projectId: PROJECT, fields: { name: '杯' }, photos: [], retired: 'bad' });
  files.add('/saved/unknown'); assert.throws(() => draft.read(binding, PROJECT, ''), e => e.code === 'DRAFT_CORRUPT');
  draft.discard(binding, PROJECT, ''); assert.equal(files.has('/saved/unknown'), true); assert.equal(storage.has(storageKey), false);
});
test('China local date and paged product response contracts are stable', () => {
  assert.equal(domain.chinaLocalDate(new Date('2026-10-15T16:30:00Z')), '2026-10-16');
  assert.deepEqual(domain.productPage([{ id: 'old' }]), { items: [{ id: 'old' }], nextCursor: null, legacy: true });
  assert.deepEqual(domain.productPage({ items: [{ id: 'new' }], nextCursor: 'cursor' }), { items: [{ id: 'new' }], nextCursor: 'cursor', legacy: false });
  assert.throws(() => domain.productPage({ items: {}, nextCursor: null }), /响应无效/);
});
test('pending project snapshot locks later edits until the original request is checked', () => {
  const p = page('pages/projects/index.js');
  p._pending = { requestKey: domain.uuid(), name: '旧任务', market: '一区', date: '2026-10-16' };
  p.setData({ pending: true, name: '旧任务', market: '一区', date: '2026-10-16' });
  p.input({ currentTarget: { dataset: { key: 'name' } }, detail: { value: '不应写入' } });
  p.dateChange({ detail: { value: '2026-10-20' } });
  assert.equal(p.data.name, '旧任务'); assert.equal(p.data.date, '2026-10-16');
});
function assertBoundDirectives(markup, filename) {
  // Count every directive, including malformed/unquoted attributes. The old quoted-only
  // regex skipped wx:if={{value}}, letting a native compilation error pass the test.
  const directive = /\bwx:(if|elif|for|show)\s*=\s*/g;
  for (const match of markup.matchAll(directive)) {
    const rest = markup.slice(match.index + match[0].length);
    const quote = rest[0];
    assert.ok(quote === '"' || quote === "'", filename + ': wx:' + match[1] + ' 属性必须有引号');
    const end = rest.indexOf(quote, 1);
    assert.ok(end > 0, filename + ': 属性引号未闭合');
    const value = rest.slice(1, end);
    assert.match(value, /^\{\{[\s\S]+\}\}$/, filename + ': wx:' + match[1] + ' 必须绑定完整 {{ }} 表达式');
  }
  for (const image of markup.matchAll(/<image\b[^>]*>/g)) {
    const source = image[0].match(/\bsrc\s*=\s*(["'])([\s\S]*?)\1/);
    assert.ok(source && source[2].trim(), filename + ': image src 必须填写路径或绑定表达式，空属性会请求 true');
  }
}
test('template guard rejects the actual unquoted replacement regression and literal conditions', () => {
  assert.throws(() => assertBoundDirectives('<view wx:if={{loggedIn}} />', 'broken.wxml'), /引号/);
  assert.throws(() => assertBoundDirectives('<view wx:if="!loggedIn" />', 'broken.wxml'), /表达式/);
  assert.throws(() => assertBoundDirectives('<view wx:elif="{{ready}" />', 'broken.wxml'), /表达式/);
  assert.throws(() => assertBoundDirectives('<image class="step-icon" src />', 'broken.wxml'), /src/);
  assert.doesNotThrow(() => assertBoundDirectives('<view wx:if="{{loggedIn}}" /><view wx:elif="{{!loading}}" />', 'valid.wxml'));
});
test('client manifest resolves page files and all WXML event handlers', () => {
  const root = path.resolve(__dirname, '../miniprogram'); const manifest = JSON.parse(fs.readFileSync(path.join(root, 'app.json')));
  for (const entry of manifest.pages) {
    for (const extension of ['js', 'json', 'wxml']) assert.ok(fs.existsSync(path.join(root, entry + '.' + extension)), entry + '.' + extension);
    const p = page(entry + '.js'), markup = fs.readFileSync(path.join(root, entry + '.wxml'), 'utf8');
    for (const match of markup.matchAll(/(?:bind|catch)[\w:]*="([a-zA-Z][\w]*)"/g)) assert.equal(typeof p[match[1]], 'function', entry + ': ' + match[1]);
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'project.config.json'))).setting.urlCheck, true);
  assert.equal(manifest.lazyCodeLoading, 'requiredComponents');
  for (const entry of manifest.pages) {
    const markup = fs.readFileSync(path.join(root, entry + '.wxml'), 'utf8');
    assertBoundDirectives(markup, entry);
  }
  const dateRail = fs.readFileSync(path.join(root, 'components/date-rail/index.wxml'), 'utf8');
  assertBoundDirectives(dateRail, 'components/date-rail/index');
});

test('save and continue resets the saved product while retaining supplier and contact', async () => {
  const p = editor(); wx.pageScrollTo = () => {};
  files.add('/saved/continuous');
  p.setData({ fields: { ...domain.emptyFields, name: '杯子', sku: 'YW-42', supplier: '博艺陶瓷', supplierContact: '微信 demo' }, photos: [{ persistent: true, path: '/saved/continuous', id: '' }] });
  const original = api.request;
  api.request = async (_path, options) => ({ ...options.data.fields, id: PRODUCT, version: 1 });
  try {
    await p.saveNext();
    assert.equal(p.data.fields.name, ''); assert.equal(p.data.fields.sku, ''); assert.equal(p.data.fields.supplier, '博艺陶瓷'); assert.equal(p.data.fields.supplierContact, '微信 demo');
    assert.equal(p.data.editing, false); assert.equal(p._productId, ''); assert.equal(p.data.photos.length, 0); assert.equal(p._pending, null); assert.equal(navigations, 0);
    assert.ok(removed.includes('/saved/continuous'));
    assert.equal(draft.read(session.capture(), PROJECT, ''), null);
    p.input({ currentTarget: { dataset: { key: 'name' } }, detail: { value: '下一件商品' } });
    const next = draft.read(session.capture(), PROJECT, p._draftProductId); assert.equal(next.fields.name, '下一件商品'); assert.equal(next.pendingCommand, null);
  } finally { api.request = original; }
});

test('comparison selection is bounded and isolated by account and task', () => {
  const a = session.capture();
  store.setCompareSelection(a, PROJECT, ['one', 'one', 'two', 'three']);
  assert.deepEqual(store.compareSelection(a, PROJECT), ['one', 'two']);
  assert.deepEqual(store.compareSelection(a, PRODUCT), []);
  const b = install('bob', 'b'); assert.deepEqual(store.compareSelection(b, PROJECT), []);
});

test('server search ignores late results for the previous filter', async () => {
  const p = page('pages/products/index.js'), binding = session.capture(); p._alive = true; p._seq = 1; p._binding = binding; p._coverCache = new Map();
  p.setData({ project: { id: PROJECT }, query: '', status: 'all' });
  const original = api.request, calls = [];
  api.request = (url) => new Promise(resolve => calls.push({ url, resolve }));
  try {
    const old = p.reloadResults();
    p.setData({ query: '陶瓷', status: 'missingPrice' });
    const current = p.reloadResults();
    calls[1].resolve({ items: [{ ...domain.emptyFields, id: 'matching', name: '陶瓷杯', photos: [] }], nextCursor: null, summary: { total: 42, pending: 40, confirmed: 2, missingPrice: 1 }, matchedCount: 1 });
    await current;
    calls[0].resolve({ items: [{ ...domain.emptyFields, id: 'old', name: '旧结果', photos: [] }], nextCursor: null, matchedCount: 42 });
    await old;
    assert.match(calls[1].url, /q=%E9%99%B6%E7%93%B7&status=missingPrice/);
    assert.equal(p.data.items[0].id, 'matching'); assert.equal(p.data.summary.total, 42); assert.equal(p.data.matchedCount, 1);
  } finally { api.request = original; }
});

test('procurement numeric fields preserve unknowns and reject fractional lead time', () => {
  const fields = domain.validateFields({ ...domain.emptyFields, name: '杯', cartonCbm: '0.042', leadTimeDays: '18' });
  assert.equal(fields.cartonCbm, 0.042); assert.equal(fields.leadTimeDays, 18); assert.equal(fields.weightG, null);
  assert.throws(() => domain.validateFields({ ...fields, leadTimeDays: 1.5 }));
});

test('hidden editor cannot consume a late successful save or clear the persistent draft', async () => {
  const p = editor(); p._viewEpoch = 1;
  let resolve; const original = api.request;
  api.request = () => new Promise(done => { resolve = done; });
  try {
    const saving = p.save();
    await new Promise(done => setImmediate(done));
    p.onHide(); p._alive = true; p._viewEpoch += 1;
    resolve({ id: PRODUCT, version: 1 }); await saving;
    assert.ok(draft.read(session.capture(), PROJECT, '').pendingCommand);
    assert.equal(navigations, 0);
  } finally { api.request = original; }
});

test('local drafts remain visible while offline account and capability requests fail', async () => {
  draft.write(session.capture(), PROJECT, '', { fields: { name: '离线杯子' }, photos: [] });
  const p = page('pages/me/index.js');
  wx.request = o => o.fail();
  await p.load();
  assert.equal(p.data.drafts.length, 1); assert.equal(p.data.drafts[0].fields.name, '离线杯子');
  assert.equal(p.data.user.id, 'alice'); assert.ok(p.data.error);
});

test('expired login clears private draft display and export returns to the dedicated login page', async () => {
  draft.write(session.capture(), PROJECT, '', { fields: { name: '私有草稿' }, photos: [] });
  const p = page('pages/me/index.js');
  wx.request = o => o.success({ statusCode: o.url.endsWith('/api/config') ? 200 : 401, data: {} });
  await p.load();
  assert.equal(p.data.user, null); assert.deepEqual(p.data.drafts, []); assert.equal(p.data.authenticated, false); assert.equal(p.data.error, '');
  const e = page('pages/export/index.js');
  await e.refreshPreview();
  assert.equal(e.data.loading, false); assert.equal(e.data.error, ''); assert.equal(launches.at(-1), '/pages/login/index');
});

test('expired product request clears the task and ends loading with an actionable login state', async () => {
  const p = page('pages/products/index.js'); p._alive = true;
  p.setData({ project: { id: PROJECT }, loggedIn: true, products: [{ id: PRODUCT }], selectedIds: [PRODUCT] });
  wx.request = o => o.success({ statusCode: 401, data: {} });
  await p.reloadResults();
  assert.equal(p.data.loggedIn, false); assert.equal(p.data.project, null); assert.equal(p.data.loading, false);
  assert.deepEqual(p.data.selectedIds, []); assert.equal(p.data.error, ''); assert.equal(launches.at(-1), '/pages/login/index');
});

test('media picker survives temporary page hiding in both callback orders and discards after unload', async () => {
  for (const order of ['show-first', 'callback-first', 'unload']) {
    const p = editor(); p._viewEpoch = 1;
    let chosen; wx.chooseMedia = options => { chosen = options; };
    const choosing = p.addPhotos(); p.onHide();
    if (order === 'show-first') p.onShow();
    if (order === 'unload') p.onUnload();
    chosen.success({ tempFiles: [{ tempFilePath: '/temporary/cup', size: 10 }] });
    await choosing;
    if (order === 'callback-first') { assert.equal(p.data.photos.length, 0); p.onShow(); }
    if (order === 'unload') assert.equal(p.data.photos.length, 0);
    else {
      assert.equal(p.data.photos.length, 1); assert.equal(p._choosing, false);
      assert.equal(draft.read(p._binding, PROJECT, '').photos.length, 1);
    }
  }
});

test('explicit extracted currency replaces an untouched default but preserves a chosen currency', async () => {
  const original = api.request;
  api.request = async () => ({ fields: { unitPrice: 12, currency: 'USD' }, warning: '请核对' });
  try {
    const p = editor(); p.setData({ fields: { ...domain.emptyFields, name: '杯子', description: '12美元' } });
    await p.organize(); assert.equal(p.data.fields.currency, 'USD'); assert.equal(p.data.fields.unitPrice, 12);
    const selected = editor(); selected.setData({ 'fields.description': '12美元' }); selected.currency({ detail: { value: 2 } });
    await selected.organize(); assert.equal(selected.data.fields.currency, 'EUR'); assert.match(selected.data.notice, /币种/);
  } finally { api.request = original; }
});

test('manually entered supplier-only notes persist while merely opening an existing product creates no draft', async () => {
  const manual = editor(); manual.setData({ fields: { ...domain.emptyFields } });
  manual.input({ currentTarget: { dataset: { key: 'supplier' } }, detail: { value: '现场供应商' } });
  assert.equal(draft.read(session.capture(), PROJECT, '').fields.supplier, '现场供应商');
  const p = page('pages/editor/index.js'); p.onLoad({ projectId: PROJECT, id: PRODUCT }); p._alive = true; p._viewEpoch = 1;
  const original = api.request;
  api.request = async url => url.startsWith('/api/products/') ? { ...domain.emptyFields, id: PRODUCT, projectId: PROJECT, name: '已有商品', version: 1, photos: [] } : url === '/api/config' ? { modelEnabled: false } : [];
  try {
    await p.open(); p.onHide();
    assert.equal(draft.read(session.capture(), PROJECT, PRODUCT), null);
    p.onShow(); p.input({ currentTarget: { dataset: { key: 'notes' } }, detail: { value: '待核对交期' } });
    assert.equal(draft.read(session.capture(), PROJECT, PRODUCT).fields.notes, '待核对交期');
  } finally { api.request = original; }
});

test('personal profile uses acknowledged account state offline and rejects stale or foreign updates', async () => {
  const profile = require('../miniprogram/utils/profile'), binding = session.capture();
  profile.accept(binding, { ...profile.empty, name: '采购员甲', company: '甲公司', defaultCurrency: 'USD', version: 2 });
  assert.ok(session.valid(binding), 'editing a profile must not change the session identity');
  profile.accept(binding, { ...profile.empty, name: '旧资料', version: 1 });
  assert.equal(profile.read(binding).name, '采购员甲');
  session.restore(); assert.equal(profile.read(session.capture()).defaultCurrency, 'USD');
  const p = page('pages/me/index.js'); wx.request = o => o.fail(); await p.load();
  assert.equal(p.data.profile.name, '采购员甲'); assert.equal(p.data.modelKnown, false);
  const old = session.capture(); install('bob', 'b');
  assert.equal(profile.read(session.capture()).defaultCurrency, 'CNY'); assert.throws(() => profile.accept(old, { name: '泄漏' }), /登录状态/);
});

test('profile save preserves input on conflict and a late response cannot leak to another account', async () => {
  const profile = require('../miniprogram/utils/profile'), p = page('pages/profile/index.js');
  p._alive = true; p._seq = 1; p.editProfile(); p.input({ currentTarget: { dataset: { key: 'name' } }, detail: { value: '现场姓名' } });
  wx.request = o => o.success({ statusCode: 409, data: { error: { code: 'CONFLICT', message: '其他设备已更新' } } });
  await p.saveProfile(); assert.equal(p.data.editing, true); assert.equal(p.data.form.name, '现场姓名'); assert.equal(profile.read(session.capture()).name, ''); assert.match(p.data.error, /其他设备/);
  let pending; wx.request = o => { pending = o; };
  const result = p.saveProfile(); install('bob', 'b');
  pending.success({ statusCode: 200, data: { ...profile.empty, name: '现场姓名', version: 1 } }); await result;
  assert.equal(profile.read(session.capture()).name, '');
});

test('successful profile save updates defaults only after acknowledgement', async () => {
  const profile = require('../miniprogram/utils/profile'), p = page('pages/profile/index.js');
  p._alive = true; p._seq = 1; p.editProfile(); p.currency({ detail: { value: 2 } });
  let pending; wx.request = o => { pending = o; };
  const result = p.saveProfile(); assert.equal(profile.defaultCurrency(session.capture()), 'CNY');
  pending.success({ statusCode: 200, data: { ...pending.data, version: 1 } }); await result;
  assert.equal(profile.defaultCurrency(session.capture()), 'EUR'); assert.equal(p.data.editing, false);
});

test('profile editing survives the avatar picker hiding before the initial request resolves', async () => {
  const p = page('pages/profile/index.js'); p.onLoad();
  let pending; wx.request = o => { pending = o; };
  const work = p.load();
  p.input({ currentTarget: { dataset: { key: 'company' } }, detail: { value: '现场商号' } });
  p.onHide(); p.onShow();
  assert.equal(p.data.form.company, '现场商号');
  pending.success({ statusCode: 200, data: { user: { id: 'alice', profile: { company: '服务器旧商号' } } } });
  await work;
  assert.equal(p.data.form.company, '现场商号');
});

test('native nickname form submission stays in the form when saving fails', async () => {
  const p = page('pages/profile/index.js'); p._alive = true; p._seq = 1; p.editProfile();
  wx.request = o => o.success({ statusCode: 409, data: { error: { code: 'CONFLICT', message: '其他设备已更新' } } });
  await p.saveProfile({ detail: { value: { name: '微信选择姓名', company: '义乌商号', phone: '', wechat: '' } } });
  assert.equal(p.data.form.name, '微信选择姓名'); assert.equal(p.data.form.company, '义乌商号');
  assert.equal(p.data.avatarInitial, '微'); assert.equal(p._formDirty, true);
});

test('new and continuous products use personal currency while existing records retain their currency', async () => {
  const profile = require('../miniprogram/utils/profile');
  profile.accept(session.capture(), { ...profile.empty, defaultCurrency: 'USD', version: 1 });
  require('../miniprogram/utils/merchant-context').beginCapture(session.capture(),PROJECT,{supplier:'美金商户'});
  const p = page('pages/editor/index.js'); p.onLoad({ projectId: PROJECT }); p._alive = true; p._viewEpoch = 1;
  await p.open(); assert.equal(p.data.fields.currency, 'USD'); assert.equal(p.data.currencyIndex, 1);
  p.input({ currentTarget: { dataset: { key: 'name' } }, detail: { value: '美金商品' } });
  const original = api.request; api.request = async (_url, options) => ({ ...options.data.fields, id: PRODUCT, version: 1 });
  try { await p.saveNext(); assert.equal(p.data.fields.currency, 'USD'); assert.equal(p.data.currencyIndex, 1); }
  finally { api.request = original; }
  const existing = page('pages/editor/index.js'); existing.onLoad({ projectId: PROJECT, id: PRODUCT }); existing._alive = true; existing._viewEpoch = 1;
  api.request = async url => url.startsWith('/api/products/') ? { ...domain.emptyFields, id: PRODUCT, projectId: PROJECT, name: '人民币商品', version: 1, photos: [] } : url === '/api/config' ? { modelEnabled: false } : [];
  try { await existing.open(); assert.equal(existing.data.fields.currency, 'CNY'); }
  finally { api.request = original; }
});

test('daily review loads without an active task and discards late results for another day', async () => {
  const p = page('pages/products/index.js'); p.setData({ viewMode: 'day', date: '2026-10-16' });
  const original = api.request, calls = [];
  api.request = url => url === '/api/record-days' || url.startsWith('/api/merchants?') ? Promise.resolve([]) : new Promise(resolve => calls.push({ url, resolve }));
  try {
    const old = p.load(); assert.match(calls[0].url, /date=2026-10-16/); assert.ok(!calls[0].url.includes('projectId='));
    const current = p.dateChange({ detail: { value: '2026-10-15' } });
    calls[1].resolve({ items: [{ ...domain.emptyFields, id: PRODUCT, projectId: PROJECT, name: '当天商品', taskName: '客户任务', photos: [] }], nextCursor: null, summary: { total: 1 }, matchedCount: 1 }); await current;
    calls[0].resolve({ items: [{ ...domain.emptyFields, id: 'old', photos: [] }], nextCursor: null }); await old;
    assert.equal(p.data.items[0].name, '当天商品'); assert.equal(p.data.items[0].taskName, '客户任务'); assert.equal(p.data.summary.total, 1);
    let url; wx.navigateTo = options => { url = options.url; }; p.edit({ currentTarget: { dataset: { id: PRODUCT } } }); assert.match(url, new RegExp('projectId=' + PROJECT));
    p.export(); assert.equal(url, '/pages/export/index?date=2026-10-15');
  } finally { api.request = original; }
});

test('daily export preview and download use the same date with confirmation and image options', async () => {
  const p = page('pages/export/index.js'); p.onLoad({ date: '2026-10-16' }); p.setData({ scope: 'confirmed', images: false });
  const original = api.request; let previewPath, downloadPath;
  api.request = async url => { if(url.startsWith('/api/merchants?'))return []; if (url.startsWith('/api/export-preview')) return { columns: [{key:'name',label:'商品名称'}], headerRows: [] }; previewPath = url; return { items: [], nextCursor: null, summary: { total: 3, confirmed: 2 } }; };
  wx.downloadFile = options => { downloadPath = options.url; options.success({ statusCode: 200, tempFilePath: '/tmp/table.xlsx' }); };
  try {
    await p.load(); assert.match(previewPath, /date=2026-10-16&limit=3&status=confirmed/); assert.equal(p.data.exportCount, 2);
    await p.export({ currentTarget: { dataset: {} } }); assert.match(downloadPath, /date=2026-10-16&scope=confirmed&images=no/);
  } finally { api.request = original; }
});

test('opening another procurement task leaves daily review and loads the chosen task', async () => {
  const p = page('pages/products/index.js'), binding = session.capture();
  p._activeId = PRODUCT; p.setData({ viewMode: 'day', date: '2026-10-16' }); store.selectProject(binding, PROJECT);
  const original = api.request; const paths = [];
  api.request = async url => { paths.push(url); return url === '/api/projects' ? [{ id: PROJECT, name: '已选任务' }] : { items: [], nextCursor: null }; };
  try { await p.load(); assert.equal(p.data.viewMode, 'task'); assert.equal(p.data.project.id, PROJECT); assert.ok(paths.some(url => url.includes('projectId=' + PROJECT)));  }
  finally { api.request = original; }
});

test('date rail crosses months and years, marks recorded days and blocks future review dates', () => {
  const dates = require('../miniprogram/utils/date-rail');
  assert.equal(dates.shiftDate('2026-01-01', -1), '2025-12-31'); assert.equal(dates.shiftDate('2024-02-28', 1), '2024-02-29');
  assert.equal(dates.validDate('2026-02-30'), false);
  const days = dates.dateItems('2026-10-16', { '2026-10-15': 2 }, '2026-10-16', '2026-10-16');
  assert.equal(days.at(-1).date, '2026-10-16'); assert.equal(days.at(-1).week, '今'); assert.ok(days.find(day => day.date === '2026-10-15').hasRecords);
  let definition; global.Component = value => { definition = value; };
  const file = require.resolve('../miniprogram/components/date-rail/index.js'); delete require.cache[file]; require(file);
  const changes = [], component = { ...definition.methods, properties: { selectedDate: '2026-10-16', maxDate: '2026-10-16', counts: {}, allowAll: false }, data: structuredClone(definition.data), setData(patch) { Object.assign(this.data, patch); }, triggerEvent(_name, detail) { changes.push(detail.date); } };
  component.updateRail(); component.next(); assert.equal(changes.length, 0); component.previous(); assert.equal(changes[0], '2026-10-15');
  component.change('2026-10-17'); assert.equal(changes.length, 1);
  component.properties.allowAll = true; component.change(''); assert.equal(changes[1], '');
});

test('merchant date filter loads real recorded shops, keeps selected creation date and rejects future dates',async()=>{
 const p=page('pages/projects/index.js'),original=api.request;p._alive=true;
 p.setData({projects:[{id:'a',date:'2026-10-15'},{id:'b',date:'2026-10-16'}]});p.filterDates();
 api.request=async url=>[{projectId:'a',supplier:'商家甲',total:2,date:'2026-10-15'}];
 try{p.reviewDate({detail:{date:'2026-10-15'}});await new Promise(r=>setImmediate(r));assert.equal(p.data.visibleProjects[0].supplier,'商家甲');assert.equal(p.data.dateCounts['2026-10-16'],1);p.toggleCreate();assert.equal(p.data.date,'2026-10-15');p.reviewDate({detail:{date:''}});assert.equal(p.data.visibleProjects.length,1);p.closeCreate();p.reviewDate({detail:{date:'2099-01-01'}});assert.equal(p.data.selectedDate,'2026-10-15');}finally{api.request=original;}
});

test('new task modal preserves inputs and background selection through dismissal and keyboard changes',()=>{
 const p=page('pages/projects/index.js');p._alive=true;p.setData({selectedDate:'2026-10-15',visibleProjects:[{id:'a'}]});
 let hidden=0,shown=0,scrolls=0;wx.hideTabBar=()=>hidden++;wx.showTabBar=()=>shown++;wx.pageScrollTo=()=>scrolls++;wx.getWindowInfo=()=>({windowHeight:568});
 p.toggleCreate();assert.equal(p.data.showCreate,true);assert.equal(hidden,1);assert.equal(p.data.date,'2026-10-15');
 p.input({currentTarget:{dataset:{key:'name'}},detail:{value:'待填写看货'}});p.keyboard({detail:{height:300}});assert.equal(p.data.keyboardHeight,300);assert.ok(p.data.createBodyHeight<248);
 p.closeCreate();assert.equal(p.data.showCreate,false);assert.equal(p.data.keyboardHeight,0);assert.equal(shown,1);assert.equal(p.data.name,'待填写看货');assert.deepEqual(p.data.visibleProjects,[{id:'a'}]);assert.equal(scrolls,0);
 p.toggleCreate();assert.equal(p.data.name,'待填写看货');p.setData({saving:true});p.closeCreate();assert.equal(p.data.showCreate,true);p.setData({saving:false});p.onHide();assert.equal(shown,2);
});

test('new task launch waits for initial load and shows the modal without replacing pending input',async()=>{
 const p=page('pages/projects/index.js');storage.set('huoji.newProject',true);const original=api.request;api.request=async()=>[];
 try{await p.onShow();assert.equal(p.data.showCreate,true);assert.equal(p.data.name,'');assert.equal(storage.has('huoji.newProject'),false);p.onHide();}
 finally{api.request=original;}
});

test('new task modal validates and retains inputs on failed save without scrolling underlying page',async()=>{
 const p=page('pages/projects/index.js');p._alive=true;p.setData({showCreate:true,name:'',market:'一区'});let scrolls=0;wx.pageScrollTo=()=>scrolls++;const original=api.request;
 try{await p.create();assert.match(p.data.error,/名称/);assert.equal(p.data.showCreate,true);p.setData({name:'看货'});api.request=async()=>{throw session.error('VALIDATION','名称重复');};await p.create();assert.equal(p.data.name,'看货');assert.equal(p.data.market,'一区');assert.equal(p.data.pending,false);assert.equal(p.data.saving,false);assert.equal(p.data.showCreate,true);assert.equal(scrolls,0);}
 finally{api.request=original;}
});

test('new task save completed while hidden unlocks modal on return and preserves uncertain receipt for retry',async()=>{
 const original=api.request;
 try{for(const uncertain of [false,true]){
  const p=page('pages/projects/index.js');p._alive=true;p._owner=session.capture().owner;p.setData({showCreate:true,name:'后台保存演示',market:'一区'});let finish;
  api.request=async(url,options)=>{if(options&&options.method==='POST')return new Promise((resolve,reject)=>{finish=()=>uncertain?reject(session.error('NETWORK_UNKNOWN','结果尚未确认')):resolve({id:PROJECT});});return [];};
  const saving=p.create();assert.equal(p.data.saving,true);p.onHide();finish();await saving;assert.equal(p._saving,false);assert.equal(p.data.saving,true);
  await p.onShow();assert.equal(p.data.saving,false);assert.equal(p.data.pending,uncertain);if(uncertain){assert.equal(p.data.name,'后台保存演示');assert.ok(p._pending.requestKey);}else{assert.equal(p.data.name,'');assert.equal(p.data.showCreate,false);}
  p.closeCreate();assert.equal(p.data.showCreate,false);p.onHide();
 }}finally{api.request=original;}
});

test('current merchant is scoped to task and owner, reused only for new products without creating an empty draft',async()=>{
 const merchants=require('../miniprogram/utils/merchant-context'),binding=session.capture();merchants.remember(binding,PROJECT,{supplier:'商户A',supplierContact:'联系人A'});merchants.beginCapture(binding,PROJECT,{supplier:'商户A',supplierContact:'联系人A'});
 const p=page('pages/editor/index.js');p.onLoad({projectId:PROJECT});p._alive=true;p._viewEpoch=1;p.loadCaptureTemplate=()=>{};p.loadCapabilities=()=>{};
 await p.open();assert.equal(p.data.fields.supplier,'商户A');assert.equal(p.data.fields.supplierContact,'联系人A');assert.equal(p.data.fields.name,'');assert.equal(p.data.fields.unitPrice,null);assert.equal(draft.list(binding).length,0);
 assert.equal(merchants.read(binding,PRODUCT).current.supplier,'');const bob=install('bob','b');assert.equal(merchants.read(bob,PROJECT).current.supplier,'');assert.throws(()=>merchants.read(binding,PROJECT),/身份|账号|登录/);
});

test('switching shops uses both known fields and new shop clears both without copying product data',async()=>{
 const p=editor(),merchants=require('../miniprogram/utils/merchant-context');p._viewEpoch=1;p.setData({suppliers:['新商户','商户A'],fields:{...domain.emptyFields,name:'新品',unitPrice:12,supplier:'旧店',supplierContact:'旧联系人'}});merchants.remember(session.capture(),PROJECT,{supplier:'商户A',supplierContact:'联系人A'});
 await p.supplier({detail:{value:1}});assert.equal(p.data.fields.supplier,'商户A');assert.equal(p.data.fields.supplierContact,'联系人A');assert.equal(p.data.fields.name,'新品');assert.equal(p.data.fields.unitPrice,12);
 await p.supplier({detail:{value:0}});assert.equal(p.data.fields.supplier,'');assert.equal(p.data.fields.supplierContact,'');assert.equal(merchants.read(session.capture(),PROJECT).current.supplier,'');
});

test('legacy shop selection searches exact merchant across pages and ignores late contact after manual input',async()=>{
 const p=editor();p._viewEpoch=1;p.setData({suppliers:['新商户','商户A','商户B']});const original=api.request;let calls=[],resolve;
 api.request=async url=>{calls.push(url);if(url.includes('cursor='))return {items:[{supplier:'商户A',supplierContact:'正确联系人'}],nextCursor:null};return {items:[{supplier:'商户A其他',supplierContact:'错误联系人'}],nextCursor:'next'};};
 try{await p.supplier({detail:{value:1}});assert.equal(p.data.fields.supplierContact,'正确联系人');assert.equal(calls.length,2);assert.match(calls[1],/cursor=next/);
  api.request=()=>new Promise(r=>resolve=r);const pending=p.supplier({detail:{value:2}});p.input({currentTarget:{dataset:{key:'supplierContact'}},detail:{value:'人工修改'}});resolve({items:[{supplier:'商户B',supplierContact:'迟到联系人'}],nextCursor:null});await pending;assert.equal(p.data.fields.supplierContact,'人工修改');
  p.input({currentTarget:{dataset:{key:'supplier'}},detail:{value:'另一店'}});assert.equal(p.data.fields.supplierContact,'');
 }finally{api.request=original;}
});

test('successful new product save remembers merchant for reopening and keeps continuation blank',async()=>{
 const p=editor();p._viewEpoch=1;p._saveWasNew=true;p._continueRecording=true;p.setData({fields:{...domain.emptyFields,name:'杯子',supplier:'商户C',supplierContact:'微信C'}});wx.pageScrollTo=()=>{};
 await p.finish(1);const merchants=require('../miniprogram/utils/merchant-context');assert.equal(merchants.read(session.capture(),PROJECT).current.supplier,'商户C');assert.equal(p.data.fields.supplierContact,'微信C');assert.equal(p.data.fields.name,'');assert.equal(draft.list(session.capture()).length,0);
});

test('list favorite acknowledgement updates only favorite and version; conflict preserves the item', async () => {
  const p = page('pages/products/index.js'); p._alive = true; p._seq = 1;
  p.setData({ products: [{ ...domain.emptyFields, id: PRODUCT, projectId: PROJECT, name: '杯', version: 1, confirmed: true, unitPrice: 12 }], project: { id: PROJECT } });
  const original = api.request;
  api.request = async (_url, options) => { assert.deepEqual(options.data, { favorite: true, version: 1 }); return { favorite: true, version: 2 }; };
  try { await p.toggleFavorite({ currentTarget: { dataset: { id: PRODUCT } } }); assert.equal(p.data.items[0].favorite, true); assert.equal(p.data.items[0].confirmed, true); assert.equal(p.data.items[0].unitPrice, 12); }
  finally { api.request = original; }
  api.request = async () => { throw Object.assign(new Error('版本冲突，请刷新'), { code: 'CONFLICT' }); };
  try { await p.toggleFavorite({ currentTarget: { dataset: { id: PRODUCT } } }); assert.equal(p.data.items[0].favorite, true); assert.match(p.data.error, /冲突/); }
  finally { api.request = original; }
});

test('favorite responds immediately, prevents duplicate taps, and rolls back a failed save', async () => {
  const p = page('pages/products/index.js'); p._alive = true; p._seq = 1;
  p.setData({ products: [{ ...domain.emptyFields, id: PRODUCT, projectId: PROJECT, name: '杯', version: 1, favorite: false, confirmed: true, unitPrice: 12 }], project: { id: PROJECT } });
  const original = api.request; let fail, calls = 0;
  api.request = () => { calls++; return new Promise((resolve, reject) => { fail = reject; }); };
  try {
    const e = { currentTarget: { dataset: { id: PRODUCT } } }, work = p.toggleFavorite(e);
    assert.equal(p.data.items[0].favorite, true); assert.equal(p.data.items[0].favoriteBusy, true);
    await p.toggleFavorite(e); assert.equal(calls, 1);
    fail(new Error('网络中断')); await work;
    assert.equal(p.data.items[0].favorite, false); assert.equal(p.data.items[0].favoriteBusy, false);
    assert.equal(p.data.items[0].unitPrice, 12); assert.equal(p.data.items[0].confirmed, true);
  } finally { api.request = original; }
});

test('personal evaluation and ratings persist without undoing procurement confirmation', () => {
  const p = editor(); p.setData({ 'fields.confirmed': true });
  p.rate({ currentTarget: { dataset: { value: 4 } } }); p.input({ currentTarget: { dataset: { key: 'evaluation' } }, detail: { value: '质感好，适合客户' } });
  assert.equal(p.data.fields.rating, 4); assert.equal(p.data.fields.confirmed, true); assert.equal(draft.read(p._binding, PROJECT, '').fields.evaluation, '质感好，适合客户');
  p.rate({ currentTarget: { dataset: { value: 4 } } }); assert.equal(p.data.fields.rating, null);
  assert.throws(() => domain.validateFields({ name: '杯', rating: 6 }));
});

test('favorites opens from my page and history navigation stays isolated by account', async () => {
  const me = page('pages/me/index.js'); let target;
  wx.navigateTo = options => { target = options.url; }; wx.switchTab = options => { target = options.url; };
  me.favorites(); assert.equal(target, '/pages/favorites/index');
  me.review(); assert.equal(target, '/pages/products/index');
  const original = api.request;
  api.request = async url => url === '/api/record-days' ? [] : { items: [], nextCursor: null, summary: { total: 0 } };
  try {
    const products = page('pages/products/index.js'); await products.load(); assert.equal(products.data.viewMode, 'day');
    const favorites = page('pages/favorites/index.js'); store.selectProject(session.capture(), PROJECT); await favorites.load();
    assert.equal(favorites.data.viewMode, 'favorites'); assert.equal(favorites.scopeQuery(), 'favorite=yes');
    me.review(); install('bob', 'b'); const another = page('pages/products/index.js'); await another.load(); assert.equal(another.data.viewMode, 'task');
  } finally { api.request = original; }
});

test('removing a favorite clears its comparison selection before reloading', async () => {
  const p = page('pages/favorites/index.js'), binding = session.capture(); p._alive = true; p._seq = 1; p._scope = 'favorites';
  p.setData({ products: [{ ...domain.emptyFields, id: PRODUCT, favorite: true, version: 1 }], selectedIds: [PRODUCT, PROJECT] });
  store.setCompareSelection(binding, 'favorites', [PRODUCT, PROJECT]);
  const original = api.request; api.request = async url => url.endsWith('/favorite') ? { favorite: false, version: 2 } : { items: [], nextCursor: null, summary: { total: 0 } };
  try { await p.toggleFavorite({ currentTarget: { dataset: { id: PRODUCT } } }); assert.deepEqual(p.data.selectedIds, [PROJECT]); assert.deepEqual(store.compareSelection(binding, 'favorites'), [PROJECT]); }
  finally { api.request = original; }
});

test('the login page is the sole anonymous entry and every business deep link is gated before loading', async () => {
  const manifest = require('../miniprogram/app.json');
  assert.equal(manifest.pages[0], 'pages/login/index');
  session.clear();
  for (const name of manifest.pages.slice(1)) {
    const p = page(name + '.js');
    await p.onLoad({ projectId: PROJECT, id: PRODUCT }); await p.onShow();
    assert.equal(p.data.authenticated, false, name); assert.equal(requests.length, 0, name);
    assert.equal(launches.at(-1), '/pages/login/index');
    const source = fs.readFileSync(path.join(__dirname, '../miniprogram/', name + '.wxml'), 'utf8');
    assert.doesNotMatch(source, /bindtap="login"|登录后查看/);
    assert.match(source, /wx:if="\{\{authenticated\}\}"|<include/);
  }
});
test('anonymous launch stays on login, while a valid restored session enters the task workspace', () => {
  session.clear(); const p = page('pages/login/index.js'); p.onLoad(); p.onShow();
  assert.equal(p.data.checking, false); assert.equal(launches.length, 0);
  gate.show(); assert.equal(launches.length, 0);
  install(); p.onShow(); assert.equal(launches.at(-1), '/pages/projects/index');
  const home = page('pages/projects/index.js'); gate.requireLogin(home);
  assert.equal(home.data.authenticated, true); assert.equal(tabChanges.at(-1), 'show');
});
test('login survives a temporary hide and show, and only one exchange runs on double tap', async () => {
  session.clear(); const p = page('pages/login/index.js'); p.onLoad(); p.onShow();
  let pending;
  wx.login = o => { assert.equal(o.timeout, 15000); pending = o; };
  wx.request = o => { requests.push(o); o.success({ statusCode: 200, data: { user: { id: 'wechat-user' }, token: 'c'.repeat(64), expiresAt: Date.now() + 60000 } }); };
  const work = p.login({ currentTarget: { dataset: {} } });
  await p.login({ currentTarget: { dataset: {} } }); p.onHide(); p.onShow();
  assert.equal(p.data.loggingIn, true); pending.success({ code: 'once-code' }); await work;
  assert.equal(requests.length, 1); assert.equal(requests[0].data.code, 'once-code');
  assert.equal(session.info().user.id, 'wechat-user'); assert.equal(launches.at(-1), '/pages/projects/index');
  assert.equal(p.data.loggingIn, false);
});
test('failed login remains at the clean entry, and a failed wechat code exchange never hangs', async () => {
  session.clear(); const p = page('pages/login/index.js'); p.onLoad(); p.onShow();
  // 官方 wx.login 总会回调；未拿到 code 时登录必须失败并留在登录页，不能永久挂起。
  let codes = 0; wx.login = options => { codes++; (options || {}).fail?.({ errMsg: 'login:fail' }); };
  wx.getAccountInfoSync = () => ({ miniProgram: { envVersion: 'trial' } });
  await p.login({ currentTarget: { dataset: {} } });
  assert.equal(requests.length, 0); assert.equal(session.info(), null);
  assert.equal(p.data.loggingIn, false); assert.equal(launches.length, 0);
  const afterPage = codes; assert.ok(afterPage >= 1);
  wx.getAccountInfoSync = () => ({ miniProgram: { envVersion: 'develop' } });
  wx.getDeviceInfo = () => ({ platform: 'ios' });
  // 微信 wx.login 总会回调；未拿到 code 时登录必须失败，不能永久挂起。
  await assert.rejects(api.login(), /微信登录未完成/);
  assert.ok(codes > afterPage);
  assert.equal(session.info(), null); assert.equal(requests.length, 0);
});
test('login transport failure and load failure do not claim an uncertain save', async () => {
  wx.request = o => o.fail();
  await assert.rejects(api.request('/api/auth/wechat', { public: true, method: 'POST', data: { code: 'test' } }), /登录服务/);
  await assert.rejects(api.request('/api/projects'), error => /连接服务/.test(error.message) && !/保存/.test(error.message));
  await assert.rejects(api.request('/api/projects', { method: 'POST', data: {} }), /保存结果可能未返回/);
});
test('expiry redirects once while navigation is pending and hides private content before leaving', async () => {
  const p = page('pages/products/index.js'); p.data.authenticated = true;
  const binding = session.capture(); let navigation;
  wx.reLaunch = o => { launches.push(o.url); navigation = o; };
  wx.request = o => { requests.push(o); o.success({ statusCode: 401, data: {} }); };
  await assert.rejects(api.request('/api/projects', { identity: binding }));
  assert.equal(p.data.authenticated, false); assert.equal(tabChanges.at(-1), 'hide');
  gate.lock(); gate.lock(); assert.equal(launches.length, 1);
  currentPages = [{ route: 'pages/login/index' }]; navigation.complete();
});
test('logout returns to login and retains only the departing account draft', async () => {
  draft.write(session.capture(), PROJECT, '', { fields: { name: '退出前的杯子' }, photos: [] });
  const p = page('pages/me/index.js'); p._alive = true; p.data.authenticated = true;
  await p.logout(); assert.equal(session.info(), null); assert.equal(p.data.authenticated, false);
  assert.equal(launches.at(-1), '/pages/login/index');
  install('bob', 'b'); assert.deepEqual(draft.list(session.capture()), []);
  install(); assert.equal(draft.read(session.capture(), PROJECT, '').fields.name, '退出前的杯子');
});
test('the foreground expiry timer locks an idle page without requiring another tap or request', async () => {
  const p = page('pages/me/index.js'); p.data.authenticated = true;
  session.install({ user: { id: 'alice' }, token: 'a'.repeat(64), expiresAt: Date.now() + 30 });
  gate.watch(); gate.show(); await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(session.info(), null); assert.equal(p.data.authenticated, false);
  assert.equal(launches.at(-1), '/pages/login/index'); gate.hide();
});


test('camera starts a distinct new item without asking about existing drafts', async () => {
  const binding=session.capture();draft.write(binding,PROJECT,'',{fields:{...domain.emptyFields,name:'旧草稿'},photos:[]});
  require('../miniprogram/utils/merchant-context').beginCapture(binding,PROJECT,{supplier:'新品商户'});
  const p=page('pages/editor/index.js');p.onLoad({projectId:PROJECT});p._alive=true;p._viewEpoch=1;
  wx.showModal=()=>{throw new Error('new camera must not show a draft prompt');};
  await p.open();assert.equal(p.data.ready,true);assert.equal(p.data.fields.name,'');assert.ok(p._draftProductId);
  p.input({currentTarget:{dataset:{key:'name'}},detail:{value:'新品'}});
  assert.equal(draft.read(binding,PROJECT,'').fields.name,'旧草稿');assert.equal(draft.read(binding,PROJECT,p._draftProductId).fields.name,'新品');
});

test('explicit draft navigation restores immediately and remains account scoped', async () => {
  const binding=session.capture();draft.write(binding,PROJECT,PRODUCT,{fields:{...domain.emptyFields,name:'私有草稿'},photos:[]});
  const p=page('pages/editor/index.js');p.onLoad({projectId:PROJECT,draftId:PRODUCT,resume:'yes'});p._alive=true;p._viewEpoch=1;
  wx.showModal=()=>{throw new Error('explicit draft entry must not prompt');};await p.open();assert.equal(p.data.fields.name,'私有草稿');
  assert.match(draft.editorUrl(draft.read(binding,PROJECT,PRODUCT)),/resume=yes/);install('bob','b');p.onShow();assert.equal(p.data.ready,false);assert.equal(p.data.fields.name,'');
});

test('AI异步整理查询任务完成后才补空字段', async () => {
  const p = editor(); p.setData({ 'fields.description': '杯子，起订10件' });
  const original = api.request; let calls = 0;
  api.request = async (url) => { calls++; return url === '/api/extract' ? { jobId: PRODUCT, state: 'pending' } : { jobId: PRODUCT, kind: 'extraction', state: 'succeeded', result: { fields: { name: '模型名称', moq: 10 }, mode: 'model', warning: '请核对' } }; };
  try { await p.organize(); assert.equal(calls, 2); assert.equal(p.data.fields.name, '杯子'); assert.equal(p.data.fields.moq, 10); assert.equal(p.data.recognizing, false); assert.equal(p.data.detailsOpen, false); }
  finally { api.request = original; }
});

test('商品版本冲突合并保留云端独有修改，显示全部双边冲突', async () => {
  const p = editor(); p._productId = PRODUCT; p._version = 1;
  p._baseline = domain.stable({ fields: { ...domain.emptyFields, name: '杯子', unitPrice: 12, cartonQty: 24 }, photoIds: [], version: 1 });
  p.setData({ fields: { ...domain.emptyFields, name: '本机杯子', unitPrice: 12, cartonQty: 24 }, photos: [] });
  const original = api.request; api.request = async () => ({ ...domain.emptyFields, id: PRODUCT, version: 2, name: '云端杯子', unitPrice: 12, cartonQty: 36, photos: [] });
  try {
    await p.refreshVersion(); assert.deepEqual(p.data.conflictReview.map(c => c.key), ['name']);
    await p.resolveVersion({ currentTarget: { dataset: { value: 'local' } } });
    assert.equal(p.data.fields.name, '本机杯子'); assert.equal(p.data.fields.cartonQty, 36); assert.equal(p._version, 2);
  } finally { api.request = original; }
});

test('重新加载导出预览会撤销旧文件，避免保存商品后发出旧Excel', async () => {
  const p = page('pages/export/index.js'); p.onLoad({ date:'2026-10-18' }); p._file = '/old.xlsx'; p.setData({ fileReady:true });
  const original = api.request; api.request = async url => url.startsWith('/api/export-preview') ? { columns:[],headerRows:[] } : { items:[],nextCursor:null,summary:{total:0} };
  try { await p.load(); assert.equal(p._file,null); assert.equal(p.data.fileReady,false); }
  finally { api.request = original; }
});

test('版本合并等待照片时锁住保存，输入版本变化不覆盖新内容', async () => {
  const p = editor(); p._productId = PRODUCT; p._version = 1;
  p._baseline = domain.stable({ fields:{ ...domain.emptyFields,name:'杯子' },photoIds:[],version:1 });
  p.setData({fields:{ ...domain.emptyFields,name:'本机杯子'},photos:[]});
  const original = { request:api.request,hydrate:store.hydratePhotos };
  api.request = async () => ({...domain.emptyFields,id:PRODUCT,version:2,name:'云端杯子',photos:[]});
  let resolvePhotos; store.hydratePhotos = () => new Promise(resolve => {resolvePhotos=resolve;});
  try { await p.refreshVersion(); const merging=p.resolveVersion({currentTarget:{dataset:{value:'local'}}});assert.equal(p.data.saving,true);p._revision+=1;p.setData({'fields.supplier':'新商户'});resolvePhotos([]);await merging;assert.equal(p.data.fields.supplier,'新商户');assert.equal(p._version,1);assert.equal(p.data.saving,false); }
  finally {api.request=original.request;store.hydratePhotos=original.hydrate;}
});

test('旧估算候选写回草稿但不进入正式字段，开始下一件清空候选', () => {
  const p=editor();p.setData({legacyEstimates:[{label:'单件重量',value:'300'}],estimatedFields:{},conflictReview:[{key:'name'}]});p.stash();
  assert.equal(draft.read(session.capture(),PROJECT,'').legacyEstimates[0].value,'300');
  assert.equal(p.data.fields.weightG,null);p.resetForm(PRODUCT);assert.deepEqual(p.data.legacyEstimates,[]);assert.deepEqual(p.data.conflictReview,[]);
});


test('template synchronization retries after temporary hide, ignores obsolete result, and keeps custom values',async()=>{
 const p=editor();p._viewEpoch=1;p._initialized=true;
 const original=api.request;let resolve,calls=0;
 api.request=async url=>{if(url==='/api/procurement-template'){calls++;if(calls===1)return new Promise(r=>{resolve=r;});return {columns:[{key:'sku',label:'REF.',enabled:true}],customFields:[{key:'client_ref',label:'客户编号'}]};}return [];};
 try{const pending=p.loadCaptureTemplate(1);p.onHide();p.onShow();await new Promise(r=>setImmediate(r));resolve({columns:[],customFields:[{key:'stale',label:'过时'}]});await pending;assert.equal(calls,2);assert.equal(p._templateLoaded,true);assert.equal(p.data.customInputs[0].key,'client_ref');}
 finally{api.request=original;}
});
test('saved product draft in trash keeps its contents and blocks editor until restored',async()=>{
 const p=editor(),binding=session.capture();p._initialized=false;p._draftProductId=PRODUCT;p._productId=PRODUCT;p._resumeDraft=true;p._viewEpoch=1;
 draft.write(binding,PROJECT,PRODUCT,{fields:{...domain.emptyFields,name:'本机草稿'},photos:[],editId:PRODUCT,version:1});
 const original=api.request;let removed=true;api.request=async()=>({...domain.emptyFields,id:PRODUCT,projectId:PROJECT,version:2,deletedAt:removed?'2026-10-18T04:00:00Z':null,photos:[]});
 try{await p.open();assert.equal(p.data.ready,false);assert.equal(p.data.draftTrashed,true);assert.equal(draft.read(binding,PROJECT,PRODUCT).fields.name,'本机草稿');removed=false;await p.open();assert.equal(p.data.ready,true);assert.equal(p.data.draftTrashed,false);assert.equal(p.data.fields.name,'本机草稿');}
 finally{api.request=original;}
});
test('my page joins one card and keeps help after currency and draft box naming',()=>{
 const markup=fs.readFileSync(path.join(__dirname,'../miniprogram/pages/me/index.wxml'),'utf8');
 assert.equal((markup.match(/class="personal-library"/g)||[]).length,1);assert.ok(markup.indexOf('bindtap="quickCurrency"')<markup.indexOf('bindtap="showHelp"'));assert.match(markup,/草稿箱/);assert.doesNotMatch(markup,/本机草稿/);
});

test('restoring an open edited product preserves local unsaved fields, photos and conflict baseline', async()=>{
 const p=editor();p._initialized=true;p._productId=PRODUCT;p._draftProductId=PRODUCT;p._resumeDraft=false;p._viewEpoch=1;p._version=1;p._baseline='original baseline';
 p.setData({ready:true,fields:{...domain.emptyFields,name:'本机未保存名称',custom:{client_ref:'LOCAL'}},photos:[{id:'local-photo',path:'/local.jpg'}]});p.stash();
 const original=api.request;let removed=true;api.request=async()=>({...domain.emptyFields,id:PRODUCT,projectId:PROJECT,version:removed?2:3,name:'云端名称',deletedAt:removed?'2026-10-18T04:00:00Z':null,photos:[]});
 try{await p.checkSavedState(1);assert.equal(p.data.ready,false);removed=false;await p.checkSavedState(1);assert.equal(p.data.ready,true);assert.equal(p.data.draftTrashed,false);assert.equal(p.data.fields.name,'本机未保存名称');assert.equal(p.data.fields.custom.client_ref,'LOCAL');assert.equal(p.data.photos[0].id,'local-photo');assert.equal(p._version,1);assert.equal(p._baseline,'original baseline');assert.equal(draft.read(session.capture(),PROJECT,PRODUCT).fields.name,'本机未保存名称');}
 finally{api.request=original;}
});

test('merchant filter is exact and paginated; grouped cards keep selection and a new shop clears only merchant context',async()=>{
 const p=page('pages/products/index.js'),binding=session.capture(),original=api.request,background=require('../miniprogram/utils/background-organize'),refresh=background.refresh;
 p._alive=true;p._seq=1;p._binding=binding;p._coverCache=new Map();p.setData({project:{id:PROJECT},merchants:[{supplier:'商户A',supplierContact:'微信A',total:31}],supplier:'商户A'});
 const a={...domain.emptyFields,id:PRODUCT,projectId:PROJECT,supplier:'商户A',name:'新品',version:1,photos:[]};let path;
 api.request=async url=>{path=url;return{items:[a],matchedCount:31,nextCursor:'next',summary:{total:31,pending:31}};};background.refresh=async(_,items)=>items;
 try{
  await p.fetchPage('',false,binding,1);assert.match(path,/supplier=%E5%95%86%E6%88%B7A/);assert.equal(p.data.hasMore,true);assert.equal(p.data.merchantGroups[0].supplier,'商户A');assert.equal(p.data.merchantGroups[0].items[0].id,PRODUCT);
  p.add();assert.equal(require('../miniprogram/utils/merchant-context').read(binding,PROJECT).current.supplierContact,'微信A');
  let url;wx.navigateTo=o=>url=o.url;p.exportMerchant({currentTarget:{dataset:{supplier:'商户A'}}});assert.match(url,/supplier=/);assert.ok(url.includes('projectId='+PROJECT));
  wx.switchTab=o=>url=o.url;p.newMerchant();assert.equal(storage.get('huoji.newProject'),true);assert.equal(url,'/pages/projects/index');
  p.restoreAcknowledged({...a,id:'other',supplier:'商户AB',deletedAt:null,createdAt:'2026-10-18T01:00:00Z'});assert.equal(p.data.products.length,1);
 }finally{api.request=original;background.refresh=refresh;clearTimeout(p._organizeTimer);}
});
test('single merchant export uses the same task/date/supplier in preview and container job including unnamed shop',async()=>{
 const p=page('pages/export/index.js');p.onLoad({projectId:PROJECT,date:'2026-10-18',supplier:''});p.setData({images:false});
 const original=api.request,download=store.exportProject;let urls=[],options;
 api.request=async url=>{urls.push(url);if(url.startsWith('/api/merchants'))return[{supplier:'',total:2}];if(url.startsWith('/api/export-preview'))return{columns:[],headerRows:[]};return{items:[],matchedCount:2,summary:{total:2,confirmed:1}};};store.exportProject=async(_,id,share,o)=>{assert.equal(id,PROJECT);options=o;};
 try{await p.load();assert.ok(urls.filter(u=>!u.startsWith('/api/merchants')).every(u=>u.includes('projectId='+PROJECT)&&u.includes('date=2026-10-18')&&u.includes('supplier=')));assert.equal(p.data.exportCount,2);assert.equal(p.data.supplierLabel,'未填写商家');await p.export({currentTarget:{dataset:{}}});assert.equal(options.supplier,'');assert.equal(options.date,'2026-10-18');}
 finally{api.request=original;store.exportProject=download;}
});
test('late merchant lookup never changes a submitted save or the merchant inherited by the next product',async()=>{
 const p=editor();p._viewEpoch=1;p.setData({suppliers:['新商户','旧商户'],fields:{...domain.emptyFields,name:'新品'}});const original=api.request;let resolveContact,resolveSave,saved;
 api.request=(url,o)=>url.startsWith('/api/products?')?new Promise(r=>resolveContact=r):new Promise(r=>{saved=o.data;resolveSave=r;});
 try{
  const lookup=p.supplier({detail:{value:1}}),saving=p.saveNext();await new Promise(r=>setImmediate(r));assert.equal(saved.fields.supplierContact,'');
  resolveContact({items:[{...domain.emptyFields,supplier:'旧商户',supplierContact:'迟到联系人',photos:[]}],nextCursor:null});await lookup;assert.equal(p.data.fields.supplierContact,'');
  resolveSave({...saved.fields,id:PRODUCT,version:1,photos:[],description:''});await saving;assert.equal(p.data.fields.supplierContact,'');assert.equal(draft.list(session.capture()).length,0);
 }finally{api.request=original;}
});

test('merchant entry merges the same shop across old tasks and opens a date-scoped workspace with shared contact',async()=>{
 const p=page('pages/projects/index.js'),binding=session.capture(),original=api.request;p._alive=true;p._seq=1;p._owner=binding.owner;
 api.request=async()=>[{projectId:PROJECT,supplier:'商户A',supplierContact:'微信A',date:'2026-10-18',total:2,confirmed:1,pending:1,missingPrice:0},{projectId:PRODUCT,supplier:'商户A',date:'2026-10-18',total:1,confirmed:0,pending:1,missingPrice:0}];
 try{await p.loadVisits(binding,1);assert.equal(p.data.visibleProjects.length,1);assert.equal(p.data.visibleProjects[0].total,3);p.select({currentTarget:{dataset:{index:0}}});const selected=store.consumeMerchant(binding);assert.equal(selected.supplier,'商户A');assert.equal(selected.date,'2026-10-18');assert.equal(require('../miniprogram/utils/merchant-context').read(binding,PROJECT).current.supplierContact,'微信A');}finally{api.request=original;}
 const exportPage=page('pages/export/index.js');exportPage.onLoad({date:'2026-10-18',supplier:'商户A'});assert.equal(exportPage.fileName(),'商户A-2026-10-18.xlsx');exportPage.onLoad({date:'2026-10-17'});assert.equal(exportPage.fileName(),'看货记录-2026-10-17.xlsx');
});

test('merchant comparison scopes distinguish stores, unnamed and whole day; full-day review clears merchant context',async()=>{
 const a=store.comparisonScope({date:'2026-10-18',supplier:'A'}),b=store.comparisonScope({date:'2026-10-18',supplier:'B'}),blank=store.comparisonScope({date:'2026-10-18',supplier:''}),day=store.comparisonScope({date:'2026-10-18'});
 assert.equal(new Set([a,b,blank,day]).size,4);const binding=session.capture();store.setCompareSelection(binding,a,['one','two']);assert.deepEqual(store.compareSelection(binding,b),[]);
 const p=page('pages/products/index.js');p.setData({supplier:'A',merchantDay:true,viewDate:'2026-10-17'});let observed;p.load=async()=>observed={...p.data};await p.review();assert.equal(observed.supplier,null);assert.equal(observed.merchantDay,false);assert.equal(observed.date,'2026-10-17');
});
test('historical shop capture switches to today before opening a blank product and merge retains later contact',async()=>{
 const p=page('pages/products/index.js'),binding=session.capture();p._alive=true;p.setData({project:{id:PROJECT},merchantDay:true,viewDate:'2026-10-17',supplier:'店甲',merchants:[{supplier:'店甲',supplierContact:'微信甲'}]});let selected,url;p.load=async()=>{selected=store.consumeMerchant(binding);p.setData({viewDate:selected.date});};wx.navigateTo=o=>url=o.url;await p.add();assert.equal(selected.date,domain.chinaLocalDate());assert.equal(selected.supplier,'店甲');assert.match(url,/pages\/editor/);
 const list=page('pages/projects/index.js'),original=api.request;list._alive=true;list._seq=1;api.request=async()=>[{projectId:PROJECT,supplier:'店甲',total:1,pending:1},{projectId:PRODUCT,supplier:'店甲',supplierContact:'可继承',total:2,pending:2}];try{await list.loadVisits(binding,1);assert.equal(list.data.visibleProjects[0].supplierContact,'可继承');}finally{api.request=original;}
});

test('reopening products keeps the selected merchant and date without exposing old task names',async()=>{
 const binding=session.capture();store.selectMerchant(binding,{projectId:PROJECT,supplier:'店甲',date:'2026-10-17'});store.consumeMerchant(binding);store.consumeProductView(binding);
 const p=page('pages/products/index.js'),original=api.request;const urls=[];
 api.request=async url=>{urls.push(url);if(url==='/api/projects')return[{id:PROJECT,name:'旧任务名称',date:'2026-10-16'}];if(url.startsWith('/api/products?'))return{items:[],matchedCount:0};return[];};
 try{await p.load();assert.equal(p.data.merchantDay,true);assert.equal(p.data.supplier,'店甲');assert.equal(p.data.viewDate,'2026-10-17');assert.equal(p.data.project.name,'店甲');assert.ok(urls.some(u=>u.startsWith('/api/products?date=2026-10-17')&&u.includes('supplier=')));
  await p.allMerchants();assert.equal(p.data.project.name,'当天商品');assert.equal(store.rememberedMerchant(binding).supplier,null);
  store.selectProject(binding,PRODUCT);assert.equal(store.rememberedMerchant(binding),null);assert.equal(store.consumeMerchant(binding),null);
  const other=install('bob','b');assert.equal(store.rememberedMerchant(other),null);
 }finally{api.request=original;clearTimeout(p._organizeTimer);}
});

test('navigation decodes Chinese and percent merchant names once in export and comparison',()=>{
 for(const name of ['后台演示商户','店名 100%','店名 %E5']){const encoded=encodeURIComponent(name),exportPage=page('pages/export/index.js');exportPage.onLoad({date:'2026-10-17',supplier:encoded});assert.equal(exportPage._supplier,name);assert.equal(exportPage.fileName(),name+'-2026-10-17.xlsx');const compare=page('pages/compare/index.js');compare.onLoad({date:'2026-10-17',supplier:encoded});assert.equal(compare._supplier,name);}
});

test('explicit whole-day navigation clears a previously selected merchant',async()=>{
 const binding=session.capture();store.selectMerchant(binding,{projectId:PROJECT,supplier:'店甲',date:'2026-10-17'});store.consumeMerchant(binding);store.consumeProductView(binding);
 const p=page('pages/products/index.js');p._activeId=PROJECT;p.setData({supplier:'店甲',merchantDay:true,viewDate:'2026-10-17'});store.selectMerchant(binding,{projectId:PROJECT,supplier:'店甲',date:'2026-10-17'});store.requestProductView(binding,'day');const original=api.request,urls=[];api.request=async url=>{urls.push(url);return url.startsWith('/api/products?')?{items:[],matchedCount:0}:[];};
 try{await p.load();assert.equal(p.data.supplier,null);assert.equal(p.data.merchantDay,false);assert.equal(p.data.viewDate,'');assert.equal(p.data.viewMode,'day');assert.ok(urls.some(u=>u.startsWith('/api/products?date=')&&!u.includes('supplier=')));}finally{api.request=original;}
});

test('capture without an explicit named merchant goes to merchants despite a cached old task or store',async()=>{
 const merchants=require('../miniprogram/utils/merchant-context'),binding=session.capture();
 merchants.remember(binding,PROJECT,{supplier:'缓存旧店'});
 for(const supplier of [null,'','   ']){
  const p=page('pages/products/index.js');p.setData({project:{id:PROJECT},supplier});let destination;
  wx.switchTab=o=>destination=o.url;wx.navigateTo=()=>assert.fail('must not open an unnamed capture');
  await p.add();assert.equal(destination,'/pages/projects/index');
 }
 const p=page('pages/products/index.js');let destination;wx.switchTab=o=>destination=o.url;
 await p.add();assert.equal(destination,'/pages/projects/index');
});

test('a named group camera carries exactly that merchant rather than the previous cached store',async()=>{
 const binding=session.capture(),merchants=require('../miniprogram/utils/merchant-context');merchants.remember(binding,PROJECT,{supplier:'旧店',supplierContact:'旧微信'});
 const p=page('pages/products/index.js');p.setData({project:{id:PROJECT},supplier:null,merchants:[{supplier:'目标店',supplierContact:'目标微信'}]});let url;
 wx.navigateTo=o=>{url=o.url;if(o.complete)o.complete();};
 await p.add({currentTarget:{dataset:{supplier:'目标店'}}});
 assert.match(url,/editor\/index\?projectId=/);assert.deepEqual(merchants.consumeCapture(binding,PROJECT),{supplier:'目标店',supplierContact:'目标微信'});
 assert.equal(merchants.consumeCapture(binding,PROJECT),null);
});

test('capture admission is bound to project and current login session and never falls back to remembered merchants',()=>{
 const merchants=require('../miniprogram/utils/merchant-context'),binding=session.capture();
 assert.throws(()=>merchants.beginCapture(binding,PROJECT,{supplier:' '}),/商户/);
 merchants.beginCapture(binding,PROJECT,{supplier:'店甲'});assert.equal(merchants.consumeCapture(binding,PRODUCT),null);
 assert.equal(merchants.consumeCapture(binding,PROJECT),null);
 merchants.beginCapture(binding,PROJECT,{supplier:'店甲'});const replacement=install();assert.equal(merchants.consumeCapture(replacement,PROJECT),null);
 merchants.beginCapture(replacement,PROJECT,{supplier:'店甲'});const bob=install('bob','b');assert.equal(merchants.consumeCapture(bob,PROJECT),null);
});

test('a direct new-item URL with only an old project cannot open an editor or create a draft',async()=>{
 const binding=session.capture(),merchants=require('../miniprogram/utils/merchant-context');merchants.cancelCapture();merchants.remember(binding,PROJECT,{supplier:'旧店'});
 const p=page('pages/editor/index.js');p.onLoad({projectId:PROJECT});p._alive=true;p._viewEpoch=1;
 await p.open();assert.equal(p.data.ready,false);assert.equal(p.data.merchantRequired,true);assert.equal(draft.list(binding).length,0);
 let destination;wx.switchTab=o=>destination=o.url;p.chooseMerchant();assert.equal(destination,'/pages/projects/index');
});

test('new merchant capture locks its store, survives reopen and continues with the same store and contact',async()=>{
 const binding=session.capture(),merchants=require('../miniprogram/utils/merchant-context');merchants.beginCapture(binding,PROJECT,{supplier:'店甲',supplierContact:'微信甲'});
 const p=page('pages/editor/index.js');p.onLoad({projectId:PROJECT});p._alive=true;p._viewEpoch=1;p.loadCaptureTemplate=()=>{};p.loadSuppliers=async()=>{};p.loadCapabilities=()=>{};
 await p.open();assert.equal(p.data.ready,true);assert.equal(p.data.merchantLocked,true);
 p.input({currentTarget:{dataset:{key:'supplier'}},detail:{value:''}});await p.supplier({detail:{value:0}});assert.equal(p.data.fields.supplier,'店甲');
 p.input({currentTarget:{dataset:{key:'supplierContact'}},detail:{value:'新微信'}});p.input({currentTarget:{dataset:{key:'name'}},detail:{value:'第一件'}});
 p.onHide();p.onShow();assert.equal(p.data.fields.name,'第一件');assert.equal(p.data.fields.supplier,'店甲');
 const original=api.request;p.setData({autoOrganize:false});api.request=async(url,o)=>({...o.data.fields,id:PRODUCT,projectId:PROJECT,version:1,photos:[]});
 try{await p.saveNext();assert.equal(p.data.fields.name,'');assert.equal(p.data.fields.supplier,'店甲');assert.equal(p.data.fields.supplierContact,'新微信');assert.equal(p.data.merchantLocked,true);assert.equal(draft.list(binding).length,0);}
 finally{api.request=original;}
});

test('legacy unnamed new draft keeps its text and photo but cannot be formally saved until the store is repaired',async()=>{
 const binding=session.capture();files.add('/saved/legacy');draft.write(binding,PROJECT,PRODUCT,{fields:{...domain.emptyFields,name:'旧草稿',description:'旧现场原话'},photos:[{path:'/saved/legacy',persistent:true}]});
 const p=page('pages/editor/index.js');p.onLoad({projectId:PROJECT,draftId:PRODUCT,resume:'yes'});p._alive=true;p._viewEpoch=1;p.loadCaptureTemplate=()=>{};p.loadSuppliers=async()=>{};p.loadCapabilities=()=>{};
 await p.open();assert.equal(p.data.fields.description,'旧现场原话');assert.equal(p.data.photos[0].path,'/saved/legacy');
 const original=api.request;let sent=0;api.request=async()=>{sent++;};
 try{await p.save();assert.equal(sent,0);assert.equal(p.data.fieldError.key,'supplier');assert.equal(draft.read(binding,PROJECT,PRODUCT).fields.name,'旧草稿');assert.ok(files.has('/saved/legacy'));
  p.input({currentTarget:{dataset:{key:'supplier'}},detail:{value:'补回店名'}});p.setData({photos:[],autoOrganize:false});api.request=async(url,o)=>{sent++;return{...o.data.fields,id:domain.uuid(),version:1,photos:[]};};await p.saveNext();assert.equal(sent,1);assert.equal(p.data.fields.supplier,'补回店名');assert.equal(p.data.merchantLocked,true);
 }finally{api.request=original;}
});

test('editing an existing unnamed item can save but continue must return to merchants instead of creating an unnamed new item',async()=>{
 const p=editor();p._viewEpoch=1;p._productId=PRODUCT;p._version=1;p.setData({editing:true,fields:{...domain.emptyFields,name:'旧无店商品'}});
 const original=api.request;let destination,sent=0;wx.switchTab=o=>destination=o.url;api.request=async(url,o)=>{sent++;assert.equal(o.data.id,PRODUCT);return{...o.data.fields,id:PRODUCT,version:2,photos:[]};};
 try{await p.saveNext();assert.equal(sent,1);assert.equal(destination,'/pages/projects/index');assert.equal(p.data.ready,false);assert.equal(p._productId,PRODUCT);assert.equal(draft.list(session.capture()).length,0);}
 finally{api.request=original;}
});

test('legacy pending unnamed save is reconciled once and never starts a second unnamed capture',async()=>{
 const p=editor();p._viewEpoch=1;p.setData({fields:{...domain.emptyFields,name:'待核查旧商品'}});const command={projectId:PROJECT,fields:{...p.data.fields},photoIds:[],requestKey:domain.uuid()};p._pending=command;
 const original=api.request;let destination,sent=0;wx.switchTab=o=>destination=o.url;api.request=async(url,o)=>{sent++;assert.deepEqual(o.data,command);return{...command.fields,id:PRODUCT,version:1,photos:[]};};
 try{await p.saveNext();assert.equal(sent,1);assert.equal(p._productId,PRODUCT);assert.equal(p.data.ready,false);assert.equal(destination,'/pages/projects/index');}
 finally{api.request=original;}
});

test('historical capture ignores double taps and a late reload cannot open a store that the user has left',async()=>{
 for(const leave of [false,true]){
  const p=page('pages/products/index.js');p._alive=true;p._seq=1;p.setData({project:{id:PROJECT},supplier:'店甲',merchantDay:true,viewDate:'2026-10-17'});
  let finishLoad,loads=0,opens=0;p.load=()=>{loads++;p._seq++;return new Promise(resolve=>{finishLoad=resolve;});};wx.navigateTo=o=>{opens++;if(o.complete)o.complete();};
  const first=p.add();await p.add();assert.equal(loads,1);
  if(leave){p._seq++;p.setData({supplier:'店乙'});}finishLoad();await first;assert.equal(opens,leave?0:1);
  assert.equal(p._captureOpening,false);require('../miniprogram/utils/merchant-context').cancelCapture();
 }
});

test('merchant group export preserves the same confirmed scope as the main export action',()=>{
 const p=page('pages/products/index.js');p.setData({project:{id:PROJECT},supplier:'店甲',merchantDay:true,viewDate:'2026-10-18'});
 const urls=[];wx.navigateTo=o=>urls.push(new URL(o.url,'https://synthetic.invalid'));
 for(const status of ['all','confirmed']){
  p.setData({status});p.export();p.exportMerchant({currentTarget:{dataset:{supplier:'店甲'}}});
  const main=urls.at(-2).searchParams,group=urls.at(-1).searchParams;
  assert.deepEqual([...group].sort(),[...main].sort());assert.equal(group.get('scope'),status==='confirmed'?'confirmed':null);
 }
});

test('new capture return follows the actual server record day and editing old records does not move it',async()=>{
 const binding=session.capture();store.selectMerchant(binding,{projectId:PROJECT,supplier:'店甲',date:'2026-10-18'});store.consumeMerchant(binding);store.consumeProductView(binding);
 const p=editor();p._viewEpoch=1;p._saveWasNew=true;p.setData({fields:{...domain.emptyFields,name:'跨日新品',supplier:'店甲',supplierContact:'新微信'}});
 await p.finish(1,{...p.data.fields,id:PRODUCT,projectId:PROJECT,createdAt:'2026-10-20T16:00:00.000Z',photos:[]});
 assert.equal(store.rememberedMerchant(binding).date,'2026-10-21');assert.equal(store.consumeMerchant(binding).supplierContact,'新微信');assert.equal(store.consumeProductView(binding),'task');
 p._saveWasNew=false;await p.finish(1,{...p.data.fields,id:PRODUCT,createdAt:'2026-10-18T00:00:00.000Z',photos:[]});
 assert.equal(store.rememberedMerchant(binding).date,'2026-10-21');assert.equal(store.consumeMerchant(binding),null);
});

test('new pending receipt updates its record day even when later local edits require a separate update',async()=>{
 const binding=session.capture();store.selectMerchant(binding,{projectId:PROJECT,supplier:'店甲',date:'2026-10-18'});store.consumeMerchant(binding);store.consumeProductView(binding);
 const p=editor();p._viewEpoch=1;p.setData({fields:{...domain.emptyFields,name:'后来改的名称',supplier:'店甲'}});
 const submitted={projectId:PROJECT,fields:{...p.data.fields,name:'已提交名称'},photoIds:[],requestKey:domain.uuid()};p._pending=submitted;
 const original=api.request;let calls=0;api.request=async(url,o)=>{calls++;return{...o.data.fields,id:PRODUCT,projectId:PROJECT,version:calls,createdAt:'2026-10-20T16:00:00.000Z',photos:[]};};
 try{
  await p.save();assert.equal(calls,1);assert.equal(p._productId,PRODUCT);assert.equal(p.data.fields.name,'后来改的名称');assert.equal(store.rememberedMerchant(binding).date,'2026-10-21');assert.equal(draft.list(binding).length,1);
  store.consumeMerchant(binding);store.consumeProductView(binding);
  await p.save();assert.equal(calls,2);assert.equal(store.rememberedMerchant(binding).date,'2026-10-21');assert.equal(store.consumeMerchant(binding),null);assert.equal(draft.list(binding).length,0);
 }finally{api.request=original;}
});

test('reconciling an existing-product pending update never changes the selected record day',async()=>{
 const binding=session.capture();store.selectMerchant(binding,{projectId:PROJECT,supplier:'店甲',date:'2026-10-21'});store.consumeMerchant(binding);store.consumeProductView(binding);
 const p=editor();p._viewEpoch=1;p._pending={projectId:PROJECT,id:PRODUCT,version:1,fields:{...p.data.fields},photoIds:[],requestKey:domain.uuid()};
 const original=api.request;api.request=async(url,o)=>({...o.data.fields,id:PRODUCT,version:2,createdAt:'2026-10-18T00:00:00.000Z',photos:[]});
 try{await p.save();assert.equal(p._saveWasNew,false);assert.equal(store.rememberedMerchant(binding).date,'2026-10-21');assert.equal(store.consumeMerchant(binding),null);}finally{api.request=original;}
});

test('date exports warn about owned merchant drafts across old tasks without including them in exported counts',async()=>{
 const binding=session.capture();
 const add=(projectId,productId,supplier)=>draft.write(binding,projectId,productId,{fields:{...domain.emptyFields,name:'合成草稿',supplier},photos:[]});
 add(PROJECT,'draft-a','店甲');add(PRODUCT,'draft-b','店甲');add(PRODUCT,'draft-c','店乙');add(PROJECT,'draft-empty','');
 const old=draft.read(binding,PROJECT,'draft-a');old.updatedAt=1;storage.set(draft.key(binding.owner,PROJECT,'draft-a'),old);
 storage.set(draft.key('other-owner',PROJECT,'foreign'),{format:1,owner:'other-owner',projectId:PROJECT,fields:{...domain.emptyFields,supplier:'店甲'},photos:[]});
 const p=page('pages/export/index.js');p.onLoad({date:'2026-10-21',supplier:encodeURIComponent('店甲')});p.loadMerchantOptions=async()=>{};p.loadMetadata=async()=>{};p.loadPreview=async()=>p.setData({exportCount:7});
 await p.load();assert.deepEqual(p.data.drafts.map(d=>d.productId).sort(),['draft-a','draft-b']);assert.equal(p.data.exportCount,7);assert.equal(p.data.supplierScoped,true);
 p._merchants=[{supplier:undefined,label:'所有商家'},{supplier:'',label:'未填写商家'},{supplier:'店乙',label:'店乙'}];
 await p.merchant({detail:{value:1}});assert.deepEqual(p.data.drafts.map(d=>d.productId),['draft-empty']);assert.equal(p.data.exportCount,7);
 await p.merchant({detail:{value:2}});assert.deepEqual(p.data.drafts.map(d=>d.productId),['draft-c']);
 await p.merchant({detail:{value:0}});assert.equal(p.data.drafts.length,4);assert.equal(p.data.supplierScoped,false);assert.equal(p.data.exportCount,7);
});
