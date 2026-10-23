const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const file = path.resolve(__dirname, '../miniprogram/pages/procurement/index.js');
function environment(recordedQuantity = 50) {
  let definition;
  const messages = [], binding = {};
  const modules = {
    api: {}, store: {}, session: { capture: () => binding, valid: () => true, assert() {} },
    'page-kit': { protectedPage: p => p, current: () => true, message: (_, e) => messages.push(e.message) },
  };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { Page: p => definition = p, require: id => modules[id.split('/').at(-1)] });
  const line = { id: 'line', quantity: recordedQuantity ?? 48, recordedQuantity, cartons: 2, pcsPerCarton: 24, unitPrice: 2.5, cartonCbm: .1, decision: 'pending', note: '', imageUrls: [] };
  const p = { ...definition, data: JSON.parse(JSON.stringify(definition.data)), _doc: { id: 'doc', version: 1, lines: [line] }, _id: 'doc', _retainedEdits: {}, _seq: 1 };
  p.setData = values => { for (const [key, value] of Object.entries(values)) { if (key.startsWith('form.')) p.data.form[key.slice(5)] = value; else p.data[key] = value; } };
  p.edit({ currentTarget: { dataset: { id: 'line' } } });
  return { p, line, messages, modules, input(key, value) { p.input({ currentTarget: { dataset: { key } }, detail: { value } }); } };
}

test('采购整理显式数量优先、修改箱数保留填写值，清空恢复推导，0不丢失', () => {
  const { p, input } = environment();
  assert.equal(p.data.form.quantity, '50');
  assert.equal(p.data.quantityPreview, '50'); assert.equal(p.data.amountPreview, '125.00');
  input('cartons', '3');
  assert.equal(p.data.form.quantity, '50'); assert.equal(p.data.quantityPreview, '50'); assert.equal(p.data.amountPreview, '125.00');
  input('quantity', '');
  assert.equal(p.data.quantityPreview, '72'); assert.equal(p.data.amountPreview, '180.00');
  input('quantity', '0');
  assert.equal(p.data.quantityPreview, '0'); assert.equal(p.data.amountPreview, '0.00');
  input('quantity', 'bad');
  assert.equal(p.data.quantityPreview, '待填写'); assert.equal(p.data.amountPreview, '待补全');
});

test('旧采购单的推导数量不固化成覆盖值，保存发送null；显式0照常发送', () => {
  const { p, input, messages } = environment(null);
  let saved;
  p.mutate = (route, data) => { saved = { route, data }; };
  assert.equal(p.data.form.quantity, ''); assert.equal(p.data.quantityPreview, '48');
  input('cartons', '3'); p.saveLine();
  assert.equal(saved.data.fields.quantity, null); assert.equal(saved.data.fields.cartons, 3);
  input('quantity', '0'); p.saveLine(); assert.equal(saved.data.fields.quantity, 0);
  input('quantity', '2.5'); p.saveLine(); assert.match(messages.at(-1), /实际采购数量数值无效/);
  const legacy = environment(undefined); delete legacy.line.recordedQuantity;
  legacy.p.edit({ currentTarget: { dataset: { id: 'line' } } });
  assert.equal(legacy.p.data.form.quantity, '', 'older response without recordedQuantity cannot freeze its derived quantity');
});

test('未保存的数量与清空选择可恢复，并参与冲突逐项核对', async () => {
  const env = environment(), { p, input } = env;
  input('quantity', ''); p.retainEdit();
  p.setData({ editing: null }); p.edit({ currentTarget: { dataset: { id: 'line' } } });
  assert.equal(p.data.form.quantity, ''); assert.equal(p.data.quantityPreview, '48');
  const latest = { ...p._doc, version: 2, lines: [{ ...env.line, recordedQuantity: 60 }] };
  p.readCurrent = async () => latest;
  await p.reviewCurrent();
  const quantity = p.data.editReview.rows.find(row => row.key === 'quantity');
  assert.equal(quantity.local, '未填'); assert.equal(quantity.latest, '60'); assert.equal(quantity.changed, true);
  const markup = fs.readFileSync(file.replace(/\.js$/, '.wxml'), 'utf8');
  assert.match(markup, /data-key="quantity"/); assert.match(markup, /填写值优先，修改箱数不会改动/);
});

test('旧021响应不显示或提交quantity，保持箱数逻辑并兼容严格旧API', () => {
  const env = environment(), { p, input } = env;
  delete env.line.recordedQuantity;
  p.edit({ currentTarget: { dataset: { id: 'line' } } });
  let saved; p.mutate = (route, data) => { saved = { route, data }; };
  assert.equal(p.data.quantityEditable, false);
  assert.equal(p.data.quantityPreview, '48'); assert.equal(p.data.amountPreview, '120.00');
  input('quantity', '999'); assert.equal(p.data.form.quantity, '');
  input('cartons', '3'); p.saveLine();
  assert.equal(p.data.quantityPreview, '72'); assert.equal(p.data.amountPreview, '180.00');
  assert.equal(Object.hasOwn(saved.data.fields, 'quantity'), false);
  assert.equal(saved.data.fields.cartons, 3);
  const markup = fs.readFileSync(file.replace(/\.js$/, '.wxml'), 'utf8');
  assert.match(markup, /wx:if="\{\{quantityEditable\}\}"/);
  env.line.recordedQuantity = null;
  p.edit({ currentTarget: { dataset: { id: 'line' } } });
  assert.equal(p.data.quantityEditable, true); p.saveLine();
  assert.equal(Object.hasOwn(saved.data.fields, 'quantity'), true); assert.equal(saved.data.fields.quantity, null);
});
