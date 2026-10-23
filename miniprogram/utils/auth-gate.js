const session = require('./session');
const LOGIN = 'pages/login/index';
const HOME = 'pages/projects/index';
const TABS = [HOME, 'pages/products/index', 'pages/me/index'];
let redirecting = false;
let timer = null;
let watching = false;
let foreground = true;
function route() {
  const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
  return pages.length ? pages[pages.length - 1] : null;
}
function lock(page) {
  page = page || route();
  if (page && page.setData) page.setData({ authenticated: false });
  if (page && page.route === LOGIN) return false;
  if (wx.hideTabBar) wx.hideTabBar({ animation: false });
  if (!redirecting) {
    redirecting = true;
    wx.reLaunch({ url: '/' + LOGIN, complete() { redirecting = false; } });
  }
  return false;
}
function requireLogin(page) {
  if (!session.info()) return lock(page);
  if (page && page.setData) page.setData({ authenticated: true });
  if (page && TABS.includes(page.route) && wx.showTabBar) wx.showTabBar({ animation: false });
  return true;
}
function enter() {
  if (!session.info()) return lock();
  if (redirecting) return;
  redirecting = true;
  wx.reLaunch({ url: '/' + HOME, complete() { redirecting = false; } });
}
function schedule() {
  clearTimeout(timer); timer = null;
  const value = session.info();
  if (!value) { if (foreground && route()) lock(); return; }
  if (foreground) timer = setTimeout(() => { session.info(); schedule(); }, Math.min(value.expiresAt - Date.now(), 2147483647));
}
function watch() {
  if (!watching) { watching = true; session.subscribe(schedule); }
  schedule();
}
function show() {
  foreground = true;
  const page = route();
  if (!session.info()) { if (page) lock(page); }
  else if (page && page.route === LOGIN) enter();
  else if (page) requireLogin(page);
  if (watching) schedule();
}
function hide() { foreground = false; clearTimeout(timer); timer = null; }
function protectedPage(definition) {
  const result = Object.assign({}, definition, { data: Object.assign({}, definition.data, { authenticated: false }) });
  ['onLoad', 'onShow'].forEach(name => {
    result[name] = function (...args) {
      if (!requireLogin(this)) return;
      if (definition[name]) return definition[name].apply(this, args);
    };
  });
  return result;
}
module.exports = { lock, requireLogin, enter, watch, show, hide, protectedPage };
