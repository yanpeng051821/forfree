const api = require('../../utils/api');
const session = require('../../utils/session');
const store = require('../../utils/store');
const domain = require('../../utils/domain');
const kit = require('../../utils/page-kit');
const specs = [
  ['unitPrice', '单价'], ['currency', '币种'],
  ['rating', '选品评分', '/ 5'], ['evaluation', '选品评价'], ['tradeTerms', '报价条款'], ['moq', '起订量', '件'], ['cartonQty', '每箱数量', '件/箱'],
  ['cartonCbm', '单箱体积', 'm³'], ['leadTimeDays', '大货交期', '天'], ['cartonDimensions', '外箱尺寸'],
  ['dimensions', '商品尺寸'], ['weightG', '单件重量', 'g'], ['material', '材质 / 工艺'], ['colors', '颜色'],
  ['sku', '货号 / 型号'], ['supplierContact', '联系方式'], ['notes', '备注 / 待问事项'], ['description', '现场原话']
];
const groupKeys = { quote: ['unitPrice', 'currency', 'tradeTerms', 'moq', 'cartonQty', 'leadTimeDays'], specs: ['cartonCbm', 'cartonDimensions', 'dimensions', 'weightG', 'material', 'colors'], records: ['rating', 'evaluation', 'sku', 'supplierContact', 'notes', 'description'] };
Page(kit.protectedPage({
  data: { items: [], rows: [], visibleRows: [], activeGroup: 'quote', onlyDifferences: false, differenceCount: 0, quoteHint: '', groups: [{ key: 'quote', label: '报价' }, { key: 'specs', label: '规格包装' }, { key: 'records', label: '现场记录' }], loading: false, error: '' },
  onShow() { this.load(); }, onHide() { kit.stop(this); }, onUnload() { if(store.files)store.files.release(this);kit.stop(this); },
  onLoad(options) {
    this._projectId=options.projectId;this._date=options.date;this._favorites=options.favorite==='yes';this._supplier=options.supplier;
    this._dateFrom=options.dateFrom;this._dateTo=options.dateTo;
    try{if(this._supplier!==undefined)this._supplier=decodeURIComponent(this._supplier);}catch(_){}
  },
  async load() {
    if (!kit.requireLogin(this)) return;
    const seq = kit.start(this);
    this.setData({ items: [], rows: [], visibleRows: [], quoteHint: '', differenceCount: 0, error: '', loading: true });
    try {
      const binding = session.capture(), ids = store.compareSelection(binding,store.comparisonScope({projectId:this._projectId,date:this._date,dateFrom:this._dateFrom,dateTo:this._dateTo,favorite:this._favorites,supplier:this._supplier}));
      if (ids.length !== 2) throw new Error('请返回商品列表，选择两件商品进行对比');
      const items = await Promise.all(ids.map(async id => {
        const product = await api.request('/api/products/' + encodeURIComponent(id), { identity: binding });
        const date=domain.chinaLocalDate(product.createdAt);
        if (this._dateFrom ? date<this._dateFrom || date>this._dateTo : this._date ? date !== this._date : this._favorites ? !product.favorite : product.projectId !== this._projectId) throw new Error('商品不属于当前回顾范围');
        if(product.deletedAt || (this._supplier!==undefined && product.supplier!==this._supplier))throw new Error('商品不属于当前回顾范围');
        const photos = await store.hydratePhotos(product.photos.slice(0, 1), binding, this);
        return Object.assign({}, domain.productView(product), { cover: photos[0] && photos[0].path || '' });
      }));
      if (!kit.current(this, binding, seq)) return;
      const rows = specs.map(([key, label, unit]) => {
        const values = items.map(item => {
          const value = item[key];
          const missing = value === null || value === undefined || value === '';
          return { id: item.id, text: missing ? '待补充' : key === 'unitPrice' ? domain.priceText(item) : String(value) + (unit ? ' ' + unit : ''), missing };
        });
        return { key, label, values, different: key === 'unitPrice' ? (values[0].missing !== values[1].missing || (!values[0].missing && Number(items[0].unitPrice) !== Number(items[1].unitPrice))) : values[0].text !== values[1].text };
      });
      const quoteHint = items[0].currency !== items[1].currency ? '币种不同，单价需换算后比较' : !items[0].tradeTerms || !items[1].tradeTerms ? '报价条款待补，单价仅供参考' : items[0].tradeTerms !== items[1].tradeTerms ? '报价条款不同，先确认费用范围' : '币种与已填写条款一致';
      this.setData({ items, rows, quoteHint });if(store.files)store.files.protect(this,items.map(item=>item.cover)); this.refreshRows();
    } catch (e) {
      if (!this._alive || this._seq !== seq) return;
      kit.message(this, e);
      // 没有两件商品时页面没有内容，补一个明确的“返回商品”出口，避免只剩重试死路。
      if (/两件商品|不属于当前回顾范围/.test(e.message || '') && typeof wx.showModal === 'function') {
        wx.showModal({ title: '无法对比', content: e.message, confirmText: '返回商品', cancelText: '留在本页', success: res => { if (res.confirm) this.back(); } });
      }
    }
    finally { if (this._alive && this._seq === seq) this.setData({ loading: false }); }
  },
  refreshRows() {
    const keys = groupKeys[this.data.activeGroup] || groupKeys.quote;
    const rows = this.data.rows.filter(row => keys.includes(row.key));
    this.setData({ differenceCount: rows.filter(row => row.different).length, visibleRows: this.data.onlyDifferences ? rows.filter(row => row.different) : rows });
  },
  selectGroup(e) { const key = e.currentTarget.dataset.key; if (this.data.groups.some(group => group.key === key)) { this.setData({ activeGroup: key }); this.refreshRows(); } },
  toggleDifferences(e) { this.setData({ onlyDifferences: e.detail.value === true }); this.refreshRows(); },
  edit(e) { const product = this.data.items.find(item => item.id === e.currentTarget.dataset.id); if (product) wx.navigateTo({ url: '/pages/editor/index?projectId=' + encodeURIComponent(product.projectId) + '&id=' + encodeURIComponent(product.id) }); },
  back() { wx.navigateBack({ fail: () => wx.switchTab({ url:'/pages/products/index' }) }); }
}));
