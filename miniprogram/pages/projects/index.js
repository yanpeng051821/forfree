const api = require('../../utils/api');
const session = require('../../utils/session');
const store = require('../../utils/store');
const domain = require('../../utils/domain');
const kit = require('../../utils/page-kit');
const dates = require('../../utils/date-rail');
const merchants=require('../../utils/merchant-context');
Page(kit.protectedPage({
  data: { projects: [], visibleProjects: [], dateCounts: {}, selectedDate: domain.chinaLocalDate(), totalProducts: 0, totalPending: 0, loggedIn: false, active: '', loading: false, saving: false, pending: false, error: '', showCreate: false, keyboardHeight: 0, createBodyHeight: 200, marketFocus: false, name: '', market: '',supplierContact:'', merchantVisits:[], date: domain.chinaLocalDate() },
  async onShow() {
    this.setData({ saving: !!this._saving });
    let create = false;
    try { create = !!wx.getStorageSync('huoji.newProject'); if (create) wx.removeStorageSync('huoji.newProject'); } catch (_) { create = false; }
    await this.load();
    if (!this._alive || !session.info()) return;
    if (create && !this._pending) this.setData({ showCreate: true, name: '', market: '',supplierContact:'', error: '', date: this.data.selectedDate || domain.chinaLocalDate() });
    this.syncCreate();
  },
  onHide() { this.releaseCreate(); kit.stop(this); },
  onUnload() { this.releaseCreate(); kit.stop(this); },
  async onPullDownRefresh() { try { await this.load(); if (this._alive) this.syncCreate(); } finally { wx.stopPullDownRefresh(); } },
  async load() {
    if (!kit.requireLogin(this)) return;
    const seq = kit.start(this);
    this.setData({ loggedIn: !!session.info(), projects: [], visibleProjects: [], merchantVisits:[],dateCounts: {}, active: '', totalProducts: 0, totalPending: 0, error: '', loading: false });
    if (!session.info()) return;
    const binding = session.capture();
    if (this._owner !== binding.owner) { this._pending = null; this._request = null; this.setData({ name: '', market: '',supplierContact:'', pending: false, showCreate: false, selectedDate: domain.chinaLocalDate() }); }
    this._owner = binding.owner;
    this._pending = wx.getStorageSync('huoji.pendingProject.' + binding.owner) || null;
    this.setData({ pending: !!this._pending });
    if (this._pending) this.setData({ name: this._pending.supplier || this._pending.name, market: this._pending.market, supplierContact:this._pending.supplierContact || '', date: this._pending.date, showCreate: true });
    this.setData({ loading: true });
    try {
      const projects = await api.request('/api/projects', { identity: binding });
      if (!kit.current(this, binding, seq)) return;
      const active = store.activeProject(binding);
      this.setData({ projects, active, totalProducts: projects.reduce((sum, p) => sum + (p.summary ? p.summary.total : 0), 0), totalPending: projects.reduce((sum, p) => sum + (p.summary ? p.summary.pending : 0), 0) });
      this.filterDates();
      await this.loadVisits(binding,seq);
      const days=await api.request('/api/record-days',{identity:binding}); if(kit.current(this,binding,seq) && Array.isArray(days)){const counts={...this.data.dateCounts};days.forEach(d=>counts[d.date]=d.count);this.setData({dateCounts:counts});}
    } catch (e) { kit.failure(this, binding, seq, e); }
    finally { if (this._alive && this._seq === seq) this.setData({ loading: false }); }
  },
  login: kit.loginPage,
  settings() { if (kit.requireLogin(this) && !this._saving) wx.navigateTo({url:'/pages/me/index'}); },
  filterDates() {
    const dateCounts = {};
    this.data.projects.forEach(project => { dateCounts[project.date] = (dateCounts[project.date] || 0) + 1; });
    this.setData({ dateCounts, visibleProjects: this.data.merchantVisits || [] });
  },
  async loadVisits(binding,seq) {
    const visits=await api.request('/api/merchant-visits?date='+encodeURIComponent(this.data.selectedDate),{identity:binding});
    if(kit.current(this,binding,seq) && Array.isArray(visits)){const groups=new Map();visits.forEach(v=>{const g=groups.get(v.supplier);if(g){if(!g.supplierContact && v.supplierContact)g.supplierContact=v.supplierContact;if(!g.market && v.market)g.market=v.market;g.total+=v.total;g.pending+=v.pending;g.confirmed+=v.confirmed;g.missingPrice+=v.missingPrice;}else groups.set(v.supplier,Object.assign({},v));});const merged=[...groups.values()];this.setData({merchantVisits:merged,visibleProjects:merged});}
  },
  reviewDate(e) { const date = e.detail.date; if (!dates.validDate(date) || date > domain.chinaLocalDate() || this.data.showCreate) return; this.setData({ selectedDate: date,visibleProjects:[],merchantVisits:[],loading:true,error:'' }); const seq=kit.start(this),binding=session.capture(); this.loadVisits(binding,seq).catch(e=>kit.failure(this,binding,seq,e)).finally(()=>{if(kit.current(this,binding,seq))this.setData({loading:false});}); },
  toggleCreate() {
    if (this.data.saving) return;
    const opening = !this.data.showCreate;
    this.setData({ showCreate: opening, error: '', ...(opening && !this._pending ? { date: this.data.selectedDate || domain.chinaLocalDate() } : {}) });
    this.syncCreate();
  },
  syncCreate() {
    this.resizeCreate(this.data.keyboardHeight);
    if (this.data.showCreate) { this._createTabHidden = true; if (wx.hideTabBar) wx.hideTabBar({ animation: false }); }
    else this.releaseCreate();
  },
  releaseCreate() {
    if (this._createTabHidden && session.info() && wx.showTabBar) wx.showTabBar({ animation: false });
    this._createTabHidden = false;
    this.setData({ keyboardHeight: 0, marketFocus: false });
  },
  closeCreate() {
    if (this._saving || this.data.saving) return;
    this.setData({ showCreate: false, error: '' });
    if (wx.hideKeyboard) wx.hideKeyboard();
    this.releaseCreate();
  },
  resizeCreate(height) {
    let viewport = 640, width = 375;
    try { const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync(); viewport = info.windowHeight || viewport; width = info.windowWidth || width; } catch (_) {}
    const keyboardHeight = Math.max(0, Math.min(Number(height) || 0, viewport));
    const bodyHeight = (510 + (this.data.pending ? 84 : 0) + (this.data.error ? 96 : 0)) * width / 750;
    this.setData({ keyboardHeight, createBodyHeight: Math.min(bodyHeight, Math.max(88, viewport - keyboardHeight - 168)) });
  },
  keyboard(e) { if (this.data.showCreate) this.resizeCreate(e.detail.height); },
  nextField() { if (!this._pending && !this.data.saving) this.setData({ marketFocus: true }); },
  marketBlur() { this.setData({ marketFocus: false }); },
  stopTouch() {},
  createMessage(error) { if (!session.info()) { kit.message(this, error); return; } if (this._alive) { this.setData({ error: error.message || '操作失败，请重试' }); this.resizeCreate(this.data.keyboardHeight); } kit.toast(error.message || '操作失败，请重试'); },
  workbench() { wx.switchTab({ url: '/pages/products/index' }); },
  exportDay() { if(!this.data.showCreate && this.data.selectedDate)wx.navigateTo({url:'/pages/export/index?date='+encodeURIComponent(this.data.selectedDate)}); },
  export(e) { wx.navigateTo({ url: '/pages/export/index?projectId=' + encodeURIComponent(e.currentTarget.dataset.id) }); },
  input(e) { const key = e.currentTarget.dataset.key; if (!this._pending && !this._saving && ['name', 'market', 'supplierContact'].includes(key)) this.setData({ [key]: e.detail.value, error: '' }); },
  dateChange(e) { if (!this._pending && !this._saving) this.setData({ date: e.detail.value }); },
  select(e) {
    try { const visit=this.data.visibleProjects[e.currentTarget.dataset.index]; if(!visit)return; const binding=session.capture(); store.selectMerchant(binding,visit); merchants.remember(binding,visit.projectId,visit); wx.switchTab({ url: '/pages/products/index' }); }
    catch (err) { kit.message(this, err); }
  },
  async create() {
    if (this._saving) return;
    let binding;
    try { binding = session.capture(); } catch (e) { kit.message(this, e); return; }
    if (!this._pending && !this.data.name.trim()) { this.createMessage(new Error('请填写商户名称')); return; }
    this._saving = true; this.setData({ saving: true, error: '' });
    try {
      if (this._pending) {
        const pending = this._pending;
        const project = await api.request('/api/projects', { method: 'POST', data: pending, identity: binding });
        this._pending = null;
        wx.removeStorageSync('huoji.pendingProject.' + binding.owner);
        this.setData({ pending: false });
        session.assert(binding);
        this.setData({ showCreate: false, name: '', market: '',supplierContact:'', pending: false });
        if (!this._alive) return;
        store.selectMerchant(binding,{projectId:project.id,supplier:project.supplier || project.name,supplierContact:project.supplierContact || '',date:project.date}); merchants.remember(binding,project.id,{supplier:project.supplier || project.name,supplierContact:project.supplierContact || ''});
        this.setData({ showCreate: false, name: '', market: '',supplierContact:'' });
        this.releaseCreate();
        await this.load();
        kit.toast('已核查上次商户保存，请在列表查看');
        return;
      }
      const fields = { name: this.data.name.trim(), supplier: this.data.name.trim(), supplierContact:this.data.supplierContact.trim(), market: this.data.market.trim(), date: this.data.date };
      this._request = domain.requestFor(fields, this._request);
      this._pending = Object.assign({}, fields, { requestKey: this._request.requestKey });
      wx.setStorageSync('huoji.pendingProject.' + binding.owner, this._pending);
      const project = await api.request('/api/projects', { method: 'POST', data: this._pending, identity: binding });
      this._pending = null;
      wx.removeStorageSync('huoji.pendingProject.' + binding.owner);
      session.assert(binding);
      this.setData({ showCreate: false, name: '', market: '',supplierContact:'', pending: false });
      if (!this._alive) return;
      store.selectMerchant(binding,{projectId:project.id,supplier:project.supplier || project.name,supplierContact:project.supplierContact || '',date:project.date}); merchants.remember(binding,project.id,{supplier:project.supplier || project.name,supplierContact:project.supplierContact || ''}); this.setData({ showCreate: false, name: '', market: '',supplierContact:'' });
      this.releaseCreate();
      await this.load();
      if (this._alive && session.valid(binding)) wx.switchTab({ url: '/pages/products/index' });
    } catch (e) {
      if (!domain.uncertain(e)) { this._pending = null; this.setData({ pending: false }); try { wx.removeStorageSync('huoji.pendingProject.' + binding.owner); } catch (_) {} }
      if (this._alive && session.valid(binding)) this.createMessage(e);
    }
    finally { this._saving = false; if (this._alive) this.setData({ saving: false, pending: !!this._pending }); }
  }
}));
