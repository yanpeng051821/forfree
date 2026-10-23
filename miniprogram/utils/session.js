const KEY = 'huoji.session.v1';
let current = null;
let epoch = 0;
const listeners = new Set();
function notify() { listeners.forEach(listener => listener()); }
function subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
function error(code, message) { return Object.assign(new Error(message), { code }); }
function restore() {
  epoch += 1;
  try {
    const value = wx.getStorageSync(KEY);
    current = value && value.user && value.user.id && /^[a-f0-9]{64}$/.test(value.token) && value.expiresAt > Date.now() ? value : null;
  } catch (_) { current = null; }
  const value = info(); notify(); return value;
}
function info() {
  if (current && current.expiresAt <= Date.now()) clear();
  return current ? { user: current.user, expiresAt: current.expiresAt } : null;
}
function install(value) {
  if (!value || !value.user || !value.user.id || !/^[a-f0-9]{64}$/.test(value.token) || !(value.expiresAt > Date.now())) throw error('AUTH_INVALID', '登录响应无效，请重试');
  wx.setStorageSync(KEY, value);
  current = value; epoch += 1;
  notify();
  return info();
}
function capture() {
  if (!info()) throw error('LOGIN_REQUIRED', '请先登录');
  return { owner: current.user.id, token: current.token, epoch };
}
function valid(binding) { return !!binding && !!info() && binding.owner === current.user.id && binding.token === current.token && binding.epoch === epoch; }
function assert(binding) { if (!valid(binding)) throw error('IDENTITY_CHANGED', '登录状态已变化，请返回后重新打开'); }
function clear() { current = null; epoch += 1; try { wx.removeStorageSync(KEY); } catch (_) {} notify(); }
function generation() { return epoch; }
function updateProfile(binding, profile) {
  assert(binding);
  const next = Object.assign({}, current, { user: Object.assign({}, current.user, { profile }) });
  // A profile edit does not change the account identity or invalidate in-flight requests.
  try { wx.setStorageSync(KEY, next); } catch (_) { /* Server state remains available this session. */ }
  current = next;
}
module.exports = { restore, info, install, capture, valid, assert, clear, generation, error, updateProfile, subscribe };
