const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { SaxesParser } = require('saxes');
const domain = require('../miniprogram/utils/domain');
const root = path.resolve(__dirname, '../miniprogram/pages');
const event = (dataset = {}, value) => ({ currentTarget: { dataset }, detail: { value } });
const plain = value => JSON.parse(JSON.stringify(value));
function page(name, overrides = {}) {
  let definition;
  const binding = { owner: 'alice' };
  const storage = overrides.storage || new Map();
  const calls = [];
  const api = { usesContainer: () => false, request: async (url, options) => { calls.push({ url, options }); return {}; }, download: async url => { calls.push({ url }); return '/temp/purchase.xlsx'; } };
  const session = { info: () => ({ user: { id: binding.owner } }), capture: () => binding, assert() {}, valid: () => true };
  const kit = { protectedPage: x => x, requireLogin: () => true, start: p => { p._alive = true; return p._seq = (p._seq || 0) + 1; }, stop: p => { p._alive = false; p._seq = (p._seq || 0) + 1; }, current: (p, _, seq) => p._alive && p._seq === seq, message: (p, e) => p.setData({ error: e.message }), toast() {}, confirm: async () => true };
  const store = { comparisonScope:options=>(options.date?'day:'+options.date:options.favorite?'favorites':options.projectId)+(options.supplier!==undefined?':supplier:'+JSON.stringify(options.supplier):''), activeProject: () => 'project', compareSelection: () => ['a', 'b'], hydratePhotos: async () => [] };
  const wx = { getStorageSync: key => storage.has(key) ? plain(storage.get(key)) : '', setStorageSync: (key, value) => storage.set(key, plain(value)), removeStorageSync: key => storage.delete(key), navigateTo: options => calls.push(options), navigateBack: () => calls.push({ back: true }), openDocument: options => { calls.push(options); options.success(); } };
  const modules = { api, session, 'page-kit': kit, store, domain, ...overrides };
  vm.runInNewContext(fs.readFileSync(path.join(root, name, 'index.js'), 'utf8'), { Page: x => { definition = x; }, require: id => modules[id.split('/').at(-1)], wx }, { filename: name + '/index.js' });
  const p = Object.assign({}, definition, { data: plain(definition.data), _alive: true, _seq: 1 });
  p.setData = patch => Object.entries(patch).forEach(([key, value]) => { const keys = key.split('.'); let object = p.data; keys.slice(0, -1).forEach(part => { object = object[part]; }); object[keys.at(-1)] = value; });
  return { p, calls, api, session, store, wx, storage, kit };
}
function template() {
  return { version: 3, company: '义乌贸易', companyEnglish: 'YIWU TRADE', address: '', contact: '', documentTitle: '采购记录', paymentTerms: '定金30%', shippingMark: 'YIWU', packingRequirements: '独立包装',
    columns: [{ key: 'sku', label: '货号', enabled: true, width: 11.4666666666667 }, { key: 'image', label: '图片', enabled: false, width: 22 }], customFields: [{ key: 'client_ref', label: '客户货号', width: 20 }],
    layout: { headerRows: [{ key: 'company', label: '公司名', text: '', enabled: true, font: '宋体', size: 26, height: 33, bold: true, align: 'center' }, { key: 'documentTitle', label: '标题', text: '', enabled: true, font: 'Arial', size: 16, height: 24, bold: true, align: 'center' }], latinFont: 'Times New Roman', chineseFont: '宋体', fieldSize: 10, bodySize: 12, totalSize: 11, alignment: 'center', border: 'thin', orientation: 'landscape', paper: 'A4', printMode: 'fit', headerSpan: 0, fieldHeight: 25.5, bodyHeight: 98, multiImageHeight: 128, moneyDecimals: 2, volumeDecimals: 6, scale: 85, repeatHeader: true } };
}
function settings() { const env = page('table-settings'); const form = template(); env.p.setData({ form, fields: form.columns.map(c => ({ ...c, required: c.key === 'sku' })) }); env.p._binding = env.session.capture(); env.p._version = form.version; env.p.refresh(); return env; }
function line(id = 'line', patch = {}) { return { id, sku: 'A001', supplier: '义乌商户', currency: 'CNY', decision: 'pending', cartons: null, pcsPerCarton: 24, quantity: null, unitPrice: 0, amount: null, cartonCbm: 0.12, cbm: null, description: '现场说明', note: '已确认颜色', barcode: '', source: '看货商品 item', sourceMark: '', sourceIncluded: false, imageUrls: [], imageCount: 0, warnings: ['箱数待填'], custom: { client_ref: '客户001' }, ...patch }; }
function doc(lines = [line()], patch = {}) { return { id: 'purchase', version: 4, name: '义乌采购', sourceHash: '', template: template(), suppliers: [{ name: '义乌商户', freight: null, warnings: [], information: '' }], lines, summary: { sourceAmount: null, amount: null, lines: lines.length, suppliers: 1, pending: lines.length, included: 0, cancelled: 0, currency: lines[0]?.currency || '' }, ...patch }; }

