const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const domain = require('../miniprogram/utils/domain');
const captureTemplate = require('../miniprogram/utils/capture-template');

function product(patch = {}) {
  return { ...domain.emptyFields, id: 'synthetic', projectId: 'project', name: '示例商品', version: 1, photos: [], createdAt: '2026-10-18T01:00:00Z', ...patch };
}
async function preview(layout, products, formatting = {}) {
  const binding = { owner: 'synthetic-owner' }, calls = [];
  const metadata = {
    columns: ['unitPrice', 'amount', 'quantity', 'cartonCbm', 'cbm', ...(formatting.description ? ['description'] : [])].map(key => ({ key, label: key, width: 16, hidden: false, ...(formatting[key] || {}) })),
    headerRows: [{ key: 'company', text: '合成公司', enabled: true, font: '宋体', size: 26 }],
    documentTitle: '合成选品表',
    ...(layout === undefined ? {} : { layout }),
  };
  const modules = {
    api: { request: async (url, options) => {
      calls.push({ url, options });
      return url.startsWith('/api/export-preview') ? metadata : { items: products, nextCursor: null, summary: { total: products.length, confirmed: 0 } };
    } },
    session: { capture: () => binding },
    store: { hydratePhotos: async () => { throw new Error('Image-disabled preview must not hydrate photos'); } },
    domain,
    'capture-template': captureTemplate,
    'page-kit': {
      protectedPage: page => page,
      requireLogin: () => true,
      start: page => { page._alive = true; return page._seq = (page._seq || 0) + 1; },
      current: (page, captured, seq) => page._alive && captured === binding && page._seq === seq,
      message: (_, error) => { throw error; },
    },
  };
  let definition;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/pages/export/index.js'), 'utf8'), {
    Page: value => { definition = value; },
    require: id => modules[id.split('/').at(-1)],
  }, { filename: 'export/index.js' });
  const page = { ...definition, data: structuredClone(definition.data) };
  page.setData = patch => Object.assign(page.data, patch);
  page.onLoad({ projectId: 'project' }); page.data.images = false;
  await page.refreshPreview();
  const value = (key, row = 0) => page.data.preview[row].cells.find(cell => cell.key === key).value;
  assert.ok(calls[0].url.startsWith('/api/export-preview'));
  assert.ok(calls[1].url.startsWith('/api/products?projectId=project'));
  assert.equal(calls.every(call => call.options.identity === binding), true);
  return { page, value };
}

