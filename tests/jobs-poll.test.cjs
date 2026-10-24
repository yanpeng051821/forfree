const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const session = require('../miniprogram/utils/session');
const api = require('../miniprogram/utils/api');
const jobs = require('../miniprogram/utils/jobs');

const JOB = '3f2a1b4c-5d6e-4f70-8a91-2b3c4d5e6f70';
let requests, responses;
function install() { session.install({ user: { id: 'alice' }, token: 'a'.repeat(64), expiresAt: Date.now() + 60000 }); return session.capture(); }
// 模拟真实云容器边界，保持原有业务断言读取解码后的请求体。
function replyInContainer(o) {
  assert.equal(o.timeout,15000);
  let data=o.data;
  if(data!==undefined){assert.equal(typeof data,'string','容器JSON请求必须显式串化');data=JSON.parse(data);}
  requests.push({...o,url:o.path,data});
  const reply=responses.shift() || {statusCode:200,data:{}};
  o.success({statusCode:reply.statusCode || 200,data:reply.data});
}
function transport(queue) {
  responses = queue;
  global.wx.cloud={callContainer:replyInContainer};
}
beforeEach(() => {
  requests = []; responses = [];
  global.wx = {
    getStorageSync: () => '', setStorageSync() {}, removeStorageSync() {},
    getAccountInfoSync: () => ({ miniProgram: { envVersion: 'develop' } }), getDeviceInfo: () => ({ platform: 'devtools' }),
    request: () => assert.fail('云任务不能回退公网wx.request'),
    cloud:{callContainer:replyInContainer},
  };
  session.clear(); install();
});

test('api.js 保持既有导出，并新增提交与查询任务的入口', () => {
  for (const name of ['request', 'upload', 'uploadWorkbook', 'download', 'login', 'logout', 'lastDiagnosis', 'recordReason']) assert.equal(typeof api[name], 'function', name);
  assert.equal(typeof api.extractAsync, 'function');
  assert.equal(typeof api.getJob, 'function');
  // 容器通道会把超时钳到 15000，声明更大的值只会误导调用方。
  assert.equal(api.CONTAINER_MAX_TIMEOUT, 15000);
  assert.equal(jobs.POLL_INTERVAL_MS, 1500);
  assert.equal(jobs.MAX_POLLS, 40);
});

test('整理提交只发一次请求，结果靠任务号轮询取回', async () => {
  const binding = install();
  transport([
    { statusCode: 202, data: { jobId: JOB, state: 'pending' } },
    { statusCode: 200, data: { jobId: JOB, kind: 'extraction', state: 'running', result: null, error: null } },
    { statusCode: 200, data: { jobId: JOB, kind: 'extraction', state: 'succeeded', result: { fields: { name: '杯子' }, mode: 'model', warning: '请核对' }, error: null } },
  ]);
  const { jobId, result } = await jobs.runExtract('陶瓷杯，12元一个', [], binding, { interval: 0, maxPolls: 5 });
  assert.equal(jobId, JOB);
  assert.equal(result.fields.name, '杯子');
  assert.equal(requests.length, 3);
  assert.match(requests[0].url, /\/api\/extract$/);
  assert.equal(requests[0].method, 'POST');
  assert.deepEqual(requests[0].data, { description: '陶瓷杯，12元一个', photoIds: [] });
  assert.match(requests[1].url, new RegExp('/api/jobs/' + JOB + '$'));
  assert.match(requests[2].url, new RegExp('/api/jobs/' + JOB + '$'));
});

test('任务失败把服务端错误码与文案抛给页面，成功前不写入任何字段', async () => {
  const binding = install();
  transport([
    { statusCode: 202, data: { jobId: JOB, state: 'pending' } },
    { statusCode: 200, data: { jobId: JOB, kind: 'extraction', state: 'failed', result: null, error: { code: 'UPSTREAM_FAILED', message: '智能整理服务暂不可用，原始记录已保留' } } },
  ]);
  await assert.rejects(() => jobs.runExtract('杯子', [], binding, { interval: 0 }), error => {
    assert.equal(error.code, 'UPSTREAM_FAILED');
    assert.match(error.message, /原始记录已保留/);
    return true;
  });
  assert.equal(requests.length, 2);
});

test('轮询到上限仍未结束就提示仍在进行，不会无限等待', async () => {
  const binding = install();
  transport([
    { statusCode: 202, data: { jobId: JOB, state: 'pending' } },
    { statusCode: 200, data: { jobId: JOB, kind: 'extraction', state: 'running', result: null, error: null } },
    { statusCode: 200, data: { jobId: JOB, kind: 'extraction', state: 'running', result: null, error: null } },
    { statusCode: 200, data: { jobId: JOB, kind: 'extraction', state: 'running', result: null, error: null } },
  ]);
  await assert.rejects(() => jobs.pollJob(JOB, binding, { interval: 0, maxPolls: 3 }), error => {
    assert.equal(error.code, 'JOB_TIMEOUT');
    return true;
  });
  assert.equal(requests.length, 3, '每次轮询都是一次独立的15秒内请求');
});

test('任务号不合法不发请求，避免拼出越权路径', async () => {
  const binding = install();
  // 任务号校验是同步的：非法值一律不发请求。
  assert.throws(() => api.getJob('../jobs/other', binding), error => error.code === 'BAD_RESPONSE');
  assert.throws(() => api.getJob('', binding), error => error.code === 'BAD_RESPONSE');
  assert.equal(requests.length, 0);
  await assert.rejects(() => jobs.pollJob('nope', binding, { interval: 0, maxPolls: 2 }), error => error.code === 'BAD_RESPONSE');
});

