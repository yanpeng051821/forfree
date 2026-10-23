const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const config = require('../miniprogram/config');
const session = require('../miniprogram/utils/session');
const api = require('../miniprogram/utils/api');
const container = require('../miniprogram/utils/container');
const endpoint = require('../miniprogram/utils/endpoint');

const ENV = config.CLOUD_ENV;
const SERVICE = config.CLOUD_SERVICE;
const SOURCE = fs.readFileSync(path.join(__dirname, '../miniprogram/utils/container.js'), 'utf8');
let containerCalls, httpCalls, written;
let readCalls, fileBase64, readFails;

function mockWx(options) {
  const settings = options || {};
  const cloud = settings.cloud !== false;
  const sdk = settings.sdk || '2.33.0';
  const envVersion = settings.envVersion || 'release';
  const platform = settings.platform || 'ios';
  const storage = new Map();
  containerCalls = []; httpCalls = []; written = [];
  readCalls = []; fileBase64 = ''; readFails = false;
  global.getCurrentPages = () => [];
  global.wx = {
    getStorageSync: key => storage.has(key) ? structuredClone(storage.get(key)) : '',
    setStorageSync: (key, value) => storage.set(key, JSON.parse(JSON.stringify(value))),
    removeStorageSync: key => storage.delete(key),
    getAccountInfoSync: () => ({ miniProgram: { envVersion, SDKVersion: sdk } }),
    getDeviceInfo: () => ({ platform, SDKVersion: sdk }),
    hideTabBar() {}, showTabBar() {}, reLaunch: o => { if (o.complete) o.complete(); },
    request: o => { httpCalls.push(o); o.success({ statusCode: 200, data: [] }); },
    uploadFile: o => { httpCalls.push(o); o.success({ statusCode: 201, data: '{"id":"photo"}' }); },
    downloadFile: o => { httpCalls.push(o); o.success({ statusCode: 200, tempFilePath: '/temp/from-domain' }); },
    getFileSystemManager: () => ({
      writeFileSync: (target, data, encoding) => written.push({ target, data, encoding }),
      readFile: o => { readCalls.push(o); if (readFails) { o.fail({ errMsg: 'readFile:fail' }); return; } o.success({ data: fileBase64 }); },
    }),
    env: { USER_DATA_PATH: 'wxfile://usr' }
  };
  if (cloud) global.wx.cloud = { callContainer: o => { containerCalls.push(o); o.success({ statusCode: 200, data: [], header: { 'x-wx-openid': 'private-openid' } }); } };
}
function install(owner, letter) {
  session.clear();
  session.install({ user: { id: owner || 'alice' }, token: (letter || 'a').repeat(64), expiresAt: Date.now() + 60000 });
  return session.capture();
}
function respond(statusCode, data) {
  global.wx.cloud.callContainer = o => { containerCalls.push(o); o.success({ statusCode, data, header: { 'x-wx-openid': 'private-openid' } }); };
}

test('container probe requires cloud env, service, SDK 2.23.0 and a real device', () => {
  mockWx(); assert.equal(container.isContainerAvailable(), true);
  mockWx({ cloud: false }); assert.equal(container.isContainerAvailable(), false);
  mockWx({ sdk: '2.22.9' }); assert.equal(container.isContainerAvailable(), false);
  mockWx({ sdk: '2.23.0' }); assert.equal(container.isContainerAvailable(), true);
  mockWx({ envVersion: 'develop', platform: 'devtools' }); assert.equal(container.isContainerAvailable(), true);
  const local = endpoint.localDevelopment; endpoint.localDevelopment = () => true;
  try { assert.equal(container.isContainerAvailable(), false); } finally { endpoint.localDevelopment = local; }
  delete global.wx; assert.equal(container.isContainerAvailable(), false);
});

test('request prefers callContainer with a relative path and never touches the public domain', async () => {
  mockWx(); const binding = install();
  const result = await api.request('/api/projects', { method: 'POST', data: { name: '杯子' } });
  assert.deepEqual(result, []);
  assert.equal(httpCalls.length, 0);
  assert.equal(containerCalls.length, 1);
  const call = containerCalls[0];
  assert.equal(call.path, '/api/projects');
  assert.equal(call.method, 'POST');
  // 容器通道不会自动序列化 JSON，必须显式转字符串，否则后端解析失败。
  assert.equal(call.data, JSON.stringify({ name: '杯子' }));
  assert.deepEqual(call.config, { env: ENV });
  assert.equal(call.header['X-WX-SERVICE'], SERVICE);
  assert.equal(call.header.Authorization, 'Bearer ' + binding.token);
  assert.equal(call.timeout, 15000);
  assert.equal(call.url, undefined);
  assert.equal(call.filePath, undefined);
});

