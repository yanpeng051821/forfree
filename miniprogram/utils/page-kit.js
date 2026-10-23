const session = require('./session');
const gate = require('./auth-gate');
function start(page) { page._alive = true; page._seq = (page._seq || 0) + 1; return page._seq; }
function current(page, binding, seq) { return page._alive && session.valid(binding) && page._seq === seq; }
function stop(page) { page._alive = false; page._seq = (page._seq || 0) + 1; }
function message(page, error) {
  if (!session.info()) { gate.lock(page); return; }
  const text = error.message || '操作失败，请重试';
  if (page._alive) page.setData({ error: text });
  // 页面顶部的提示常在屏幕外，光靠 setData 用户会以为点了没反应。
  toast(text);
  if (page._alive && page.data && 'error' in page.data && typeof wx.pageScrollTo === 'function') wx.pageScrollTo({ scrollTop: 0, duration: 200 });
}
function failure(page, binding, seq, error) {
  if (!page._alive || page._seq !== seq) return;
  if (session.valid(binding)) { message(page, error); return; }
  if (!session.info()) {
    const patch = { authenticated: false, loggedIn: false, error: '', loading: false, loadingMore: false };
    ['projects', 'visibleProjects', 'products', 'items', 'drafts', 'selectedIds'].forEach(key => { if (key in page.data) patch[key] = []; });
    if ('dateCounts' in page.data) patch.dateCounts = {};
    ['project', 'summary'].forEach(key => { if (key in page.data) patch[key] = null; });
    page.setData(patch);
    gate.lock(page);
  }
}
function toast(title) { wx.showToast({ title, icon: 'none' }); }
function confirm(title, content) {
  return new Promise(resolve => wx.showModal({ title, content, confirmColor: '#245c46', success: res => resolve(res.confirm === true), fail: () => resolve(false) }));
}
function loginPage() { gate.lock(); }
function info(title, content) { wx.showModal({ title, content, showCancel: false, confirmText: '知道了' }); }
module.exports = { start, current, stop, message, failure, toast, confirm, loginPage, info, protectedPage: gate.protectedPage, requireLogin: gate.requireLogin };
