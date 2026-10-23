const api = require('../../utils/api');
const session = require('../../utils/session');
const kit = require('../../utils/page-kit');
const required = ['sku', 'cartons', 'pcsPerCarton', 'quantity', 'unitPrice', 'amount'];
const fonts = ['Times New Roman', '宋体', 'Arial', 'Calibri', '黑体', '微软雅黑'];
const coreHeaders = ['company', 'companyEnglish', 'address', 'contact', 'documentTitle'];
const aligns = ['左对齐', '居中', '右对齐'], alignValues = ['left', 'center', 'right'];
const optionSets = { alignment: alignValues, orientation: ['portrait', 'landscape'], paper: ['A4', 'Letter'], printMode: ['fit', 'scale'], border: ['none', 'thin', 'medium'] };
function numeric(value) { return value === '' ? '' : Number(value); }
function draftKey(owner) { return 'huoji.tableSettingsDraft.v1.' + encodeURIComponent(owner); }
function snapshot(form, fields) { return Object.assign({}, form, { columns: fields.map(({ key, label, enabled, width }) => ({ key, label, enabled, width })) }); }
function settingValues(form) {
  const names = { company: '公司名', companyEnglish: '英文公司名', address: '地址', contact: '联系方式', documentTitle: '单据标题', paymentTerms: '付款方式', shippingMark: '唛头', packingRequirements: '包装要求', columns: '列', customFields: '扩展列', layout: '版式', headerRows: '表头行', label: '名称', text: '内容', enabled: '显示', width: '列宽', font: '字体', size: '字号', height: '行高', bold: '加粗', align: '对齐', latinFont: '西文字体', chineseFont: '中文字体', fieldSize: '字段字号', bodySize: '内容字号', totalSize: '合计字号', fieldHeight: '字段行高', bodyHeight: '商品行高', multiImageHeight: '多图行高', alignment: '内容对齐', border: '边框', orientation: '方向', paper: '纸张', printMode: '缩放方式', headerSpan: '表头跨列', moneyDecimals: '金额小数', volumeDecimals: '体积小数', scale: '比例', repeatHeader: '重复表头' };
  const values = {};
  function walk(value, path, name) {
    if (Array.isArray(value)) {
      values[path + '.order'] = { name: name + '顺序', value: value.map(row => row.key) };
      value.forEach(row => walk(row, path + '.' + row.key, name + ' · ' + (row.label || row.key)));
    } else if (value && typeof value === 'object') Object.keys(value).forEach(key => { if (key !== 'version') walk(value[key], path + '.' + key, (name ? name + ' · ' : '') + (names[key] || key)); });
    else values[path] = { name, value };
  }
  walk(form, '', ''); return values;
}
function settingDifferences(local, latest) {
  const a = settingValues(local), b = settingValues(latest);
  const display = value => value === undefined || value === null || value === '' ? '未填' : typeof value === 'boolean' ? value ? '是' : '否' : Array.isArray(value) ? value.join(' → ') : String(value);
  return [...new Set(Object.keys(a).concat(Object.keys(b)))].filter(key => JSON.stringify(a[key] && a[key].value) !== JSON.stringify(b[key] && b[key].value)).map(key => ({ key, name: (a[key] || b[key]).name, local: display(a[key] && a[key].value), latest: display(b[key] && b[key].value) }));
}
function location(key, index, custom) {
  if (coreHeaders.includes(key) || ['content', 'label', 'size', 'height', 'font', 'align', 'bold', 'enabled'].includes(key)) return { group: 'header', key, index };
  if (['paymentTerms', 'shippingMark', 'packingRequirements'].includes(key)) return { group: 'requirements', key };
  if (['latinFont', 'chineseFont', 'fieldSize', 'bodySize', 'totalSize', 'fieldColor', 'bodyColor', 'totalColor'].includes(key)) return { group: 'style', key };
  return { group: custom === undefined ? 'print' : 'columns', key, index, custom };
}
function invalidSetting(form, fields) {
  const fail = (message, target) => Object.assign({ message }, target);
  for (const [key, max] of [['company', 200], ['companyEnglish', 200], ['address', 500], ['contact', 200], ['documentTitle', 120], ['paymentTerms', 500], ['shippingMark', 500], ['packingRequirements', 2000]]) {
    if (typeof form[key] !== 'string' || form[key].trim().length > max || (key === 'documentTitle' && !form[key].trim())) return fail(key === 'documentTitle' ? '请填写单据标题（最多120字）' : '内容超过允许长度，请缩短后保存', location(key));
  }
  for (const [index, row] of form.layout.headerRows.entries()) {
    const target = { group: 'header', index };
    if (!row.label || !row.label.trim() || row.label.trim().length > 40 || (row.text || '').length > 500) return fail('请检查表头行名称与内容长度', target);
    if (!fonts.includes(row.font) || !alignValues.includes(row.align) || typeof row.size !== 'number' || row.size < 6 || row.size > 40 || !Number.isFinite(row.size) || typeof row.height !== 'number' || !Number.isFinite(row.height) || row.height < 10 || row.height > 120 || row.height < row.size * 1.15) return fail('表头字号须为6–40 pt，行高须为10–120 pt且至少为字号的1.15倍', Object.assign({ key: 'size' }, target));
    if (row.key === 'documentTitle' && !row.enabled) return fail('请保留单据标题行', target);
  }
  const labels = new Set();
  for (const [custom, entries] of [[false, fields], [true, form.customFields]]) {
    for (const [index, field] of entries.entries()) {
      const target = { group: 'columns', index, custom };
      if (typeof field.label !== 'string' || !field.label.trim() || field.label.trim().length > 80) return fail('列名称须为1–80字', target);
      if ((custom || field.width !== undefined) && (typeof field.width !== 'number' || !Number.isFinite(field.width) || field.width < 5 || field.width > 80)) return fail('列宽须为5–80', target);
      if (field.enabled || custom) { const label = field.label.trim(); if (labels.has(label)) return fail('显示列的名称不能重复', target); labels.add(label); }
      if (!custom && required.includes(field.key) && !field.enabled) return fail('采购核心列必须保留', target);
    }
  }
  const limits = { fieldSize: [8, 20], bodySize: [8, 20], totalSize: [8, 20], headerSpan: [0, 30, true], fieldHeight: [15, 100], bodyHeight: [40, 300], multiImageHeight: [60, 409], moneyDecimals: [0, 6, true], volumeDecimals: [0, 6, true], scale: [10, 100, true] };
  for (const key of Object.keys(limits)) {
    const value = form.layout[key], [min, max, integer] = limits[key];
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value)))) return fail('请将' + ({ fieldSize: '表头字号', bodySize: '内容字号', totalSize: '合计字号', headerSpan: '表头跨列', fieldHeight: '字段行高', bodyHeight: '商品行高', multiImageHeight: '多图行高', moneyDecimals: '金额小数', volumeDecimals: '体积小数', scale: '打印比例' }[key]) + '设为' + min + '–' + max + (integer ? '的整数' : ''), location(key));
  }
  if (form.layout.fieldHeight < form.layout.fieldSize * 1.2 || form.layout.multiImageHeight < form.layout.bodyHeight) return fail('请增大字段行高，且多图行高不能小于商品行高', { group: 'print' });
  for (const key of ['latinFont', 'chineseFont']) if (!fonts.includes(form.layout[key])) return fail('请选择有效字体', location(key));
  return null;
}
Page(kit.protectedPage({
  data: { form: null, loading: false, saving: false, error: '', fields: [], headerRows: [], activeHeader: 0, fonts, aligns, advanced: false, activeGroup: 'header', groups: [{ key: 'header', label: '表头' }, { key: 'columns', label: '列与扩展' }, { key: 'style', label: '字体' }, { key: 'print', label: '版式' }, { key: 'requirements', label: '采购要求' }], headerEditing: false, headerStyleOpen: false, activeColumn: '', columnEditor: null, activeCustom: '', customEditor: null, previewOpen: true, dirty: false, draftNotice: '', hasOldDraft: false, settingsNeedsReview: false, settingsReview: null, previewColumns: [], previews: [], borderLabels: ['无边框', '细边框', '中等边框'], orientationLabels: ['纵向', '横向'], printLabels: ['适应一页宽', '按比例打印'], paperLabels: ['A4', 'Letter'] },
  async useReferenceColumns(){
    if(this._saving || !this.data.form)return;
    if(!(await kit.confirm('采用示例列','将列名称、顺序和显示范围设为示例表格；保留公司信息、字体、版式和扩展列。保存后生效。')))return;
    if(!this._alive || !session.valid(this._binding))return;
    const order=['sku','cartons','pcsPerCarton','quantity','unitPrice','amount','description','image','cartonCbm','cbm','barcode','supplier','decision','currency'];
    const labels={sku:'REF.',cartons:'CTNS（箱数）',pcsPerCarton:'PCS/ CTN',quantity:'QUANTITY(数量）',unitPrice:'PRICE (价格RMB)',amount:'AMOUNT (RMB总金额)',description:'备注',image:'图片',cartonCbm:'体积',cbm:'总体积(m³)',barcode:'条码号'};
    const fields=order.map(key=>Object.assign({},this.data.fields.find(c=>c.key===key),{label:labels[key] || this.data.fields.find(c=>c.key===key).label,enabled:Object.prototype.hasOwnProperty.call(labels,key)}));
    this._dirty=true;this.setData({fields,dirty:true,activeColumn:''});this.changed();this.persistDraft();
  },
  onShow() {
    this._alive = true;
    const info = session.info();
    if (!info || (this._owner && info.user.id !== this._owner)) { this._dirty = false; this.setData({ form: null, fields: [], headerRows: [], previews: [], previewColumns: [], rowEditor: null, columnEditor: null, customEditor: null, activeHeader: 0, activeColumn: '', activeCustom: '', headerEditing: false, headerStyleOpen: false, previewOpen: true, advanced: false, activeGroup: 'header', dirty: false, draftNotice: '', hasOldDraft: false, settingsNeedsReview: false, settingsReview: null }); this._oldDraft = null; this._settingsReview = null; }
    if (!this._saving && !this._picking && !this._dirty) this.load();
  },
  onHide() { this.persistDraft(); kit.stop(this); }, onUnload() { this.persistDraft(); this._unloaded = true; kit.stop(this); },
  persistDraft() {
    const owner = this._binding && this._binding.owner;
    if (!this._dirty || !this.data.form || !owner || (this._owner && this._owner !== owner) || this.data.form.version !== this._version) return;
    try { wx.setStorageSync(draftKey(owner), { schema: 1, owner, version: this._version, form: snapshot(this.data.form, this.data.fields) }); }
    catch (_) { if (this._alive) { this.setData({ draftNotice: '本机草稿保存失败，请保持页面打开并保存设置' }); kit.toast('本机草稿保存失败'); } }
  },
  restoreDraft(binding, serverForm) {
    let draft;
    try { draft = wx.getStorageSync(draftKey(binding.owner)); } catch (_) { this.setData({ draftNotice: '本机草稿暂时无法读取，当前显示已保存设置' }); return; }
    if (!draft) return;
    if (draft.schema !== 1 || draft.owner !== binding.owner || !draft.form || draft.form.version !== draft.version || !Number.isInteger(draft.version) || !Array.isArray(draft.form.columns) || !Array.isArray(draft.form.customFields) || !draft.form.layout || !Array.isArray(draft.form.layout.headerRows) || !draft.form.layout.headerRows.length || !draft.form.columns.every(c => c && typeof c.key === 'string') || !draft.form.customFields.every(c => c && typeof c.key === 'string') || !draft.form.layout.headerRows.every(row => row && typeof row.key === 'string' && typeof row.label === 'string')) { this.setData({ draftNotice: '本机草稿格式异常，当前显示已保存设置' }); return; }
    if (draft.version !== serverForm.version) { this._oldDraft = draft; this.setData({ hasOldDraft: true, draftNotice: '已保存设置版本已更新，本机旧草稿保留但未自动恢复' }); return; }
    this._dirty = true;
    this.setData({ form: draft.form, fields: draft.form.columns.map(c => Object.assign({}, c, { required: required.includes(c.key) })), draftNotice: '已恢复本机未保存设置，点击保存后才会更新模板' });
  },
  clearDraft(binding, submitted) {
    try { const key = draftKey(binding.owner), draft = wx.getStorageSync(key); if (draft && draft.owner === binding.owner && draft.version === submitted.version && JSON.stringify(draft.form) === JSON.stringify(submitted)) wx.removeStorageSync(key); } catch (_) { if (this._alive) this.setData({ draftNotice: '设置已保存，本机草稿清理失败' }); }
  },
  async readLatest(binding, seq) {
    const latest = await api.request('/api/procurement-template', { identity: binding });
    session.assert(binding);
    if (!kit.current(this, binding, seq)) return null;
    if (!latest || !Number.isInteger(latest.version) || !latest.layout || !Array.isArray(latest.columns)) throw new Error('最新设置读取不完整，请重试核对');
    this._latestForm = latest; return latest;
  },
  async reviewLatest() { return this.reviewSettings(false); },
  async restoreOldDraft() { return this.reviewSettings(true); },
  async reviewSettings(oldDraft) {
    if (this._saving || !this.data.form || (oldDraft && !this._oldDraft)) return;
    this._saving = true; this.setData({ saving: true, error: '', settingsReview: null });
    const binding = this._binding, seq = this._seq, current = JSON.stringify(snapshot(this.data.form, this.data.fields));
    try {
      session.assert(binding);
      const local = oldDraft ? this._oldDraft.form : snapshot(this.data.form, this.data.fields);
      const latest = await this.readLatest(binding, seq);
      if (!latest || current !== JSON.stringify(snapshot(this.data.form, this.data.fields))) return;
      this._settingsReview = { binding, seq, current, local, latest, oldDraft };
      this.setData({ settingsReview: { oldDraft, version: latest.version, rows: settingDifferences(local, latest) }, draftNotice: oldDraft ? '核对旧草稿与当前设置，确认后恢复到本机' : '核对本机与最新设置，确认后保留本机内容并采用最新版本' });
    } catch (e) { if (kit.current(this, binding, seq)) kit.message(this, e); }
    finally { this._saving = false; if (this._alive && this._seq === seq) this.setData({ saving: false }); }
  },
  async acceptLatest() {
    const review = this._settingsReview;
    if (this._saving || !this.data.settingsReview || !review) return;
    this._saving = true; this.setData({ saving: true });
    try {
      session.assert(review.binding);
      if (!kit.current(this, review.binding, review.seq)) return;
      const confirmed = await kit.confirm(review.oldDraft ? '确认恢复旧草稿' : '确认采用最新版本', '已核对上方全部差异。' + (review.oldDraft ? '旧草稿将替换当前页内容，' : '保留本机全部设置，') + '采用服务器版本 ' + review.latest.version + '。之后仍需点击保存设置才会提交。');
      session.assert(review.binding);
      if (!confirmed || !kit.current(this, review.binding, review.seq)) return;
      if (review.current !== JSON.stringify(snapshot(this.data.form, this.data.fields))) { this.setData({ settingsReview: null }); throw new Error('本机内容已变化，请重新核对'); }
      const form = Object.assign({}, review.local, { version: review.latest.version });
      this._version = form.version; this._dirty = true; this._oldDraft = null; this._settingsReview = null;
      this.setData({ form, fields: form.columns.map(c => Object.assign({}, c, { required: required.includes(c.key) })), settingsNeedsReview: false, settingsReview: null, hasOldDraft: false, error: '', draftNotice: review.oldDraft ? '旧草稿已恢复到本机，请保存设置' : '已采用最新版本并保留本机内容，请保存设置' });
      this.refresh(); this.persistDraft();
    } catch (e) { if (kit.current(this, review.binding, review.seq)) kit.message(this, e); }
    finally { this._saving = false; if (this._alive && this._seq === review.seq) this.setData({ saving: false }); }
  },
  showSettingError(error, target) {
    if (!target) target = /表头行|标题行/.test(error.message || '') ? { group: 'header', index: 0 } : /扩展|列|字段名称/.test(error.message || '') ? { group: 'columns' } : /行高|小数|打印/.test(error.message || '') ? { group: 'print' } : this._lastLocation;
    if (target) {
      const patch = { activeGroup: target.group };
      if (target.group === 'header') { patch.activeHeader = target.index === undefined ? Math.max(0, this.data.headerRows.findIndex(row => row.key === target.key)) : target.index; patch.headerEditing = true; patch.headerStyleOpen = !coreHeaders.includes(target.key); }
      if (target.group === 'columns' && target.index !== undefined) { const field = (target.custom ? this.data.form.customFields : this.data.fields)[target.index]; if (field) { patch.activeColumn = target.custom ? '' : field.key; patch.activeCustom = target.custom ? field.key : ''; } }
      if (target.group === 'print') patch.advanced = true;
      this.setData(patch); this.refresh();
    }
    kit.message(this, error);
    if (typeof wx.pageScrollTo === 'function') wx.pageScrollTo({ selector: '#settings-error', duration: 200 });
  },
  async importReference() {
    if (this._saving || this.data.loading) return;
    this._saving = true; this._picking = true; this.setData({ saving: true, error: '' });
    try {
      const binding = session.capture();
      const file = await new Promise((resolve, reject) => wx.chooseMessageFile({ count: 1, type: 'file', extension: ['xlsx'], success: res => resolve(res.tempFiles[0]), fail: e => reject(Object.assign(new Error('未选择文件'), { cancelled: /cancel/.test(e.errMsg || '') })) }));
      this._picking = false; if (this._unloaded) return; this._alive = true; session.assert(binding);
      if (!file || !/\.xlsx$/i.test(file.name || '') || file.size > 40 * 1024 * 1024) throw new Error('请选择40MB以内的 .xlsx 文件');
      const form = await api.uploadWorkbook(file.path, binding, true); session.assert(binding);
      if (this._unloaded || !this._alive) return;
      this._binding = binding; this._owner = binding.owner; this._version = form.version;
      this.setData({ form, fields: form.columns.map(c => Object.assign({}, c, { required: required.includes(c.key) })), activeHeader: 0 }); this.changed();
    } catch (e) { if (!e.cancelled) kit.message(this, e); }
    finally { this._picking = false; this._saving = false; if (this._alive) this.setData({ saving: false }); }
  },
  async load() {
    if (!kit.requireLogin(this)) return;
    const seq = kit.start(this); this._oldDraft = null; this._settingsReview = null; this.setData({ loading: true, error: '', draftNotice: '', hasOldDraft: false, settingsNeedsReview: false, settingsReview: null });
    try {
      const binding = session.capture(); this._binding = binding;
      if (this._owner !== binding.owner) { this._owner = binding.owner; this.setData({ form: null, fields: [] }); }
      const form = await api.request('/api/procurement-template', { identity: binding });
      if (!kit.current(this, binding, seq)) return;
      this._version = form.version; this._dirty = false; this._latestForm = form;
      this.setData({ form, fields: form.columns.map(c => Object.assign({}, c, { required: required.includes(c.key) })) }); this.restoreDraft(binding, form); this.refresh();
    } catch (e) { if (this._alive && this._seq === seq) { if (!session.info()) this.setData({ form: null, fields: [], previews: [] }); kit.message(this, e); } }
    finally { if (this._alive && this._seq === seq) this.setData({ loading: false }); }
  },
  refresh() {
    const f = this.data.form; if (!f) return;
    const headerRows = f.layout.headerRows.map((row, i) => Object.assign({}, row, { index: i, content: coreHeaders.includes(row.key) ? f[row.key] : row.text, fontIndex: fonts.indexOf(row.font), alignIndex: alignValues.indexOf(row.align), removable: !coreHeaders.includes(row.key) }));
    const previews = headerRows.filter(row => row.enabled).map(row => Object.assign({}, row, { previewText: row.content || row.label, previewStyle: 'font-family:' + row.font + ';color:' + (row.color || '#000000') + ';font-size:' + (row.size * 1.5) + 'rpx;text-align:' + row.align + ';font-weight:' + (row.bold ? '700' : '400') + ';min-height:' + Math.max(24, row.height * 1.5) + 'rpx;' }));
    const fields = this.data.fields.map(field => Object.assign({}, field, { widthText: field.width === '' ? '' : Math.round(field.width * 100) / 100 }));
    const columns = fields.filter(c => c.enabled).concat(f.customFields);
    this.setData({ fields, headerRows, previews, dirty: !!this._dirty, previewColumns: columns.map(c => Object.assign({}, c, { previewWidth: Math.max(88, c.width * 9), previewValue: ({image:'',supplier:'义乌商户',sku:'YW-018',decision:'待核对',cartons:'10',pcsPerCarton:'48',quantity:'480',unitPrice:'12.00',currency:'CNY',amount:'5,760.00',cartonCbm:'0.036',cbm:'0.360',description:'陶瓷杯 · 白色',barcode:'6900000018'})[c.key] || '—' })), previewCount: columns.length, previewTableWidth: Math.max(560, columns.reduce((n,c) => n + Math.max(88, c.width * 9), 0)), previewFieldStyle: 'color:' + (f.layout.fieldColor || '#000000') + ';font-family:' + f.layout.chineseFont + ';font-size:' + (f.layout.fieldSize * 1.5) + 'rpx;', previewBodyStyle: 'color:' + (f.layout.bodyColor || '#000000') + ';font-family:' + f.layout.latinFont + ';font-size:' + (f.layout.bodySize * 1.5) + 'rpx;', previewTotalStyle: 'color:' + (f.layout.totalColor || '#000000') + ';font-size:' + (f.layout.totalSize * 1.5) + 'rpx;', rowEditor: headerRows[Math.min(this.data.activeHeader, headerRows.length - 1)], columnEditor: fields.map((field, index) => Object.assign({}, field, { index })).find(field => field.key === this.data.activeColumn) || null, customEditor: f.customFields.map((field, index) => Object.assign({}, field, { index })).find(field => field.key === this.data.activeCustom) || null, latinIndex: fonts.indexOf(f.layout.latinFont), chineseIndex: fonts.indexOf(f.layout.chineseFont), alignmentIndex: alignValues.indexOf(f.layout.alignment), borderIndex: optionSets.border.indexOf(f.layout.border), orientationIndex: optionSets.orientation.indexOf(f.layout.orientation), paperIndex: optionSets.paper.indexOf(f.layout.paper), printIndex: optionSets.printMode.indexOf(f.layout.printMode) });
  },
  selectGroup(e) { const key = e.currentTarget.dataset.key; if (this.data.groups.some(group => group.key === key)) this.setData({ activeGroup: key }); },
  togglePreview() { this.setData({ previewOpen: !this.data.previewOpen }); },
  toggleHeaderStyle() { this.setData({ headerStyleOpen: !this.data.headerStyleOpen }); },
  closeHeader() { this.setData({ headerEditing: false, headerStyleOpen: false }); },
  selectColumn(e) { const key = e.currentTarget.dataset.key; if (this.data.fields.some(field => field.key === key)) { this.setData({ activeColumn: this.data.activeColumn === key ? '' : key, activeCustom: '' }); this.refresh(); } },
  selectCustom(e) { const key = e.currentTarget.dataset.key; if (this.data.form.customFields.some(field => field.key === key)) { this.setData({ activeCustom: this.data.activeCustom === key ? '' : key, activeColumn: '' }); this.refresh(); } },
  changed() { this._dirty = true; this._settingsReview = null; this.setData({ settingsReview: null }); this.refresh(); },
  input(e) { const key = e.currentTarget.dataset.key; if (!this._saving && ['company', 'companyEnglish', 'address', 'contact', 'documentTitle', 'paymentTerms', 'shippingMark', 'packingRequirements'].includes(key)) { this._lastLocation = location(key); this.setData({ ['form.' + key]: e.detail.value }); this.changed(); } },
  selectHeader(e) { const index = Number(e.currentTarget.dataset.index); if (!this.data.headerRows[index]) return; this.setData({ activeHeader: index, activeGroup: 'header', headerEditing: true, headerStyleOpen: false }); this.refresh(); },
  headerInput(e) {
    if (this._saving) return;
    const index = this.data.activeHeader, key = e.currentTarget.dataset.key, row = this.data.form.layout.headerRows[index]; this._lastLocation = location(key, index);
    if (key === 'content') {
      if (coreHeaders.includes(row.key)) this.setData({ ['form.' + row.key]: e.detail.value });
      else this.setData({ 'form.layout.headerRows': this.data.form.layout.headerRows.map((r, i) => i === index ? Object.assign({}, r, { text: e.detail.value }) : r) });
    } else if (['label', 'size', 'height'].includes(key)) this.setData({ 'form.layout.headerRows': this.data.form.layout.headerRows.map((r, i) => i === index ? Object.assign({}, r, { [key]: key === 'label' ? e.detail.value : numeric(e.detail.value) }) : r) });
    this.changed();
  },
  headerSlide(e) {
    if (this._saving) return;
    const key = e.currentTarget.dataset.key, index = this.data.activeHeader;
    if (!['size', 'height'].includes(key)) return;
    const value = Number(e.detail.value), row = this.data.form.layout.headerRows[index];
    if (!Number.isFinite(value) || !row) return;
    const next = Object.assign({}, row, { [key]: value });
    next.height = Math.max(next.height, Math.ceil(next.size * 1.15 * 100) / 100);
    this.setData({ 'form.layout.headerRows': this.data.form.layout.headerRows.map((r,i) => i === index ? next : r) }); this.changed();
  },
  layoutSlide(e) {
    if (this._saving) return;
    const key = e.currentTarget.dataset.key, value = Number(e.detail.value);
    if (!['fieldSize','bodySize','totalSize','fieldHeight','bodyHeight','multiImageHeight','headerSpan','moneyDecimals','volumeDecimals','scale'].includes(key) || !Number.isFinite(value)) return;
    const next = Object.assign({}, this.data.form.layout, { [key]: value });
    next.fieldHeight = Math.max(next.fieldHeight, Math.ceil(next.fieldSize * 1.2 * 100) / 100);
    next.multiImageHeight = Math.max(next.multiImageHeight, next.bodyHeight);
    this.setData({ 'form.layout': next }); this.changed();
  },
  headerColor(e) {
    if (this._saving || !/^#[0-9a-fA-F]{6}$/.test(e.detail.value)) return;
    this.setData({ 'form.layout.headerRows': this.data.form.layout.headerRows.map((r,i) => i === this.data.activeHeader ? Object.assign({},r,{color:e.detail.value}) : r) }); this.changed();
  },
  layoutColor(e) {
    const key = e.currentTarget.dataset.key;
    if (this._saving || !['fieldColor','bodyColor','totalColor'].includes(key) || !/^#[0-9a-fA-F]{6}$/.test(e.detail.value)) return;
    this.setData({ ['form.layout.' + key]:e.detail.value }); this.changed();
  },
  headerOption(e) {
    if (this._saving) return;
    const key = e.currentTarget.dataset.key, index = this.data.activeHeader; this._lastLocation = location(key, index);
    let value = e.detail.value;
    if (key === 'font') value = fonts[Number(value)]; else if (key === 'align') value = alignValues[Number(value)];
    if (!['font', 'align', 'bold', 'enabled'].includes(key)) return;
    if (key === 'enabled' && this.data.form.layout.headerRows[index].key === 'documentTitle') return;
    this.setData({ 'form.layout.headerRows': this.data.form.layout.headerRows.map((r, i) => i === index ? Object.assign({}, r, { [key]: value }) : r) }); this.changed();
  },
  moveHeader(e) {
    if (this._saving) return;
    const rows = this.data.form.layout.headerRows.slice(), from = this.data.activeHeader, to = from + Number(e.currentTarget.dataset.direction);
    if (to < 0 || to >= rows.length) return;
    [rows[from], rows[to]] = [rows[to], rows[from]]; this.setData({ 'form.layout.headerRows': rows, activeHeader: to }); this.changed();
  },
  addHeader() {
    if (this._saving || this.data.form.layout.headerRows.length >= 8) return;
    const rows = this.data.form.layout.headerRows.concat({ key: 'header_' + Date.now().toString(36), label: '补充信息', text: '', enabled: true, font: this.data.form.layout.chineseFont, size: 11, bold: false, align: 'center', height: 18 });
    this.setData({ 'form.layout.headerRows': rows, activeHeader: rows.length - 1, headerEditing: true, headerStyleOpen: false }); this.changed();
  },
  removeHeader() { if (this._saving || !this.data.rowEditor.removable) return; this.setData({ 'form.layout.headerRows': this.data.form.layout.headerRows.filter((_, i) => i !== this.data.activeHeader), activeHeader: 0, headerEditing: false, headerStyleOpen: false }); this.changed(); },
  layoutInput(e) { const key = e.currentTarget.dataset.key; if (!this._saving && ['fieldSize', 'fieldHeight', 'bodySize', 'bodyHeight', 'multiImageHeight', 'totalSize', 'moneyDecimals', 'volumeDecimals', 'headerSpan', 'scale'].includes(key)) { this._lastLocation = location(key); this.setData({ ['form.layout.' + key]: numeric(e.detail.value) }); this.changed(); } },
  layoutOption(e) {
    if (this._saving) return;
    const key = e.currentTarget.dataset.key; this._lastLocation = location(key);
    const value = key === 'repeatHeader' ? e.detail.value : ['latinFont', 'chineseFont'].includes(key) ? fonts[Number(e.detail.value)] : optionSets[key] && optionSets[key][Number(e.detail.value)];
    if (value === undefined) return; this.setData({ ['form.layout.' + key]: value }); this.changed();
  },
  toggleAdvanced() { this.setData({ advanced: !this.data.advanced }); },
  columnName(e) { this.columnUpdate(e, 'label', e.detail.value); },
  columnWidth(e) { this.columnUpdate(e, 'width', numeric(e.detail.value)); },
  columnEnabled(e) { this.columnUpdate(e, 'enabled', e.detail.value); },
  columnUpdate(e, key, value) {
    if (this._saving) return;
    const index = Number(e.currentTarget.dataset.index); this._lastLocation = { group: 'columns', index, custom: false };
    this.setData({ fields: this.data.fields.map((field, i) => i === index && !(key === 'enabled' && field.required) ? Object.assign({}, field, { [key]: value }) : field) }); this.changed();
  },
  moveColumn(e) {
    if (this._saving) return;
    const fields = this.data.fields.slice(), from = Number(e.currentTarget.dataset.index), to = from + Number(e.currentTarget.dataset.direction);
    if (to < 0 || to >= fields.length) return;
    [fields[from], fields[to]] = [fields[to], fields[from]]; this.setData({ fields }); this.changed();
  },
  addCustom() { if (!this._saving && this.data.form.customFields.length < 8) { const key = 'custom_' + Date.now().toString(36); this.setData({ 'form.customFields': this.data.form.customFields.concat({ key, label: '', width: 20 }), activeCustom: key, activeColumn: '' }); this.changed(); } },
  customName(e) { this.customUpdate(e, 'label', e.detail.value); }, customWidth(e) { this.customUpdate(e, 'width', numeric(e.detail.value)); },
  customUpdate(e, key, value) { if (this._saving) return; const index = Number(e.currentTarget.dataset.index); this._lastLocation = { group: 'columns', index, custom: true }; this.setData({ 'form.customFields': this.data.form.customFields.map((field, i) => i === index ? Object.assign({}, field, { [key]: value }) : field) }); this.changed(); },
  moveCustom(e) {
    if (this._saving) return;
    const fields = this.data.form.customFields.slice(), from = Number(e.currentTarget.dataset.index), to = from + Number(e.currentTarget.dataset.direction);
    if (to < 0 || to >= fields.length) return;
    [fields[from], fields[to]] = [fields[to], fields[from]]; this.setData({ 'form.customFields': fields }); this.changed();
  },
  removeCustom(e) { if (!this._saving) { this.setData({ 'form.customFields': this.data.form.customFields.filter((_, i) => i !== Number(e.currentTarget.dataset.index)), activeCustom: '' }); this.changed(); } },
  async save() {
    if (this._saving || !this.data.form) return;
    if (this.data.settingsNeedsReview) { kit.message(this, new Error('请先核对最新设置并确认版本')); return; }
    const invalid = invalidSetting(this.data.form, this.data.fields);
    if (invalid) { this.showSettingError(new Error(invalid.message), invalid); return; }
    this._saving = true; this.setData({ saving: true, error: '' }); const seq = this._seq;
    try {
      session.assert(this._binding); const binding = this._binding;
      const submitted = snapshot(this.data.form, this.data.fields); this.persistDraft();
      const fields = Object.assign({}, submitted); delete fields.version;
      const form = await api.request('/api/procurement-template', { method: 'POST', identity: binding, data: { version: this._version, fields } });
      session.assert(binding); this.clearDraft(binding, submitted); this._version = form.version; this._dirty = false;
      if (kit.current(this, binding, seq)) { this._oldDraft = null; this._settingsReview = null; this.setData({ form, draftNotice: '', hasOldDraft: false, settingsNeedsReview: false, settingsReview: null }); this.refresh(); kit.toast('表格设置已保存'); }
    } catch (e) {
      if (this._alive && this._seq === seq) {
        if (e.code === 'CONFLICT') {
          this.setData({ settingsNeedsReview: true, settingsReview: null, draftNotice: '设置版本已更新，本机修改已保留，请核对最新设置' });
          try { await this.readLatest(this._binding, seq); } catch (readError) { if (this._alive && this._seq === seq) kit.message(this, readError); }
          if (this._alive && this._seq === seq) kit.message(this, new Error('请核对最新设置并确认版本后再保存'));
        } else this.showSettingError(e);
      }
    }
    finally { this._saving = false; if (this._alive) this.setData({ saving: false }); }
  }
}));