test('company layout flows from metadata into actual preview: 0, 3, 4 and 6 money decimals without early rounding', async () => {
  for (const [moneyDecimals, price, amount] of [
    [0, 'USD 1', 'USD 2'],
    [3, 'USD 1.235', 'USD 2.469'],
    [4, 'USD 1.2346', 'USD 2.4691'],
    [6, 'USD 1.234567', 'USD 2.469134'],
  ]) {
    const layout = { moneyDecimals, volumeDecimals: 4, fieldSize: 13, bodySize: 15, fieldColor: '#245C46', bodyColor: '#1E3A5F', chineseFont: '黑体', latinFont: 'Arial' };
    const original = structuredClone(layout);
    const { page, value } = await preview(layout, [product({ currency: 'USD', unitPrice: 1.234567, quantity: 2 })]);
    assert.equal(value('unitPrice'), price); assert.equal(value('amount'), amount);
    assert.equal(page._metadata.layout, layout);
    assert.match(page.data.previewFieldStyle, /font-size:26rpx;color:#245C46;font-family:黑体/);
    assert.match(page.data.previewBodyStyle, /font-size:30rpx;color:#1E3A5F;font-family:Arial/);
    assert.equal(page.data.headerRows[0].text, '合成公司');
    assert.deepEqual(layout, original);
  }
});

test('preview preserves zero and unknown money/volume, derives quantity without MOQ and rounds volume once', async () => {
  const { value } = await preview({ moneyDecimals: 3, volumeDecimals: 6 }, [
    product({ unitPrice: 0, quantity: 0, cartons: 0, cartonCbm: 0 }),
    product({ unitPrice: 12, moq: 100, cartonQty: 24 }),
    product({ unitPrice: null, quantity: 48, cartons: 2, cartonQty: 24 }),
    product({ unitPrice: 1.234567, cartons: 2, cartonQty: 24, cartonCbm: .00000026 }),
  ]);
  for (const key of ['unitPrice', 'amount']) assert.equal(value(key), 'CNY 0.000');
  assert.equal(value('quantity'), '0');
  for (const key of ['cartonCbm', 'cbm']) assert.equal(value(key), '0.000000');
  assert.equal(value('unitPrice', 1), 'CNY 12.000'); assert.equal(value('amount', 1), '—');
  assert.equal(value('quantity', 1), '—'); assert.equal(value('cbm', 1), '—');
  assert.equal(value('unitPrice', 2), '—'); assert.equal(value('amount', 2), '—');
  assert.equal(value('cartonCbm', 2), '—'); assert.equal(value('cbm', 2), '—');
  assert.equal(value('quantity', 3), '48'); assert.equal(value('amount', 3), 'CNY 59.259');
  assert.equal(value('cartonCbm', 3), '0.000000'); assert.equal(value('cbm', 3), '0.000001');
});

test('four-decimal amount uses the raw product 1.2345 × 3, including quantity derived from cartons', async () => {
  const { value } = await preview({ moneyDecimals: 4, volumeDecimals: 6 }, [
    product({ unitPrice: 1.2345, quantity: 3 }),
    product({ unitPrice: 1.2345, cartons: 1, cartonQty: 3 }),
  ]);
  for (const row of [0, 1]) {
    assert.equal(value('unitPrice', row), 'CNY 1.2345');
    assert.equal(value('quantity', row), '3');
    assert.equal(value('amount', row), 'CNY 3.7035');
  }
});

test('missing or invalid decimal settings fall back to money 2 and volume 6', async () => {
  for (const decimals of [undefined, null, -1, 7, 1.5, '3', NaN, Infinity]) {
    const { value } = await preview({ moneyDecimals: decimals, volumeDecimals: decimals }, [product({ unitPrice: 1.234567, quantity: 2, cartons: 2, cartonCbm: .01234567 })]);
    assert.equal(value('unitPrice'), 'CNY 1.23'); assert.equal(value('amount'), 'CNY 2.47');
    assert.equal(value('cartonCbm'), '0.012346'); assert.equal(value('cbm'), '0.024691');
  }
  const { value } = await preview(undefined, [product({ unitPrice: 0, quantity: 0 })]);
  assert.equal(value('unitPrice'), 'CNY 0.00'); assert.equal(value('amount'), 'CNY 0.00');
});

test('volume decimals 0 and 4 apply equally to single-carton and total volume', async () => {
  for (const [volumeDecimals, single, total] of [[0, '1', '2'], [4, '1.2346', '2.4691']]) {
    const { value } = await preview({ moneyDecimals: 2, volumeDecimals }, [product({ cartons: 2, cartonCbm: 1.234567 })]);
    assert.equal(value('cartonCbm'), single); assert.equal(value('cbm'), total);
  }
});


test('new metadata keeps CNY in explicit headers, formats grouped money and removes duplicate SKU from remarks; old API remains compatible', async () => {
  const { value, page } = await preview({ moneyDecimals: 2, volumeDecimals: 3, deduplicateSku: true }, [product({ name: 'SKU001', sku: 'SKU001', exportRemarks: '独立纸盒', currency: 'CNY', unitPrice: 1234.5, quantity: 2 })], { unitPrice: { currencyPrefix: false, primary: true }, amount: { currencyPrefix: false, primary: true }, quantity: { width: 8.5, primary: true }, description: { primary: true } });
  assert.equal(value('unitPrice'), '1,234.50'); assert.equal(value('amount'), '2,469.00');
  assert.equal(page.data.preview[0].cells[0].primary, true);
  assert.equal(value('description'), '独立纸盒');
  assert.equal(page.data.preview[0].cells.find(cell => cell.key === 'quantity').width, 8.5 * 12);
  const mixed = await preview({ moneyDecimals: 2 }, [product({ currency: 'USD', unitPrice: 1234.5, quantity: 2 })], { unitPrice: { currencyPrefix: true }, amount: { currencyPrefix: true } });
  assert.equal(mixed.value('unitPrice'), 'USD 1,234.50'); assert.equal(mixed.value('amount'), 'USD 2,469.00');
  const old = await preview(undefined, [product({ unitPrice: 1234.5, quantity: 2 })]);
  assert.equal(old.value('unitPrice'), 'CNY 1234.50');
});
