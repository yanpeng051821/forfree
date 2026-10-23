const api = require('../../utils/api');
const session = require('../../utils/session');
const kit = require('../../utils/page-kit');
const store = require('../../utils/store');
const decisions = ['待核对', '计入', '取消'];
function number(value, label, integer, positive) {
  if (value === '' || value === null || value === undefined) return null;
  if (!/^\d+(?:\.\d+)?$/.test(String(value))) throw new Error(label + '请填写数字');
  const result = Number(value);
  if (!Number.isFinite(result) || (integer && !Number.isInteger(result)) || (positive && result <= 0)) throw new Error(label + '数值无效');
  return result;
}
function editFields(line, template) {
  const text = value => value === null || value === undefined ? '' : String(value);
  return { form: { cartons: text(line.cartons), pcsPerCarton: text(line.pcsPerCarton), quantity: text(line.recordedQuantity), unitPrice: text(line.unitPrice), cartonCbm: text(line.cartonCbm), note: line.note || '' }, decisionIndex: ['pending', 'include', 'cancel'].indexOf(line.decision), customInputs: (template && template.customFields || []).map(field => Object.assign({}, field, { value: text(line.custom && line.custom[field.key]) })) };
}
function reviewValue(value) { return value === undefined || value === null || value === '' ? '未填' : String(value); }
function reviewRow(key, name, local, latest) { return { key, name, local: reviewValue(local), latest: reviewValue(latest), changed: reviewValue(local) !== reviewValue(latest) }; }
function quantitySupported(line) { return !!line && Object.prototype.hasOwnProperty.call(line, 'recordedQuantity'); }
Page(kit.protectedPage({
  data: { records: [], doc: null, lines: [], supplierNames: ['全部商户'], supplierIndex: 0, filters: ['全部商品', '待核对', '已计入', '已取消'], filterIndex: 0, query: '', limit: 20, matched: 0, loading: false, busy: false, error: '', editing: null, form: {}, decisions, decisionIndex: 0, freightEditing: null, freight: '', suppliersOpen: false, optionsOpen: false, lineDetailsOpen: false, supplierPending: 0, expandedLine: '', customInputs: [], sourceTask: null, sourceNotice: '', sourceUnsupported: false, retainedCount: 0, editNotice: '', editNeedsReview: false, editReview: null, quantityPreview: '待填写', amountPreview: '待补全' },
  onLoad(options) { this._id = options.id || ''; this._projectId = options.projectId || ''; this._covers = {}; this._retainedEdits = {}; },
  onShow() {
    this._alive = true;
    const info = session.info();
    if (!info || (this._owner && info.user.id !== this._owner)) {
      this._id = ''; this._projectId = ''; this._doc = null; this._covers = {}; this._retainedEdits = {}; this._converted = false; this._editInitial = '';
      this.setData({ doc: null, lines: [], records: [], editing: null, freightEditing: null, form: {}, customInputs: [], freight: '', suppliersOpen: false, optionsOpen: false, lineDetailsOpen: false, expandedLine: '', sourceTask: null, sourceNotice: '', sourceUnsupported: false, retainedCount: 0, editNotice: '', editNeedsReview: false, editReview: null, quantityPreview: '待填写', amountPreview: '待补全' });
    }
    if (!this._busy && !this._picking && !this.data.editing && !this.data.freightEditing) this.load();
  }, onHide() { this.retainEdit(); kit.stop(this); }, onUnload() { this._unloaded = true; kit.stop(this); },
  async loadSource(binding, seq, projectId) {
    const projects = await api.request('/api/projects', { identity: binding });
    if (!kit.current(this, binding, seq)) return null;
    const project = projects.find(item => item.id === projectId);
    this.setData({ sourceTask: project ? { id: project.id, name: project.name, count: project.summary && project.summary.total !== undefined ? project.summary.total : null } : null, sourceNotice: project ? '' : '请先选择当前看货任务' });
    return project;
  },
  exportSource() {
    if (this._busy || this._loading || !this.data.sourceTask) return;
    try { session.capture(); wx.navigateTo({ url: '/pages/export/index?projectId=' + encodeURIComponent(this.data.sourceTask.id) }); } catch (e) { kit.message(this, e); }
  },
  retry() { return this.load(); },
  async load() {
    if (!kit.requireLogin(this)) return;
    if (this._loading) return;
    this._loading = true; let converting = false;
    const seq = kit.start(this);
    this.setData({ loading: true, error: '' });
    try {
      const binding = session.capture();
      if (this._owner !== binding.owner) { if (this._owner) { this._id = ''; this._projectId = ''; this._doc = null; } this._owner = binding.owner; this._covers = {}; this.setData({ doc: null, lines: [], records: [], editing: null, freightEditing: null }); }
      if (this._projectId && !this._converted) {
        converting = true; this.setData({ sourceUnsupported: false });
        await this.loadSource(binding, seq, this._projectId);
        if (!kit.current(this, binding, seq)) return;
        const doc = await api.request('/api/procurement/from-project', { method: 'POST', identity: binding, data: { projectId: this._projectId } });
        if (!kit.current(this, binding, seq)) return;
        this._id = doc.id; this.accept(doc); this._converted = true;
      } else if (this._id) {
        const doc = await api.request('/api/procurement/' + this._id, { identity: binding });
        if (!kit.current(this, binding, seq)) return; this.accept(doc);
      } else {
        const records = await api.request('/api/procurement', { identity: binding });
        if (!kit.current(this, binding, seq)) return;
        this.setData({ records });
        const projectId = store.activeProject(binding);
        if (projectId) { try { await this.loadSource(binding, seq, projectId); } catch (_) { if (kit.current(this, binding, seq)) this.setData({ sourceTask: null, sourceNotice: '当前任务暂时无法读取，请重试' }); } }
        else this.setData({ sourceTask: null, sourceNotice: '请先选择当前看货任务' });
      }
      await this.covers(binding, seq);
    } catch (e) { if (converting) this._converted = false; if (this._alive && this._seq === seq) { if (e.code === 'CURRENCY_UNSUPPORTED') this.setData({ sourceUnsupported: true }); if (!session.info()) this.setData({ doc: null, lines: [], records: [], editing: null, freightEditing: null }); kit.message(this, e); } }
    finally { this._loading = false; if (this._alive && this._seq === seq) this.setData({ loading: false }); }
  },
  accept(doc) {
    this._id = doc.id; this._doc = doc;
    const currency = doc.summary.currency || (doc.lines.length && doc.lines.every(line => line.currency === doc.lines[0].currency) ? doc.lines[0].currency : '');
    const summary = Object.assign({}, doc.summary, { sourceAmountText: doc.summary.sourceAmount === null ? '未提供' : doc.summary.sourceAmount.toFixed(2), amountText: doc.summary.amount === null ? '待补全' : doc.summary.amount.toFixed(2), currencyText: currency || '多币种 / 待确认' });
    this.setData({ doc: Object.assign({}, doc, { lines: [], summary }), supplierNames: ['全部商户'].concat(doc.suppliers.map(s => s.name)), supplierPending: doc.suppliers.filter(s => s.freight === null).length });
    this.filterLines(); this.refreshRetained();
  },
  filterLines() {
    if (!this._doc) return;
    const supplier = this.data.supplierNames[this.data.supplierIndex];
    const state = ['', 'pending', 'include', 'cancel'][this.data.filterIndex];
    const query = this.data.query.trim().toLowerCase();
    const all = this._doc.lines.filter(line => (!this.data.supplierIndex || line.supplier === supplier) && (!state || line.decision === state) && (!query || [line.sku, line.supplier, line.description, line.note, line.barcode].join(' ').toLowerCase().includes(query)));
    const lines = all.slice(0, this.data.limit).map(line => Object.assign({}, line, { cover: this._covers[line.id] || '', decisionText: decisions[['pending', 'include', 'cancel'].indexOf(line.decision)], priceText: line.unitPrice === null ? '未填' : line.unitPrice.toFixed(2), amountText: line.amount === null ? '待补全' : line.amount.toFixed(2), quantityText: line.quantity === null ? '待填写' : line.quantity, warning: line.warnings.filter(message => !(line.source.startsWith('看货商品 ') && line.cartons !== null && message === '下单箱数待填写，起订量不作为采购数量')).join(' · ') }));
    this.setData({ lines, matched: all.length });
  },
  async covers(binding, seq) {
    const current = this.data.lines;
    await Promise.all(current.filter(line => line.imageUrls[0] && !this._covers[line.id]).map(async line => {
      try { const path = await api.download(line.imageUrls[0], binding); if (kit.current(this, binding, seq)) this._covers[line.id] = path; } catch (_) {}
    }));
    if (kit.current(this, binding, seq)) this.filterLines();
  },
  open(e) { if (this._busy || this._loading) return; this._id = e.currentTarget.dataset.id; this.setData({ editing: null, supplierIndex: 0, filterIndex: 0, query: '', limit: 20, suppliersOpen: false, optionsOpen: false, expandedLine: '' }); this.load(); },
  backList() { if (this._busy || this._loading) return; this._id = ''; this._projectId = ''; this._doc = null; this.setData({ doc: null, lines: [], editing: null, freightEditing: null, suppliersOpen: false, optionsOpen: false, expandedLine: '' }); this.load(); },
  toggleSuppliers() { this.setData({ suppliersOpen: !this.data.suppliersOpen }); },
  toggleOptions() { this.setData({ optionsOpen: !this.data.optionsOpen }); },
  toggleLineDetails() { this.setData({ lineDetailsOpen: !this.data.lineDetailsOpen }); },
  toggleLine(e) { const id = e.currentTarget.dataset.id; if (this.data.lines.some(line => line.id === id)) this.setData({ expandedLine: this.data.expandedLine === id ? '' : id }); },
  async importFile() {
    if (this._busy || this.data.loading) return;
    this._busy = true; this.setData({ busy: true, error: '' });
    try {
      const binding = session.capture();
      this._picking = true;
      const file = await new Promise((resolve, reject) => wx.chooseMessageFile({ count: 1, type: 'file', extension: ['xlsx'], success: res => resolve(res.tempFiles[0]), fail: e => reject(Object.assign(new Error('未选择文件'), { cancelled: /cancel/.test(e.errMsg || '') })) }));
      this._picking = false;
      if (this._unloaded) return;
      this._alive = true;
      session.assert(binding);
      if (!file || !/\.xlsx$/i.test(file.name || '') || file.size > 40 * 1024 * 1024) throw new Error('请选择40MB以内的 .xlsx 文件');
      const doc = await api.uploadWorkbook(file.path, binding);
      session.assert(binding); this._id = doc.id;
      if (this._alive) { this.setData({ supplierIndex: 0, filterIndex: 0, query: '', limit: 20 }); this.accept(doc); await this.covers(binding, this._seq); }
    } catch (e) { if (!e.cancelled) kit.message(this, e); }
    finally { this._picking = false; this._busy = false; if (this._alive) this.setData({ busy: false }); }
  },
  async fromTask() {
    if (this._busy || this.data.loading) return;
    const binding = session.capture(), projectId = store.activeProject(binding);
    if (!projectId) { kit.message(this, new Error('请先在任务中选择本次看货任务')); return; }
    this._projectId = projectId; this._converted = false; this._id = ''; this.setData({ supplierIndex: 0, filterIndex: 0, query: '', limit: 20, suppliersOpen: false, optionsOpen: false, expandedLine: '', sourceUnsupported: false }); await this.load();
  },
  supplier(e) { this.setData({ supplierIndex: Number(e.detail.value), limit: 20 }); this.filterLines(); this.covers(session.capture(), this._seq); },
  status(e) { this.setData({ filterIndex: Number(e.detail.value), limit: 20 }); this.filterLines(); this.covers(session.capture(), this._seq); },
  search(e) { this.setData({ query: e.detail.value, limit: 20 }); this.filterLines(); this.covers(session.capture(), this._seq); },
  more() { this.setData({ limit: this.data.limit + 20 }); this.filterLines(); this.covers(session.capture(), this._seq); },
  edit(e) {
    if (this._busy) return;
    const line = this._doc.lines.find(line => line.id === e.currentTarget.dataset.id);
    if (!line) return;
    this.retainEdit();
    this._editVersion = this._doc.version; this._editReview = null;
    this.setData({ editing: line, quantityEditable: quantitySupported(line), freightEditing: null, lineDetailsOpen: false, ...editFields(line, this._doc.template), error: '' });
    this._editInitial = this.editDigest();
    const retained = this._retainedEdits[this.editKey()];
    if (retained) { this._editVersion = retained.version; this._editInitial = retained.initial; this.setData({ form: retained.form, decisionIndex: retained.decisionIndex, customInputs: retained.customInputs, lineDetailsOpen: retained.lineDetailsOpen }); }
    this.setData({ editNeedsReview: !!(retained && retained.needsReview) || this._editVersion !== this._doc.version, editReview: null, editNotice: retained ? retained.version === this._doc.version ? '已恢复本次未保存调整' : '采购单版本已更新，保留的调整需重新核对后保存' : '' });
    this.refreshCalculation();
  },
  input(e) { const key = e.currentTarget.dataset.key; if (key === 'quantity' && !quantitySupported(this.data.editing)) return; if (!this._busy && ['cartons', 'pcsPerCarton', 'quantity', 'unitPrice', 'cartonCbm', 'note'].includes(key)) { this.setData({ ['form.' + key]: e.detail.value }); this.refreshCalculation(); } },
  customInput(e) { if (!this._busy) this.setData({ customInputs: this.data.customInputs.map(field => field.key === e.currentTarget.dataset.key ? Object.assign({}, field, { value: e.detail.value }) : field) }); },
  decision(e) { if (!this._busy) this.setData({ decisionIndex: Number(e.detail.value) }); },
  refreshCalculation() {
    const f = this.data.form; let quantity = null, amount = null;
    try {
      quantity = quantitySupported(this.data.editing) ? number(f.quantity, '实际采购数量', true) : null;
      if (quantity === null) { const cartons = number(f.cartons, '箱数', true), pcs = number(f.pcsPerCarton, '每箱数量', true, true); if (cartons !== null && pcs !== null) quantity = cartons * pcs; }
    } catch (_) {}
    try { const price = number(f.unitPrice, '采购单价'); if (quantity !== null && price !== null) amount = quantity * price; } catch (_) {}
    this.setData({ quantityPreview: quantity === null || !Number.isFinite(quantity) ? '待填写' : String(quantity), amountPreview: amount === null || !Number.isFinite(amount) ? '待补全' : (Math.round((amount + Number.EPSILON) * 100) / 100).toFixed(2) });
  },
  editKey() { return this._id + ':' + (this.data.editing ? 'line:' + this.data.editing.id : this.data.freightEditing ? 'supplier:' + this.data.freightEditing.name : ''); },
  editDigest() { return JSON.stringify(this.data.editing ? { form: this.data.form, decisionIndex: this.data.decisionIndex, customInputs: this.data.customInputs } : { freight: this.data.freight }); },
  refreshRetained() { this.setData({ retainedCount: Object.keys(this._retainedEdits || {}).filter(key => key.startsWith(this._id + ':')).length }); },
  retainEdit() {
    if (!this.data.editing && !this.data.freightEditing) return false;
    this._retainedEdits = this._retainedEdits || {};
    const key = this.editKey();
    if (this._editInitial && (this.data.editNeedsReview || this.editDigest() !== this._editInitial)) this._retainedEdits[key] = JSON.parse(JSON.stringify({ version: this._editVersion, initial: this._editInitial, form: this.data.form, decisionIndex: this.data.decisionIndex, customInputs: this.data.customInputs, freight: this.data.freight, lineDetailsOpen: this.data.lineDetailsOpen, needsReview: !!this.data.editNeedsReview }));
    else delete this._retainedEdits[key];
    this.refreshRetained(); return !!this._retainedEdits[key];
  },
  cancelEdit() { if (!this._busy) { const retained = this.retainEdit(); this._editReview = null; this.setData({ editing: null, freightEditing: null, editNotice: '', editNeedsReview: false, editReview: null }); if (retained) kit.toast('调整已保留，点商品或运费继续编辑'); } },
  async readCurrent(binding, seq, id) {
    const latest = await api.request('/api/procurement/' + id, { identity: binding });
    session.assert(binding);
    if (!kit.current(this, binding, seq) || this._id !== id) return null;
    if (!latest || latest.id !== id || !Number.isInteger(latest.version) || !Array.isArray(latest.lines) || !Array.isArray(latest.suppliers)) throw new Error('当前采购单读取不完整，请重试核对');
    return latest;
  },
  async reviewCurrent() {
    if (this._busy || (!this.data.editing && !this.data.freightEditing)) return;
    this._busy = true; this.setData({ busy: true, error: '', editReview: null });
    const seq = this._seq, id = this._id, key = this.editKey(), digest = this.editDigest(); let binding;
    try {
      binding = session.capture();
      const latest = await this.readCurrent(binding, seq, id);
      if (!latest || key !== this.editKey() || digest !== this.editDigest()) return;
      const rows = [reviewRow('document', '采购单名称', this._doc.name, latest.name)];
      let target, fields, blocked = '';
      if (this.data.editing) {
        const local = this.data.editing; target = latest.lines.find(line => line.id === local.id);
        if (!target) throw new Error('当前商品已被移除，本机调整继续保留，无法采用新版本');
        fields = editFields(target, latest.template);
        for (const [field, name] of [['sku', '货号'], ['supplier', '供应商'], ['currency', '币种'], ['description', '商品说明'], ['barcode', '条码'], ['source', '来源'], ['sourceMark', '原表标记']]) rows.push(reviewRow(field, name, local[field], target[field]));
        rows.push(reviewRow('decision', '处理决定', decisions[this.data.decisionIndex], decisions[fields.decisionIndex]));
        for (const [field, name] of [['cartons', '箱数'], ['pcsPerCarton', '每箱数量'], ['quantity', '实际采购数量（空白按箱数计算）'], ['unitPrice', '单价'], ['cartonCbm', '单箱体积'], ['note', '备注']]) rows.push(reviewRow(field, name, this.data.form[field], fields.form[field]));
        const localCustom = this.data.customInputs || [], latestCustom = fields.customInputs;
        for (const fieldKey of [...new Set(localCustom.map(field => field.key).concat(latestCustom.map(field => field.key), Object.keys(target.custom || {})))]) {
          const a = localCustom.find(field => field.key === fieldKey), b = latestCustom.find(field => field.key === fieldKey);
          rows.push(reviewRow('custom.' + fieldKey, '扩展 · ' + (a && a.label || b && b.label || fieldKey), a ? a.value : '本机无此字段；将保留服务器值', b ? b.value : target.custom && target.custom[fieldKey]));
          if (a && b && a.label !== b.label) rows.push(reviewRow('label.' + fieldKey, '扩展列名称 · ' + fieldKey, a.label, b.label));
          if (!b && (a || target.custom && target.custom[fieldKey])) blocked = '扩展列已移除或不在当前模板中，本机值已保留，请先核对采购模板';
        }
        fields.customInputs = latestCustom.map(field => { const localField = localCustom.find(a => a.key === field.key); return Object.assign({}, field, { value: localField ? localField.value : field.value }); });
      } else {
        target = latest.suppliers.find(supplier => supplier.name === this.data.freightEditing.name);
        if (!target) throw new Error('当前供应商已被移除，本机运费继续保留，无法采用新版本');
        rows.push(reviewRow('supplier', '供应商', this.data.freightEditing.name, target.name), reviewRow('freight', '运费 · CNY', this.data.freight, target.freight), reviewRow('information', '供应商信息', this.data.freightEditing.information, target.information));
      }
      this._editReview = { binding, seq, id, key, digest, latest, target, fields, blocked };
      this.setData({ editReview: { version: latest.version, rows, blocked }, editNotice: '逐项核对本机与服务器内容，确认后才能采用当前版本' });
    } catch (e) { if (kit.current(this, binding, seq)) kit.message(this, e); }
    finally { this._busy = false; if (this._alive && this._seq === seq) this.setData({ busy: false }); }
  },
  async acceptCurrent() {
    const review = this._editReview;
    if (this._busy || !this.data.editReview || !review || review.blocked) return;
    this._busy = true; this.setData({ busy: true });
    try {
      session.assert(review.binding);
      if (!kit.current(this, review.binding, review.seq)) return;
      const confirmed = await kit.confirm('确认采用当前采购版本', '已核对上方全部字段（含币种、数量、单价、备注及扩展）。保留本机填写值，新增扩展字段保留服务器值，并采用版本 ' + review.latest.version + '。之后需再次点击保存才会提交。');
      session.assert(review.binding);
      if (!confirmed || !kit.current(this, review.binding, review.seq)) return;
      if (review.id !== this._id || review.key !== this.editKey() || review.digest !== this.editDigest()) { this.setData({ editReview: null }); throw new Error('本机调整已变化，请重新核对全部字段'); }
      const baseline = review.fields ? editFields(review.target, review.latest.template) : null;
      this._editInitial = JSON.stringify(baseline || { freight: review.target.freight === null ? '' : String(review.target.freight) });
      this.accept(review.latest); this._editVersion = review.latest.version;
      const patch = { editNeedsReview: false, editReview: null, editNotice: '已采用当前版本并保留本机调整，请保存', error: '' };
      if (review.fields) { patch.editing = review.target; patch.quantityEditable = quantitySupported(review.target); patch.customInputs = review.fields.customInputs; } else patch.freightEditing = review.target;
      this._editReview = null; this.setData(patch); this.retainEdit(); this.refreshCalculation();
    } catch (e) { if (kit.current(this, review.binding, review.seq)) kit.message(this, e); }
    finally { this._busy = false; if (this._alive && this._seq === review.seq) this.setData({ busy: false }); }
  },
  async mutate(path, data) {
    if (this._busy) return;
    this._busy = true; this.setData({ busy: true, error: '' });
    const seq = this._seq, editedKey = this.data.editing || this.data.freightEditing ? this.editKey() : ''; let binding;
    try {
      binding = session.capture(); const doc = await api.request('/api/procurement/' + this._id + path, { method: 'POST', identity: binding, data });
      if (kit.current(this, binding, seq)) { if (editedKey) delete this._retainedEdits[editedKey]; this.accept(doc); this.setData({ editing: null, freightEditing: null, editNotice: '' }); kit.toast('已保存'); }
    } catch (e) {
      if (this._alive && this._seq === seq) {
        if (e.code === 'CONFLICT' && editedKey && editedKey === this.editKey()) {
          this.setData({ editNeedsReview: true, editReview: null, editNotice: '采购单版本已更新，本机调整已保留，请核对当前内容' }); this.retainEdit();
          try { const latest = await this.readCurrent(binding, seq, this._id); if (latest) this.accept(latest); } catch (_) {}
          if (this._alive && this._seq === seq) kit.message(this, new Error('请核对当前采购内容并确认版本后再保存'));
        } else kit.message(this, e);
      }
    }
    finally { this._busy = false; if (this._alive) this.setData({ busy: false }); }
  },
  saveLine() {
    if (this.data.editNeedsReview || this._editVersion !== this._doc.version) { kit.message(this, new Error('请先核对当前采购内容并确认版本')); return; }
    try {
      const f = this.data.form;
      const custom = {}; (this.data.customInputs || []).forEach(field => { custom[field.key] = field.value; });
      const fields = { decision: ['pending', 'include', 'cancel'][this.data.decisionIndex], cartons: number(f.cartons, '箱数', true), pcsPerCarton: number(f.pcsPerCarton, '每箱数量', true, true), unitPrice: number(f.unitPrice, '采购单价'), cartonCbm: number(f.cartonCbm, '单箱体积'), note: f.note || '', custom };
      if (quantitySupported(this.data.editing)) fields.quantity = number(f.quantity, '实际采购数量', true);
      return this.mutate('/lines/' + this.data.editing.id, { version: this._editVersion, fields });
    } catch (e) { kit.message(this, e); }
  },
  async sourceSelection() {
    if (this._busy || !(await kit.confirm('按原表计入', '仅计入原合计范围内、字段完整且没有导入核对提示的商品。合计下方、取消、待确认及异常项继续保留待核对。'))) return;
    return this.mutate('/source-selection', { version: this._doc.version });
  },
  async applyTemplate() {
    if (this._busy || !(await kit.confirm('应用最新表格设置', '更新这份采购记录的表头、字体和列布局，已有商品数据保留。已填写的旧扩展列会继续保留。'))) return;
    return this.mutate('/template', { version: this._doc.version });
  },
  editFreight(e) {
    if (this._busy) return;
    const supplier = this._doc.suppliers.find(s => s.name === e.currentTarget.dataset.name);
    if (!supplier) return;
    this.retainEdit();
    this._editVersion = this._doc.version; this._editReview = null;
    this.setData({ freightEditing: supplier, freight: supplier.freight === null ? '' : String(supplier.freight), editing: null, error: '', editNotice: '' });
    this._editInitial = this.editDigest(); const retained = this._retainedEdits[this.editKey()];
    if (retained) { this._editVersion = retained.version; this._editInitial = retained.initial; this.setData({ freight: retained.freight, editNotice: retained.version === this._doc.version ? '已恢复本次未保存运费' : '采购单版本已更新，保留运费需重新核对' }); }
    this.setData({ editNeedsReview: !!(retained && retained.needsReview) || this._editVersion !== this._doc.version, editReview: null });
  },
  freightInput(e) { if (!this._busy) this.setData({ freight: e.detail.value }); },
  saveFreight() {
    if (this.data.editNeedsReview || this._editVersion !== this._doc.version) { kit.message(this, new Error('请先核对当前运费并确认版本')); return; }
    try { return this.mutate('/supplier', { version: this._editVersion, name: this.data.freightEditing.name, freight: number(this.data.freight, '运费') }); } catch (e) { kit.message(this, e); }
  },
  async preview(e) {
    const line = this._doc.lines.find(l => l.id === e.currentTarget.dataset.id);
    if (!line || !line.imageUrls.length) return;
    try { const binding = session.capture(); const paths = await Promise.all(line.imageUrls.map(path => api.download(path, binding))); session.assert(binding); if (this._alive) wx.previewImage({ urls: paths, current: paths[0] }); } catch (e) { kit.message(this, e); }
  },
  async exportFile(e) {
    if (this._busy) return;
    this._busy = true; this.setData({ busy: true, error: '' });
    try {
      const binding = session.capture();
      const route = '/api/procurement/' + this._id;
      const submitted = api.usesContainer() && !e.currentTarget.dataset.original ? await api.request(route + '/export-job', { method: 'POST', identity: binding, data: {} }) : null;
      const path = submitted ? await store.downloadJobFile(submitted.jobId, binding) : await api.download(route + (e.currentTarget.dataset.original ? '/original' : '/export'), binding);
      session.assert(binding);
      await new Promise((resolve, reject) => wx.openDocument({ filePath: path, fileType: 'xlsx', showMenu: true, success: resolve, fail: () => reject(new Error('文件已下载，当前设备无法打开 Excel')) }));
    } catch (e) { kit.message(this, e); }
    finally { this._busy = false; if (this._alive) this.setData({ busy: false }); }
  },
  async remove() {
    if (this._busy || !(await kit.confirm('删除整理记录', '删除当前账号下这份整理记录及其上传副本。你原来的 Excel 文件不受影响。'))) return;
    this._busy = true; this.setData({ busy: true });
    try { const binding = session.capture(); await api.request('/api/procurement/' + this._id, { method: 'DELETE', identity: binding, data: { version: this._doc.version } }); this._busy = false; if (session.valid(binding) && this._alive) this.backList(); } catch (e) { kit.message(this, e); }
    finally { this._busy = false; if (this._alive) this.setData({ busy: false }); }
  }
}));
