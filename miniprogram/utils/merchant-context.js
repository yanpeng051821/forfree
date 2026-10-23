const session = require('./session');
let capture = null;
function beginCapture(binding, projectId, value) {
  session.assert(binding);
  const merchant = normalize(value);
  if (!merchant.supplier) throw new Error('请先选择商户');
  capture = { binding, projectId, merchant };
}
function consumeCapture(binding, projectId) {
  session.assert(binding);
  const entry = capture; capture = null;
  return entry && session.valid(entry.binding) && entry.binding.owner === binding.owner && entry.projectId === projectId ? entry.merchant : null;
}
function cancelCapture() { capture = null; }
function key(binding, projectId) { session.assert(binding); return 'huoji.merchants.' + binding.owner + '.' + projectId; }
function normalize(value) {
  return { supplier: typeof value?.supplier === 'string' ? value.supplier.trim().slice(0, 200) : '', supplierContact: typeof value?.supplierContact === 'string' ? value.supplierContact.trim().slice(0, 200) : '' };
}
function read(binding, projectId) {
  try { const saved = wx.getStorageSync(key(binding, projectId)); return { current: normalize(saved.current), entries: Array.isArray(saved.entries) ? saved.entries.map(normalize).filter(v => v.supplier).slice(0, 60) : [] }; }
  catch (_) { session.assert(binding); return { current: normalize(), entries: [] }; }
}
function remember(binding, projectId, value) {
  const merchant = normalize(value), previous = read(binding, projectId);
  const entries = merchant.supplier ? [merchant, ...previous.entries.filter(v => v.supplier !== merchant.supplier)].slice(0, 60) : previous.entries;
  try { wx.setStorageSync(key(binding, projectId), { current: merchant, entries }); } catch (_) { session.assert(binding); }
  return merchant;
}
function lookup(binding, projectId, supplier) { return read(binding, projectId).entries.find(v => v.supplier === supplier); }
module.exports = { read, remember, lookup, normalize, beginCapture, consumeCapture, cancelCapture };
