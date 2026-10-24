const emptyFields = Object.freeze({ name: '', sku: '', supplier: '', supplierContact: '', colors: '', material: '', dimensions: '', weightG: null, unitPrice: null, currency: 'CNY', moq: null, cartonQty: null, cartons:null,quantity:null,barcode:'',exportRemarks:'',custom:{}, cartonDimensions: '', cartonCbm: null, leadTimeDays: null, tradeTerms: '', description: '', notes: '', confirmed: false, favorite: false, rating: null, evaluation: '' });
const numeric = ['weightG', 'unitPrice', 'moq', 'cartonQty', 'cartonCbm', 'leadTimeDays','cartons','quantity'];
const factual = ['name','sku','supplier','supplierContact','colors','material','dimensions','weightG','unitPrice','currency','moq','cartonQty','cartons','quantity','barcode','exportRemarks','custom','cartonDimensions','cartonCbm','leadTimeDays','tradeTerms'];
function factChanged(before, after) {
  const normalize = (key, value) => numeric.includes(key) ? value === '' || value == null ? null : Number(value) : value;
  return factual.some(key => stable(normalize(key, before[key])) !== stable(normalize(key, after[key])));
}
function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = Math.floor(Math.random() * 16); return (c === 'x' ? r : (r & 3) | 8).toString(16);
  });
}
function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
function fieldsFrom(product) {
  const fields = Object.assign({}, emptyFields);
  Object.keys(fields).forEach(k => { if (product && product[k] !== undefined) fields[k] = product[k]; });
  fields.custom=Object.assign({},fields.custom);
  return fields;
}
function validateFields(source) {
  const fields = fieldsFrom(source);
  ['name', 'sku', 'supplier', 'supplierContact', 'colors', 'material', 'dimensions', 'cartonDimensions', 'tradeTerms','barcode'].forEach(k => { fields[k] = String(fields[k] || '').trim(); });
  if (!fields.name) throw new Error('请填写商品名称');
  const limits = { name: 120, sku: 120, supplier: 200, supplierContact: 200, colors: 200, material: 200, dimensions: 200, cartonDimensions: 200, tradeTerms: 200, description: 10000, notes: 5000, evaluation: 5000,barcode:200,exportRemarks:5000 };
  Object.keys(limits).forEach(k => { if (typeof fields[k] !== 'string' || fields[k].length > limits[k]) throw new Error('字段内容过长或格式不正确'); });
  numeric.forEach(k => {
    const value = fields[k];
    if (value === '' || value === null || value === undefined) { fields[k] = null; return; }
    if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value.trim()))) throw new Error('请填写有效数字');
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 100000000 || (['moq', 'cartonQty', 'leadTimeDays','cartons','quantity'].includes(k) && !Number.isInteger(n)) || (k === 'cartonQty' && n === 0)) throw new Error('价格、重量和体积须非负；数量与交期须有效整数');
    fields[k] = n;
  });
  if (!['CNY', 'USD', 'EUR'].includes(fields.currency)) throw new Error('币种无效');
  if (fields.rating !== null && (!Number.isInteger(fields.rating) || fields.rating < 1 || fields.rating > 5)) throw new Error('评分须为1到5星');
  fields.favorite = fields.favorite === true;
  fields.confirmed = fields.confirmed === true;
  if(!fields.custom || Array.isArray(fields.custom)||typeof fields.custom!=='object'||Object.keys(fields.custom).length>40||Object.entries(fields.custom).some(([key,value])=>!/^[a-z][a-z0-9_]{0,39}$/.test(key)||typeof value!=='string'||value.length>2000))throw new Error('扩展字段格式不正确或内容过长');
  return fields;
}
function mergeExtraction(current, extracted) {
  const fields = fieldsFrom(current), conflicts = [];
  const allowed = ['name', 'sku', 'notes','exportRemarks', 'colors', 'material', 'dimensions', 'weightG', 'unitPrice', 'moq','cartons','quantity','barcode', 'cartonQty', 'cartonDimensions', 'cartonCbm', 'leadTimeDays', 'tradeTerms'];
  const currencyMismatch = extracted && extracted.unitPrice != null && extracted.currency && extracted.currency !== fields.currency;
  allowed.forEach(k => {
    const value = extracted && extracted[k];
    if (value === null || value === undefined) return;
    if (k === 'unitPrice' && currencyMismatch) { conflicts.push('currency'); return; }
    if (numeric.includes(k) && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100000000 || (['moq', 'cartonQty', 'leadTimeDays','cartons','quantity'].includes(k) && !Number.isInteger(value)) || (k === 'cartonQty' && value === 0))) return;
    if (!numeric.includes(k) && (typeof value !== 'string' || value.length > (['name', 'sku'].includes(k) ? 120 : ['notes','exportRemarks'].includes(k) ? 5000 : 200))) return;
    if (k === 'currency' && !['CNY', 'USD', 'EUR'].includes(value)) return;
    if (fields[k] === '' || fields[k] === null || fields[k] === undefined || (k === 'name' && fields[k] === '未命名商品')) fields[k] = value;
    else if (fields[k] !== value) conflicts.push(k);
  });
  if (factChanged(current, fields)) fields.confirmed = false;
  return { fields, conflicts };
}
function requestFor(payload, previous) {
  const digest = stable(payload);
  return previous && previous.digest === digest ? previous : { digest, requestKey: uuid() };
}
function filterProducts(products, query, status) {
  const text = String(query || '').trim().toLowerCase();
  return products.filter(p => (status === 'all' || (status === 'missingPrice' ? p.unitPrice === null : status === 'confirmed' ? p.confirmed : !p.confirmed)) && (!text || [p.name, p.sku, p.supplier, p.supplierContact, p.description, p.notes, p.evaluation].join(' ').toLowerCase().includes(text)));
}
function uncertain(error) { return ['NETWORK_UNKNOWN', 'BAD_RESPONSE', 'IDENTITY_CHANGED', 'INTERNAL', 'UPSTREAM_FAILED'].includes(error.code) || /^HTTP_5/.test(error.code || ''); }
function chinaLocalDate(value) {
  const date = value instanceof Date ? value : new Date(value === undefined ? Date.now() : value);
  if (!Number.isFinite(date.getTime())) throw new Error('日期无效');
  const china = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const pad = number => String(number).padStart(2, '0');
  return china.getUTCFullYear() + '-' + pad(china.getUTCMonth() + 1) + '-' + pad(china.getUTCDate());
}
function productPage(value) {
  if (Array.isArray(value)) return { items: value, nextCursor: null, legacy: true };
  if (!value || !Array.isArray(value.items) || !(value.nextCursor === null || value.nextCursor === undefined || typeof value.nextCursor === 'string')) throw new Error('商品列表响应无效，请稍后重试');
  return { items: value.items, nextCursor: value.nextCursor || null, legacy: false };
}
function priceText(product) {
  return product.unitPrice === null || product.unitPrice === undefined || product.unitPrice === '' ? '待询价格' : ({ CNY: '¥', USD: '$', EUR: '€' }[product.currency] || product.currency + ' ') + Number(product.unitPrice).toFixed(2);
}
function productView(product) {
  const missing = [];
  if (product.unitPrice === null) missing.push('价格');
  if (product.moq === null) missing.push('起订量');
  if (!product.supplier) missing.push('供应商');
  return Object.assign({}, product, { priceText: priceText(product), missingText: missing.length ? '待补：' + missing.join('、') : '', specText: [product.material, product.colors, product.dimensions].filter(Boolean).join(' · ') || '规格待填写' });
}
module.exports = { emptyFields, numeric, factual, factChanged, uuid, stable, fieldsFrom, validateFields, mergeExtraction, requestFor, filterProducts, uncertain, chinaLocalDate, productPage, priceText, productView };
