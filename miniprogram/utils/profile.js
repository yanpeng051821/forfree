const session = require('./session');
const empty = Object.freeze({ name: '', company: '', role: 'buyer', phone: '', wechat: '', defaultCurrency: 'CNY', version: 0 });
const roles = ['buyer', 'merchant', 'both'];
const currencies = ['CNY', 'USD', 'EUR'];
function normalize(value) {
  const result = Object.assign({}, empty);
  ['name', 'company', 'phone', 'wechat'].forEach(key => { if (value && typeof value[key] === 'string') result[key] = value[key]; });
  if (value && typeof value.avatar === 'string' && /^(?:|data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2})$/.test(value.avatar) && value.avatar.length <= 32768) result.avatar = value.avatar;
  if (value && roles.includes(value.role)) result.role = value.role;
  if (value && currencies.includes(value.defaultCurrency)) result.defaultCurrency = value.defaultCurrency;
  if (value && Number.isInteger(value.version) && value.version >= 0) result.version = value.version;
  return result;
}
function read(binding) { session.assert(binding); return normalize(session.info().user.profile); }
function accept(binding, value) { session.assert(binding); const profile = normalize(value), current = read(binding); if (profile.version < current.version) return current; session.updateProfile(binding, profile); return profile; }
function validate(value) {
  const result = normalize(value);
  const limits = { name: 80, company: 200, phone: 80, wechat: 120 };
  Object.keys(limits).forEach(key => { result[key] = result[key].trim(); if (result[key].length > limits[key]) throw new Error('个人资料内容过长'); });
  if (!roles.includes(value.role) || !currencies.includes(value.defaultCurrency)) throw new Error('请选择身份与币种');
  return result;
}
function defaultCurrency(binding) { return read(binding).defaultCurrency; }
module.exports = { empty, roles, currencies, normalize, read, accept, validate, defaultCurrency };
