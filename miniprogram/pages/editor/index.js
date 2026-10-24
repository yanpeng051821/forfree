const api = require('../../utils/api');
const session = require('../../utils/session');
const store = require('../../utils/store');
const domain = require('../../utils/domain');
const draft = require('../../utils/draft');
const kit = require('../../utils/page-kit');
const profile = require('../../utils/profile');
const jobs = require('../../utils/jobs');
const background = require('../../utils/background-organize');
const captureTemplate = require('../../utils/capture-template');
const merchants = require('../../utils/merchant-context');
const fileCache=require('../../utils/file-cache');
const names = { cartons:'箱数',quantity:'记录数量',barcode:'条码',custom:'扩展字段',exportRemarks:'商品说明 / 表格备注', name: '商品名称', sku: '货号', colors: '颜色', material: '材质', dimensions: '尺寸', weightG: '单件重量', unitPrice: '单价', currency: '币种', moq: '起订量', cartonQty: '每箱数量', cartonDimensions: '外箱尺寸', cartonCbm: '单箱体积', leadTimeDays: '大货交期', tradeTerms: '报价条款' };
function withPhotoKeys(photos) {
  return (photos || []).map((photo, index) => Object.assign({}, photo, { viewKey: photo.viewKey || (photo.id ? 'remote:' + photo.id : photo.path ? 'local:' + photo.path : 'missing:' + index) }));
}
Page(kit.protectedPage({
  data: { merchantRequired:false, merchantLocked:false, fieldLabels:{}, fieldVisible:{}, customInputs:[], captureTotals:{}, templateNotice:"", autoOrganize:true, keyboardHeight:0, continuing:false, fields: Object.assign({}, domain.emptyFields), photos: [], suppliers: [], detailsOpen: false, supplierOpen: true, evaluationOpen: true, filledCount: 0, loading: false, saving: false, recognizing: false, modelEnabled: false, modelKnown: false, capabilityFailed: false, capabilityChecking: false, error: '', notice: '', confirmNotice: '', fieldError: null, draftNotice: '', draftBroken: false, pending: false, editing: false, ready: false, currencies: ['CNY', 'USD', 'EUR'], currencyIndex: 0, stars: [1, 2, 3, 4, 5], demo: false, estimatedFields: {}, specSummary: '', evaluationSummary: '', conflictReview: [], legacyEstimates: [] },
  onLoad(options) {
    this._unloaded = false;
    this._projectId = options.projectId;
    this._productId = options.id || '';
    this._readOnly = options.saved === 'yes' && !!this._productId;
    this.setData({ readOnly: this._readOnly, restoredDraft: false, savedFields: [] });
    this._resumeDraft = !this._readOnly && (!!this._productId || options.resume === 'yes' || options.draftId !== undefined);
    this._draftProductId = this._resumeDraft ? (options.draftId || this._productId) : (this._productId || domain.uuid());
    this._revision = 0; this._retired = [];
    try { const info=session.info();if(info){const preference=wx.getStorageSync('huoji.autoOrganize.'+info.user.id);this.setData({autoOrganize:preference!==false});}} catch(_) {}
  },
  onShow() {
    this._viewEpoch = (this._viewEpoch || 0) + 1;
    this._alive = true;
    this._saving = false; this._recognizing = false; this._choosing = !!this._photoChoice;
    this._continueRecording = false;
    this.setData({ saving: false, recognizing: false });
    if (this._opening && this._openingEpoch !== this._viewEpoch) this._opening = false;
    if (this._binding && !session.valid(this._binding)) {
      draft.release(this);fileCache.release(this);
      if (this._photoChoice && this._photoChoice.photos) this._photoChoice.photos.forEach(draft.removeFile);
      this._photoChoice = null; this._choosing = false;
      this.setData({ fields: Object.assign({}, domain.emptyFields), photos: [], suppliers: [], ready: false, error: '账号已变化，请返回重新打开' });
      return;
    }
    this.applyChosenPhotos();
    if(this._initialized && !this._readOnly && !this._templateLoaded)this.loadCaptureTemplate(this._viewEpoch);
    if(this._initialized && !this._readOnly && this._productId)this.checkSavedState(this._viewEpoch);
    if (!this._initialized && !this._opening) this.open();
  },
  onHide() { this.stash(); this._viewEpoch = (this._viewEpoch || 0) + 1; kit.stop(this); },
  onUnload() { this.stash(); this._unloaded = true; draft.release(this);fileCache.release(this); if (this._photoChoice && this._photoChoice.photos) this._photoChoice.photos.forEach(draft.removeFile); this._photoChoice = null; this._viewEpoch = (this._viewEpoch || 0) + 1; kit.stop(this); },
  valid(viewEpoch) { return this._alive && session.valid(this._binding) && (viewEpoch === undefined || viewEpoch === this._viewEpoch); },
  confirmAction(title, content, confirmText, cancelText) {
    return new Promise(resolve => wx.showModal({ title, content, confirmText, cancelText, confirmColor: '#245c46', success: res => resolve(res.confirm === true), fail: () => resolve(false) }));
  },
  async open() {
    const viewEpoch = this._viewEpoch;
    this._openingEpoch = viewEpoch;
    this._opening = true; this.setData({ loading: true, error: '', draftBroken: false, confirmNotice: '', fieldError: null });
    try {
      this._binding = session.capture();
      if (!/^[a-f0-9-]{36}$/.test(this._projectId || '')) { this.requireMerchant(); return; }
      if (!this._readOnly) this._draftToken = draft.snapshot(wx.getStorageSync(draft.key(this._binding.owner, this._projectId, this._draftProductId)));
      const saved = this._resumeDraft ? draft.read(this._binding, this._projectId, this._draftProductId) : null;
      if (this._resumeDraft && !saved && !this._productId) { this.requireMerchant('草稿已不存在，请从商户重新记录'); return; }
      if (saved) {
        if(this._productId && saved.editId && saved.editId !== this._productId) throw session.error('DRAFT_PRODUCT_MISMATCH','草稿对应的是其他商品，本页未修改草稿');
        if(saved.editId || this._productId){
          try{
            const existing=await api.request('/api/products/'+encodeURIComponent(saved.editId || this._productId),{identity:this._binding});
            if(!this.valid(viewEpoch))return;
            if(existing.projectId !== this._projectId) throw session.error('DRAFT_PRODUCT_MISMATCH','草稿对应的商品不属于当前商户记录');
            if(existing.deletedAt){this.setData({ready:false,error:'商品在回收站，先恢复后可继续草稿',draftTrashed:true});return;}
            this._savedVersion = existing.version;
          }catch(e){if(e.code==='LOGIN_REQUIRED' || e.code==='IDENTITY_CHANGED' || e.code==='NOT_FOUND' || e.code==='DRAFT_PRODUCT_MISMATCH')throw e;}
        }
        {
          if (!this.valid(viewEpoch)) return;
          this._pending = saved.pendingCommand || null;
          this._request = saved.request || null;
          this._productId = saved.editId || this._productId;
          this._version = saved.version; this._baseline = saved.baseline || null;
          this._retired = saved.retired || [];
          this._currencyTouched = true;
          const restored = domain.fieldsFrom(saved.fields), legacy = Object.keys(saved.estimatedFields || {}).filter(key => saved.estimatedFields[key]);
          if (legacy.length && this._pending) throw session.error('DRAFT_ESTIMATE_PENDING', '旧草稿含估算值且保存结果未确认。请先在商品列表检查是否已保存，再手工核对；原草稿仍保留。');
          legacy.forEach(key => { restored[key] = domain.emptyFields[key]; });
          this._captureMerchant = !this._productId && restored.supplier.trim() ? merchants.normalize(restored) : null;
          this.setData({ merchantLocked:!!this._captureMerchant, legacyEstimates: (saved.legacyEstimates || []).concat(legacy.map(key => ({ label: names[key] || key, value: String(saved.fields[key]) }))), notice: legacy.length ? '旧草稿的估算值已移出正式字段，请按现场信息重新填写。' : !this._productId && !restored.supplier.trim() ? '原草稿已保留，请先补全商户再保存' : '', demo: !!saved.demo, fields: restored, photos: withPhotoKeys(saved.photos), estimatedFields: {}, pending: !!this._pending, editing: !!this._productId, ready: true, detailsOpen: false, supplierOpen: true, evaluationOpen: true });
          this.setData({ restoredDraft: true });
          if(this._productId && this._savedVersion !== undefined && this._savedVersion !== saved.version) this.setData({ notice:'已恢复本机修改；云端版本有变化，请核对最新版本后保存。' });
        }
      } else if (this._productId) {
        const product = await api.request('/api/products/' + encodeURIComponent(this._productId), { identity: this._binding });
        if (!this.valid(viewEpoch)) return;
        if(product.deletedAt){this.setData({ready:false});wx.redirectTo({url:'/pages/trash/index'});return;}
        if (product.projectId !== this._projectId) throw new Error('商品不属于当前记录');
        this._version = product.version;
        this._organizeJobId=product.organizeJobId;this._organizeState=product.organizeState;
        if(product.organizeState==='failed')this.setData({notice:product.organizeError||'后台整理未完成，可再次AI整理'});
        if(product.organizeState==='queued' && !this._readOnly){
          const checked=(await background.refresh(this._binding,[product]))[0];
          if(!this.valid(viewEpoch))return;
          if(checked.version>product.version)Object.assign(product,checked);
          this._version=product.version;this._organizeState=product.organizeState;
          this.setData({notice:checked.organizePending?'后台正在整理，修改商品时将保留你的输入':checked.organizeLabel?'后台整理未完成，可再次AI整理':''});
        }
        this._currencyTouched = true;
        this.setData({ demo: !!product.demo, fields: domain.fieldsFrom(product), photos: withPhotoKeys(product.photos.map(p => ({ id: p.id, name: p.name, path: '', persistent: false }))), editing: true, ready: true, detailsOpen: false, supplierOpen: true, evaluationOpen: true });
        this._baseline = this.draftSnapshot();
        if (this._readOnly) {
          const labels = Object.assign({name:'商品名称',supplier:'商户',supplierContact:'联系方式',description:'现场描述',notes:'内部备注',evaluation:'个人评价',rating:'评分'},names);
          const savedFields = Object.keys(labels).filter(key => product[key] !== null && product[key] !== undefined && product[key] !== '' && key !== 'custom')
            .map(key => ({key,label:labels[key],value:String(product[key])}));
          Object.entries(product.custom || {}).forEach(([key,value]) => { if(value) savedFields.push({key:'custom:'+key,label:'扩展 · '+key,value}); });
          this.setData({savedFields});
        }
      } else {
        this._captureMerchant = this._captureMerchant || merchants.consumeCapture(this._binding, this._projectId);
        if (!this._captureMerchant) { this.requireMerchant(); return; }
        this.resetForm(this._draftProductId, this._captureMerchant);
      }
      if (!this.valid(viewEpoch)) return;
      this._initialized = true;
      this.restoreFolds();
      this.setData({ currencyIndex: this.data.currencies.indexOf(this.data.fields.currency), draftTrashed: false });
      this.stash();
      if (!this._readOnly) {
        this.loadCaptureTemplate(viewEpoch);
        this.loadSuppliers(viewEpoch).catch(() => {});
        this.loadCapabilities(viewEpoch);
      }
      const photos = await store.hydratePhotos(this.data.photos, this._binding, this);
      if (!this.valid(viewEpoch)) return;
      this.setData({ photos: withPhotoKeys(photos) });
      fileCache.protect(this,photos.map(photo=>photo.path));
    } catch (e) {
      if (this._alive && /^DRAFT_/.test(e.code || '')) this.setData({ error: e.message, draftBroken: true, ready: false });
      else kit.message(this, e);
    }
    finally { if (this._openingEpoch === viewEpoch) this._opening = false; if (this._alive && viewEpoch === this._viewEpoch) this.setData({ loading: false }); }
  },
  backToProducts() { wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/products/index' }) }); },
  viewSaved() {
    if (!this._productId || this._saving || this._recognizing || !this.valid() || !this.stash()) return;
    wx.navigateTo({url:'/pages/editor/index?projectId='+encodeURIComponent(this._projectId)+'&id='+encodeURIComponent(this._productId)+'&saved=yes'});
  },
  chooseMerchant() { wx.switchTab({ url: '/pages/projects/index' }); },
  requireMerchant(message) { this.setData({ ready:false, merchantRequired:true, error:message || '' }); },
  resetForm(draftId, carried) {
    this._productId = ''; this._draftProductId = draftId || '';
    this._version = null; this._pending = null; this._request = null;
    this._draftToken = draft.snapshot(null);
    this._retired = []; this._baseline = null; this._conflict = null; this._currencyTouched = false;
    this._revision += 1; this._carriedSupplier = carried || null; this._merchantChoice = (this._merchantChoice || 0) + 1;
    this._captureMerchant = carried && carried.supplier && carried.supplier.trim() ? merchants.normalize(carried) : null;
    const currency = profile.defaultCurrency(this._binding);
    this.setData({ fields: Object.assign({}, domain.emptyFields, carried || {}, { currency }), photos: [],
      ready: true, merchantRequired:false, merchantLocked:!!this._captureMerchant, editing: false, pending: false, demo: false, detailsOpen: false, supplierOpen: !(carried && carried.supplier), evaluationOpen: true,
      restoredDraft:false, filledCount: 0, estimatedFields: {}, legacyEstimates: [], conflictReview: [], specSummary: '', evaluationSummary: '', currencyIndex: this.data.currencies.indexOf(currency), error: '', notice: '', confirmNotice: '', draftNotice: '', fieldError: null });
    this.restoreFolds();
  },
  restoreFolds() {
    if(!this._binding || !session.valid(this._binding))return;
    const value=wx.getStorageSync('huoji.folds.'+this._binding.owner) || {};
    this.setData({detailsOpen:value.detailsOpen===true,supplierOpen:!this.data.fields.supplier || value.supplierOpen===true,evaluationOpen:value.evaluationOpen===true,customOpen:value.customOpen===true});
    if(this.data.restoredDraft){
      try{const baseline=this._baseline ? JSON.parse(this._baseline).fields || {} : domain.emptyFields,current=this.data.fields;
        if(domain.factual.some(key=>!['name','sku','unitPrice','currency','colors','supplier','supplierContact','exportRemarks','custom'].includes(key) && domain.stable(current[key])!==domain.stable(baseline[key])))this.setData({detailsOpen:true});
        if(domain.stable(current.custom)!==domain.stable(baseline.custom))this.setData({customOpen:true});
      }catch(_){}
    }
  },
  toggleFold(key) {
    if(this._readOnly)return;
    this.setData({[key]:!this.data[key]});
    if(this._binding && session.valid(this._binding)){
      const storageKey='huoji.folds.'+this._binding.owner,value=wx.getStorageSync(storageKey)||{};
      try{wx.setStorageSync(storageKey,Object.assign({},value,{[key]:this.data[key]}));}catch(_){}
    }
  },
  async loadCaptureTemplate(viewEpoch) {
    const binding=this._binding;
    if(!this.valid(viewEpoch) || this._templateLoadingEpoch===viewEpoch)return;
    this._templateLoadingEpoch=viewEpoch;
    const cacheKey='huoji.captureTemplate.'+binding.owner;
    try{const cached=wx.getStorageSync(cacheKey);if(cached && this.valid(viewEpoch))this.applyCaptureTemplate(cached);}catch(_){}
    try{
      const template=await api.request('/api/procurement-template',{identity:binding});
      if(!this.valid(viewEpoch))return;
      this.applyCaptureTemplate(template);this._templateLoaded=true;this.setData({templateNotice:''});
      try{wx.setStorageSync(cacheKey,template);}catch(_){}
    }catch(_){if(this.valid(viewEpoch))this.setData({templateNotice:'表格字段暂未同步，可先录入或重试'});}finally{if(this._templateLoadingEpoch===viewEpoch)this._templateLoadingEpoch=null;}
  },
  retryTemplate(){this._templateLoaded=false;return this.loadCaptureTemplate(this._viewEpoch);},
  openTrash(){wx.navigateTo({url:'/pages/trash/index'});},
  async checkSavedState(epoch){
    if(!this._productId || !this.valid(epoch))return;
    try{const p=await api.request('/api/products/'+encodeURIComponent(this._productId),{identity:this._binding});if(!this.valid(epoch))return;if(p.deletedAt){this.setData({ready:false,draftTrashed:true,error:'商品在回收站，先恢复后可继续草稿'});}else if(this.data.draftTrashed){this.setData({ready:true,draftTrashed:false,error:'',notice:'商品已恢复，本机修改仍保留，保存时会核对最新记录'});this.stash();}}catch(_){}
  },
  applyCaptureTemplate(template){
    this._captureSchema=captureTemplate.columns(template);
    this.setData({fieldLabels:this._captureSchema.labels,fieldVisible:this._captureSchema.visible,customInputs:captureTemplate.customValues(this._captureSchema.custom,this.data.fields)});
  },
  customInput(e){
    if(this._readOnly || !this.data.ready || this._saving)return;
    const key=e.currentTarget.dataset.key;
    if(!this._captureSchema || !this._captureSchema.custom.some(c=>c.key===key))return;
    this._revision+=1;
    const custom=Object.assign({},this.data.fields.custom,{[key]:e.detail.value});
    const changed=domain.factChanged(this.data.fields,Object.assign({},this.data.fields,{custom}));
    this.setData({'fields.custom':custom,'fields.confirmed':changed?false:this.data.fields.confirmed,...(changed && this.data.fields.confirmed?{confirmNotice:'资料有改动，请重新核对后再保存'}:{})});this.stash();
  },
  async loadCapabilities(viewEpoch) {
    if (!this.valid(viewEpoch)) return;
    this.setData({ capabilityChecking: true });
    try {
      const capabilities = await api.request('/api/config', { public: true });
      if (this.valid(viewEpoch)) this.setData({ modelEnabled: capabilities.modelEnabled, modelKnown: true, capabilityFailed: false });
      if (!this.valid(viewEpoch)) return;
    } catch (_) {
      if (this.valid(viewEpoch) && !this.data.modelKnown) this.setData({ capabilityFailed: true, notice: '暂时无法确认自动填写能力，可以先手工录入，或点“重试”再试一次' });
    } finally { if (this.valid(viewEpoch)) this.setData({ capabilityChecking: false }); }
  },
  retryCapabilities() {
    if (this._saving || this.data.capabilityChecking) return;
    this.setData({ capabilityFailed: false });
    this.loadCapabilities(this._viewEpoch);
  },
  async loadSuppliers(viewEpoch) {
    if (!this.valid(viewEpoch)) return;
    const cached = merchants.read(this._binding, this._projectId).entries.map(v => v.supplier);
    this.setData({ suppliers: ['新商户', ...cached] });
    const names = await api.request('/api/suppliers?projectId=' + encodeURIComponent(this._projectId), { identity: this._binding });
    if (this.valid(viewEpoch)) this.setData({ suppliers: ['新商户', ...new Set([...(Array.isArray(names) ? names : []), ...cached].filter(v => typeof v === 'string' && v.trim()))] });
  },
  stash() {
    if (this._readOnly) return true;
    if (!this.valid() || !this.data.ready) return false;
    draft.protect(this, this._binding, this.data.photos.concat(this._retired || []));
    fileCache.protect(this,this.data.photos.map(photo=>photo.path));
    const f = this.data.fields;
    this.setData({captureTotals:captureTemplate.totals(f),customInputs:captureTemplate.customValues(this._captureSchema && this._captureSchema.custom,f)});
    this.setData({ specSummary: [f.material, f.dimensions, f.cartonQty !== null && f.cartonQty !== '' ? f.cartonQty + ' 件/箱' : ''].filter(Boolean).join(' · '), evaluationSummary: f.evaluation || f.notes || '' });
    if (this._productId && !this._pending && this._baseline === this.draftSnapshot()) { this.setData({ draftNotice: '' }); return true; }
    const meaningful = this.data.photos.length || Object.keys(domain.emptyFields).some(key => {
      if(key==='custom')return Object.values(f.custom || {}).some(v=>String(v).trim());
      if (['currency', 'confirmed', 'favorite'].includes(key)) return false;
      if (this._carriedSupplier && ['supplier', 'supplierContact'].includes(key) && this.data.fields[key] === this._carriedSupplier[key]) return false;
      if (key === 'rating' && this.data.fields[key] === null) return false;
      return this.data.fields[key] !== '' && this.data.fields[key] !== null && this.data.fields[key] !== undefined;
    });
    if (!this._productId && !this._pending && !meaningful) { this.setData({ draftNotice: '' }); return true; }
    try {
      const options = this._draftToken === undefined ? {} : { expected:this._draftToken };
      const saved = draft.write(this._binding, this._projectId, this._draftProductId, { demo: this.data.demo, fields: this.data.fields, photos: this.data.photos, editId: this._productId, version: this._version || null, pendingCommand: this._pending || null, request: this._request || null, retired: this._retired, baseline: this._baseline, legacyEstimates: this.data.legacyEstimates, estimatedFields: this.data.estimatedFields }, options);
      this._draftToken = draft.snapshot(saved);
      this.setData({ draftNotice: '草稿已保存' });
      return true;
    } catch (error) { if (this._alive) this.setData({ draftNotice: error.code === 'DRAFT_CHANGED' ? error.message : '草稿未能写入，请勿关闭页面，检查存储空间后重试' }); return false; }
  },
  draftSnapshot() { return domain.stable({ fields: domain.fieldsFrom(this.data.fields), photoIds: this.data.photos.map(photo => photo.id || photo.path), version: this._version }); },
  scrollTop() { if (typeof wx.pageScrollTo === 'function') wx.pageScrollTo({ scrollTop: 0, duration: 200 }); },
  showFieldError(key, message) {
    this.setData({ fieldError: { key, message }, error: '', ...(key === 'supplier' || key === 'supplierContact' ? {supplierOpen:true} : !['name','unitPrice','sku','colors','exportRemarks'].includes(key) ? { detailsOpen: true } : {}) });
    const focus = () => {
      if (typeof wx.createSelectorQuery !== 'function') { this.scrollTop(); return; }
      const query = wx.createSelectorQuery();
      query.select('#field-' + key).boundingClientRect();
      query.selectViewport().scrollOffset();
      query.exec(res => {
        const rect = res && res[0], offset = res && res[1];
        if (!rect || typeof wx.pageScrollTo !== 'function') { this.scrollTop(); return; }
        wx.pageScrollTo({ scrollTop: Math.max(0, rect.top + (offset ? offset.scrollTop : 0) - 160), duration: 250 });
      });
    };
    if (typeof wx.nextTick === 'function') wx.nextTick(focus); else setTimeout(focus, 0);
  },
  invalidNumericField() {
    const keys = ['unitPrice','quantity','cartons', 'moq', 'cartonQty', 'cartonCbm', 'weightG', 'leadTimeDays'];
    for (const key of keys) {
      const value = this.data.fields[key];
      if (value === '' || value === null || value === undefined) continue;
      const probe = Object.assign({}, this.data.fields, { name: 'x', evaluation: '' });
      keys.forEach(k => { if (k !== key) probe[k] = null; });
      try { domain.validateFields(probe); }
      catch (e) { if (/有效数字|价格、重量/.test(e.message)) return key; }
    }
    return '';
  },
  validateFieldsOrFocus() {
    try { domain.validateFields(this.data.fields); return true; }
    catch (e) {
      const key = /商品名称/.test(e.message) ? 'name' : /有效数字|价格、重量/.test(e.message) ? this.invalidNumericField() : '';
      if (key) { this.showFieldError(key, e.message); return false; }
      if (this._alive) this.setData({ error: e.message });
      this.scrollTop();
      return false;
    }
  },
  input(e) {
    if (this._readOnly || !this.data.ready || this._saving) return;
    const key = e.currentTarget.dataset.key;
    if (key === 'supplier' && this.data.merchantLocked) return;
    if (!Object.prototype.hasOwnProperty.call(domain.emptyFields, key) || ['confirmed', 'currency', 'favorite', 'rating','custom'].includes(key)) return;
    this._revision += 1;
    const fields = Object.assign({}, this.data.fields, { [key]: e.detail.value });
    if (key === 'supplier') { this._merchantChoice = (this._merchantChoice || 0) + 1; if (fields.supplier !== this.data.fields.supplier) fields.supplierContact = ''; }
    if (key === 'supplierContact') this._merchantChoice = (this._merchantChoice || 0) + 1;
    const wasConfirmed=this.data.fields.confirmed && domain.factChanged(this.data.fields,fields);
    if(wasConfirmed)fields.confirmed=false;
    const estimatedFields = Object.assign({}, this.data.estimatedFields); delete estimatedFields[key];
    const patch = { fields, estimatedFields };
    if (wasConfirmed) patch.confirmNotice = '资料有改动，请重新核对后再保存';
    if (this.data.fieldError && this.data.fieldError.key === key) patch.fieldError = null;
    this.setData(patch); this.stash();
  },
  favorite() { if (!this._readOnly && !this._saving && this.data.ready) { this._revision += 1; this.setData({ 'fields.favorite': !this.data.fields.favorite }); this.stash(); } },
  rate(e) { if (!this._readOnly && !this._saving && this.data.ready) { const value = Number(e.currentTarget.dataset.value); if (value < 1 || value > 5) return; this._revision += 1; this.setData({ 'fields.rating': this.data.fields.rating === value ? null : value }); this.stash(); } },
  currency(e) {
    if (this._readOnly || this._saving) return;
    this._currencyTouched = true;
    this._revision += 1;
    const currency=this.data.currencies[Number(e.detail.value)];if(!currency)return;
    const changed=currency!==this.data.fields.currency;
    const patch = { currencyIndex: Number(e.detail.value), 'fields.currency': currency, 'fields.confirmed': changed?false:this.data.fields.confirmed };
    if (this.data.fields.confirmed && changed) patch.confirmNotice = '资料有改动，请重新核对后再保存';
    this.setData(patch); this.stash();
  },
  confirm(e) { if (!this._readOnly && !this._saving) { this._revision += 1; const checked = e.detail.value === true; this.setData({ 'fields.confirmed': checked, ...(checked ? { estimatedFields: {} } : {}), confirmNotice: checked ? '' : this.data.confirmNotice }); this.stash(); } },
  async supplier(e) {
    if (this._readOnly || this.data.merchantLocked) return;
    if (!this.data.ready || this._saving) return;
    const index = Number(e.detail.value), name = this.data.suppliers[index];
    if (!Number.isInteger(index) || !name) return;
    const epoch = this._viewEpoch, choice = this._merchantChoice = (this._merchantChoice || 0) + 1;
    const selected = index === 0 ? { supplier: '', supplierContact: '' } : merchants.lookup(this._binding, this._projectId, name) || { supplier: name, supplierContact: '' };
    this._revision += 1;
    if (!this.data.editing) this._carriedSupplier = selected;
    const changed=domain.factChanged(this.data.fields,Object.assign({},this.data.fields,selected));
    this.setData({ 'fields.supplier': selected.supplier, 'fields.supplierContact': selected.supplierContact, 'fields.confirmed': changed?false:this.data.fields.confirmed, supplierOpen: index === 0,...(changed && this.data.fields.confirmed?{confirmNotice:'资料有改动，请重新核对后再保存'}:{}) });
    this.stash();
    if (!this.data.editing) merchants.remember(this._binding, this._projectId, selected);
    if (index === 0 || selected.supplierContact) return;
    try {
      let cursor = '';
      do {
        const page = domain.productPage(await api.request('/api/products?projectId=' + encodeURIComponent(this._projectId) + '&q=' + encodeURIComponent(name) + '&limit=30' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), { identity: this._binding }));
        if (!this.valid(epoch) || this._saving || choice !== this._merchantChoice || this.data.fields.supplier !== name || this.data.fields.supplierContact) return;
        const product = page.items.find(p => p.supplier === name && p.supplierContact);
        if (product) {
          this._revision += 1;
          if (!this.data.editing) this._carriedSupplier = merchants.normalize(product);
          this.setData({ 'fields.supplierContact': product.supplierContact });
          this.stash(); if (!this.data.editing) merchants.remember(this._binding, this._projectId, product); return;
        }
        cursor = page.nextCursor || '';
      } while (cursor);
    } catch (_) { if (this.valid(epoch) && choice === this._merchantChoice) kit.toast('商户已切换，联系方式可手工补充'); }
  },
  toggleDetails() { this.toggleFold('detailsOpen'); },
  toggleSupplier() { this.toggleFold('supplierOpen'); },
  toggleEvaluation() { this.toggleFold('evaluationOpen'); },
  toggleCustom() { this.toggleFold('customOpen'); },
  returnKeepDraft() { if(!this._saving && !this._recognizing && this.stash())this.backToProducts(); },
  async moreActions() {
    if (this._readOnly || this._saving || this._recognizing) return;
    const items = this.data.editing ? [this.data.fields.confirmed?'取消资料核对':'标记资料已核对', '核对最新版本', '移入回收站', '放弃修改','记录新品（保留本机修改）'] : [this.data.fields.confirmed?'取消资料核对':'标记资料已核对','放弃当前草稿'];
    try {
      const choice = await new Promise((resolve, reject) => wx.showActionSheet({ itemList: items, success: resolve, fail: reject }));
      if (!this.valid()) return;
      if(choice.tapIndex===0)return this.confirm({detail:{value:!this.data.fields.confirmed}});
      if(this.data.editing && choice.tapIndex===4){
        if(!this.stash())return;
        merchants.beginCapture(this._binding,this._projectId,{supplier:this.data.fields.supplier,supplierContact:this.data.fields.supplierContact});
        wx.navigateTo({url:'/pages/editor/index?projectId='+encodeURIComponent(this._projectId),fail:()=>merchants.cancelCapture()});return;
      }
      if (!this.data.editing || choice.tapIndex === 3) return this.discard();
      if (choice.tapIndex === 1) return this.refreshVersion();
      if (choice.tapIndex === 2) return this.remove();
    } catch (_) {}
  },
  showOrganizeInfo() { kit.info(this.data.modelEnabled ? '图文自动填写' : '文字自动填写', this.data.modelEnabled ? '所选照片与描述将发送至自动填写服务。仅提取明确的信息，补充空字段，不覆盖手工输入。结果需人工核对。' : '按明确文字提取价格、规格等信息。照片仅存档。可用手机键盘语音输入。未知内容保持空白。'); },
  keyboard(e){this.setData({keyboardHeight:Math.max(0,Number(e.detail.height)||0)});},
  blur(){this.setData({keyboardHeight:0});},
  toggleAutoOrganize(e){if(this._readOnly || this._saving)return;this.setData({autoOrganize:e.detail.value===true});if(this._binding&&session.valid(this._binding))wx.setStorageSync('huoji.autoOrganize.'+this._binding.owner,e.detail.value===true);},
  saveBack() { if (this._saving || this._recognizing || !this.data.ready) { kit.toast('页面还没准备好，请重试'); return; } this._continueRecording = false;this.setData({continuing:false}); return this.save(); },
  saveNext() {
    if (this._saving || this._recognizing || this._choosing) { kit.toast('正在处理中，请稍候'); return; }
    if (!this.data.ready) { kit.toast('页面还没准备好，请重试'); return; }

    this._continueRecording = true;this.setData({continuing:true});
    return this.save();
  },
  applyChosenPhotos() {
    const choice = this._photoChoice;
    if (!choice || !choice.photos || !this.valid() || this._unloaded) return;
    this._revision += 1;
    const patch = { photos: withPhotoKeys(this.data.photos.concat(choice.photos)), 'fields.confirmed': false };
    if (this.data.fields.confirmed) patch.confirmNotice = '资料有改动，请重新核对后再保存';
    this.setData(patch);
    this._photoChoice = null; this._choosing = false; this.stash();
  },
  async addPhotos() {
    if (this._readOnly || this._saving || this._choosing || this.data.photos.length >= 6) return;
    const choice = { binding: this._binding };
    this._photoChoice = choice;
    this._choosing = true;
    let added = [];
    try {
      session.assert(this._binding);
      const files = await new Promise((resolve, reject) => wx.chooseMedia({ count: 6 - this.data.photos.length, mediaType: ['image'], sourceType: ['album', 'camera'], sizeType: ['compressed'], success: res => resolve(res.tempFiles), fail: e => reject(new Error(/cancel/.test(e.errMsg || '') ? '已取消选择' : '无法选择照片，请检查相机/相册权限')) }));
      added = await draft.persistPhotos(files, this._binding);
      if (this._unloaded || this._photoChoice !== choice || !session.valid(choice.binding)) { added.forEach(draft.removeFile); return; }
      choice.photos = added;
      this.applyChosenPhotos();
    } catch (e) { if (e.message !== '已取消选择') kit.message(this, e); }
    finally { if (this._photoChoice === choice && !choice.photos) this._photoChoice = null; this._choosing = !!this._photoChoice; }
  },
  removePhoto(e) {
    if (this._readOnly || this._saving) return;
    const index = Number(e.currentTarget.dataset.index), photos = this.data.photos.slice(), removed = photos.splice(index, 1)[0];
    if (!removed) return;
    if (removed.persistent) this._retired.push(removed);
    this._revision += 1;
    const patch = { photos, 'fields.confirmed': false };
    if (this.data.fields.confirmed) patch.confirmNotice = '资料有改动，请重新核对后再保存';
    this.setData(patch); this.stash();
  },
  mainPhoto(e) {
    if (this._readOnly || this._saving) return;
    const photos = this.data.photos.slice(), [photo] = photos.splice(Number(e.currentTarget.dataset.index), 1);
    if (!photo) return;
    photos.unshift(photo); this._revision += 1;
    const patch = { photos };
    this.setData(patch); this.stash();
  },
  preview(e) {
    const path = this.data.photos[Number(e.currentTarget.dataset.index)].path;
    if (path) wx.previewImage({ current: path, urls: this.data.photos.map(p => p.path).filter(Boolean) });
  },
  async ensureUploads(viewEpoch) {
    const photos = await store.uploadPhotos(this.data.photos, this._binding);
    if (!this.valid(viewEpoch)) throw session.error('IDENTITY_CHANGED', '页面或登录状态已变化');
    const current = this.data.photos.map(photo => {
      const uploaded = photos.find(item => photo.path ? item.path === photo.path : item.id === photo.id);
      return uploaded ? Object.assign({}, photo, { id: uploaded.id, name: uploaded.name }) : photo;
    });
    this.setData({ photos: withPhotoKeys(current) }); this.stash();
    return photos;
  },
  async repairInvalidPhotos(viewEpoch) {
    let changed = false;
    let removedRemote = false;
    const photos = [];
    for (const photo of this.data.photos) {
      if (!photo.id) { photos.push(photo); continue; }
      try {
        const path = await api.download('/api/photos/' + encodeURIComponent(photo.id), this._binding);
        if (!this.valid(viewEpoch)) throw session.error('IDENTITY_CHANGED', '页面或登录状态已变化');
        photos.push(photo.persistent ? photo : Object.assign({}, photo, { path, error: false }));
      } catch (e) {
        if (e.code === 'LOGIN_REQUIRED' || e.code === 'IDENTITY_CHANGED') throw e;
        if (e.code !== 'NOT_FOUND') throw e;
        changed = true;
        if (photo.persistent && photo.path) photos.push(Object.assign({}, photo, { id: '', error: false }));
        else removedRemote = true;
      }
    }
    if (changed && this.valid(viewEpoch)) {
      this._request = null;
      this._revision += 1;
      this.setData({ photos: withPhotoKeys(photos), 'fields.confirmed': false, notice: removedRemote ? '照片文件已丢失，已从本次记录移除；请核对后重试保存。' : '远端照片已失效，将从本机照片重新上传；请重试保存。' });
      this.stash();
    }
    return changed;
  },
  async organize() {
    if (this._readOnly) return;
    if (this._recognizing || this._saving) { kit.toast('正在处理中，请稍候'); return; }
    if (!this.data.ready) { kit.toast('页面还没准备好，请重试'); return; }
    if (!this.data.modelKnown) { kit.toast('还没确认识别是否可用，先点“重试”或手工录入'); return; }
    const viewEpoch = this._viewEpoch;
    if (!this.data.fields.description.trim() && (!this.data.modelEnabled || !this.data.photos.length)) { kit.toast('添加照片或写下现场描述'); return; }
    if (!this.valid(viewEpoch)) return;
    this._recognizing = true; this.setData({ recognizing: true, error: '' });
    const revision = this._revision;
    try {
      const photos = this.data.modelEnabled ? await this.ensureUploads(viewEpoch) : [];
      const result = (await jobs.runExtract(this.data.fields.description, photos.map(p => p.id), this._binding, { isCurrent: () => this.valid(viewEpoch) })).result;
      if (!result || !result.fields) throw session.error('BAD_RESPONSE', '整理结果无效，请重试');
      if (!this.valid(viewEpoch)) return;
      if (revision !== this._revision) { this.setData({ notice: '识别期间内容有改动，本次结果未写入，请重新识别' }); return; }
      const wasConfirmed = this.data.fields.confirmed;
      const source = Object.assign({}, this.data.fields);
      const extracted=Object.assign({},result.fields);
      (result.estimates || []).forEach(key=>delete extracted[key]);
      const merged = domain.mergeExtraction(source, extracted);
      const filledKeys = ['name', 'sku', 'supplier', 'supplierContact', 'notes','exportRemarks', 'colors', 'material', 'dimensions', 'weightG', 'unitPrice', 'moq','quantity','cartons','barcode', 'cartonQty', 'cartonDimensions', 'cartonCbm', 'leadTimeDays', 'tradeTerms'];
      const filled = filledKeys.filter(k => (source[k] === '' || source[k] === null || source[k] === undefined) && merged.fields[k] !== '' && merged.fields[k] !== null && merged.fields[k] !== undefined).length;
      this._revision += 1;
      const estimatedFields = Object.assign({}, this.data.estimatedFields);
      (result.estimates || []).forEach(key => { if (source[key] !== merged.fields[key]) estimatedFields[key] = true; });
      const patch = { fields: merged.fields, estimatedFields, filledCount: filledKeys.filter(k => !['name', 'unitPrice'].includes(k) && source[k] !== merged.fields[k]).length, currencyIndex: this.data.currencies.indexOf(merged.fields.currency), notice: (result.warning || '') + (merged.conflicts.length ? ' 已保留原值：' + merged.conflicts.map(k => names[k]).join('、') : '') + (merged.conflicts.includes('currency')?'；币种不一致，价格未填入，请核对币种':'') };
      if (wasConfirmed && !merged.fields.confirmed) patch.confirmNotice = '资料有改动，请重新核对后再保存';
      this.setData(patch); this.stash();
      const estimated = Array.isArray(result.estimates) ? result.estimates.length : 0;
      kit.toast('已补 ' + filled + ' 项' + (estimated ? '（含 ' + estimated + ' 项估算）' : '') + '，请核对');
    } catch (e) {
      if (e.code === 'INVALID_PHOTO') {
        try { await this.repairInvalidPhotos(viewEpoch); } catch (repairError) { e = repairError; }
        if (this.valid(viewEpoch) && e.code === 'INVALID_PHOTO') e = new Error('照片文件已丢失，已标记或移除，请核对后重试');
      }
      kit.message(this, e);
    } finally { if (viewEpoch === this._viewEpoch) { this._recognizing = false; if (this.valid(viewEpoch)) this.setData({ recognizing: false }); } }
  },
  syncSavedMerchant(product) {
    if (!this._saveWasNew || !product || !product.createdAt || !Number.isFinite(new Date(product.createdAt).getTime())) return;
    const merchant = merchants.normalize(product);
    if (!merchant.supplier) return;
    store.selectMerchant(this._binding, { projectId:this._projectId, ...merchant, date:domain.chinaLocalDate(product.createdAt) });
  },
  async finish(viewEpoch, product) {
    if (!this.valid(viewEpoch)) return;
    this.syncSavedMerchant(product);
    if (this._saveWasNew) {
      merchants.remember(this._binding, this._projectId, this.data.fields);
      const name = this.data.fields.supplier.trim();
      if (name && !this.data.suppliers.includes(name)) this.setData({ suppliers: ['新商户', name, ...this.data.suppliers.filter(v => v !== '新商户')] });
    }
    draft.release(this);
    if (this._draftToken !== undefined) {
      const removed = draft.discard(this._binding, this._projectId, this._draftProductId, {expected:this._draftToken});
      if (!removed) kit.toast('商品已保存，较新的本机草稿仍保留');
    }
    draft.releaseFiles(this._retired); this._retired = [];
    this.setData({editing:true,pending:false});this._baseline=this.draftSnapshot();
    if(product && this.data.autoOrganize && this._saveWasNew && (product.description.trim()||product.photos.length)){
      try { const result=await background.submit(this._binding,product);if(!this.valid(viewEpoch))return;this._version=result.product.version;this._baseline=this.draftSnapshot(); }
      catch(e){if(!this.valid(viewEpoch))return;kit.toast('商品已保存，后台整理未启动，可在商品中重试');}
    }
    if (this._continueRecording) {
      const supplier = this.data.fields.supplier, supplierContact = this.data.fields.supplierContact;
      if (!supplier.trim()) { this.setData({ready:false});kit.toast('已保存，请先选择商户再记录新品');this.chooseMerchant();return; }
      this.resetForm(domain.uuid(), { supplier, supplierContact });
      this.stash(); kit.toast('已保存，可以继续记录下一件');
      wx.pageScrollTo({ scrollTop: 0, duration: 200 });
      return;
    }
    this.setData({ ready: false }); kit.toast('商品已保存');
    this.backToProducts();
  },
  async save() {
    if (this._readOnly) return;
    if (this._saving || this._recognizing || this._choosing) { kit.toast('正在处理中，请稍候'); return; }
    if (!this.data.ready) { kit.toast('页面还没准备好，请重试'); return; }
    const viewEpoch = this._viewEpoch;
    this._saveWasNew=!this._productId;
    if(!this.data.fields.name.trim()){
      if(this.data.fields.sku.trim())this.setData({'fields.name':this.data.fields.sku.trim()});
      else if(this.data.photos.length||this.data.fields.description.trim())this.setData({'fields.name':'未命名商品'});
    }
    this._merchantChoice = (this._merchantChoice || 0) + 1;
    this._saving = true; this.setData({ saving: true, error: '', fieldError: null });
    try {
      session.assert(this._binding);
      if(this._draftToken !== undefined && !draft.matches(this._binding,this._projectId,this._draftProductId,this._draftToken)) throw session.error('DRAFT_CHANGED','已有更新的本机草稿，请返回后重新打开；本页未覆盖新草稿');
      if (Object.keys(this.data.estimatedFields || {}).some(k => this.data.estimatedFields[k])) throw session.error('ESTIMATE_UNCONFIRMED', '估算值需手工核对并重新填写后保存');
      if (this._pending) {
        const prior = this._pending;
        const product = await api.request('/api/products', { method: 'POST', data: prior, identity: this._binding });
        if (!this.valid(viewEpoch)) return;
        this._saveWasNew = !prior.id;
        this.syncSavedMerchant(product);
        this._pending = null; this._productId = product.id; this._version = product.version;
        this.setData({ editing: true, pending: false });
        const currentFields = domain.validateFields(this.data.fields);
        if (domain.stable({ fields: currentFields, photoIds: this.data.photos.map(p => p.id) }) === domain.stable({ fields: prior.fields, photoIds: prior.photoIds })) { await this.finish(viewEpoch, product); return; }
        this.setData({ pending: false, editing: true, notice: '上次保存已核查成功。你后续的修改仍在草稿，核对后再次保存将更新同一商品。' }); this.stash();
        return;
      }
      if (!this._productId && !this.data.fields.supplier.trim()) { this.setData({supplierOpen:true});this.showFieldError('supplier','请先补全商户名称或摊位号');return; }
      if (!this._productId && this._captureMerchant && this.data.fields.supplier !== this._captureMerchant.supplier) throw new Error('商户已变化，请返回商户入口重新记录');
      if (!this._productId && !this._captureMerchant) { this._captureMerchant=merchants.normalize(this.data.fields);this.setData({merchantLocked:true}); }
      if (!this.validateFieldsOrFocus()) return;
      const photos = await this.ensureUploads(viewEpoch);
      const payload = store.payload(this.data.fields, this._projectId, photos, this._productId, this._version);
      this._request = domain.requestFor(payload, this._request);
      this._pending = Object.assign({}, payload, { requestKey: this._request.requestKey });
      this.setData({ pending: true });
      if (!this.stash()) { this._pending = null; this.setData({ pending: false }); throw new Error('保存请求无法记录在本机，请检查存储空间后重试'); }
      const product = await api.request('/api/products', { method: 'POST', data: this._pending, identity: this._binding });
      if (!this.valid(viewEpoch)) return;
      this._pending = null; this._productId = product.id; this._version = product.version;
      await this.finish(viewEpoch, product);
    } catch (e) {
      if (!this.valid(viewEpoch)) return;
      if (!domain.uncertain(e)) {
        this._pending = null; this.setData({ pending: false });
      }
      if (e.code === 'NOT_FOUND' || e.code === 'INVALID_PHOTO') { try { await this.repairInvalidPhotos(viewEpoch); } catch (_) {} }
      if (e.code === 'CONFLICT') this.setData({ notice: '服务端有较新版本。本机输入已保留，请使用下方“核对最新版本”后保存。' });
      this.stash(); kit.message(this, e);
    } finally { if (viewEpoch === this._viewEpoch) { this._saving = false; this._continueRecording = false; if (this._alive) this.setData({ saving: false, continuing:false, pending: !!this._pending }); } }
  },
  async refreshVersion() {
    if (this._readOnly) return;
    if (!this._productId || this._saving || this._pending) return;
    const revision = this._revision, epoch = this._viewEpoch, productId = this._productId;
    try {
      const remote = await api.request('/api/products/' + encodeURIComponent(this._productId), { identity: this._binding });
      if (!this.valid(epoch) || revision !== this._revision || productId !== this._productId) { if (this.valid()) kit.toast('输入已变化，请重新核对版本'); return; }
      const local = domain.fieldsFrom(this.data.fields), server = domain.fieldsFrom(remote);
      let baseline = null; try { baseline = this._baseline && JSON.parse(this._baseline); } catch (_) {}
      const merged = Object.assign({}, local), conflicts = [];
      const customMerge=captureTemplate.mergeCustom(local.custom,server.custom,baseline && baseline.fields.custom,this._captureSchema && this._captureSchema.custom);merged.custom=customMerge.fields;conflicts.push(...customMerge.conflicts);
      Object.keys(domain.emptyFields).forEach(key => {
        if(key==='custom')return;
        if (domain.stable(local[key]) === domain.stable(server[key])) return;
        if (baseline && domain.stable(local[key]) === domain.stable(baseline.fields[key])) merged[key] = server[key];
        else if (!baseline || domain.stable(server[key]) !== domain.stable(baseline.fields[key])) conflicts.push({ key, label: names[key] || ({ supplier:'商户',supplierContact:'联系方式',notes:'备注',description:'现场描述',evaluation:'评价',rating:'评分',favorite:'收藏',confirmed:'核对状态' })[key] || key, local: String(local[key] === null ? '未填写' : local[key]), remote: String(server[key] === null ? '未填写' : server[key]) });
      });
      const localPhotos = this.data.photos, remotePhotos = withPhotoKeys(remote.photos.map(p => ({ id:p.id,name:p.name,path:'',persistent:false })));
      const localIds = localPhotos.map(p => p.id || p.path), remoteIds = remotePhotos.map(p => p.id), baseIds = baseline && baseline.photoIds;
      let mergedPhotos = localPhotos;
      if (domain.stable(localIds) !== domain.stable(remoteIds)) {
        if (baseIds && domain.stable(localIds) === domain.stable(baseIds)) mergedPhotos = remotePhotos;
        else if (!baseIds || domain.stable(remoteIds) !== domain.stable(baseIds)) conflicts.push({ key:'photos',label:'照片',local:localPhotos.length+' 张：'+localPhotos.map(p => p.name).join('、'),remote:remotePhotos.length+' 张：'+remotePhotos.map(p => p.name).join('、') });
      }
      this._conflict = { remote, fields: merged, photos: mergedPhotos, remotePhotos, conflicts, revision, epoch, productId };
      if (!conflicts.length) return this.resolveVersion({ currentTarget: { dataset: { value: 'local' } } });
      this.setData({ conflictReview: conflicts, notice: '请核对全部冲突；云端独有修改将自动保留。' }); this.scrollTop();
    } catch (e) { kit.message(this, e); }
  },
  async resolveVersion(e) {
    if (this._readOnly || !this._conflict || this._saving) return;
    const review = this._conflict;
    if (!this.valid(review.epoch) || review.revision !== this._revision || review.productId !== this._productId) { this._conflict = null; this.setData({ conflictReview: [] }); kit.toast('输入已变化，请重新核对版本'); return this.refreshVersion(); }
    this._saving = true; this.setData({ saving: true });
    const fields = Object.assign({}, review.fields); let photos = review.photos;
    if (e.currentTarget.dataset.value === 'remote') review.conflicts.forEach(item => { if (item.key === 'photos') photos = review.remotePhotos; else if(item.key.startsWith('custom:')){const key=item.key.slice(7);if(review.remote.custom[key]===undefined)delete fields.custom[key];else fields.custom[key]=review.remote.custom[key];}else fields[item.key] = review.remote[item.key]; });
    try {
      photos = await store.hydratePhotos(photos, this._binding, this); if (!this.valid(review.epoch) || review.revision !== this._revision || review.productId !== this._productId) return;
      this._version = review.remote.version; this._request = null; this._revision += 1;
      this._baseline = domain.stable({ fields: domain.fieldsFrom(review.remote), photoIds: review.remote.photos.map(p=>p.id), version: review.remote.version });
      this._conflict = null; fields.confirmed = false;
      this.setData({ fields, photos: withPhotoKeys(photos), currencyIndex:this.data.currencies.indexOf(fields.currency), conflictReview:[], notice:'已合并最新记录，请核对后保存。' }); this.stash();
    } catch (error) { kit.message(this,error); }
    finally { this._saving = false; if (this.valid()) this.setData({ saving:false }); }
  },
  async remove() {
    if (this._readOnly || !this._productId || this._saving || this._pending) return;
    if (!(await kit.confirm('移入回收站', '商品将从列表和导出中移除，可在“设置 · 回收站”恢复到原商户和原日期。'))) return;
    this._saving = true; this.setData({ saving: true });
    try {
      await api.request('/api/products/' + encodeURIComponent(this._productId) + '/trash', { method: 'POST', data: { version: this._version }, identity: this._binding });
      if (this.valid()) {
        draft.release(this);
        const options = this._draftToken === undefined ? {expected:draft.snapshot(null)} : {expected:this._draftToken};
        if(!draft.discard(this._binding,this._projectId,this._draftProductId,options)) kit.toast('商品已移入回收站，较新的本机草稿仍保留');
        draft.releaseFiles(this._retired); this.setData({ready:false}); this.backToProducts();
      }
    } catch (e) { kit.message(this, e); }
    finally { this._saving = false; if (this._alive) this.setData({ saving: false }); }
  },
  async discard() {
    if (this._readOnly) return;
    if (this._saving || !(await this.confirmAction('放弃未保存的内容', '删除本机输入和新照片；不会删除已保存的商品。', '放弃', '取消'))) return;
    try {
      session.assert(this._binding);
      const options = this._draftToken === undefined ? {} : {expected:this._draftToken};
      draft.release(this);
      if (!draft.discard(this._binding,this._projectId,this._draftProductId,options)) { draft.protect(this,this._binding,this.data.photos.concat(this._retired || [])); throw session.error('DRAFT_CHANGED','草稿已经更新，本次没有放弃新草稿，请返回后重新打开'); }
      draft.releaseFiles(this._retired); this.setData({ready:false}); this.backToProducts();
    }
    catch (e) { kit.message(this, e); }
  },
  login: kit.loginPage
}));