const originalMethods = {
  'table-settings': ['onShow', 'onHide', 'onUnload', 'importReference', 'load', 'refresh', 'changed', 'input', 'selectHeader', 'headerInput', 'headerOption', 'moveHeader', 'addHeader', 'removeHeader', 'layoutInput', 'layoutOption', 'toggleAdvanced', 'columnName', 'columnWidth', 'columnEnabled', 'columnUpdate', 'moveColumn', 'addCustom', 'customName', 'customWidth', 'customUpdate', 'moveCustom', 'removeCustom', 'save'],
  procurement: ['onLoad', 'onShow', 'onHide', 'onUnload', 'load', 'accept', 'filterLines', 'covers', 'open', 'backList', 'importFile', 'fromTask', 'supplier', 'status', 'search', 'more', 'edit', 'input', 'customInput', 'decision', 'cancelEdit', 'mutate', 'saveLine', 'sourceSelection', 'applyTemplate', 'editFreight', 'freightInput', 'saveFreight', 'preview', 'exportFile', 'remove'],
  compare: ['onLoad', 'onShow', 'onHide', 'onUnload', 'load', 'edit', 'back']
};
test('slice templates are well formed and every original method and bound handler remains callable', () => {
  for (const name of Object.keys(originalMethods)) {
    const { p } = page(name);
    const markup = fs.readFileSync(path.join(root, name, 'index.wxml'), 'utf8');
    const parser = new SaxesParser({ xmlns: false }); const errors = [];
    // WXML accepts boolean attributes and raw operators inside quoted bindings.
    const xml = markup.replace(/\s(scroll-x|auto-height|wx:else)(?=\s|\/?>)/g, ' $1="true"').replace(/&/g, '&amp;');
    parser.on('error', e => errors.push(e.message)); parser.write(xml).close(); assert.deepEqual(errors, [], name);
    for (const method of originalMethods[name]) assert.equal(typeof p[method], 'function', name + ': ' + method);
    for (const match of markup.matchAll(/(?:bind|catch)[\w:]*="([a-zA-Z][\w]*)"/g)) assert.equal(typeof p[match[1]], 'function', name + ': ' + match[1]);
    assert.match(markup, /wx:if="\{\{authenticated\}\}"/);
    assert.match(fs.readFileSync(path.join(root, name, 'index.wxss'), 'utf8'), /#28805a/);
  }
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'table-settings/index.wxml'), 'utf8'), /bindtap="importReference"/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'procurement/index.wxml'), 'utf8'), /bindtap="importFile"|导入采购 Excel|导入的单据/);
});
test('settings start compact; disclosure and group changes preserve semantics and clean status', () => {
  const { p } = settings(); const before = plain(p.data.form);
  assert.equal(p.data.activeGroup, 'header'); assert.equal(p.data.previewOpen, true); assert.equal(p.data.headerEditing, false); assert.equal(p.data.advanced, false);
  p.selectGroup(event({ key: 'columns' })); p.togglePreview(); p.selectHeader(event({ index: 1 })); p.toggleHeaderStyle();
  assert.equal(p.data.activeGroup, 'header'); assert.equal(p.data.rowEditor.key, 'documentTitle'); assert.equal(p.data.headerEditing, true);
  p.closeHeader(); p.selectGroup(event({ key: 'invalid' }));
  assert.equal(p.data.activeGroup, 'header'); assert.equal(p.data.headerEditing, false); assert.equal(p.data.dirty, false); assert.deepEqual(plain(p.data.form), before);
});
test('settings keep selected column identity through reorder and mutually exclusive custom editing', () => {
  const { p } = settings(); p.selectColumn(event({ key: 'sku' }));
  p.moveColumn(event({ index: 0, direction: 1 })); assert.equal(p.data.columnEditor.key, 'sku'); assert.equal(p.data.columnEditor.index, 1);
  p.columnEnabled(event({ index: 1 }, false)); assert.equal(p.data.fields[1].enabled, true);
  p.selectCustom(event({ key: 'client_ref' })); assert.equal(p.data.columnEditor, null); assert.equal(p.data.customEditor.key, 'client_ref');
  p.addCustom(); assert.equal(p.data.customEditor.label, ''); p.customName(event({ index: 1 }, '验货要求')); p.customWidth(event({ index: 1 }, '28'));
  p.moveCustom(event({ index: 1, direction: -1 })); assert.equal(p.data.customEditor.index, 0); assert.equal(p.data.customEditor.width, 28);
  p.removeCustom(event({ index: 0 })); assert.equal(p.data.customEditor, null); assert.equal(p.data.form.customFields[0].key, 'client_ref');
});
test('saving settings from another group preserves precise widths, all layout fields and custom data', async () => {
  const { p, api } = settings();
  p.selectHeader(event({ index: 0 })); p.headerInput(event({ key: 'content' }, '义乌外贸公司')); p.headerInput(event({ key: 'size' }, '24'));
  p.selectGroup(event({ key: 'print' })); p.layoutOption(event({ key: 'orientation' }, '0')); p.selectGroup(event({ key: 'requirements' }));
  let command; api.request = async (_, options) => { command = plain(options.data); return { ...command.fields, version: 4 }; };
  await p.save();
  assert.equal(command.version, 3); assert.equal(command.fields.company, '义乌外贸公司'); assert.equal(command.fields.layout.headerRows[0].size, 24); assert.equal(command.fields.layout.orientation, 'portrait');
  assert.equal(command.fields.columns[0].width, 11.4666666666667); assert.equal(command.fields.columns[1].enabled, false); assert.equal(command.fields.customFields[0].key, 'client_ref');
  assert.equal(command.fields.packingRequirements, '独立包装'); assert.equal(command.fields.layout.repeatHeader, true); assert.equal(command.fields.version, undefined); assert.equal(command.fields.activeGroup, undefined); assert.equal(command.fields.columns[0].required, undefined);
  assert.equal(p.data.dirty, false); assert.equal(p._dirty, false);
});
test('header add/remove and title visibility still enforce original constraints', () => {
  const { p } = settings(); p.selectHeader(event({ index: 1 })); p.headerOption(event({ key: 'enabled' }, false)); assert.equal(p.data.rowEditor.enabled, true);
  p.addHeader(); assert.equal(p.data.headerEditing, true); assert.equal(p.data.rowEditor.removable, true); p.headerInput(event({ key: 'content' }, '补充信息'));
  p.moveHeader(event({ direction: -1 })); assert.equal(p.data.rowEditor.content, '补充信息'); p.removeHeader(); assert.equal(p.data.headerEditing, false); assert.equal(p.data.form.layout.headerRows.length, 2);
});
test('legacy procurement loads normally and hidden sections keep source data and values', async () => {
  const { p, api } = page('procurement'); const legacy = doc([line()], { sourceHash: 'old-workbook', summary: { sourceAmount: 888, amount: null, currency: 'CNY', pending: 1 } });
  p.onLoad({ id: 'purchase' }); api.request = async url => { assert.equal(url, '/api/procurement/purchase'); return legacy; }; await p.load();
  assert.equal(p.data.doc.sourceHash, 'old-workbook'); assert.equal(p.data.doc.summary.sourceAmountText, '888.00'); assert.equal(p.data.lines[0].priceText, '0.00'); assert.equal(p.data.doc.summary.currencyText, 'CNY');
  assert.equal(p.data.suppliersOpen, false); assert.equal(p.data.optionsOpen, false); assert.equal(p.data.expandedLine, ''); p.toggleOptions(); p.toggleSuppliers(); p.toggleLine(event({ id: 'line' }));
  assert.deepEqual(plain(p._doc), legacy); assert.equal(p.data.expandedLine, 'line'); assert.equal(p.data.supplierPending, 1);
});
test('from current task resets filters and uses the existing creation endpoint', async () => {
  const { p, api } = page('procurement'); p.onLoad({}); p.setData({ query: 'old', supplierIndex: 2, filterIndex: 3, limit: 80, suppliersOpen: true, optionsOpen: true });
  api.request = async (url, options) => { if (url === '/api/projects') return [{ id: 'project', name: '义乌看货', summary: { total: 12 } }]; assert.equal(url, '/api/procurement/from-project'); assert.equal(options.method, 'POST'); assert.deepEqual(plain(options.data), { projectId: 'project' }); return doc(); };
  await p.fromTask(); assert.equal(p.data.doc.id, 'purchase'); assert.equal(p.data.query, ''); assert.equal(p.data.supplierIndex, 0); assert.equal(p.data.limit, 20); assert.equal(p.data.suppliersOpen, false); assert.equal(p.data.optionsOpen, false);
});
test('collapsed procurement editor preserves notes, volume, custom values, unknowns and edit version', async () => {
  const { p } = page('procurement'); p.onLoad({}); p.accept(doc()); p.edit(event({ id: 'line' }));
  assert.equal(p.data.lineDetailsOpen, false); assert.equal(p.data.form.cartons, ''); let saved;
  p.mutate = async (url, data) => { saved = { url, data: plain(data) }; };
  p.toggleLineDetails(); p.toggleLineDetails(); await p.saveLine();
  assert.equal(saved.url, '/lines/line'); assert.equal(saved.data.version, 4); assert.equal(saved.data.fields.cartons, null); assert.equal(saved.data.fields.unitPrice, 0); assert.equal(saved.data.fields.cartonCbm, 0.12); assert.equal(saved.data.fields.note, '已确认颜色'); assert.deepEqual(saved.data.fields.custom, { client_ref: '客户001' });
  p.input(event({ key: 'cartons' }, '1.5')); saved = null; await p.saveLine(); assert.equal(saved, null); assert.match(p.data.error, /数值无效/);
});
test('procurement container export awaits the job file; original and desktop exports keep binary endpoints', async () => {
  const { p, calls, api, store, session } = page('procurement'); p.onLoad({}); p.accept(doc());
  const binding = session.capture(), jobId = 'e8eb64bd-4425-4ad8-b7d5-77a3d518685c';
  api.usesContainer = () => true;
  api.request = async (url, options) => {
    assert.equal(url, '/api/procurement/purchase/export-job');
    assert.equal(options.method, 'POST'); assert.equal(options.identity, binding); assert.deepEqual(plain(options.data), {});
    calls.push({ url, options }); return { jobId, state: 'queued' };
  };
  let finishDownload, markDownloadStarted;
  const downloaded = new Promise(resolve => { finishDownload = resolve; });
  const downloadStarted = new Promise(resolve => { markDownloadStarted = resolve; });
  store.downloadJobFile = (id, identity) => {
    assert.equal(id, jobId); assert.equal(identity, binding); calls.push({ jobId: id }); markDownloadStarted(); return downloaded;
  };
  const exporting = p.exportFile(event());
  await downloadStarted;
  assert.deepEqual(calls.map(call => call.url || call.jobId), ['/api/procurement/purchase/export-job', jobId]);
  assert.equal(p.data.busy, true); assert.equal(calls.some(call => call.filePath), false);
  await p.exportFile(event()); assert.equal(calls.length, 2);
  finishDownload('/temp/completed-job.xlsx'); await exporting;
  assert.equal(calls[2].filePath, '/temp/completed-job.xlsx'); assert.equal(calls[2].fileType, 'xlsx'); assert.equal(calls[2].showMenu, true);
  assert.equal(p.data.error, ''); assert.equal(p.data.busy, false); assert.equal(p._busy, false);

  calls.length = 0;
  api.request = async () => { assert.fail('original/desktop export must not submit an export job'); };
  store.downloadJobFile = async () => { assert.fail('original/desktop export must not download a job file'); };
  api.download = async (url, identity) => { assert.equal(identity, binding); calls.push({ url }); return '/temp/original.xlsx'; };
  await p.exportFile(event({ original: 'yes' }));
  assert.equal(calls[0].url, '/api/procurement/purchase/original'); assert.equal(calls[1].filePath, '/temp/original.xlsx'); assert.equal(calls[1].showMenu, true);
  assert.equal(p.data.error, ''); assert.equal(p.data.busy, false);

  calls.length = 0; api.usesContainer = () => false;
  await p.exportFile(event());
  assert.equal(calls[0].url, '/api/procurement/purchase/export'); assert.equal(calls[1].fileType, 'xlsx'); assert.equal(calls[1].showMenu, true);
  assert.equal(p.data.error, ''); assert.equal(p.data.busy, false);
});
test('procurement job download failure shows the error without opening Excel and releases busy state', async () => {
  const { p, calls, api, store } = page('procurement'); p.onLoad({}); p.accept(doc());
  api.usesContainer = () => true;
  api.request = async () => ({ jobId: 'e8eb64bd-4425-4ad8-b7d5-77a3d518685c', state: 'queued' });
  store.downloadJobFile = async () => { throw new Error('导出任务失败'); };
  await p.exportFile(event());
  assert.equal(calls.length, 0); assert.equal(p.data.error, '导出任务失败'); assert.equal(p.data.busy, false); assert.equal(p._busy, false);
});
test('procurement summary labels existing currency and handles mixed currencies without conversion', () => {
  const { p } = page('procurement'); p.onLoad({}); p.accept(doc([line('usd', { currency: 'USD' })])); assert.equal(p.data.doc.summary.currencyText, 'USD');
  const mixed = doc([line(), line('usd', { currency: 'USD' })]); mixed.summary.currency = ''; p.accept(mixed); assert.equal(p.data.doc.summary.currencyText, '多币种 / 待确认'); assert.equal(p.data.doc.summary.amount, null);
});
test('switching accounts clears data held in collapsed editors and closes disclosures', async () => {
  const { p, session } = settings(); p._owner = 'alice'; p.selectColumn(event({ key: 'sku' })); p.selectCustom(event({ key: 'client_ref' })); p.selectHeader(event({ index: 0 })); p.togglePreview(); p.load = () => {};
  session.info = () => ({ user: { id: 'bob' } }); p.onShow(); assert.equal(p.data.form, null); assert.equal(p.data.rowEditor, null); assert.equal(p.data.columnEditor, null); assert.equal(p.data.customEditor, null); assert.equal(p.data.headerEditing, false); assert.equal(p.data.previewOpen, true);
  const env = page('procurement'); env.p.onLoad({}); env.p._owner = 'alice'; env.p.accept(doc()); env.p.edit(event({ id: 'line' })); env.p.toggleLineDetails(); env.p.load = () => {};
  env.session.info = () => ({ user: { id: 'bob' } }); env.p.onShow(); assert.equal(env.p.data.doc, null); assert.deepEqual(plain(env.p.data.form), {}); assert.deepEqual(plain(env.p.data.customInputs), []); assert.equal(env.p.data.lineDetailsOpen, false);
});
function product(id, patch = {}) { return { ...domain.emptyFields, id, projectId: 'project', name: id === 'a' ? '保温杯' : '玻璃杯', supplier: '商户', photos: [], unitPrice: 0, moq: 100, cartonQty: 24, tradeTerms: 'EXW', material: '玻璃', ...patch }; }
test('compare defaults to quote, retains all original specs and filters differences per group', async () => {
  const { p, api } = page('compare'); p.onLoad({ projectId: 'project' });
  api.request = async url => product(url.split('/').at(-1), url.endsWith('/b') ? { moq: 200, notes: '请确认包装' } : {}); await p.load();
  assert.equal(p.data.items.length, 2); assert.equal(p.data.rows.length, 18); assert.equal(p.data.visibleRows.length, 6); assert.equal(p.data.differenceCount, 1); assert.match(p.data.quoteHint, /币种与已填写条款一致/);
  p.toggleDifferences(event({}, true)); assert.deepEqual(plain(p.data.visibleRows.map(row => row.key)), ['moq']); p.selectGroup(event({ key: 'specs' })); assert.equal(p.data.visibleRows.length, 0);
  p.selectGroup(event({ key: 'records' })); assert.deepEqual(plain(p.data.visibleRows.map(row => row.key)), ['notes']); p.toggleDifferences(event({}, false)); assert.equal(p.data.visibleRows.length, 6);
  const rating = p.data.rows.find(row => row.key === 'rating'); assert.equal(rating.values[0].text, '待补充'); assert.equal(rating.values[0].missing, true); assert.equal(p.data.items[0].priceText, '¥0.00');
});
test('compare price context distinguishes currency mismatch, absent terms and different terms', async () => {
  for (const [patch, pattern] of [[{ currency: 'USD' }, /币种不同/], [{ tradeTerms: '' }, /条款待补/], [{ tradeTerms: 'FOB' }, /条款不同/]]) {
    const { p, api } = page('compare'); p.onLoad({ projectId: 'project' }); api.request = async url => product(url.split('/').at(-1), url.endsWith('/b') ? patch : {}); await p.load(); assert.match(p.data.quoteHint, pattern);
  }
});

