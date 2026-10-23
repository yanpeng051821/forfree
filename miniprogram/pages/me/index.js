const api = require('../../utils/api');
const session = require('../../utils/session');
const draft = require('../../utils/draft');
const store = require('../../utils/store');
const kit = require('../../utils/page-kit');
const profile = require('../../utils/profile');
const roleNames = ['采购员', '商家', '采购与经营'];
Page(kit.protectedPage({
  data: { user: null, profile: profile.normalize(), form: profile.normalize(), roleName: '', roles: roleNames, roleIndex: 0, currencies: profile.currencies, currencyIndex: 0, editing: false, saving: false, drafts: [], modelEnabled: false, modelKnown: false, error: '', avatarInitial: '我', avatarPreview: '' },
  onShow() { this.load(); },
  onHide() { kit.stop(this); },
  onUnload() { kit.stop(this); },
  display(value) {
    const next = profile.normalize(value);
    this.setData({ profile: next, avatarPreview: next.avatar || '', avatarInitial:(next.name || '我').slice(0,1), roleName: roleNames[profile.roles.indexOf(next.role)] });
  },
  async load() {
    if (!kit.requireLogin(this)) return;
    const seq = kit.start(this), info = session.info();
    let binding;
    const sameOwner = info && this._owner === info.user.id;
    this._owner = info && info.user.id;
    this.setData({ user: info && info.user, drafts: [], error: '', modelEnabled: false, modelKnown: false });
    if (!sameOwner) this.setData({ editing: false, form: profile.normalize() });
    this.display(info && info.user.profile);
    try {
      if (info) { binding = session.capture(); this.setData({ drafts: draft.list(binding) }); }
      const results = await Promise.allSettled([
        api.request('/api/config', { public: true }),
        binding ? api.request('/api/auth/me', { identity: binding }) : Promise.resolve(null)
      ]);
      if (!this._alive || this._seq !== seq) return;
      if (binding && !session.valid(binding)) {
        if (!session.info()) { this.setData({ user: null, drafts: [], editing: false, form: profile.normalize(), error: '' }); this.display(null); }
        return;
      }
      const [capabilities, me] = results;
      if (capabilities.status === 'fulfilled') this.setData({ modelEnabled: capabilities.value.modelEnabled, modelKnown: true });
      if (me.status === 'fulfilled' && me.value) { const next = profile.accept(binding, me.value.user.profile); this.setData({ user: me.value.user }); this.display(next); }
      const failed = me.status === 'rejected' ? me : capabilities.status === 'rejected' ? capabilities : null;
      if (failed) kit.message(this, failed.reason);
    } catch (e) { if (this._alive && this._seq === seq) kit.message(this, e); }
  },
  async quickCurrency() {
    if (this._saving) return;
    const binding = session.capture();
    try {
      const pick = await new Promise((resolve, reject) => wx.showActionSheet({ itemList: ['人民币 CNY', '美元 USD', '欧元 EUR'], success: resolve, fail: reject }));
      session.assert(binding);
      const current = profile.read(binding), currency = profile.currencies[pick.tapIndex];
      if (!currency || currency === current.defaultCurrency) return;
      this._saving = true; this.setData({ saving: true, error: '' });
      const result = await api.request('/api/profile', { method: 'POST', identity: binding, data: profile.validate(Object.assign({}, current, { defaultCurrency: currency })) });
      profile.accept(binding, result); if (this._alive) this.display(result);
    } catch (e) { if (e.code || !/cancel/.test(e.errMsg || '')) kit.message(this, e); }
    finally { this._saving = false; if (this._alive) this.setData({ saving: false }); }
  },
  editProfile() { if(session.info() && !this._saving) wx.navigateTo({url:'/pages/profile/index'}); },
  async logout() {
    if (this._saving || !(await kit.confirm('退出登录', '本机草稿会保留在当前账号下，其他账号不能读取。'))) return;
    kit.stop(this); api.logout(); this._owner = null; this._alive = true;
    this.setData({ authenticated: false, user: null, drafts: [], editing: false, form: profile.normalize(), error: '' }); this.display(null); kit.loginPage();
  },
  resume(e) {
    const item = this.data.drafts[e.currentTarget.dataset.index];
    if (item) wx.navigateTo({ url: store.drafts.editorUrl(item) });
  },
  favorites() { if (session.info()) wx.navigateTo({ url: '/pages/favorites/index' }); },
  trash() { if (session.info()) wx.navigateTo({ url: '/pages/trash/index' }); },
  procurement() { if (session.info()) wx.navigateTo({ url: '/pages/procurement/index' }); },
  tableSettings() { if (session.info()) wx.navigateTo({ url: '/pages/table-settings/index' }); },
  review() { if (session.info()) { store.requestProductView(session.capture(), 'day'); wx.switchTab({ url: '/pages/products/index' }); } },
  openDrafts() { if(session.info()) wx.navigateTo({url:'/pages/drafts/index'}); },
  showHelp() { if(session.info()) wx.navigateTo({url:'/pages/help/index'}); }
}));
