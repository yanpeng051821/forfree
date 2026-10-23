const config = require('../config');
const session = require('./session');
// 本文件只服务公网域名通道。微信云托管容器通道（wx.cloud.callContainer）不走 request 合法域名校验，
// 不需要域名也不需要 baseUrl：它由云环境 ID 与服务名寻址（见 utils/container.js），只接受相对 path。
// 因此容器通道不调用 baseUrl()/url()，域名白名单问题与本文件的校验逻辑无关。
function desktopDevelopment() {
  try {
    const account = wx.getAccountInfoSync();
    const device = wx.getDeviceInfo ? wx.getDeviceInfo() : wx.getSystemInfoSync();
    return account.miniProgram.envVersion === 'develop' && device.platform === 'devtools';
  } catch (_) { return false; }
}
function localDevelopment() { return desktopDevelopment() && config.USE_LOCAL_API === true; }
function baseUrl() {
  const local = localDevelopment() && config.LOCAL_API_BASE_URL;
  const base = String(local || config.API_BASE_URL || '').replace(/\/$/, '');
  if (local && /^http:\/\/127\.0\.0\.1:\d+$/.test(base)) return base;
  if (!/^https:\/\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d+)?$/i.test(base) || /^https:\/\/(?:localhost|127\.|0\.|\[)/i.test(base) || /^https:\/\/(?:[a-z0-9-]+\.)*workbuddy\.host(?::\d+)?$/i.test(base)) {
    throw session.error('SERVICE_UNCONFIGURED', '当前版本暂未连接服务，请稍后重试');
  }
  return base;
}
function url(path) {
  if (!/^\/(?:api\/|health(?:\?|$))/.test(path) || path.includes('://')) throw session.error('INVALID_ROUTE', '接口路径无效');
  return baseUrl() + path;
}
module.exports = { desktopDevelopment, localDevelopment, baseUrl, url };
