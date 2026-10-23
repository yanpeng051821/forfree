const api = require('../../utils/api');
const session = require('../../utils/session');
const store = require('../../utils/store');
const domain = require('../../utils/domain');
const kit = require('../../utils/page-kit');
const captureTemplate=require('../../utils/capture-template');
function validDate(value) { return /^\d{4}-\d{2}-\d{2}$/.test(value || '') && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value; }
function cellValue(column,p,layout={}){
  const t=captureTemplate.totals(p),key=column.key;
  if(key==='image')return '';
  if(key==='description')return [layout.deduplicateSku===true && String(p.name || '').trim()===String(p.sku || '').trim()?'':p.name,p.colors,p.material,p.dimensions,p.cartonDimensions?'外箱：'+p.cartonDimensions:'',p.exportRemarks].filter(Boolean).join(' / ');
  if(key==='pcsPerCarton')return p.cartonQty;
  if(key==='quantity')return p.quantity===null || p.quantity===undefined ? t.derivedQuantity:p.quantity;
  if(key==='amount'){const quantity=p.quantity===null || p.quantity===undefined ? t.derivedQuantity:p.quantity;return quantity!==null && quantity!==undefined && quantity!=='' && p.unitPrice!==null && p.unitPrice!==undefined && p.unitPrice!=='' ? quantity*p.unitPrice:null;}
  if(key==='cbm')return p.cartons!==null && p.cartons!==undefined && p.cartons!=='' && p.cartonCbm!==null && p.cartonCbm!==undefined && p.cartonCbm!=='' ? p.cartons*p.cartonCbm:null;
  if(key==='decision')return p.confirmed?'已核对':'待核对';
  if(key.startsWith('business:')){const field=key.slice(9);return field==='favorite'?(p.favorite?'已收藏':''):field==='photoCount'?p.photos.length:field==='recordDate'?domain.chinaLocalDate(p.createdAt):field==='project'?(p.taskName||''):field==='market'?(p.taskMarket||''):field==='date'?(p.taskDate||''):field==='demo'?(p.demo?'模拟数据':''):p[field];}
  return Object.prototype.hasOwnProperty.call(p.custom || {},key)?p.custom[key]:p[key];
}
function columnWidth(column){return Math.max(Object.prototype.hasOwnProperty.call(column,'primary')?60:110,(column.width||16)*12);}
function previewCells(columns,product,layout={}){
  const precision=(value,fallback)=>Number.isInteger(value) && value>=0 && value<=6 ? value:fallback;
  const moneyDecimals=precision(layout.moneyDecimals,2),volumeDecimals=precision(layout.volumeDecimals,6);
  return columns.map(c=>{let v=cellValue(c,product,layout);if(v!==null && v!==undefined && v!==''){if(['unitPrice','amount'].includes(c.key)){const parts=Number(v).toFixed(moneyDecimals).split('.');if(c.currencyPrefix!==undefined)parts[0]=parts[0].replace(/\B(?=(\d{3})+(?!\d))/g,',');v=(c.currencyPrefix===false?'':product.currency+' ')+parts.join('.');}if(['cartonCbm','cbm'].includes(c.key))v=Number(v).toFixed(volumeDecimals);}return {key:c.key,primary:c.primary,value:v===null || v===undefined || v===''?'—':String(v),width:columnWidth(c)};});
}
Page(kit.protectedPage({
  data: { dateControls:false,dateMode:'day',selectedDate:'',dateFrom:'',dateTo:'',today:'',rangeChecking:false,dateNotice:'',merchantCount:null,merchantOptions:[], merchantIndex:0, supplierLabel:'所有商家', supplierScoped:false, project: null, summary: null, drafts: [], preview: [], scope: 'all', audience: 'selection', columnsOpen: false, templateColumns: [], previewWidth:1000, previewFieldStyle:'',previewBodyStyle:'',fileReady: false, fileName: '', images: true, exportCount: 0, headerRows: [], documentTitle: '', metadataReady: false, loading: false, exporting: false, error: '' },
  onLoad(options) {
    this._projectId=options.projectId;this._favorites=options.favorite==='yes';this._dateControls=!this._projectId && !this._favorites;
    const today=domain.chinaLocalDate(),range=options.dateFrom!==undefined || options.dateTo!==undefined;
    this._date=options.date!==undefined ? options.date : this._dateControls && !range ? today:undefined;
    this._dateFrom=options.dateFrom;this._dateTo=options.dateTo;
    if(range && (!this._dateControls || options.date!==undefined))this._dateScopeError='日期范围不能与单日、原商户记录或收藏入口混用';
    this._supplier=options.supplier;try{if(this._supplier!==undefined)this._supplier=decodeURIComponent(this._supplier);}catch(_){}
    this.setData({dateControls:this._dateControls,dateMode:range?'range':'day',today,selectedDate:this._date || today,dateFrom:this._dateFrom || this._date || today,dateTo:this._dateTo || today,supplierScoped:this._supplier!==undefined,supplierLabel:this._supplier===undefined?'所有商家':this._supplier || '未填写商家'});
    if(options.scope==='confirmed')this.setData({scope:'confirmed'});
  },
  onShow() { this.load(); },
  onHide() { this.stopView(); }, onUnload() { this.stopView(); },
  stopView() { this._capabilitySerial=(this._capabilitySerial || 0)+1;this.setData({rangeChecking:false});kit.stop(this); },
  async load() {
    if (!kit.requireLogin(this)) return;
    const seq = kit.start(this);
    this._file = null; this._fileBinding = null;this._merchantSummaries=null;
    this.setData({ today:domain.chinaLocalDate(),fileReady: false, fileName: '', project: null, summary: null, preview: [], drafts: [], exportCount:0,merchantCount:null,loading: true, error: '' });
    try {
      const binding = session.capture(); this._binding = binding;
      this.validateDateScope(false);
      if(this._dateControls && this.data.dateMode==='range' && !this.rangeSupported())await this.requireRangeSupport(binding);
      if(!kit.current(this,binding,seq))return;
      await this.loadMerchantOptions(binding,seq).catch(()=>{});
      if(!kit.current(this,binding,seq))return;
      await this.loadMetadata(binding, seq);
      if(!kit.current(this,binding,seq))return;
      if (this._date || this._dateControls || this._favorites) {
        this.setData({ project: { name: this._favorites ? '收藏商品' : '看货记录' }, drafts: this.relatedDrafts(binding) });
        await this.loadPreview(binding, seq); return;
      }
      const projects = await api.request('/api/projects', { identity: binding });
      if (!kit.current(this, binding, seq)) return;
      const project = projects.find(item => item.id === this._projectId);
      if (!project) throw new Error('商户记录已不可访问，请返回重新选择');
      this.setData({ project, summary: project.summary || null, drafts: this.relatedDrafts(binding) });
      await this.loadPreview(binding, seq);
    } catch (e) { if (this._alive && this._seq === seq) kit.message(this, e); }
    finally { if (this._alive && this._seq === seq) this.setData({ loading: false }); }
  },
  rangeSupported() { return this._rangeSupported===true && session.valid(this._rangeBinding); },
  async requireRangeSupport(binding) {
    this._rangeSupported=false;
    let capabilities;
    try{capabilities=await api.request('/api/capabilities',{identity:binding});}
    catch(error){if(error.code==='LOGIN_REQUIRED' || error.code==='IDENTITY_CHANGED')throw error;throw new Error('当前服务暂不支持日期范围，请使用单日导出');}
    session.assert(binding);
    if(!capabilities || capabilities.dateRangeExport!==true)throw new Error('当前服务暂不支持日期范围，请使用单日导出');
    this._rangeSupported=true;this._rangeBinding=binding;
  },
  validateDateScope(requireSupport=true) {
    if(this._dateScopeError)throw new Error(this._dateScopeError);
    const today=domain.chinaLocalDate();
    if(this._dateControls && this.data.dateMode==='range'){
      if(!validDate(this._dateFrom) || !validDate(this._dateTo) || this._dateFrom>this._dateTo || this._dateTo>today)throw new Error('请选择有效的起止日期，开始日期不能晚于结束日期，且不能晚于今天');
      if(requireSupport && !this.rangeSupported())throw new Error('当前服务尚未确认支持日期范围，请重试或使用单日导出');
    }else if(this._date!==undefined && (!validDate(this._date) || this._date>today))throw new Error('请选择有效日期，且不能晚于今天');
  },
  async changeDateMode(e) {
    if(this._exporting || !this._dateControls)return;
    const mode=e.currentTarget.dataset.mode;
    if(!['day','range'].includes(mode) || mode===this.data.dateMode && !this.data.rangeChecking)return;
    if(mode==='range' && this.data.rangeChecking)return;
    const serial=this._capabilitySerial=(this._capabilitySerial || 0)+1;
    if(mode==='range'){
      const binding=session.capture(),seq=this._seq;
      this.setData({rangeChecking:true,dateNotice:''});
      try{await this.requireRangeSupport(binding);if(!kit.current(this,binding,seq) || serial!==this._capabilitySerial)return;}
      catch(error){if(kit.current(this,binding,seq) && serial===this._capabilitySerial)this.setData({dateNotice:'当前服务暂不支持日期范围，请使用单日导出'});return;}
      finally{if(this._alive && serial===this._capabilitySerial)this.setData({rangeChecking:false});}
      this._dateFrom=this.data.selectedDate;this._dateTo=domain.chinaLocalDate();this._date=undefined;
      this.setData({dateMode:'range',dateFrom:this._dateFrom,dateTo:this._dateTo,dateNotice:''});
    }else{
      this._date=validDate(this._dateFrom)?this._dateFrom:this.data.selectedDate;this._dateFrom=undefined;this._dateTo=undefined;
      this.setData({dateMode:'day',selectedDate:this._date,dateNotice:'',rangeChecking:false});
    }
    this._dateScopeError='';return this.load();
  },
  dateChange(e) {
    if(this._exporting || !this._dateControls)return;
    const key=e.currentTarget.dataset.key,value=e.detail.value,today=domain.chinaLocalDate();
    if(!validDate(value) || value>today){this.setData({error:'请选择有效日期，且不能晚于今天'});return;}
    if(key==='date' && this.data.dateMode==='day'){if(value===this._date)return;this._date=value;this.setData({selectedDate:value});}
    else if(['dateFrom','dateTo'].includes(key) && this.data.dateMode==='range'){
      const from=key==='dateFrom'?value:this._dateFrom,to=key==='dateTo'?value:this._dateTo;
      if(from>to){this.setData({error:'开始日期不能晚于结束日期'});return;}
      this._date=undefined;this._dateFrom=from;this._dateTo=to;this.setData({dateFrom:from,dateTo:to});
    }else return;
    this._capabilitySerial=(this._capabilitySerial || 0)+1;this._dateScopeError='';this.setData({rangeChecking:false,dateNotice:''});return this.load();
  },
  relatedDrafts(binding) {
    return store.drafts.list(binding).filter(item =>
      (!this._projectId || item.projectId === this._projectId) &&
      (this._supplier === undefined || (item.fields.supplier || '') === this._supplier) &&
      (!this._favorites || item.fields.favorite === true));
  },
  baseQuery() { this.validateDateScope();return (this._projectId ? 'projectId='+encodeURIComponent(this._projectId) : this._favorites ? 'favorite=yes' : this.data.dateMode==='range' ? 'dateFrom='+encodeURIComponent(this._dateFrom)+'&dateTo='+encodeURIComponent(this._dateTo) : 'date='+encodeURIComponent(this._date)) + (this._projectId && this._date ? '&date='+encodeURIComponent(this._date) : ''); },
  scopeQuery() { return this.baseQuery() + (this._supplier !== undefined ? '&supplier='+encodeURIComponent(this._supplier) : ''); },
  async loadMerchantOptions(binding,seq) {
    const merchants=await api.request('/api/merchants?'+this.baseQuery(),{identity:binding});
    if(!kit.current(this,binding,seq) || !Array.isArray(merchants))return;
    this._merchantSummaries=merchants;
    this._merchants=[{supplier:undefined,label:'所有商家'},...merchants.map(m=>({supplier:m.supplier,label:m.supplier || '未填写商家'}))];
    if(this._supplier!==undefined && !this._merchants.some(m=>m.supplier===this._supplier))this._merchants.push({supplier:this._supplier,label:this._supplier || '未填写商家'});
    this.setData({merchantOptions:this._merchants.map(m=>m.label),merchantIndex:Math.max(0,this._merchants.findIndex(m=>m.supplier===this._supplier))});
  },
  scopedMerchantCount() {
    if(!Array.isArray(this._merchantSummaries))return null;
    return new Set(this._merchantSummaries.filter(m=>(this._supplier===undefined || m.supplier===this._supplier) && (this.data.scope==='confirmed'?m.confirmed:m.total)>0).map(m=>m.supplier)).size;
  },
  merchant(e) {
    if(this._exporting || this.data.loading)return;
    const selected=this._merchants[Number(e.detail.value)];if(!selected)return;
    this._supplier=selected.supplier;this._file=null;this.setData({merchantIndex:Number(e.detail.value),supplierLabel:selected.label,supplierScoped:this._supplier!==undefined,fileReady:false,drafts:this.relatedDrafts(session.capture())});return this.refreshPreview();
  },
  async loadMetadata(binding, seq) {
    const metadata = await api.request('/api/export-preview?images=' + (this.data.images ? 'yes' : 'no') + '&audience=' + this.data.audience + '&scope='+this.data.scope+'&'+this.scopeQuery(), { identity: binding });
    if (kit.current(this, binding, seq)) {this._metadata=metadata;metadata.layout=metadata.layout||{fieldSize:10,bodySize:12,chineseFont:"宋体",latinFont:"Times New Roman"};this.setData({previewWidth:metadata.columns.filter(c=>!c.hidden).reduce((n,c)=>n+columnWidth(c),0),previewFieldStyle:'font-size:'+metadata.layout.fieldSize*2+'rpx;color:'+(metadata.layout.fieldColor||'#000000')+';font-family:'+metadata.layout.chineseFont+';',previewBodyStyle:'font-size:'+metadata.layout.bodySize*2+'rpx;color:'+(metadata.layout.bodyColor||'#000000')+';font-family:'+metadata.layout.latinFont+';', templateColumns: metadata.columns.filter(c => !c.hidden).map(c=>Object.assign({},c,{previewWidth:columnWidth(c)})), headerRows: metadata.headerRows.filter(r => r.enabled), documentTitle: metadata.documentTitle, metadataReady: true });}
  },
  async loadPreview(binding, seq) {
    const raw = await api.request('/api/products?' + this.scopeQuery() + '&limit=3&status=' + (this.data.scope === 'confirmed' ? 'confirmed' : 'all'), { identity: binding });
    if(!kit.current(this,binding,seq))return;
    const page = domain.productPage(raw);
    const preview = await Promise.all(page.items.map(async product => {
      const photos = this.data.images ? await store.hydratePhotos(product.photos.slice(0, 1), binding) : [];
      return Object.assign({}, domain.productView(product), { cover: photos[0] && photos[0].path || '',cells:previewCells(this.data.templateColumns,product,this._metadata && this._metadata.layout) });
    }));
    if (!kit.current(this, binding, seq)) return;
    const summary = raw.summary || this.data.summary;
    this.setData({ summary, preview, merchantCount:this.scopedMerchantCount(),exportCount: raw.matchedCount !== undefined ? raw.matchedCount : summary ? (this.data.scope === 'confirmed' ? summary.confirmed : summary.total) : preview.length });
  },
  async refreshPreview() {
    if (!kit.requireLogin(this)) { this.setData({ loading: false, preview: [], drafts: [], project: null, summary: null, error: '' }); return; }
    const seq = kit.start(this);
    this.setData({ loading: true, preview: [], error: '' });
    try { const binding = session.capture(); await this.loadMetadata(binding, seq); if(kit.current(this,binding,seq))await this.loadPreview(binding, seq); }
    catch (e) { if (this._alive && this._seq === seq) kit.message(this, e); }
    finally { if (this._alive && this._seq === seq) this.setData({ loading: false }); }
  },
  toggleColumns() { this.setData({ columnsOpen: !this.data.columnsOpen }); },
  audience(e) { if (!this._exporting) { this._file = null; this.setData({ audience: e.currentTarget.dataset.value, fileReady: false }); return this.refreshPreview(); } },
  scope(e) { if (this._exporting) return; this._file = null; this.setData({ scope: e.currentTarget.dataset.value, fileReady: false }); return this.refreshPreview(); },
  format(e) { if (this._exporting) return; this._file = null; this.setData({ images: e.currentTarget.dataset.value === 'images', fileReady: false }); return this.refreshPreview(); },
  returnToProducts() { wx.switchTab({ url: '/pages/products/index' }); },
  showExportInfo() {kit.info('导出说明','按公司表格设置的列、顺序、表头和字体导出，按商户分工作表。采购数量优先使用填写值，否则根据箱数 × 每箱数量计算；未知值保持空白。内部记录另外包含现场描述、联系信息和评价。草稿与回收站商品不纳入导出。最多500件商品。');},
  resume(e) { const item = this.data.drafts[Number(e.currentTarget.dataset.index)]; if (item) wx.navigateTo({ url: store.drafts.editorUrl(item) }); },
  fileName() {
    const date = this._dateControls && this.data.dateMode==='range' ? this._dateFrom+'至'+this._dateTo:this._date || (this.data.project && this.data.project.date) || domain.chinaLocalDate();
    const task = this._supplier !== undefined ? (this._supplier || '未填写商家') : this._favorites ? '收藏' : this._dateControls ? '看货记录' : (this.data.project && this.data.project.name) || '看货';
    return Array.from(String(task).replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ')).slice(0,Math.min(60,74-date.length)).join('') + '-' + date + '.xlsx';
  },
  async export(e) {
    if (this._exporting || this.data.loading || !this.data.exportCount) return;
    this._exporting = true; this.setData({ exporting: true, error: '' });
    const seq = this._seq;
    try {
      const binding = session.capture(), share = e.currentTarget.dataset.share === 'yes';
      if(this._dateControls && this.data.dateMode==='range')await this.requireRangeSupport(binding);
      if(!kit.current(this,binding,seq))return;
      this.validateDateScope();
      if (this._file && session.valid(this._fileBinding)) {
        await new Promise((resolve, reject) => share && wx.shareFileMessage ? wx.shareFileMessage({ filePath: this._file, fileName: this.fileName(), success: resolve, fail: () => reject(new Error('分享未完成，可再次分享或打开文件')) }) : wx.openDocument({ filePath: this._file, fileType: 'xlsx', showMenu: true, success: resolve, fail: () => { this._file = null; reject(new Error('文件已失效，请重新导出')); } }));
        return;
      }
      await store.exportProject(binding, this._projectId, e.currentTarget.dataset.share === 'yes', { onFileReady: path => { if (kit.current(this,binding,seq)) { this._file = path; this._fileBinding = binding; this.setData({ fileReady: true, fileName: this.fileName() }); } }, audience: this.data.audience, scope: this.data.scope, images: this.data.images, supplier: this._supplier, date: this._date, dateFrom:this._dateFrom,dateTo:this._dateTo,favorite: this._favorites, fileName: this.fileName() }); }
    catch (err) { if (this._alive && this._seq === seq) kit.message(this, err); }
    finally { this._exporting = false; if (this._alive) this.setData({ exporting: false }); }
  }
}));
