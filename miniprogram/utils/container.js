const config = require('../config');
const session = require('./session');
const endpoint = require('./endpoint');

// 微信云托管容器通道：wx.cloud.callContainer 不走 request 合法域名校验，
// 因此小程序端默认走容器，API_BASE_URL 仅保留为桌面开发与降级通道。
const DEFAULT_TIMEOUT = 15000;
// 官方限制：小程序内单次请求超时不得超过 15 秒，AI 与导出超时必须改为异步任务轮询。
const MAX_TIMEOUT = 15000;
const MIN_SDK = '2.23.0';
// 与 endpoint.url 相同的路由校验，容器通道只接受相对路径，避免拼接出外部地址。
const ROUTE = /^\/(?:api\/|health(?:\?|$))/;
let inited = false;

function route(path) {
  if (typeof path !== 'string' || !ROUTE.test(path) || path.includes('://')) throw session.error('INVALID_ROUTE', '接口路径无效');
  return path;
}
function decoded(data) { if (typeof data === 'string') { try { return JSON.parse(data); } catch (_) { throw session.error('BAD_RESPONSE', '服务响应无效，请稍后重试'); } } return data; }
// 与 api.js failure() 语义一致：业务错误码优先，否则 HTTP_<status>。
function failure(data, status) {
  const value = decoded(data);
  return session.error(value && value.error && value.error.code || 'HTTP_' + status, value && value.error && value.error.message || '服务暂不可用，请稍后重试');
}
function timeout(value) {
  const given = Number(value);
  return Math.min(given > 0 ? given : DEFAULT_TIMEOUT, MAX_TIMEOUT);
}
function sdkVersion() {
  // wx.getDeviceInfo() 不含 SDKVersion；基础库版本在 getAppBaseInfo / getSystemInfoSync 里。
  const sources = [
    () => (wx.getAppBaseInfo ? wx.getAppBaseInfo().SDKVersion : null),
    () => (wx.getSystemInfoSync ? wx.getSystemInfoSync().SDKVersion : null),
    () => { const a = wx.getAccountInfoSync ? wx.getAccountInfoSync() : null; return a && a.miniProgram && a.miniProgram.SDKVersion; },
  ];
  for (const read of sources) {
    try { const value = read(); if (value) return String(value); } catch (_) { }
  }
  return '';
}
function supported(version) {
  // 版本未知时不拦：callContainer 的存在性已单独校验，避免真机误判回退公网。
  const given = String(version || '').trim();
  if (!given || !/^\d+(\.\d+)*$/.test(given)) return true;
  const parts = given.split('.').map(part => parseInt(part, 10) || 0);
  const floor = MIN_SDK.split('.').map(part => parseInt(part, 10) || 0);
  for (let i = 0; i < floor.length; i += 1) { if ((parts[i] || 0) > floor[i]) return true; if ((parts[i] || 0) < floor[i]) return false; }
  return true;
}
// 真机上 wx.cloud 可能只有在 init 之后才挂载 callContainer，能力探测前必须先初始化，
// 否则会误判为不可用并退回公网通道（公网域名不在白名单里，登录必然失败）。
function ensureCloud() {
  if (typeof wx === 'undefined') return false;
  if (typeof wx.cloud !== 'object' || wx.cloud === null) return false;
  if (!inited && typeof wx.cloud.init === 'function') {
    try { wx.cloud.init({ env: config.CLOUD_ENV }); inited = true; } catch (_) { return false; }
  }
  return true;
}
function isContainerAvailable() {
  if (!config.CLOUD_ENV || !config.CLOUD_SERVICE) return false;
  if (!ensureCloud()) return false;
  if (typeof wx.cloud.callContainer !== 'function') return false;
  if (!supported(sdkVersion())) return false;
  // 桌面开发工具保留公网域名通道，方便直连本机后端联调。
  return !endpoint.localDevelopment();
}
// 归一为与 wx.request 相同的 { statusCode, data, header }。
// header 中包含微信注入的用户标识，只在此透传，绝不打印、不落存储、不写入日志。
function normalized(res) {
  return { statusCode: Number(res && res.statusCode) || 0, data: res ? res.data : undefined, header: (res && res.header) || {} };
}
function send(options) {
  let path;
  try { path = route(options.path); } catch (e) { return Promise.reject(e); }
  if (!ensureCloud()) return Promise.reject(session.error('CONTAINER_TRANSPORT', '容器通道不可用'));
  const payload = {
    config: { env: config.CLOUD_ENV },
    path,
    method: options.method || 'GET',
    header: Object.assign({}, options.header, { 'X-WX-SERVICE': config.CLOUD_SERVICE }),
    timeout: timeout(options.timeout)
  };
  if (options.data !== undefined) {
    // 容器通道不会像 wx.request 那样自动序列化：JSON 请求必须显式转成字符串，
    // 否则后端会按表单体收到、解析失败并返回“请求格式不正确”。
    const json = /^application\/json/i.test(String(payload.header['Content-Type'] || payload.header['content-type'] || ''));
    payload.data = json && typeof options.data === 'object' && options.data !== null ? JSON.stringify(options.data) : options.data;
  }
  // 二进制上传：filePath 为 wxfile:// 临时路径，以 name 指定的表单字段提交。
  if (options.filePath) { payload.filePath = options.filePath; payload.name = options.name || 'file'; }
  if (options.dataType) payload.dataType = options.dataType;
  if (options.responseType) payload.responseType = options.responseType;
  return new Promise((resolve, reject) => {
    payload.success = res => resolve(normalized(res));
    // 传输失败不带任何内部信息，文案由 api.js 按调用点给出。
    payload.fail = e => {
      // 只提取微信标准数字错误码用于诊断，不透出 errMsg 里的域名或路径。
      const code = String((e && e.errMsg) || '').match(/(-?\d{5,})/);
      const reason = code ? code[1] : '';
      try { require('./api').recordReason && require('./api').recordReason(reason); } catch (_) { }
      reject(session.error('CONTAINER_TRANSPORT', '容器通道不可用'));
    };
    wx.cloud.callContainer(payload);
  });
}
function request(options) {
  return send(options).then(res => {
    if (res.statusCode < 200 || res.statusCode >= 300) throw failure(res.data, res.statusCode);
    return res;
  });
}
function upload(options) {
  return request(Object.assign({}, options, { method: options.method || 'POST' }));
}
// 下载不做 failure() 映射：api.js 需要区分 401 与 404，故此处只归一响应。
function download(options) {
  // dataType 控制文本解析；二进制必须用 responseType，否则 JPEG/ZIP 会被 UTF-8 解码损坏。
  return send(Object.assign({}, options, { method: options.method || 'GET', dataType: 'text', responseType: 'arraybuffer' }));
}
module.exports = { request, upload, download, isContainerAvailable };