test('container statusCode is normalized and 401 or 500 keep the original error contract', async () => {
  mockWx({ envVersion: 'develop' }); install();
  respond(401, {});
  await assert.rejects(() => api.request('/api/projects'), error => error.code === 'HTTP_401' && /服务暂不可用/.test(error.message));
  install();
  respond(500, { error: { code: 'CONFLICT', message: '版本冲突，请刷新' } });
  await assert.rejects(() => api.request('/api/projects'), error => error.code === 'CONFLICT' && error.message === '版本冲突，请刷新');
  install();
  respond(200, { ok: true });
  assert.deepEqual(await api.request('/api/projects'), { ok: true });
});

test('container transport failure keeps the original wording and leaks no internal address', async () => {
  mockWx({ envVersion: 'develop' }); install();
  global.wx.cloud.callContainer = o => { containerCalls.push(o); o.fail({ errMsg: 'callContainer:fail https://huoji-api-yanpeng-d1giw89zv518e3f6e-1374757182.ap-shanghai.run.wxcloudrun.com/api/projects not in domain list' }); };
  let error;
  await assert.rejects(() => api.request('/api/projects').catch(e => { error = e; throw e; }));
  assert.equal(error.code, 'NETWORK_UNKNOWN');
  assert.equal(error.message, '暂时无法连接服务，请检查网络后重试');
  assert.doesNotMatch(error.message, /https?:|yanpeng-|huoji-api|\/api\//);
  await assert.rejects(() => api.request('/api/projects', { method: 'POST', data: {} }), e => /保存结果可能未返回/.test(e.message));
  await assert.rejects(() => api.request('/api/auth/wechat', { method: 'POST', data: { code: 'x' }, public: true }), e => /登录服务/.test(e.message));
});

test('unavailable cloud or old SDK never falls back to public request, photo/workbook upload or download', async () => {
  for(const options of [{cloud:false},{sdk:'2.22.0'},{cloud:false,envVersion:'develop',platform:'devtools'}]){
    mockWx(options);const binding=install();
    for(const operation of [()=>api.request('/api/projects'),()=>api.request('/api/auth/wechat',{public:true,method:'POST',data:{code:'synthetic'}}),()=>api.upload('/saved/synthetic.jpg',binding),()=>api.uploadWorkbook('/saved/synthetic.xlsx',binding),()=>api.download('/api/photos/synthetic',binding)]){
      await assert.rejects(operation,error=>error.code==='CONTAINER_UNAVAILABLE' && /TRANSPORT_CONTAINER/.test(error.message) && !/https?:|yanpeng-|huoji-api|Bearer/.test(error.message));
    }
    assert.equal(containerCalls.length,0);assert.equal(httpCalls.length,0);assert.equal(api.lastDiagnosis(),'TRANSPORT_CONTAINER');
  }
});

test('desktop development keeps the cloud channel unless local development is explicitly enabled',async()=>{
  mockWx({ envVersion: 'develop', platform: 'devtools' }); install();
  await api.request('/api/projects');
  assert.equal(containerCalls.length, 1);
  assert.equal(httpCalls.length, 0);
});

function apiWithConfig(overrides) {
  const configuration={...config,...overrides};
  const endpointContext={module:{exports:{}},wx:global.wx,require:id=>id==='../config'?configuration:session};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../miniprogram/utils/endpoint.js'),'utf8'),endpointContext);
  const modules={'../config':configuration,'./session':session,'./endpoint':endpointContext.module.exports,'./container':container,'./auth-gate':{lock(){}}};
  const context={module:{exports:{}},wx:global.wx,require:id=>modules[id]};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../miniprogram/utils/api.js'),'utf8'),context);
  return context.module.exports;
}

test('explicit desktop loopback mode allows local APIs, uploads and downloads without enabling development login',async()=>{
  mockWx({cloud:false,envVersion:'develop',platform:'devtools'});const binding=install();
  const local=apiWithConfig({USE_LOCAL_API:true,ENABLE_LOCAL_DEV_LOGIN:false});
  await local.request('/api/projects');await local.upload('/saved/synthetic.jpg',binding);await local.uploadWorkbook('/saved/synthetic.xlsx',binding,true);await local.download('/api/photos/synthetic',binding);
  assert.equal(httpCalls.length,4);httpCalls.forEach(call=>{assert.ok(call.url.startsWith('http://127.0.0.1:3000/api/'));assert.equal(call.header.Authorization,'Bearer '+binding.token);assert.equal(call.timeout,15000);});
});

test('local flags cannot enable public or non-loopback transports on real devices, release builds or malformed local URLs',async()=>{
  for(const options of [{envVersion:'release',platform:'ios'},{envVersion:'develop',platform:'ios'},{envVersion:'release',platform:'devtools'},{envVersion:'develop',platform:'devtools',local:'https://api.invalid'},{envVersion:'develop',platform:'devtools',local:'http://127.0.0.1:3000@api.invalid'},{envVersion:'develop',platform:'devtools',local:'http://localhost:3000'}]){
    mockWx({...options,cloud:false});const binding=install();const local=apiWithConfig({USE_LOCAL_API:true,ENABLE_LOCAL_DEV_LOGIN:true,...(options.local?{LOCAL_API_BASE_URL:options.local}:{})});
    await assert.rejects(()=>local.request('/api/projects'),e=>e.code==='CONTAINER_UNAVAILABLE');await assert.rejects(()=>local.upload('/saved/synthetic.jpg',binding),e=>e.code==='CONTAINER_UNAVAILABLE');await assert.rejects(()=>local.download('/api/photos/synthetic',binding),e=>e.code==='CONTAINER_UNAVAILABLE');assert.equal(httpCalls.length,0);
  }
});

test('upload in the container sends ordered base64 chunks instead of filePath', async () => {
  mockWx(); const binding = install();
  // 120000 原始字节 -> 160000 base64 字符 -> 每片65536字符 -> 3片。
  const bytes = Buffer.alloc(120000, 9);
  fileBase64 = bytes.toString('base64');
  global.wx.cloud.callContainer = o => {
    containerCalls.push(o);
    const body = JSON.parse(o.data);
    const done = body.index === body.total - 1;
    o.success({
      statusCode: done ? 201 : 202,
      data: done ? { id: 'photo', name: 'image.jpg', url: '/api/photos/photo' } : { received: body.index + 1, total: body.total, complete: false },
      header: {}
    });
  };
  const photo = await api.upload('/saved/image.jpg', binding);
  assert.deepEqual(photo, { id: 'photo', name: 'image.jpg', url: '/api/photos/photo' });
  assert.equal(httpCalls.length, 0);
  assert.equal(readCalls.length, 1);
  assert.equal(readCalls[0].filePath, '/saved/image.jpg');
  assert.equal(readCalls[0].encoding, 'base64');
  assert.equal(containerCalls.length, 3);
  const bodies = containerCalls.map(call => JSON.parse(call.data));
  assert.deepEqual(bodies.map(body => body.index), [0, 1, 2]);
  bodies.forEach((body, index) => {
    const call = containerCalls[index];
    assert.equal(call.path, '/api/photos/chunks');
    assert.equal(call.method, 'POST');
    assert.equal(typeof call.data, 'string');
    assert.equal(call.filePath, undefined);
    assert.equal(call.dataType, undefined);
    assert.equal(call.header['X-WX-SERVICE'], SERVICE);
    assert.equal(call.header.Authorization, 'Bearer ' + binding.token);
    assert.equal(body.total, 3);
    assert.equal(body.name, 'image.jpg');
    assert.equal(body.uploadId, bodies[0].uploadId);
    assert.match(body.uploadId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  // 48KiB 原始字节切片，最后一片为剩余部分。
  assert.equal(Buffer.from(bodies[0].data, 'base64').length, 48 * 1024);
  assert.equal(Buffer.from(bodies[1].data, 'base64').length, 48 * 1024);
  assert.equal(Buffer.from(bodies[2].data, 'base64').length, 120000 - 96 * 1024);
  assert.deepEqual(Buffer.concat(bodies.map(body => Buffer.from(body.data, 'base64'))), bytes);
});

test('chunk upload fails as a whole on the first failed chunk and keeps the local file', async () => {
  mockWx(); const binding = install();
  const bytes = Buffer.alloc(120000, 9);
  fileBase64 = bytes.toString('base64');
  global.wx.cloud.callContainer = o => {
    containerCalls.push(o);
    const body = JSON.parse(o.data);
    if (body.index === 1) { o.success({ statusCode: 500, data: { error: { code: 'INTERNAL', message: '服务暂不可用' } }, header: {} }); return; }
    o.success({ statusCode: 202, data: { received: 1, total: body.total, complete: false }, header: {} });
  };
  await assert.rejects(() => api.upload('/saved/image.jpg', binding), error => error.code === 'INTERNAL');
  // 任一片失败即停，不发送第3片；本机文件从未被删除或改写。
  assert.equal(containerCalls.length, 2);
  assert.equal(httpCalls.length, 0);
  assert.equal(written.length, 0);
});

test('chunk upload fails when the local file cannot be read', async () => {
  mockWx(); const binding = install();
  readFails = true;
  await assert.rejects(() => api.upload('/saved/image.jpg', binding), error => error.code === 'UPLOAD_FAILED' && /本机照片已保留/.test(error.message));
  assert.equal(readCalls.length, 1);
  assert.equal(containerCalls.length, 0);
  assert.equal(httpCalls.length, 0);
});

test('chunk upload rejects photos over 8MB before sending anything', async () => {
  mockWx(); const binding = install();
  fileBase64 = Buffer.alloc(8 * 1024 * 1024 + 1, 1).toString('base64');
  await assert.rejects(() => api.upload('/saved/image.jpg', binding), error => error.code === 'INVALID_PHOTO' && error.message === '照片不能超过 8MB');
  assert.equal(containerCalls.length, 0);
  assert.equal(httpCalls.length, 0);
});

test('uploadWorkbook still sends filePath through the container and keeps upload failures', async () => {
  mockWx(); const binding = install();
  await api.uploadWorkbook('/saved/book.xlsx', binding, false);
  assert.equal(containerCalls[0].path, '/api/procurement/import');
  assert.equal(containerCalls[0].filePath, '/saved/book.xlsx');
  assert.equal(containerCalls[0].name, 'workbook');
  await api.uploadWorkbook('/saved/tpl.xlsx', binding, true);
  assert.equal(containerCalls[1].path, '/api/procurement-template/import');
  assert.equal(containerCalls[1].filePath, '/saved/tpl.xlsx');
  assert.equal(containerCalls[1].name, 'workbook');

  global.wx.cloud.callContainer = o => o.fail();
  await assert.rejects(() => api.uploadWorkbook('/saved/book.xlsx', binding, false), e => e.code === 'UPLOAD_FAILED' && /原文件仍在本机/.test(e.message));
});

test('download writes the container payload to a temp path and keeps 404, 401 and failure codes', async () => {
  mockWx(); let binding = install();
  global.wx.cloud.callContainer = o => { containerCalls.push(o); o.success({ statusCode: 200, data: new ArrayBuffer(8), header: {} }); };
  const target = await api.download('/api/photos/1', binding);
  assert.equal(containerCalls[0].path, '/api/photos/1');
  assert.equal(containerCalls[0].dataType, 'text');
  assert.equal(containerCalls[0].responseType, 'arraybuffer');
  assert.equal(containerCalls[0].header['X-WX-SERVICE'], SERVICE);
  assert.equal(containerCalls[0].header.Authorization, 'Bearer ' + binding.token);
  assert.equal(httpCalls.length, 0);
  assert.ok(target.startsWith('wxfile://usr/'));
  assert.equal(written.length, 1);
  assert.equal(written[0].target, target);
  assert.equal(written[0].encoding, 'binary');
  assert.ok(target.endsWith('.jpg'));

  respond(404, {});
  await assert.rejects(() => api.download('/api/photos/1', binding), e => e.code === 'NOT_FOUND');
  global.wx.cloud.callContainer = o => o.fail();
  await assert.rejects(() => api.download('/api/photos/1', binding), e => e.code === 'DOWNLOAD_FAILED');
  binding = install();
  respond(401, {});
  await assert.rejects(() => api.download('/api/photos/1', binding), e => e.code === 'LOGIN_REQUIRED');
});

test('binary downloads preserve non-UTF8 bytes and reject an accidentally decoded text response', async () => {
  mockWx(); const binding = install();
  const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xdb, 0, 0x80]);
  global.wx.cloud.callContainer = o => {
    containerCalls.push(o);
    // Reproduce the real container distinction: dataType=arraybuffer alone decodes text.
    const data = o.responseType === 'arraybuffer' ? bytes.buffer : Buffer.from(bytes).toString('utf8');
    o.success({ statusCode: 200, data, header: {} });
  };
  await api.download('/api/photos/2', binding);
  assert.deepEqual(new Uint8Array(written[0].data), bytes);
  respond(200, '\ufffd\ufffd broken binary');
  await assert.rejects(() => api.download('/api/photos/2', binding), e => e.code === 'DOWNLOAD_FAILED');
  assert.equal(written.length, 1);
});

test('container module never prints or persists the WeChat user headers', () => {
  assert.doesNotMatch(SOURCE, /console\./);
  assert.doesNotMatch(SOURCE, /setStorageSync|getStorageSync|writeFileSync\([^)]*header/);
  assert.match(SOURCE, /X-WX-SERVICE/);
});
