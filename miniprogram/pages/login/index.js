const api = require('../../utils/api');
const session = require('../../utils/session');
const gate = require('../../utils/auth-gate');
const endpoint = require('../../utils/endpoint');
const config = require('../../config');
Page({
  data: { checking: true, loggingIn: false, devLogin: false, error: '' },
  onLoad() { this._unloaded = false; },
  onShow() {
    this._visible = true;
    if (session.info()) { gate.enter(); return; }
    this.setData({ checking: false, devLogin: config.ENABLE_LOCAL_DEV_LOGIN && endpoint.desktopDevelopment() });
    if (this._pendingError) { this.setData({ error: this._pendingError }); this._pendingError = ''; }
  },
  onHide() { this._visible = false; },
  onUnload() { this._unloaded = true; this._visible = false; },
  async login(e) {
    if (this._loggingIn || this._unloaded) return;
    this._loggingIn = true; this.setData({ loggingIn: true, error: '' });
    try {
      await api.login(e && e.currentTarget.dataset.dev === 'yes');
      // wx.login may temporarily hide this page. Only navigation away cancels entry.
      if (!this._unloaded && this._visible) gate.enter();
    } catch (err) {
      if (!this._unloaded) {
        const diagnosis = api.lastDiagnosis ? api.lastDiagnosis() : '';
        this._pendingError = (err.message || '登录未完成，请重试') + (diagnosis ? ' [诊断 ' + diagnosis + ']'  : '');
        if (this._visible) { this.setData({ error: this._pendingError }); this._pendingError = ''; }
      }
    } finally { this._loggingIn = false; if (!this._unloaded) this.setData({ loggingIn: false }); }
  }
});
