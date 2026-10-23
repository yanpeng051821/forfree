const config = require('../config');
const session = require('./session');
const endpoint = require('./endpoint');
const container = require('./container');
const gate = require('./auth-gate');
const url = endpoint.url;
// 微信容器通道 wx.cloud.callContainer 会把单次请求超时钳到 15000ms（见 container.js MAX_TIMEOUT），
// 这里写 45000/60000 不会生效，只会被钳到同一个上限并误导调用方，所以统一声明为同一常量。
// 显式本机开发通道同样按此值声明：真机只走容器，长耗时操作一律改成任务号轮询。
const CONTAINER_MAX_TIMEOUT = 15000;
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// 容器通道单次文本上限100KiB：按48KiB原始字节切片，base64后约64KB，留足JSON信封余量。
const PHOTO_MAX_BYTES = 8 * 1024 * 1024;
const PHOTO_CHUNK_BASE64 = 48 * 1024 * 4 / 3;
function decoded(data) { if (typeof data === 'string') { try { return JSON.parse(data); } catch (_) { throw session.error('BAD_RESPONSE', '服务响应无效，请稍后重试'); } } return data; }
function failure(data, status) {
  const value = decoded(data);
  return session.error(value && value.error && value.error.code || 'HTTP_' + status, value && value.error && value.error.message || '服务暂不可用，请稍后重试');
}
function handleAuth(err, binding) {
  if (err.code === 'LOGIN_REQUIRED' || err.code === 'HTTP_401') {
    if (session.valid(binding)) session.clear();
    if (!session.info()) gate.lock();
  }
  return err;
}
// 诊断期临时：把失败原因编码附在文案末尾，只暴露错误码与通道，不暴露域名、路径或凭据。
// 诊断期临时：仅在体验版/正式版把通道与错误码附在文案末尾，开发与测试保持原文案。
function diagnose() {
  try { return Boolean(wx.getAccountInfoSync && wx.getAccountInfoSync()); } catch (_) { return false; }
}
// 最近一次请求的诊断摘要（通道与错误码），只含固定取值，不含域名、路径或凭据。
let lastTrace = '';
function trace(tag) { if (diagnose()) lastTrace = tag; return tag; }
function lastDiagnosis() { return lastTrace; }
function recordReason(reason) { if (reason) lastTrace = (lastTrace ? lastTrace + ' ' : '') + 'CODE_' + reason; }
function localTarget(path) {
  if(config.USE_LOCAL_API!==true || !endpoint.localDevelopment() || !/^http:\/\/127\.0\.0\.1:\d+$/.test(String(config.LOCAL_API_BASE_URL || '')))return null;
  const target=url(path),base=String(config.LOCAL_API_BASE_URL);
  return target.startsWith(base+'/') ? target:null;
}
function containerUnavailable() {
  trace('TRANSPORT_CONTAINER');
  return session.error('CONTAINER_UNAVAILABLE','微信云服务暂不可用，请更新微信或稍后重试 [诊断 TRANSPORT_CONTAINER]');
}
function transportFailure(path, method) {
  const message = path === '/api/auth/wechat' || path === '/api/auth/dev' ? '暂时无法连接登录服务，请检查网络后重试' : !method || method === 'GET' ? '暂时无法连接服务，请检查网络后重试' : '网络中断，输入已保留。保存结果可能未返回，请重试核查';
  if (diagnose()) {
    trace(endpoint.localDevelopment() ? 'TRANSPORT_LOCAL':'TRANSPORT_CONTAINER');
    return session.error('NETWORK_UNKNOWN', message);
  }
  return session.error('NETWORK_UNKNOWN', message);
}
// 容器与显式本机通道共用错误语义；生产请求绝不回退公网域名。
function settle(err, binding, transport) {
  if (err && err.code === 'CONTAINER_TRANSPORT') { trace('CONTAINER_TRANSPORT'); return handleAuth(transport, binding); }
  if (err && err.code === 'NETWORK_UNKNOWN' && err.reasonCode) trace('FAIL_' + err.reasonCode);
  if (err && err.code) trace('HTTP_' + err.code);
  if (binding) session.assert(binding);
  return handleAuth(err, binding);
}
function downloadFailure(status) {
  return session.error(status === 401 ? 'LOGIN_REQUIRED' : status === 404 ? 'NOT_FOUND' : 'DOWNLOAD_FAILED', status === 404 ? '照片或文件已过期，请重试上传' : '文件下载失败，请重新登录或重试');
}
function tempFile(data, path) {
  if (Object.prototype.toString.call(data) !== '[object ArrayBuffer]' || !data.byteLength) throw session.error('DOWNLOAD_FAILED', '文件下载不完整，请稍后重试');
  try {
    const suffix = /^\/api\/photos\//.test(path) ? '.jpg' : '.bin';
    const target = wx.env.USER_DATA_PATH + '/huoji-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + suffix;
    wx.getFileSystemManager().writeFileSync(target, data, 'binary');
    return target;
  } catch (_) { throw session.error('DOWNLOAD_FAILED', '文件下载失败，请稍后重试'); }
}
function request(path, options) {
  options = options || {};
  let binding;
  try { binding = options.public ? null : options.identity || session.capture(); if (binding) session.assert(binding); } catch (e) { return Promise.reject(handleAuth(e, binding)); }
  const header = Object.assign({ 'Content-Type': 'application/json' }, binding ? { Authorization: 'Bearer ' + binding.token } : {});
  if (container.isContainerAvailable()) {
    return container.request({ path, method: options.method || 'GET', data: options.data, header, timeout: options.timeout || CONTAINER_MAX_TIMEOUT })
      .then(res => { if (binding) session.assert(binding); return decoded(res.data); })
      .catch(e => { throw settle(e, binding, transportFailure(path, options.method)); });
  }
  let target;
  try { target = localTarget(path);if(!target)return Promise.reject(containerUnavailable()); } catch (e) { return Promise.reject(handleAuth(e, binding)); }
  return new Promise((resolve, reject) => wx.request({
    url: target, method: options.method || 'GET', data: options.data,
    timeout: options.timeout || CONTAINER_MAX_TIMEOUT,
    header: header,
    success(res) {
      try {
        if (binding) session.assert(binding);
        if (res.statusCode < 200 || res.statusCode >= 300) throw failure(res.data, res.statusCode);
        resolve(decoded(res.data));
      } catch (e) { reject(handleAuth(e, binding)); }
    },
    fail() { reject(transportFailure(path, options.method)); }
  }));
}
// base64 长度换算原始字节数（含尾部填充），用于8MB上限判断，避免额外 stat 调用。
function base64Bytes(text) {
  const padding = text.slice(-2) === '==' ? 2 : text.slice(-1) === '=' ? 1 : 0;
  return Math.floor(text.length * 3 / 4) - padding;
}
// 小程序运行环境没有 crypto.randomUUID，生成 v4 格式仅用于区分同一账号的并发上传。
function uploadToken() {
  const hex = '0123456789abcdef';
  let value = '';
  for (let index = 0; index < 36; index += 1) {
    if (index === 8 || index === 13 || index === 18 || index === 23) { value += '-'; continue; }
    const random = Math.floor(Math.random() * 16);
    value += index === 14 ? '4' : index === 19 ? hex[(random & 3) | 8] : hex[random];
  }
  return value;
}
function photoName(filePath) {
  const text = String(filePath || '').split('?')[0];
  const base = text.slice(text.lastIndexOf('/') + 1);
  return (base && !/[\\/]/.test(base) ? base : 'photo.jpg').slice(0, 200);
}
function chunkFailure() { return session.error('UPLOAD_FAILED', '照片上传失败，本机照片已保留，请重试'); }
function readPhotoBase64(filePath) {
  return new Promise((resolve, reject) => {
    const fail = () => reject(session.error('UPLOAD_FAILED', '照片读取失败，本机照片已保留，请重试'));
    let manager;
    try { manager = wx.getFileSystemManager(); } catch (_) { fail(); return; }
    if (!manager || typeof manager.readFile !== 'function') { fail(); return; }
    manager.readFile({
      filePath, encoding: 'base64',
      success(res) { if (res && typeof res.data === 'string' && res.data) resolve(res.data); else fail(); },
      fail
    });
  });
}
// 容器通道不支持 filePath：读成本地base64后按48KiB顺序分片，最后一片返回与 upload 相同结构。
function uploadChunkedPhoto(filePath, binding) {
  try { session.assert(binding); } catch (e) { return Promise.reject(handleAuth(e, binding)); }
  const header = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + binding.token };
  return readPhotoBase64(filePath).then(base64 => {
    const bytes = base64Bytes(base64);
    if (!bytes) throw session.error('INVALID_PHOTO', '照片无法读取，请重新选择');
    if (bytes > PHOTO_MAX_BYTES) throw session.error('INVALID_PHOTO', '照片不能超过 8MB');
    const total = Math.max(1, Math.ceil(base64.length / PHOTO_CHUNK_BASE64));
    const uploadId = uploadToken(), name = photoName(filePath);
    let chain = Promise.resolve();
    for (let index = 0; index < total; index += 1) {
      chain = chain.then(() => {
        session.assert(binding);
        // 必须显式序列化：容器通道不会像 wx.request 那样自动转 JSON。
        const data = JSON.stringify({ uploadId, index, total, name, data: base64.slice(index * PHOTO_CHUNK_BASE64, (index + 1) * PHOTO_CHUNK_BASE64) });
        return container.request({ path: '/api/photos/chunks', method: 'POST', data, header, timeout: CONTAINER_MAX_TIMEOUT })
          .then(res => {
            if (index !== total - 1) return null;
            const photo = decoded(res.data);
            // 最后一片仍可能只是“进行中”（例如中间片丢失），没有照片标识就不算成功。
            if (!photo || !photo.id) throw chunkFailure();
            return photo;
          });
      });
    }
    return chain;
  }).catch(e => { throw settle(e, binding, chunkFailure()); });
}
function upload(path, binding) {
  try { session.assert(binding); } catch (e) { return Promise.reject(e); }
  const auth = { Authorization: 'Bearer ' + binding.token };
  if (container.isContainerAvailable()) return uploadChunkedPhoto(path, binding);
  let target;
  try{target=localTarget('/api/photos');if(!target)return Promise.reject(containerUnavailable());}catch(e){return Promise.reject(e);}
  return new Promise((resolve, reject) => wx.uploadFile({
    url: target, filePath: path, name: 'photo', timeout: CONTAINER_MAX_TIMEOUT,
    header: auth,
    success(res) {
      try { session.assert(binding); if (res.statusCode < 200 || res.statusCode >= 300) throw failure(res.data, res.statusCode); resolve(decoded(res.data)); }
      catch (e) { reject(handleAuth(e, binding)); }
    }, fail() { reject(session.error('UPLOAD_FAILED', '照片上传失败，本机照片已保留，请重试')); }
  }));
}
function uploadWorkbook(path, binding, templateOnly) {
  try { session.assert(binding); } catch (e) { return Promise.reject(e); }
  const auth = { Authorization: 'Bearer ' + binding.token };
  const route = templateOnly ? '/api/procurement-template/import' : '/api/procurement/import';
  if (container.isContainerAvailable()) {
    return container.upload({ path: route, filePath: path, name: 'workbook', header: auth, timeout: CONTAINER_MAX_TIMEOUT })
      .then(res => decoded(res.data))
      .catch(e => { throw settle(e, binding, session.error('UPLOAD_FAILED', '表格上传未确认，请刷新整理记录核查，原文件仍在本机')); });
  }
  let target;
  try{target=localTarget(route);if(!target)return Promise.reject(containerUnavailable());}catch(e){return Promise.reject(e);}
  return new Promise((resolve, reject) => wx.uploadFile({
    url: target, filePath: path, name: 'workbook', timeout: CONTAINER_MAX_TIMEOUT,
    header: auth,
    success(res) {
      try { session.assert(binding); if (res.statusCode < 200 || res.statusCode >= 300) throw failure(res.data, res.statusCode); resolve(decoded(res.data)); }
      catch (e) { reject(handleAuth(e, binding)); }
    }, fail() { reject(session.error('UPLOAD_FAILED', '表格上传未确认，请刷新整理记录核查，原文件仍在本机')); }
  }));
}
function download(path, binding) {
  try { session.assert(binding); } catch (e) { return Promise.reject(e); }
  const auth = { Authorization: 'Bearer ' + binding.token };
  if (container.isContainerAvailable()) {
    return container.download({ path, header: auth, timeout: CONTAINER_MAX_TIMEOUT })
      .then(res => {
        session.assert(binding);
        if (res.statusCode < 200 || res.statusCode >= 300) throw downloadFailure(res.statusCode);
        return tempFile(res.data, path);
      })
      .catch(e => { throw settle(e, binding, session.error('DOWNLOAD_FAILED', '文件下载失败，请稍后重试')); });
  }
  let target;
  try{target=localTarget(path);if(!target)return Promise.reject(containerUnavailable());}catch(e){return Promise.reject(e);}
  return new Promise((resolve, reject) => wx.downloadFile({
    url: target, timeout: CONTAINER_MAX_TIMEOUT, header: auth,
    success(res) {
      try {
        session.assert(binding);
        if (res.statusCode < 200 || res.statusCode >= 300) throw downloadFailure(res.statusCode);
        resolve(res.tempFilePath);
      } catch (e) { reject(handleAuth(e, binding)); }
    }, fail() { reject(session.error('DOWNLOAD_FAILED', '文件下载失败，请稍后重试')); }
  }));
}
async function login(development) {
  const base = endpoint.baseUrl();
  const generation = session.generation();
  let result;
  if (development) {
    if (!config.ENABLE_LOCAL_DEV_LOGIN || !endpoint.desktopDevelopment() || !/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw new Error('开发登录仅可用于显式本机配置');
    result = await request('/api/auth/dev', { method: 'POST', data: {}, public: true });
  } else {
    const code = await new Promise((resolve, reject) => wx.login({ timeout: 15000, success: res => res.code ? resolve(res.code) : reject(new Error('微信登录未完成，请重试')), fail: () => reject(new Error('微信登录未完成，请重试')) }));
    result = await request('/api/auth/wechat', { method: 'POST', data: { code }, public: true });
  }
  if (session.generation() !== generation) throw session.error('IDENTITY_CHANGED', '登录状态已变化');
  return session.install(result);
}
function logout() {
  try { const binding = session.capture(); request('/api/auth/logout', { method: 'POST', data: {}, identity: binding }).catch(() => {}); } catch (_) {}
  session.clear();
}
// AI 整理：服务端只登记任务并立即返回任务号（202），整理在后台执行，避免容器15秒硬上限。
function extractAsync(description, photoIds, binding) {
  return module.exports.request('/api/extract', { method: 'POST', data: { description: description || '', photoIds: photoIds || [] }, identity: binding });
}
// 任务视图只含任务号、状态、结果与错误，不含对象路径；下载按任务号另取短期地址。
function getJob(jobId, binding) {
  if (typeof jobId !== 'string' || !JOB_ID.test(jobId)) throw session.error('BAD_RESPONSE', '任务号无效，请重新整理');
  return module.exports.request('/api/jobs/' + jobId, { identity: binding });
}
let modelRecovery = null;
function restoreModelSession(binding) {
  session.assert(binding);
  if (modelRecovery && modelRecovery.binding.token === binding.token && modelRecovery.binding.epoch === binding.epoch) return modelRecovery.promise;
  const recovery = { binding };
  recovery.promise = (async () => {
    const code = await new Promise((resolve, reject) => wx.login({ timeout: 15000, success: res => res.code ? resolve(res.code) : reject(session.error('MODEL_LOGIN_REQUIRED', '微信验证未完成，请重试AI整理')), fail: () => reject(session.error('MODEL_LOGIN_REQUIRED', '微信验证未完成，请重试AI整理')) }));
    session.assert(binding);
    const result = await module.exports.request('/api/auth/model-session', { method: 'POST', data: { code }, identity: binding });
    session.assert(binding);
    if (!result || result.restored !== true) throw session.error('BAD_RESPONSE', 'AI登录恢复未确认，请重试');
  })().finally(() => { if (modelRecovery === recovery) modelRecovery = null; });
  modelRecovery = recovery;
  return recovery.promise;
}
module.exports = { usesContainer: container.isContainerAvailable, request, upload, uploadChunkedPhoto, uploadWorkbook, download, login, logout, lastDiagnosis, recordReason, extractAsync, getJob, restoreModelSession, CONTAINER_MAX_TIMEOUT };
