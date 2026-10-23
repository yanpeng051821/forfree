const api = require('./api');
const session = require('./session');
const store = require('./store');
const domain = require('./domain');
const kit = require('./page-kit');
const background = require('./background-organize');
const merchants = require('./merchant-context');
const PAGE_SIZE = 30;
const MAX_MANAGE = 50;
const UNDO_MS = 12000;
async function mapLimit(items, limit, worker) {
  const result = new Array(items.length); let next = 0;
  async function run() { while (next < items.length) { const index = next++; result[index] = await worker(items[index], index); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return result;
}
module.exports = function productPage(fixedMode) { return kit.protectedPage({
  data: { project: null, viewMode: fixedMode || 'task', date: domain.chinaLocalDate(), dateCounts: {}, today: domain.chinaLocalDate(), products: [], items: [], merchantGroups: [], merchants: [], supplier: null, viewDate:'',merchantDay:false,summary: null, matchedCount: 0, drafts: [], selectedIds: [], query: '', status: 'all', nextCursor: null, hasMore: false, loading: false, loadingMore: false, error: '', loggedIn: false, favoriteBusy: {}, lastProjectId: '', compareMode: false, manageMode: false, manageIds: [], mutationBusy: false, mutationId: '', mutationLabel: '', mutationDone: 0, mutationTotal: 0, menuId: '', undoCount: 0, undoMessage: '' },
  onShow() { this.load(); },
  onHide() { clearTimeout(this._organizeTimer);clearTimeout(this._searchTimer); this.clearUndo(); kit.stop(this); },
  onUnload() { clearTimeout(this._organizeTimer);clearTimeout(this._searchTimer); this.clearUndo(); kit.stop(this); },
  async onPullDownRefresh() { try { await this.load(); } finally { wx.stopPullDownRefresh(); } },
  onReachBottom() { this.loadMore(); },
  async load() {
    if (this.data.mutationBusy && this._mutation && kit.current(this, this._mutation.binding, this._mutation.seq)) return;
    if (!kit.requireLogin(this)) return;
    const seq = kit.start(this);
    clearTimeout(this._searchTimer);clearTimeout(this._organizeTimer);
    this._mutation = null; this._menuPending = false; this._paginationRestart = false; this._restoredIds = new Set(); this.clearUndo();
    if(!this._coverCache || this._coverOwner!==session.capture().owner){this._coverCache=new Map();this._coverOwner=session.capture().owner;}
    this.setData({ loggedIn: !!session.info(), today: domain.chinaLocalDate(), dateCounts: {}, project: null, products: [], items: [], merchants:[], merchantGroups:[], summary: null, drafts: [], selectedIds: [], nextCursor: null, hasMore: false, error: '', loading: false, loadingMore: false, favoriteBusy:{}, compareMode: false, manageMode: false, manageIds: [], mutationBusy: false, mutationId: '', mutationLabel: '', mutationDone: 0, mutationTotal: 0, menuId: '' });
    if (!session.info()) return;
    const binding = session.capture();
    this._binding = binding;
    if (this._owner && this._owner !== binding.owner) this.setData({ viewMode: 'task', supplier:null,viewDate:'',merchantDay:false,date: domain.chinaLocalDate() });
    this._owner = binding.owner;
    const id = store.activeProject(binding);
    let lastProjectId = id;
    if (!lastProjectId) { try { lastProjectId = wx.getStorageSync('huoji.lastProject.' + binding.owner) || ''; } catch (_) { lastProjectId = ''; } }
    if (id) { try { wx.setStorageSync('huoji.lastProject.' + binding.owner, id); } catch (_) { /* Remembering the last batch is a convenience, not a requirement. */ } }
    this.setData({ lastProjectId });
    const initialView=this._activeId===undefined;
    if (this._activeId !== undefined && this._activeId !== id) this.setData({ viewMode: 'task',supplier:null,viewDate:'',merchantDay:false });
    this._activeId = id;
    let selectedMerchant = fixedMode ? null : store.consumeMerchant(binding);
    const requestedView = fixedMode ? null : store.consumeProductView(binding);
    if(requestedView==='day')selectedMerchant=null;
    if(!fixedMode && initialView && !selectedMerchant && !requestedView && store.rememberedMerchant)selectedMerchant=store.rememberedMerchant(binding);
    if(requestedView==='day' || (requestedView==='task' && !selectedMerchant))this.setData({supplier:null,viewDate:'',merchantDay:false});
    if (fixedMode) this.setData({ viewMode: fixedMode });
    else if (requestedView) this.setData({ viewMode: requestedView, ...(requestedView === 'day' ? { date: domain.chinaLocalDate() } : {}) });
    const daily = this.data.viewMode === 'day', favorites = this.data.viewMode === 'favorites', trash = this.data.viewMode === 'trash';
    if(selectedMerchant)this.setData({supplier:selectedMerchant.supplier,viewDate:selectedMerchant.date,merchantDay:true});
    this._scope = trash ? 'trash' : store.comparisonScope({projectId:id,date:daily?this.data.date:this.data.merchantDay?this.data.viewDate:undefined,favorite:favorites,supplier:this.data.supplier});
    const context=binding.owner+':'+this._scope;
    if(this._context!==context)this.setData({query:'',status:'all'});
    this._context=context;
    this.setData({drafts:this.relatedDrafts(binding,id)});
    if (!id && !daily && !favorites && !trash) return;
    this.setData({ loading: true });
    try {
      if (trash) { await this.fetchPage('', false, binding, seq); return; }
      this.loadDateCounts(binding, seq);
      if (daily || favorites) { void this.loadMerchants(binding, seq); const selectedIds=store.compareSelection(binding,this._scope);this.setData({selectedIds,compareMode:selectedIds.length>0}); await this.fetchPage('', false, binding, seq); return; }
      const projects = await api.request('/api/projects', { identity: binding });
      const project = projects.find(p => p.id === id);
      if (!kit.current(this, binding, seq)) return;
      if (!project) { try { wx.removeStorageSync('huoji.lastProject.' + binding.owner); } catch (_) { /* Nothing to clear. */ } this.setData({ lastProjectId: '', error: '该看货已不可访问，请重新选择看货' }); return; }
      const drafts=this.relatedDrafts(binding,id),selectedIds=store.compareSelection(binding,this._scope);
      this.setData({ project: Object.assign({},project,{name:this.data.supplier!==null ? this.data.supplier || '未填写商户':this.data.merchantDay ? '当天商品':project.supplier || '看货商品'}), summary: project.summary || null, drafts, selectedIds,compareMode:selectedIds.length>0 });
      void this.loadMerchants(binding, seq);
      await this.fetchPage('', false, binding, seq);
    } catch (e) { kit.failure(this, binding, seq, e); }
    finally { if (this._alive && this._seq === seq) this.setData({ loading: false }); }
  },
  relatedDrafts(binding,projectId) {
    if(this.data.viewMode!=='task')return [];
    return store.drafts.list(binding).filter(item=>(this.data.merchantDay && this.data.supplier!==null || item.projectId===projectId) && (this.data.supplier===null || (item.fields.supplier || '')===this.data.supplier));
  },
  async loadMerchants(binding, seq) {
    const request=this._merchantRequest=(this._merchantRequest || 0)+1;
    try {
      const scope=this.baseScopeQuery(),list=await api.request('/api/merchants?'+scope,{identity:binding});
      if (this._alive && session.valid(binding) && request===this._merchantRequest && scope===this.baseScopeQuery() && Array.isArray(list)) { this.setData({ merchants: list }); this.filter(); }
    } catch (_) { /* Products remain available if merchant summaries cannot load. */ }
  },
  async merchant(e) {
    if (this.data.mutationBusy || this.data.loadingMore) return;
    const supplier = e.currentTarget.dataset.supplier;
    if (supplier === undefined || supplier === this.data.supplier) return;
    this._scope=store.comparisonScope({projectId:this.data.project && this.data.project.id,date:this.data.viewMode==='day'?this.data.date:this.data.merchantDay?this.data.viewDate:undefined,favorite:this.data.viewMode==='favorites',supplier});
    this.setData({ supplier, query: '', status: 'all', selectedIds: [], compareMode: false, manageMode: false, manageIds: [] });
    this.rememberView();
    return this.reloadResults();
  },
  rememberView(){if(this.data.merchantDay && this.data.project && store.rememberMerchantView)store.rememberMerchantView(session.capture(),{projectId:this.data.project.id,supplier:this.data.supplier,date:this.data.viewDate});},
  allMerchants() { if(this.data.mutationBusy)return; this._scope=store.comparisonScope({projectId:this.data.project && this.data.project.id,date:this.data.viewMode==='day'?this.data.date:this.data.merchantDay?this.data.viewDate:undefined,favorite:this.data.viewMode==='favorites'}); this.setData({ supplier:null, query:'', status:'all', selectedIds:[], compareMode:false, manageMode:false, manageIds:[] }); this.rememberView();return this.reloadResults(); },
  newMerchant() {
    if (this.data.mutationBusy || !this.data.project) return;
    wx.setStorageSync('huoji.newProject',true);wx.switchTab({url:'/pages/projects/index'});
  },
  async loadDateCounts(binding, seq) {
    try {
      const days = await api.request('/api/record-days', { identity: binding });
      if (kit.current(this, binding, seq)) { const dateCounts = {}; days.forEach(day => { dateCounts[day.date] = day.count; }); this.setData({ dateCounts }); }
    } catch (_) { /* Date navigation stays usable without counts. */ }
  },
  async covers(products, binding, seq) {
    return mapLimit(products, 4, async product => {
      if (!kit.current(this, binding, seq)) return null;
      const photo = product.photos && product.photos[0];
      if (!photo) return Object.assign({}, product, { cover: '' });
      if (this._coverCache.has(photo.id)) return Object.assign({}, product, { cover: this._coverCache.get(photo.id) });
      let cover='';
      try {cover=await this.downloadCover(photo.id,binding,seq);} catch(e) {if(!session.valid(binding))throw e;}
      if (!kit.current(this, binding, seq)) return null;
      if(cover){this._coverCache.set(photo.id,cover);while(this._coverCache.size>90)this._coverCache.delete(this._coverCache.keys().next().value);}
      return Object.assign({}, product, { cover });
    });
  },
  downloadCover(id, binding, seq) {
    this._coverQueue = this._coverQueue || [];
    return new Promise((resolve, reject) => {
      this._coverQueue.push({ id, binding, seq, resolve, reject }); this.drainCovers();
    });
  },
  drainCovers() {
    while ((this._coverActive || 0) < 4 && this._coverQueue.length) {
      const task = this._coverQueue.shift();
      if (!kit.current(this, task.binding, task.seq)) { task.resolve(''); continue; }
      this._coverActive = (this._coverActive || 0) + 1;
      Promise.resolve().then(() => kit.current(this, task.binding, task.seq) ? api.download('/api/photos/' + encodeURIComponent(task.id) + '/thumbnail', task.binding) : '')
        .then(task.resolve, task.reject).finally(() => { this._coverActive -= 1; this.drainCovers(); });
    }
  },
  async fetchPage(cursor, append, binding, seq) {
    const id = this.data.project && this.data.project.id;
    const daily = this.data.viewMode === 'day', favorites = this.data.viewMode === 'favorites', trash = this.data.viewMode === 'trash';
    if (!id && !daily && !favorites && !trash) return;
    const path = (trash ? '/api/trash?limit=' + PAGE_SIZE : '/api/products?' + (daily ? 'date=' + this.data.date : favorites ? 'favorite=yes' : this.data.merchantDay ? 'date='+encodeURIComponent(this.data.viewDate) : 'projectId=' + encodeURIComponent(id) + (this.data.viewDate ? '&date='+encodeURIComponent(this.data.viewDate) : '')) + '&limit=' + PAGE_SIZE) + '&q=' + encodeURIComponent(this.data.query.trim().slice(0, 200)) + (trash ? '' : '&status=' + this.data.status + (this.data.supplier !== null ? '&supplier=' + encodeURIComponent(this.data.supplier) : '')) + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
    const raw = await api.request(path, { identity: binding });
    const page = domain.productPage(raw);
    if (!kit.current(this, binding, seq)) return;
    const products = page.items.filter(p => trash ? !!p.deletedAt : !p.deletedAt).map(p=>Object.assign({},p,{cover:p.photos&&p.photos[0]&&this._coverCache.get(p.photos[0].id)||''}));
    if (!kit.current(this, binding, seq)) return;
    const merged = append ? Array.from(new Map(this.data.products.concat(products).map(p => [p.id, p])).values()) : products;
    this.setData({ products: merged, nextCursor: page.nextCursor, hasMore: !!page.nextCursor, summary: raw.summary || this.data.summary, matchedCount: raw.matchedCount === undefined ? merged.length : raw.matchedCount });
    this.filter();
    void this.fillCovers(products,binding,seq);
    if (!trash) void this.refreshOrganization(binding,seq);
  },
  async loadMore() {
    if (this.data.loading || this.data.loadingMore || this.data.mutationBusy || !this.data.hasMore || !this._binding) return;
    const binding = this._binding, seq = this._seq;
    const restart = this._paginationRestart;
    this.setData({ loadingMore: true, error: '' });
    try {
      const before = new Set(this.data.products.map(p => p.id));
      let cursor = this._paginationRestart ? '' : this.data.nextCursor;
      this._paginationRestart = false;
      do {
        await this.fetchPage(cursor, true, binding, seq);
        if (!kit.current(this, binding, seq)) return;
        const next = this.data.nextCursor;
        if (!this.data.hasMore || this.data.products.some(p => !before.has(p.id)) || next === cursor) break;
        cursor = next;
      } while (true);
    }
    catch (e) { if (restart && kit.current(this, binding, seq)) this._paginationRestart = true; kit.failure(this, binding, seq, e); }
    finally { if (kit.current(this, binding, seq)) this.setData({ loadingMore: false }); }
  },
  async fillCovers(products,binding,seq){
    try{const hydrated=(await this.covers(products,binding,seq)).filter(Boolean);
      if(!kit.current(this,binding,seq))return;
      const covers=new Map(hydrated.map(p=>[p.id,p.cover]));
      this.setData({products:this.data.products.map(p=>covers.has(p.id)?Object.assign({},p,{cover:covers.get(p.id)}):p)});this.filter();
    }catch(_){}
  },
  async refreshOrganization(binding,seq){
    try{const statuses=await background.refresh(binding,this.data.products);if(!kit.current(this,binding,seq))return;
      if(this.data.mutationBusy || this.data.manageMode || this.data.compareMode){clearTimeout(this._organizeTimer);this._organizeTimer=setTimeout(()=>{if(kit.current(this,binding,seq))this.refreshOrganization(binding,seq);},5000);return;}
      const index=new Map(statuses.map(p=>[p.id,p]));
      const changed=statuses.some(result=>this.data.products.some(p=>p.id===result.id && result.version>p.version));
      this.setData({products:this.data.products.map(p=>{
        const result=index.get(p.id);if(!result || result.version<p.version)return p;
        if (this.data.mutationBusy && this.data.mutationId === p.id) return p;
        return result.version===p.version ? Object.assign({},p,{organizeLabel:result.organizeLabel,organizePending:result.organizePending}) : Object.assign({},result,{cover:p.cover});
      })});this.filter();
      if(changed){
        if(this.data.query.trim() || this.data.status!=='all' || this.data.supplier!==null || this.data.viewMode==='favorites' || statuses.some(p=>p.deletedAt)){await this.reloadResults();return;}
        const raw=await api.request('/api/products?'+this.scopeQuery()+'&limit=1&status=all',{identity:binding});
        if(!kit.current(this,binding,seq))return;
        this.setData({summary:raw.summary || this.data.summary,matchedCount:raw.matchedCount===undefined?this.data.matchedCount:raw.matchedCount});void this.loadMerchants(binding,seq);
      }
      clearTimeout(this._organizeTimer);if(statuses.some(p=>p.organizePending))this._organizeTimer=setTimeout(()=>{if(kit.current(this,binding,seq))this.refreshOrganization(binding,seq);},5000);
    }catch(_){}
  },
  filter() {
    const drafts=this.data.viewMode==='task' && this._binding && session.valid(this._binding) ? this.relatedDrafts(this._binding,this.data.project && this.data.project.id || this._activeId) : this.data.drafts;
    const items = this.data.products.filter(p => this.data.viewMode === 'trash' ? !!p.deletedAt : !p.deletedAt).map(p => Object.assign({}, domain.productView(p), { selected: this.data.selectedIds.includes(p.id), manageSelected: this.data.manageIds.includes(p.id), favoriteBusy:!!this.data.favoriteBusy[p.id], actionBusy: this.data.mutationId === p.id || this.data.menuId === p.id, recordDateText:p.createdAt ? domain.chinaLocalDate(p.createdAt) : '',deletedText: p.deletedAt ? domain.chinaLocalDate(p.deletedAt) : '' }));
    const groups = new Map();
    for (const item of items) { const key = item.supplier || ''; if(!groups.has(key))groups.set(key,{ supplier:key, label:key || '未填写商家', items:[] }); groups.get(key).items.push(item); }
    this.setData({ items, drafts, merchantGroups: [...groups.values()],...(this.data.project ? {project:Object.assign({},this.data.project,{name:this.data.supplier!==null ? this.data.supplier || '未填写商户':this.data.merchantDay ? '当天商品':this.data.project.supplier || '看货商品'})}: {}) });
  },
  async reloadResults() {
    if (this.data.mutationBusy) return;
    clearTimeout(this._searchTimer);clearTimeout(this._organizeTimer);
    if ((!this.data.project && this.data.viewMode === 'task') || !session.info()) return;
    const seq = kit.start(this), binding = session.capture();
    this._binding = binding;
    this._context=binding.owner+':'+this._scope;
    this._paginationRestart = false;
    this.setData({ products: [], items: [], manageIds: [], nextCursor: null, hasMore: false, loading: true, loadingMore: false, error: '' });
    try { await this.fetchPage('', false, binding, seq); }
    catch (e) { kit.failure(this, binding, seq, e); }
    finally { if (kit.current(this, binding, seq)) this.setData({ loading: false }); }
  },
  search(e) {
    if (this.data.mutationBusy) return;
    this.setData({ query: e.detail.value });
    clearTimeout(this._searchTimer);
    // Immediately invalidate the old request, including a pending next page.
    this._seq = (this._seq || 0) + 1;
    this.setData({ loading: true, products: [], items: [], hasMore: false });
    this._searchTimer = setTimeout(() => { if (this._alive) this.reloadResults(); }, 300);
  },
  clearSearch() { if(this.data.mutationBusy)return; this.setData({ query: '' }); this.reloadResults(); },
  status(e) { if(this.data.mutationBusy || this.data.status===e.currentTarget.dataset.value)return; this.setData({ status: e.currentTarget.dataset.value }); this.reloadResults(); },
  review() { if(this.data.mutationBusy)return; this.setData({ viewMode: 'day',date:this.data.viewDate || domain.chinaLocalDate(),supplier:null,viewDate:'',merchantDay:false }); return this.load(); },
  currentTask() { if(this.data.mutationBusy)return; this.setData({ viewMode: 'task',supplier:null,viewDate:'',merchantDay:false }); return this.load(); },
  dateChange(e) { if(this.data.mutationBusy)return;const date=e.detail.date || e.detail.value;if(!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10)!==date || date>domain.chinaLocalDate())return; this.setData({viewMode:'day',date,supplier:null,viewDate:'',merchantDay:false});return this.load(); },
  today() { if(this.data.mutationBusy)return; this.setData({ date: domain.chinaLocalDate() }); return this.load(); },
  async toggleFavorite(e) {
    if (this.data.mutationBusy || this.data.manageMode || this.data.compareMode || this.data.viewMode === 'trash') return;
    const id = e.currentTarget.dataset.id, product = this.data.products.find(item => item.id === id);
    if (!product) return;
    this._favoritePending = this._favoritePending || new Set();
    if (this._favoritePending.has(id)) return;
    this._favoritePending.add(id);
    // Acknowledge the tap immediately; a busy ring distinguishes it from saved state.
    this.setData({ products:this.data.products.map(item=>item.id===id?Object.assign({},item,{favorite:!product.favorite}):item), favoriteBusy:Object.assign({},this.data.favoriteBusy,{[id]:true}) }); this.filter();
    let binding; const seq = this._seq;
    try {
      binding = session.capture();
      const updated = await api.request('/api/products/' + encodeURIComponent(id) + '/favorite', { method: 'POST', identity: binding, data: { favorite: !product.favorite, version: product.version } });
      if (!kit.current(this, binding, seq)) return;
      if (this.data.viewMode === 'favorites' && !updated.favorite) {
        const selectedIds = this.data.selectedIds.filter(selectedId => selectedId !== id);
        store.setCompareSelection(binding, this._scope || 'favorites', selectedIds);
        this.setData({ selectedIds }); await this.reloadResults(); return;
      }
      this.setData({ products: this.data.products.map(item => item.id === id ? Object.assign({}, item, { favorite: updated.favorite, version: updated.version }) : item) }); this.filter();
    } catch (e) {
      if (kit.current(this,binding,seq)) { this.setData({products:this.data.products.map(item=>item.id===id?Object.assign({},item,{favorite:product.favorite}):item)});this.filter(); }
      kit.failure(this, binding, seq, e);
    }
    finally {
      this._favoritePending.delete(id);
      if (this._alive && this._seq===seq) { const busy=Object.assign({},this.data.favoriteBusy);delete busy[id];this.setData({favoriteBusy:busy});this.filter(); }
    }
  },
  baseScopeQuery() { return this.data.viewMode === 'day' ? 'date=' + this.data.date : this.data.viewMode === 'favorites' ? 'favorite=yes' : this.data.merchantDay ? 'date='+encodeURIComponent(this.data.viewDate) : 'projectId=' + encodeURIComponent(this.data.project.id) + (this.data.viewDate ? '&date='+encodeURIComponent(this.data.viewDate) : ''); },
  scopeQuery() { return this.baseScopeQuery() + (this.data.supplier !== null ? '&supplier=' + encodeURIComponent(this.data.supplier) : ''); },
  toggleCompareMode() {
    if (this.data.mutationBusy || this.data.viewMode === 'trash') return;
    this.setData({ manageMode: false, manageIds: [] });
    if (this.data.compareMode) { this.clearCompare(); this.setData({ compareMode: false }); }
    else this.setData({ compareMode: true });
    this.filter();
  },
  toggleCompare(e) {
    if (this.data.mutationBusy || this.data.manageMode) return;
    try {
      const id = e.currentTarget.dataset.id, ids = this.data.selectedIds.slice();
      const index = ids.indexOf(id);
      if (index >= 0) ids.splice(index, 1);
      else if (ids.length < 2) ids.push(id);
      else { kit.toast('一次对比两件商品，请先取消一件'); return; }
      store.setCompareSelection(session.capture(), this._scope || this.data.project.id, ids);
      this.setData({ selectedIds: ids }); this.filter();
    } catch (e) { kit.message(this, e); }
  },
  compare() { if (this.data.selectedIds.length === 2) wx.navigateTo({ url: '/pages/compare/index?' + this.scopeQuery() }); },
  clearCompare() { store.setCompareSelection(session.capture(), this._scope || this.data.project.id, []); this.setData({ selectedIds: [],compareMode:false }); this.filter(); },
  resumeDraft(e) {
    const item = this.data.drafts[e.currentTarget.dataset.index || 0];
    if (item) wx.navigateTo({ url: store.drafts.editorUrl(item) });
  },
  tasks() { wx.switchTab({ url: '/pages/projects/index' }); },
  continueLast() {
    try {
      const binding = session.capture();
      const id = this.data.lastProjectId || store.activeProject(binding);
      if (!id) return this.tasks();
      const saved=store.rememberedMerchant && store.rememberedMerchant(binding);
      if(saved && saved.projectId===id && saved.supplier)store.selectMerchant(binding,saved);else return this.tasks();
      this.load();
    } catch (e) { kit.message(this, e); }
  },
  newBatch() {
    try {
      session.capture();
      wx.setStorageSync('huoji.newProject', true);
      wx.switchTab({ url: '/pages/projects/index' });
    } catch (e) { kit.message(this, e); }
  },
  async add(e) {
    if (this.data.mutationBusy || this.data.manageMode || this.data.compareMode || this._captureOpening) return;
    const supplier = e && e.currentTarget && e.currentTarget.dataset.supplier !== undefined ? e.currentTarget.dataset.supplier : this.data.supplier;
    const daily = this.data.viewMode === 'day';
    if ((!daily && this.data.viewMode !== 'task') || (!daily && !this.data.project) || typeof supplier !== 'string' || !supplier.trim()) return this.tasks();
    this._captureOpening = true;
    let navigating = false, admitted = false, binding, captureSeq;
    try {
      binding = session.capture(); captureSeq = this._seq;
      let projectId, selected;
      if (daily) {
        const date = this.data.date;
        const current = () => kit.current(this,binding,captureSeq) && this.data.viewMode === 'day' && this.data.date === date && this.data.supplier === supplier && !this.data.compareMode && !this.data.manageMode;
        const visits = await api.request('/api/merchant-visits?date='+encodeURIComponent(date),{identity:binding});
        if (!current()) return;
        selected = Array.isArray(visits) && visits.find(v => v.supplier === supplier && v.date === date && /^[a-f0-9-]{36}$/.test(v.projectId || ''));
        if (!selected) throw new Error('该商户记录已变化，请重新选择商户');
        projectId = selected.projectId;
        const projects = await api.request('/api/projects',{identity:binding});
        if (!current()) return;
        if (!Array.isArray(projects) || !projects.some(p => p.id === projectId)) throw new Error('该商户已不可访问，请重新选择商户');
        if (date !== domain.chinaLocalDate()) kit.toast('新品将记录在今天');
      } else {
        projectId = this.data.project.id;
        selected = this.data.merchants.find(m => m.supplier === supplier) || merchants.lookup(binding, projectId, supplier) || { supplier };
      }
      merchants.remember(binding, projectId, selected);
      if (!daily && this.data.merchantDay && this.data.viewDate !== domain.chinaLocalDate()) {
        store.selectMerchant(binding, { projectId, supplier, date: domain.chinaLocalDate() });
        const loading = this.load(), seq = this._seq;
        captureSeq = seq;
        await loading;
        if (!kit.current(this,binding,seq) || this.data.error || !this.data.project || this.data.project.id !== projectId || this.data.supplier !== supplier) return;
        kit.toast('新品将记录在今天');
      }
      merchants.beginCapture(binding, projectId, selected);
      admitted = true;
      navigating = true;
      wx.navigateTo({ url: '/pages/editor/index?projectId=' + encodeURIComponent(projectId), fail: () => merchants.cancelCapture(), complete: () => { this._captureOpening = false; } });
    } catch (e) {
      navigating = false; if(admitted)merchants.cancelCapture(); if(!binding || kit.current(this,binding,captureSeq))kit.message(this, e);
    } finally { if (!navigating) this._captureOpening = false; }
  },
  edit(e) { if(this.data.mutationBusy)return; if(this.data.manageMode)return this.toggleManage(e); if (this.data.compareMode) return this.toggleCompare(e); const product = this.data.products.find(item => item.id === e.currentTarget.dataset.id); if (product && !product.deletedAt) wx.navigateTo({ url: '/pages/editor/index?projectId=' + encodeURIComponent(product.projectId) + '&id=' + encodeURIComponent(product.id) }); },
  export() { if(!this.data.mutationBusy && !this.data.compareMode && !this.data.manageMode && (this.data.viewMode !== 'task' || this.data.project)) wx.navigateTo({ url: '/pages/export/index?' + this.scopeQuery() + (this.data.status === 'confirmed' ? '&scope=confirmed' : '') }); },
  exportMerchant(e) { if(!this.data.mutationBusy)wx.navigateTo({url:'/pages/export/index?'+this.baseScopeQuery()+'&supplier='+encodeURIComponent(e.currentTarget.dataset.supplier)+(this.data.status==='confirmed'?'&scope=confirmed':'')}); },
  async organizeMenu() {
    if(this.data.mutationBusy || this.data.compareMode || this.data.manageMode)return;
    try { const binding=session.capture(), seq=this._seq; const result = await new Promise((resolve, reject) => wx.showActionSheet({ itemList: ['导出Excel', '回收站'], success: resolve, fail: reject }));
      if (!kit.current(this,binding,seq)) return; if (result.tapIndex === 0) return this.export();
      if (result.tapIndex === 1) return this.openTrash();
    } catch (_) {}
  },
  openTrash() { if (!this.data.mutationBusy && kit.requireLogin(this)) wx.navigateTo({ url: '/pages/trash/index' }); },
  toggleManageMode() {
    if (this.data.mutationBusy || this.data.loading) return;
    if (!this.data.manageMode) this.clearCompare();
    this.setData({ manageMode: !this.data.manageMode, manageIds: [], compareMode: false }); this.filter();
  },
  toggleSelection(e) { return this.data.manageMode ? this.toggleManage(e) : this.toggleCompare(e); },
  toggleManage(e) {
    if (!this.data.manageMode || this.data.mutationBusy) return;
    const id = e.currentTarget.dataset.id;
    if (!this.data.products.some(p => p.id === id)) return;
    const ids = this.data.manageIds.slice(), index = ids.indexOf(id);
    if (index >= 0) ids.splice(index, 1);
    else if (ids.length < MAX_MANAGE) ids.push(id);
    else { kit.toast('一次最多选择 50 件'); return; }
    this.setData({ manageIds: ids }); this.filter();
  },
  selectLoaded() {
    if (!this.data.manageMode || this.data.mutationBusy) return;
    const ids = this.data.items.slice(0, MAX_MANAGE).map(p => p.id);
    const selected = ids.length && ids.every(id => this.data.manageIds.includes(id));
    this.setData({ manageIds: selected ? [] : ids }); this.filter();
    if (!selected && this.data.items.length > MAX_MANAGE) kit.toast('已选择前 50 件');
  },
  async productActions(e) {
    if (this.data.mutationBusy || this.data.compareMode || this._menuPending) return;
    const id = e.currentTarget.dataset.id, product = this.data.products.find(p => p.id === id);
    if (!product) return;
    let binding; const seq = this._seq;
    try {
      binding = this._binding || session.capture();
      if (!kit.current(this, binding, seq)) return;
      this._menuPending = true; this.setData({ menuId: id }); this.filter();
      const trash = this.data.viewMode === 'trash';
      const pick = await new Promise((resolve, reject) => wx.showActionSheet({ itemList: [trash ? '恢复商品' : '移入回收站', '永久删除'], success: resolve, fail: reject }));
      if (!kit.current(this, binding, seq)) return;
      if (pick.tapIndex === 0 || pick.tapIndex === 1) return await this.mutateProducts([product], pick.tapIndex === 1 ? 'delete' : trash ? 'restore' : 'trash');
    } catch (e) { if (e.code || !/cancel/.test(e.errMsg || '')) kit.failure(this, binding, seq, e); }
    finally { if (kit.current(this, binding, seq)) { this._menuPending = false; this.setData({ menuId: '' }); this.filter(); } }
  },
  moveSelected() { return this.mutateProducts(this.data.products.filter(p => this.data.manageIds.includes(p.id)), 'trash'); },
  restoreSelected() { return this.mutateProducts(this.data.products.filter(p => this.data.manageIds.includes(p.id)), 'restore'); },
  deleteSelected() { return this.mutateProducts(this.data.products.filter(p => this.data.manageIds.includes(p.id)), 'delete'); },
  restoreProduct(e) { const product = this.data.products.find(p => p.id === e.currentTarget.dataset.id); return this.mutateProducts(product ? [product] : [], 'restore'); },
  deleteProduct(e) { const product = this.data.products.find(p => p.id === e.currentTarget.dataset.id); return this.mutateProducts(product ? [product] : [], 'delete'); },
  adjustSummary(product, delta) {
    if (!this.data.summary) return null;
    const summary = Object.assign({}, this.data.summary);
    ['total', product.confirmed ? 'confirmed' : 'pending', ...(product.unitPrice === null ? ['missingPrice'] : [])].forEach(key => {
      if (typeof summary[key] === 'number') summary[key] = Math.max(0, summary[key] + delta);
    });
    return summary;
  },
  removeAcknowledged(product, binding) {
    if (this._restoredIds) this._restoredIds.delete(product.id);
    const selectedIds = this.data.selectedIds.filter(id => id !== product.id);
    if (selectedIds.length !== this.data.selectedIds.length) {
      try { store.setCompareSelection(binding, this._scope || (this.data.project && this.data.project.id), selectedIds); } catch (_) { /* A storage failure must not hide an acknowledged move. */ }
    }
    this._paginationRestart = this._paginationRestart || this.data.hasMore;
    this.setData({ products: this.data.products.filter(p => p.id !== product.id), manageIds: this.data.manageIds.filter(id => id !== product.id), selectedIds, matchedCount: Math.max(0, this.data.matchedCount - 1), summary: this.adjustSummary(product, -1), merchants:this.data.merchants.map(m=>m.supplier===product.supplier?Object.assign({},m,{total:Math.max(0,m.total-1)}):m) }); this.filter();
  },
  restoreAcknowledged(product) {
    const inScope = this.data.viewMode === 'day' ? domain.chinaLocalDate(product.createdAt) === this.data.date : this.data.viewMode === 'favorites' ? product.favorite : this.data.merchantDay ? domain.chinaLocalDate(product.createdAt)===this.data.viewDate : product.projectId === (this.data.project && this.data.project.id);
    if (!inScope || (this.data.viewDate && domain.chinaLocalDate(product.createdAt)!==this.data.viewDate) || (this.data.supplier !== null && this.data.supplier !== product.supplier)) return;
    this._restoredIds = this._restoredIds || new Set();
    const existing = this.data.products.find(p => p.id === product.id && !p.deletedAt);
    const counted = !!existing || this._restoredIds.has(product.id);
    this._restoredIds.add(product.id);
    if (existing && existing.version > product.version) product = existing;
    const photo = product.photos && product.photos[0];
    product = Object.assign({}, product, { cover: product.cover || (existing && existing.cover) || (photo && this._coverCache.get(photo.id)) || '' });
    const matches = domain.filterProducts([product], this.data.query, this.data.status).length > 0;
    const products = matches ? this.data.products.filter(p => p.id !== product.id).concat(product).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || b.id.localeCompare(a.id)) : this.data.products;
    this.setData({ products, matchedCount: this.data.matchedCount + (matches && !counted ? 1 : 0), summary: this.adjustSummary(product, counted ? 0 : 1), merchants:this.data.merchants.map(m=>m.supplier===product.supplier?Object.assign({},m,{total:m.total+(counted?0:1)}):m) }); this.filter();
    if (matches && !product.cover && this._binding) void this.fillCovers([product], this._binding, this._seq);
  },
  clearUndo() { clearTimeout(this._undoTimer); this._undo = null; this.setData({ undoCount: 0, undoMessage: '' }); },
  offerUndo(binding, records, message) {
    this.clearUndo();
    if (!records.length || !session.valid(binding)) return;
    this._undo = { binding, records: records.slice(-MAX_MANAGE), expiresAt: Date.now() + UNDO_MS };
    this.setData({ undoCount: this._undo.records.length, undoMessage: message || '已移入回收站' });
    this._undoTimer = setTimeout(() => { if (!this.data.mutationBusy) this.clearUndo(); }, UNDO_MS);
  },
  undoMove() {
    if (this.data.mutationBusy || !this._undo) return;
    if (!session.valid(this._undo.binding) || Date.now() > this._undo.expiresAt) { this.clearUndo(); return; }
    return this.mutateProducts(this._undo.records, 'restore', true);
  },
  async mutateProducts(records, action, undo = false) {
    if (this.data.mutationBusy || this.data.loading || this.data.loadingMore || !records.length || !['trash', 'restore', 'delete'].includes(action)) return;
    if (records.length > MAX_MANAGE) { kit.toast('一次最多处理 50 件'); return; }
    const seq = this._seq; let binding;
    try { binding = this._binding || session.capture(); } catch (e) { kit.message(this, e); return; }
    if (!kit.current(this, binding, seq)) return;
    const operation = { binding, seq }; this._mutation = operation;
    const label = action === 'trash' ? '移入回收站' : action === 'restore' ? '恢复' : '永久删除';
    this.setData({ mutationBusy: true, mutationId: '', mutationLabel: label, mutationDone: 0, mutationTotal: records.length, error: '' });
    const acknowledged = [], failed = []; let firstError;
    try {
      if (action === 'delete' && !(await kit.confirm('永久删除 ' + records.length + ' 件商品？', '商品和照片将永久删除，无法恢复。请确认删除所选商品。'))) return;
      if (!kit.current(this, binding, seq)) return;
      if (undo) { clearTimeout(this._undoTimer); this.setData({ undoCount: 0 }); }
      for (let index = 0; index < records.length; index += 1) {
        if (!kit.current(this, binding, seq) || this._mutation !== operation) return;
        const snapshot = records[index], product = undo ? snapshot : this.data.products.find(p => p.id === snapshot.id);
        this.setData({ mutationId: snapshot.id, mutationDone: index }); this.filter();
        try {
          if (!product || this.data.favoriteBusy[product.id]) throw new Error('商品正在更新，请稍后重试');
          const result = await api.request('/api/products/' + encodeURIComponent(product.id) + (action === 'delete' ? '' : '/' + action), { method: action === 'delete' ? 'DELETE' : 'POST', identity: binding, data: { version: product.version } });
          if (!kit.current(this, binding, seq) || this._mutation !== operation) return;
          if (action === 'delete' ? !result || result.deleted !== true : !result || result.id !== product.id || !Number.isInteger(result.version) || result.version < product.version || (action === 'trash' ? !result.deletedAt : !!result.deletedAt)) throw Object.assign(new Error('操作结果未确认，请刷新后核查'), { code: 'BAD_RESPONSE' });
          acknowledged.push(action === 'delete' ? product : Object.assign({}, result, { cover: product.cover || '' }));
          if (undo) this.restoreAcknowledged(acknowledged[acknowledged.length - 1]);
          else this.removeAcknowledged(product, binding);
        } catch (e) {
          if (!kit.current(this, binding, seq)) { kit.failure(this, binding, seq, e); return; }
          failed.push(snapshot); firstError = firstError || e;
        }
        this.setData({ mutationDone: index + 1 });
      }
      if (action === 'trash' && acknowledged.length) this.offerUndo(binding, acknowledged);
      else if (undo) this.offerUndo(binding, failed, '部分商品未恢复，可重试');
      if (failed.length) this.setData({ error: '已' + label + ' ' + acknowledged.length + ' 件，' + failed.length + ' 件未确认，已保留供重试。' + firstError.message });
      kit.toast(acknowledged.length ? '已' + label + ' ' + acknowledged.length + ' 件' + (failed.length ? '，部分未确认' : '') : '操作未确认，请重试');
    } finally {
      if (this._mutation === operation) {
        this._mutation = null;
        if (kit.current(this, binding, seq)) {
          this.setData({ mutationBusy: false, mutationId: '', mutationLabel: '' }); this.filter();
          if (this._undo && Date.now() > this._undo.expiresAt) this.clearUndo();
        }
      }
    }
  }
}); };