test('AI模型会话过期自动微信换码，只恢复当前会话并重试一次', async () => {
  const binding = install(); let logins = 0;
  global.wx.login = o => { logins++; o.success({ code: 'fresh-wx-code' }); };
  transport([
    { statusCode: 202, data: { jobId: JOB, state: 'pending' } },
    { data: { jobId: JOB, kind: 'extraction', state: 'failed', error: { code: 'MODEL_LOGIN_REQUIRED', message: 'AI 服务会话已失效' } } },
    { data: { restored: true } },
    { statusCode: 202, data: { jobId: JOB, state: 'pending' } },
    { data: { jobId: JOB, kind: 'extraction', state: 'succeeded', result: { fields: { name: '杯子' }, mode: 'model', warning: '' } } },
  ]);
  const result = await jobs.runExtract('杯子', [], binding, { interval: 0 });
  assert.equal(result.result.fields.name, '杯子'); assert.equal(logins, 1);
  assert.match(requests[2].url, /\/api\/auth\/model-session$/);
  assert.deepEqual(requests[2].data, { code: 'fresh-wx-code' });
  assert.equal(session.valid(binding), true, '不替换业务令牌，不失效已有草稿绑定');
});

test('恢复后再次过期不循环，403模型权限不触发微信登录', async () => {
  const binding = install(); let logins = 0; global.wx.login = o => { logins++; o.success({ code: 'code' }); };
  const failed = code => ({ data: { jobId: JOB, kind: 'extraction', state: 'failed', error: { code, message: 'AI失败' } } });
  transport([{ data: { jobId: JOB } }, failed('MODEL_LOGIN_REQUIRED'), { data: { restored: true } }, { data: { jobId: JOB } }, failed('MODEL_LOGIN_REQUIRED')]);
  await assert.rejects(jobs.runExtract('杯', [], binding, { interval: 0 }), e => e.code === 'MODEL_LOGIN_REQUIRED');
  assert.equal(logins, 1); assert.equal(requests.length, 5);
  transport([{ data: { jobId: JOB } }, failed('MODEL_FORBIDDEN')]);
  await assert.rejects(jobs.runExtract('杯', [], binding, { interval: 0 }), e => e.code === 'MODEL_FORBIDDEN');
  assert.equal(logins, 1); assert.equal(session.valid(binding), true);
});

test('微信换码期间切换账号或页面不重发原记录', async () => {
  const binding = install();
  global.wx.login = o => { session.clear(); install(); o.success({ code: 'other-account' }); };
  transport([{ data: { jobId: JOB } }, { data: { jobId: JOB, kind: 'extraction', state: 'failed', error: { code: 'MODEL_LOGIN_REQUIRED', message: '已过期' } } }]);
  await assert.rejects(jobs.runExtract('私人商品', [], binding, { interval: 0 }), e => e.code === 'IDENTITY_CHANGED');
  assert.equal(requests.length, 2);
});


test('旧容器协议只允许安全小文件且不回退公网下载', async () => {
  const store = require('../miniprogram/utils/store');
  const original = { request: api.request, getJob: api.getJob, download: api.download };
  const size = 655360, cache = new Map();
  wx.env = { USER_DATA_PATH: '/test' }; wx.getFileSystemManager = () => ({
    writeFileSync: (p) => cache.set(p, Buffer.alloc(0)), readFileSync: p => cache.get(p),
    appendFileSync: (p, b) => cache.set(p, Buffer.concat([cache.get(p), b])), unlinkSync: p => cache.delete(p),
  });
  api.request = async path => path === '/api/export-jobs' ? { jobId: JOB, state: 'pending' } : { size, chunkSize: 4 * 1024 * 1024 };
  api.getJob = async () => ({ jobId: JOB, kind: 'product-export', state: 'succeeded' });
  let count = 0; api.download = async path => { const offset = Number(path.split('offset=')[1]); const chunk = '/chunk' + count++; cache.set(chunk, Buffer.alloc(Math.min(4 * 1024 * 1024, size - offset), count)); return chunk; };
  try { const file = await store.exportInContainer(session.capture(), JOB, {}); assert.equal(cache.get(file).length, size); assert.equal(count, 1); assert.equal(cache.size, 1); assert.equal(cache.get(file)[size - 1], 1); }
  finally { Object.assign(api, original); }
});

test('named exports preserve record date in the actual opened file path and isolate repeated exports',async()=>{
 const store=require('../miniprogram/utils/store'),original={usesContainer:api.usesContainer,download:api.download},moves=[],directories=[],opened=[];
 wx.env={USER_DATA_PATH:'/test'};wx.getFileSystemManager=()=>({mkdirSync:(p,r)=>directories.push([p,r]),renameSync:(a,b)=>moves.push([a,b])});wx.openDocument=o=>{opened.push(o.filePath);o.success();};
 api.usesContainer=()=>false;api.download=async()=>'/download/temp.xlsx';
 try{const binding=session.capture();await store.exportProject(binding,'project',false,{date:'2026-10-17',fileName:'店甲-2026-10-17.xlsx'});await store.exportProject(binding,'project',false,{date:'2026-10-17',fileName:'店甲-2026-10-17.xlsx'});
  assert.ok(opened.every(p=>p.endsWith('/店甲-2026-10-17.xlsx')));assert.notEqual(opened[0],opened[1]);assert.equal(moves.length,2);assert.equal(directories.length,2);
 }finally{Object.assign(api,original);}
});