test('settings draft survives hide and unload, restores only same owner/version without posting', async () => {
  const first = settings(); first.p._owner = 'alice'; first.p.headerInput(event({ key: 'content' }, '未保存公司')); first.p.selectGroup(event({ key: 'style' })); first.p.layoutOption(event({ key: 'latinFont' }, '2')); first.p.layoutInput(event({ key: 'bodySize' }, '14')); first.p.onHide(); first.p.onUnload();
  const draftKey = 'huoji.tableSettingsDraft.v1.alice'; assert.equal(first.storage.get(draftKey).version, 3); assert.equal(first.storage.get(draftKey).form.version, 3); assert.equal(first.storage.get(draftKey).form.columns[0].required, undefined);
  const next = page('table-settings', { storage: first.storage }); const requests = []; next.api.request = async (url, options) => { requests.push({ url, options }); return template(); }; await next.p.load();
  assert.equal(next.p.data.form.company, '未保存公司'); assert.equal(next.p.data.form.layout.latinFont, 'Arial'); assert.equal(next.p.data.form.layout.bodySize, 14); assert.equal(next.p._version, 3); assert.equal(next.p.data.dirty, true); assert.match(next.p.data.draftNotice, /已恢复/); assert.equal(requests.length, 1); assert.equal(requests[0].options.method, undefined);
  const newer = page('table-settings', { storage: first.storage }); newer.api.request = async () => ({ ...template(), version: 4 }); await newer.p.load(); assert.equal(newer.p.data.form.company, '义乌贸易'); assert.equal(newer.p.data.dirty, false); assert.match(newer.p.data.draftNotice, /未自动恢复/); assert.equal(first.storage.get(draftKey).form.company, '未保存公司');
  const other = page('table-settings', { storage: first.storage }); other.session.capture = () => ({ owner: 'bob' }); other.api.request = async () => template(); await other.p.load(); assert.equal(other.p.data.form.company, '义乌贸易'); assert.equal(other.p.data.dirty, false); assert.equal(other.p.data.draftNotice, '');
});
test('settings save removes its acknowledged draft, preserves a later draft and retains failure data', async () => {
  const env = settings(); env.p.headerInput(event({ key: 'content' }, '本次草稿')); env.p.persistDraft(); env.storage.set('huoji.tableSettingsDraft.v1.bob', { owner: 'bob', version: 3 }); env.api.request = async (_, options) => ({ ...plain(options.data.fields), version: 4 }); await env.p.save(); assert.equal(env.storage.has('huoji.tableSettingsDraft.v1.alice'), false); assert.equal(env.storage.has('huoji.tableSettingsDraft.v1.bob'), true);
  const late = settings(); late.p.headerInput(event({ key: 'content' }, '旧提交')); late.api.request = async (_, options) => { const fresh = plain(late.storage.get('huoji.tableSettingsDraft.v1.alice')); fresh.form.company = '另一页面后续草稿'; late.storage.set('huoji.tableSettingsDraft.v1.alice', fresh); return { ...plain(options.data.fields), version: 4 }; }; await late.p.save(); assert.equal(late.storage.get('huoji.tableSettingsDraft.v1.alice').form.company, '另一页面后续草稿');
  const failed = settings(); failed.p.headerInput(event({ key: 'content' }, '网络失败保留')); failed.api.request = async () => { throw new Error('网络失败'); }; await failed.p.save(); assert.equal(failed.p.data.dirty, true); assert.equal(failed.storage.get('huoji.tableSettingsDraft.v1.alice').form.company, '网络失败保留');
});
test('settings validation opens the offending group and editor before any save request', async () => {
  for (const [change, group, verify] of [
    [p => p.layoutInput(event({ key: 'bodySize' }, '99')), 'style', p => assert.equal(p.data.activeGroup, 'style')],
    [p => p.layoutInput(event({ key: 'multiImageHeight' }, '40')), 'print', p => assert.equal(p.data.advanced, true)],
    [p => p.columnWidth(event({ index: 0 }, '1')), 'columns', p => assert.equal(p.data.activeColumn, 'sku')],
    [p => p.customName(event({ index: 0 }, '')), 'columns', p => assert.equal(p.data.activeCustom, 'client_ref')],
    [p => p.headerInput(event({ key: 'height' }, '12')), 'header', p => assert.equal(p.data.headerStyleOpen, true)],
    [p => p.input(event({ key: 'paymentTerms' }, '字'.repeat(501))), 'requirements', () => {}]
  ]) { const { p, api } = settings(); let posted = false; api.request = async () => { posted = true; }; change(p); p.selectGroup(event({ key: 'requirements' })); await p.save(); assert.equal(posted, false); assert.equal(p.data.activeGroup, group); assert.ok(p.data.error); verify(p); }
});
test('settings retains all collapsed font and print edits with no empty-to-zero coercion', async () => {
  const { p, api } = settings(); p.layoutOption(event({ key: 'latinFont' }, '3')); p.layoutOption(event({ key: 'chineseFont' }, '5')); p.layoutInput(event({ key: 'bodySize' }, '14')); p.layoutOption(event({ key: 'repeatHeader' }, false)); p.toggleAdvanced(); p.toggleAdvanced(); p.closeHeader(); p.selectGroup(event({ key: 'columns' })); let command;
  api.request = async (_, options) => { command = plain(options.data); return { ...command.fields, version: 4 }; }; await p.save(); assert.equal(command.fields.layout.latinFont, 'Calibri'); assert.equal(command.fields.layout.chineseFont, '微软雅黑'); assert.equal(command.fields.layout.bodySize, 14); assert.equal(command.fields.layout.repeatHeader, false);
  p.layoutInput(event({ key: 'bodySize' }, '')); await p.save(); assert.equal(p.data.form.layout.bodySize, ''); assert.equal(p.data.activeGroup, 'style');
});
test('compare counts price and currency separately, including null/zero and subcent changes', async () => {
  for (const [left, right, keys] of [[{ unitPrice: 10 }, { unitPrice: 20 }, ['unitPrice']], [{ unitPrice: 0 }, { unitPrice: null }, ['unitPrice']], [{ unitPrice: 1.001 }, { unitPrice: 1.002 }, ['unitPrice']], [{ unitPrice: 10 }, { unitPrice: 10, currency: 'USD' }, ['currency']]]) {
    const { p, api } = page('compare'); p.onLoad({ projectId: 'project' }); api.request = async url => product(url.split('/').at(-1), url.endsWith('/a') ? left : right); await p.load(); p.toggleDifferences(event({}, true)); assert.deepEqual(plain(p.data.visibleRows.map(row => row.key)), keys); assert.equal(p.data.differenceCount, 1);
  }
});
test('procurement live calculation preserves blank versus zero and never mutates persisted lines', () => {
  const { p } = page('procurement'); p.onLoad({}); const original = doc(); p.accept(original); p.edit(event({ id: 'line' })); assert.equal(p.data.quantityPreview, '待填写'); assert.equal(p.data.amountPreview, '待补全');
  p.input(event({ key: 'cartons' }, '0')); assert.equal(p.data.quantityPreview, '0'); assert.equal(p.data.amountPreview, '0.00'); p.input(event({ key: 'unitPrice' }, '')); assert.equal(p.data.amountPreview, '待补全'); p.input(event({ key: 'unitPrice' }, '0')); assert.equal(p.data.amountPreview, '0.00');
  p.input(event({ key: 'cartons' }, '2')); p.input(event({ key: 'pcsPerCarton' }, '10')); p.input(event({ key: 'unitPrice' }, '1.25')); assert.equal(p.data.quantityPreview, '20'); assert.equal(p.data.amountPreview, '25.00'); p.input(event({ key: 'cartons' }, '1.5')); assert.equal(p.data.quantityPreview, '待填写'); assert.equal(p.data.amountPreview, '待补全'); assert.equal(original.lines[0].cartons, null); assert.equal(original.lines[0].unitPrice, 0);
});
test('procurement close and reopen retain edits and freight at original version; success clears retention', async () => {
  const { p, api } = page('procurement'); p.onLoad({}); p.accept(doc()); p.edit(event({ id: 'line' })); p.input(event({ key: 'cartons' }, '3')); p.customInput(event({ key: 'client_ref' }, '保留客户编号')); p.decision(event({}, '1')); p.cancelEdit(); assert.equal(p.data.editing, null); assert.equal(p.data.retainedCount, 1);
  p.edit(event({ id: 'line' })); assert.equal(p.data.form.cartons, '3'); assert.equal(p.data.customInputs[0].value, '保留客户编号'); assert.equal(p.data.decisionIndex, 1); assert.match(p.data.editNotice, /已恢复/); p.cancelEdit(); p.accept(doc(undefined, { version: 5 })); p.edit(event({ id: 'line' })); assert.equal(p._editVersion, 4); assert.match(p.data.editNotice, /版本已更新/);
  api.request = async () => doc(undefined, { version: 6 }); await p.reviewCurrent(); await p.acceptCurrent(); await p.saveLine(); assert.equal(p.data.editing, null); assert.equal(p.data.retainedCount, 0);
  p.editFreight(event({ name: '义乌商户' })); p.freightInput(event({}, '0')); p.cancelEdit(); p.editFreight(event({ name: '义乌商户' })); assert.equal(p.data.freight, '0'); assert.match(p.data.editNotice, /已恢复/); await p.saveFreight(); assert.equal(p.data.retainedCount, 0);
});
test('procurement conversion failure resets state, presents task source and foreign quote export', async () => {
  const { p, api, calls } = page('procurement'); p.onLoad({ projectId: 'project' }); let conversions = 0;
  api.request = async url => { if (url === '/api/projects') return [{ id: 'project', name: '义乌外币任务', summary: { total: 18 } }]; if (url === '/api/procurement/from-project') { conversions++; if (conversions === 1) throw Object.assign(new Error('仅支持人民币'), { code: 'CURRENCY_UNSUPPORTED' }); return doc(); } throw new Error(url); };
  await p.load(); assert.equal(p._converted, false); assert.equal(p.data.sourceTask.name, '义乌外币任务'); assert.equal(p.data.sourceTask.count, 18); assert.equal(p.data.sourceUnsupported, true); p.exportSource(); assert.equal(calls.at(-1).url, '/pages/export/index?projectId=project'); await p.retry(); assert.equal(conversions, 2); assert.equal(p._converted, true); assert.equal(p.data.sourceUnsupported, false); assert.equal(p.data.doc.id, 'purchase');
});
test('page button CSS explicitly overrides native half-width buttons and keeps primary black', () => {
  const css = name => fs.readFileSync(path.join(root, name, 'index.wxss'), 'utf8');
  for (const name of ['table-settings', 'procurement', 'compare']) { const source = css(name); assert.match(source, /button\{box-sizing:border-box;width:auto;min-width:0;max-width:100%;margin:0;flex:0 0 auto\}/); assert.match(source, /\.primary\{background:#202226;color:#fff\}/); assert.match(source, /\.toolbar \.primary[^{}]*\{width:100%;min-width:0;margin:0\}|\.toolbar \.primary\{width:100%;min-width:0;margin:0\}/); }
  assert.match(css('table-settings'), /\.group-tab\{flex:0 0 20%;width:20%;min-width:0;margin:0/); assert.match(css('table-settings'), /\.setting-summary,.*\.preview-title,.*\.toolbar \.primary\{width:100%;min-width:0;margin:0\}/); assert.match(fs.readFileSync(path.join(root, 'table-settings/index.wxml'), 'utf8'), /class="preview-scroll"/);
});

test('settings conflict reads latest without replacing edits; confirmation rebases and next save uses latest version', async () => {
  const { p, api, kit, storage } = settings(); p.input(event({ key: 'company' }, '本机公司')); p.layoutInput(event({ key: 'bodySize' }, '14'));
  const latest = { ...template(), company: '服务器公司', version: 8 }; const requests = []; let conflict = true;
  api.request = async (url, options) => { requests.push({ url, options: plain(options) }); if (options.method === 'POST') { if (conflict) throw Object.assign(new Error('版本冲突'), { code: 'CONFLICT' }); return { ...plain(options.data.fields), version: 9 }; } return latest; };
  await p.save(); assert.deepEqual(requests.map(r => r.options.method || 'GET'), ['POST', 'GET']); assert.equal(p.data.form.company, '本机公司'); assert.equal(p._version, 3); assert.equal(p.data.settingsNeedsReview, true);
  await p.save(); assert.equal(requests.length, 2); await p.reviewLatest(); assert.ok(p.data.settingsReview.rows.some(row => row.name === '公司名' && row.local === '本机公司' && row.latest === '服务器公司')); assert.ok(p.data.settingsReview.rows.some(row => /内容字号/.test(row.name)));
  kit.confirm = async () => false; await p.acceptLatest(); assert.equal(p._version, 3); assert.equal(p.data.form.company, '本机公司'); assert.equal(storage.get('huoji.tableSettingsDraft.v1.alice').version, 3);
  kit.confirm = async () => true; await p.acceptLatest(); assert.equal(p._version, 8); assert.equal(p.data.form.version, 8); assert.equal(p.data.form.company, '本机公司'); assert.equal(storage.get('huoji.tableSettingsDraft.v1.alice').version, 8); assert.equal(requests.filter(r => r.options.method === 'POST').length, 1);
  conflict = false; await p.save(); assert.equal(requests.at(-1).options.data.version, 8); assert.equal(requests.at(-1).options.data.fields.layout.bodySize, 14); assert.equal(storage.has('huoji.tableSettingsDraft.v1.alice'), false);
});
test('old settings draft remains accessible and untouched until confirmed with current version', async () => {
  const first = settings(); first.p.input(event({ key: 'company' }, '旧草稿公司')); first.p.persistDraft();
  const { p, api, kit, storage } = page('table-settings', { storage: first.storage }); let requests = 0; api.request = async (_, options) => { assert.equal(options.method, undefined); requests++; return { ...template(), version: 7 }; };
  await p.load(); assert.equal(p.data.hasOldDraft, true); await p.restoreOldDraft(); assert.equal(p.data.settingsReview.oldDraft, true); assert.equal(p.data.form.company, '义乌贸易');
  kit.confirm = async () => false; await p.acceptLatest(); assert.equal(p._version, 7); assert.equal(p.data.dirty, false); assert.equal(storage.get('huoji.tableSettingsDraft.v1.alice').version, 3);
  kit.confirm = async () => true; await p.acceptLatest(); assert.equal(p.data.form.company, '旧草稿公司'); assert.equal(p.data.form.version, 7); assert.equal(p._version, 7); assert.equal(p.data.dirty, true); assert.equal(p.data.hasOldDraft, false); assert.equal(storage.get('huoji.tableSettingsDraft.v1.alice').version, 7); assert.equal(requests, 2);
});
test('procurement conflict requires full field review; cancel keeps version and confirm preserves local plus new server custom fields', async () => {
  const { p, api, kit } = page('procurement'); p.onLoad({}); p.accept(doc()); p.edit(event({ id: 'line' })); p.input(event({ key: 'cartons' }, '0')); p.input(event({ key: 'unitPrice' }, '')); p.input(event({ key: 'note' }, '本机备注')); p.customInput(event({ key: 'client_ref' }, '本机编号'));
  const latestTemplate = template(); latestTemplate.customFields.push({ key: 'new_ref', label: '新增编号', width: 20 });
  const latest = doc([line('line', { cartons: 3, unitPrice: 8, note: '服务器备注', custom: { client_ref: '服务器编号', new_ref: '不得丢失' } })], { version: 9, template: latestTemplate }); let posted = 0, saved;
  api.request = async (_, options) => { if (options.method === 'POST') { posted++; if (posted === 1) throw Object.assign(new Error('冲突'), { code: 'CONFLICT' }); saved = plain(options.data); return doc(undefined, { version: 10 }); } return latest; };
  await p.saveLine(); assert.equal(p._editVersion, 4); assert.equal(p.data.form.note, '本机备注'); assert.equal(p.data.editNeedsReview, true); await p.saveLine(); assert.equal(posted, 1);
  await p.reviewCurrent(); const rows = p.data.editReview.rows; for (const key of ['currency', 'sku', 'supplier', 'decision', 'cartons', 'pcsPerCarton', 'unitPrice', 'cartonCbm', 'note', 'custom.client_ref', 'custom.new_ref']) assert.ok(rows.some(row => row.key === key), key);
  assert.equal(rows.find(row => row.key === 'cartons').local, '0'); assert.equal(rows.find(row => row.key === 'unitPrice').local, '未填');
  kit.confirm = async () => false; await p.acceptCurrent(); assert.equal(p._editVersion, 4); assert.equal(p.data.form.unitPrice, '');
  kit.confirm = async () => true; await p.acceptCurrent(); assert.equal(p._editVersion, 9); assert.equal(p.data.form.cartons, '0'); assert.equal(p.data.form.note, '本机备注'); assert.equal(p.data.customInputs.find(field => field.key === 'new_ref').value, '不得丢失'); assert.equal(posted, 1);
  await p.saveLine(); assert.equal(saved.version, 9); assert.equal(saved.fields.cartons, 0); assert.equal(saved.fields.unitPrice, null); assert.deepEqual(saved.fields.custom, { client_ref: '本机编号', new_ref: '不得丢失' }); assert.equal(p.data.editing, null);
});
test('procurement freight rebase is explicit; changed review and removed custom schema never rebase', async () => {
  const { p, api, kit } = page('procurement'); p.onLoad({}); p.accept(doc()); p.editFreight(event({ name: '义乌商户' })); p.freightInput(event({}, '0')); p.cancelEdit(); p.accept(doc(undefined, { version: 5 })); p.editFreight(event({ name: '义乌商户' })); assert.equal(p.data.editNeedsReview, true);
  api.request = async () => doc(undefined, { version: 6, suppliers: [{ name: '义乌商户', freight: 20, information: '新运费信息', warnings: [] }] }); await p.reviewCurrent(); assert.equal(p.data.editReview.rows.find(row => row.key === 'freight').local, '0'); assert.equal(p.data.editReview.rows.find(row => row.key === 'freight').latest, '20');
  p.freightInput(event({}, '1')); await p.acceptCurrent(); assert.equal(p._editVersion, 4); assert.match(p.data.error, /已变化/); await p.reviewCurrent(); await p.acceptCurrent(); assert.equal(p._editVersion, 6); assert.equal(p.data.freight, '1');
  p.cancelEdit(); p.edit(event({ id: 'line' })); p.customInput(event({ key: 'client_ref' }, '旧字段保留')); const t = template(); t.customFields = []; api.request = async () => doc(undefined, { version: 7, template: t }); await p.reviewCurrent(); assert.match(p.data.editReview.blocked, /扩展列/); let confirms = 0; kit.confirm = async () => { confirms++; return true; }; await p.acceptCurrent(); assert.equal(confirms, 0); assert.equal(p._editVersion, 6); assert.equal(p.data.customInputs[0].value, '旧字段保留');
});


test('字号滑动即时预览并自动适配行高，颜色保存保留原公司模板和精确列宽', async () => {
  const {p,api}=settings();p.selectHeader(event({index:0}));p.setData({previewOpen:false});
  p.headerSlide(event({key:'size'},32));assert.equal(p.data.rowEditor.size,32);assert.ok(p.data.rowEditor.height>=32*1.15);assert.match(p.data.previews[0].previewStyle,/font-size:48rpx/);
  p.headerColor(event({},'#245C46'));assert.match(p.data.previews[0].previewStyle,/color:#245C46/);
  p.layoutSlide(event({key:'bodySize'},15));p.layoutColor(event({key:'bodyColor'},'#1E3A5F'));assert.match(p.data.previewBodyStyle,/font-size:22.5rpx/);assert.match(p.data.previewBodyStyle,/color:#1E3A5F/);
  assert.equal(p.data.previewOpen,false,'adjusting a control must not expand the collapsed preview and move the control');
  const width=p.data.fields[0].width;
  api.request=async (_,options)=>{assert.equal(options.data.fields.layout.bodyColor,'#1E3A5F');assert.equal(options.data.fields.columns[0].width,width);return {...options.data.fields,version:4};};
  await p.save();assert.equal(p.data.dirty,false);assert.equal(p.data.form.layout.headerRows[0].color,'#245C46');
});
