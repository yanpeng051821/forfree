import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import sharp from 'sharp';
import { repository } from '../src/lib/db';
import { AppError } from '../src/lib/errors';
import { defaultProcurementTemplate, type ProcurementTemplate } from '../src/lib/procurement-template';
import { exportQuotation, quotationExportMetadata, type QuotationExportOptions } from '../src/lib/quotation-export';
import { emptyFields, type Product, type Project } from '../src/lib/types';
import { MarketService } from '../src/server/service';
import { effective } from './excel-value';

const project: Project = { id: 'project', name: '现场选品', market: '义乌', date: '2026-10-18', demo: false, createdAt: '2026-10-18T01:00:00Z' };
function product(patch: Partial<Product> = {}): Product {
  return { ...emptyFields, id: 'product', projectId: project.id, version: 1, photos: [],
    name: '陶瓷杯', supplier: '商户甲', createdAt: '2026-10-18T01:00:00Z', updatedAt: '2026-10-18T01:00:00Z', ...patch };
}
function allColumnsTemplate(): ProcurementTemplate {
  const template = defaultProcurementTemplate();
  template.columns.forEach(column => { column.enabled = true; });
  return template;
}
// Reference structure only; all product/company values in these tests are synthetic.
const referenceKeys = ['sku', 'cartons', 'pcsPerCarton', 'quantity', 'unitPrice', 'amount', 'description', 'image', 'cartonCbm', 'cbm', 'barcode'];
const referenceLabels = ['REF.', 'CTNS（箱数）', 'PCS/ CTN', 'QUANTITY(数量）', 'PRICE (价格RMB)', 'AMOUNT (RMB总金额)', '备注', '图片', '体积', '总体积(m³)', '条码号'];
function referenceTemplate(): ProcurementTemplate {
  const template = defaultProcurementTemplate();
  template.columns.sort((a, b) => (referenceKeys.indexOf(a.key) < 0 ? 99 : referenceKeys.indexOf(a.key))
    - (referenceKeys.indexOf(b.key) < 0 ? 99 : referenceKeys.indexOf(b.key)));
  template.columns.forEach(column => {
    const index = referenceKeys.indexOf(column.key);
    column.enabled = index >= 0;
    if (index >= 0) column.label = referenceLabels[index];
  });
  template.layout.headerSpan = 7;
  return template;
}
async function load(bytes: Buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as ExcelJS.Buffer);
  return workbook;
}
function view(workbook: ExcelJS.Workbook, template?: ProcurementTemplate, options: QuotationExportOptions = {}, name = '商户甲', currencies: string[] = []) {
  const metadata = quotationExportMetadata(template, options, currencies), sheet = workbook.getWorksheet(name)!;
  const header = metadata.headerRows.filter(row => row.enabled).length + 1;
  const number = (key: string) => {
    const index = metadata.columns.findIndex(column => column.key === key);
    assert.notEqual(index, -1, 'missing column ' + key);
    return index + 1;
  };
  return { sheet, metadata, header, number, cell: (key: string, index = 0) => sheet.getCell(header + 1 + index, number(key)) };
}
function allText(workbook: ExcelJS.Workbook) {
  const texts: string[] = [];
  workbook.eachSheet(sheet => sheet.eachRow(row => row.eachCell(cell => texts.push(cell.text))));
  return texts.join('\n');
}

test('参考表核心顺序标签精确保留，默认无追加业务列或禁用列，预览与工作簿一致', async () => {
  const template = referenceTemplate();
  template.customFields = [{ key: 'client_ref', label: '客户编号', width: 18 }, { key: 'packing', label: '标签要求', width: 26 }];
  const item = product({ sku: '000001', name: '示例商品', barcode: '0000123456789', custom: { client_ref: '客户001', packing: '使用客户标签' } });
  const snapshot = structuredClone({ template, item });
  for (const version of [0, 3]) {
    const settings = { ...template, version };
    for (const audience of ['selection', 'internal'] as const) {
      for (const businessFields of [undefined, []]) {
        if (audience === 'internal' && businessFields === undefined) continue;
        const options: QuotationExportOptions = { audience, businessFields };
        const bytes = await exportQuotation(project, [item], () => null, settings, options);
        const { sheet, metadata, header, cell } = view(await load(bytes), settings, options);
        assert.deepEqual(metadata.columns.map(column => column.key), [...referenceKeys, 'client_ref', 'packing']);
        assert.deepEqual(metadata.columns.map(column => column.label), [...referenceLabels, '客户编号', '标签要求']);
        assert.deepEqual((sheet.getRow(header).values as string[]).slice(1), [...referenceLabels, '客户编号', '标签要求']);
        assert.equal(sheet.columnCount, referenceKeys.length + 2);
        assert.equal(sheet.getCell('G1').master.address, 'A1'); assert.equal(sheet.getCell('H1').isMerged, false);
        assert.equal(sheet.autoFilter, `A${header}:M${header + 1}`);
        assert.equal(cell('sku').value, '000001'); assert.equal(cell('barcode').value, '0000123456789');
        assert.equal(cell('description').text, '示例商品'); assert.equal(cell('client_ref').value, '客户001');
        assert.equal(cell('packing').value, '使用客户标签');
        assert.deepEqual(metadata.blankPurchaseFields, []);
        assert.equal(metadata.columns.every(column => column.enabled && !column.hidden), true);
      }
    }
  }
  const defaults = defaultProcurementTemplate();
  assert.deepEqual(quotationExportMetadata(undefined).columns.map(column => column.key), defaults.columns.filter(column => column.enabled).map(column => column.key));
  assert.deepEqual({ template, item }, snapshot);
});

test('detail formulas use column keys under reordering, preserve explicit zero caches in XML and omit references to removed columns',async()=>{
  const template=referenceTemplate();
  const item=product({cartons:2,cartonQty:12,quantity:null,unitPrice:3,cartonCbm:.125,barcode:'00001234'});
  const options={images:false};
  const bytes=await exportQuotation(project,[item,{...item,id:'zero',quantity:0,unitPrice:0}],()=>null,template,options);
  const workbook=await load(bytes),current=view(workbook,template,options);
  assert.equal(current.cell('quantity').formula,'IF(COUNT(B7,C7)=2,B7*C7,"")');
  assert.equal(current.cell('amount').formula,'IF(COUNT(D7,E7)=2,D7*E7,"")');
  assert.equal(current.cell('cbm').formula,'IF(COUNT(B7,H7)=2,B7*H7,"")');
  assert.equal(current.cell('quantity',1).formula,undefined);assert.equal(current.cell('quantity',1).value,0);
  assert.equal(current.cell('amount',1).result,0);assert.equal(current.cell('cbm').result,.25);
  const zip=await JSZip.loadAsync(bytes),xml=await zip.file('xl/worksheets/sheet1.xml')!.async('string');
  assert.match(xml,/<c r="F8"[^>]*>[\s\S]*?<f>[^<]*<\/f><v>0<\/v><\/c>/);
  const bookXML=await zip.file('xl/workbook.xml')!.async('string');assert.match(bookXML,/fullCalcOnLoad="1"/);
  template.columns.reverse();
  const reordered=view(await load(await exportQuotation(project,[item],()=>null,template,options)),template,options);
  const formula=`IF(COUNT(${reordered.cell('cartons').address},${reordered.cell('pcsPerCarton').address})=2,${reordered.cell('cartons').address}*${reordered.cell('pcsPerCarton').address},"")`;
  assert.equal(reordered.cell('quantity').formula,formula);
  template.columns.find(column=>column.key==='cartonCbm')!.enabled=false;
  const without=view(await load(await exportQuotation(project,[item],()=>null,template,options)),template,options);
  assert.equal(without.cell('quantity').result,24);
  assert.equal(without.cell('cbm').formula,undefined);assert.equal(without.cell('cbm').value,.25);assert.equal(without.cell('amount').result,72);
});

test('default title changes only for unsaved default; saved template labels/title/footer remain literal',async()=>{
  const template=referenceTemplate();template.version=2;template.columns.find(column=>column.key==='decision')!.enabled=true;
  template.paymentTerms='现有条款原文';template.shippingMark='客户唛头';template.packingRequirements='包装原文';
  const metadata=quotationExportMetadata(template,{},[],[product()]);
  assert.equal(metadata.documentTitle,template.documentTitle);assert.equal(metadata.columns.find(column=>column.key==='decision')!.label,'处理决定');
  assert.equal(metadata.footer.packingRequirements,'包装原文');assert.equal(metadata.counts.products,1);assert.equal(metadata.counts.missingQuantity,1);
  const text=allText(await load(await exportQuotation(project,[product()],()=>null,template)));
  for(const original of [template.documentTitle,template.paymentTerms,template.shippingMark,template.packingRequirements])assert.ok(text.includes(original));
});

test('主分支默认11列按参考顺序标签导出，备注含对外备注，客户默认不追加业务或自定义列', async () => {
  const template = defaultProcurementTemplate();
  assert.deepEqual(template.columns.filter(column => column.enabled).map(column => column.key), referenceKeys);
  assert.deepEqual(template.columns.filter(column => column.enabled).map(column => column.label), referenceLabels);
  const item = product({ name: '示例商品', sku: '000123', cartons: 3, cartonQty: 24, unitPrice: 12.5, cartonCbm: .042,
    colors: '白', material: '陶瓷', dimensions: '高15cm', cartonDimensions: '40×30×35cm',
    exportRemarks: '示例备注：使用客户标签', barcode: '0000123456789', custom: { unconfigured: '不得自动追加' },
    notes: 'PERSONAL_NOTE_PRIVATE', description: 'RAW_SPEECH_PRIVATE', evaluation: 'PERSONAL_EVALUATION_PRIVATE', supplierContact: 'SUPPLIER_CONTACT_PRIVATE' });
  const bytes = await exportQuotation(project, [item], () => null, undefined);
  const { sheet, metadata, cell, header } = view(await load(bytes));
  assert.deepEqual(metadata.columns.map(column => column.key), referenceKeys);
  assert.deepEqual((sheet.getRow(header).values as string[]).slice(1), referenceLabels);
  assert.equal(sheet.columnCount, 11); assert.equal(cell('sku').value, '000123');
  assert.equal(cell('description').value, '示例商品 / 白 / 陶瓷 / 高15cm / 外箱：40×30×35cm / 示例备注：使用客户标签');
  assert.equal(effective(cell('quantity')), 72); assert.equal(effective(cell('amount')), 900);
  assert.equal(cell('cartonCbm').value, .042); assert.equal(cell('barcode').value, '0000123456789');
  assert.ok(Math.abs(Number(effective(cell('cbm'))) - .126) < 1e-12);
  assert.equal(metadata.columns.some(column => column.businessField), false);
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file('xl/sharedStrings.xml')!.async('string');
  for (const secret of ['PERSONAL_NOTE_PRIVATE', 'RAW_SPEECH_PRIVATE', 'PERSONAL_EVALUATION_PRIVATE', 'SUPPLIER_CONTACT_PRIVATE', '不得自动追加']) assert.equal(xml.includes(secret), false);
});

test('同商户混合币种移除RMB误标，隐藏币种列以数字格式显示原币种且不改模板', async () => {
  const template = defaultProcurementTemplate();
  template.layout.moneyDecimals = 3; template.layout.fieldColor = '#1E3A5F'; template.layout.bodyColor = '#374151';
  const products = [
    product({ id: 'cny', currency: 'CNY', quantity: 2, unitPrice: 12.345 }),
    product({ id: 'usd', currency: 'USD', quantity: 3, unitPrice: 4.5 }),
    product({ id: 'eur', currency: 'EUR', quantity: 0, unitPrice: 0 }),
  ];
  const snapshot = structuredClone({ template, products }), currencies = products.map(item => item.currency);
  const metadata = quotationExportMetadata(template, {}, currencies, products);
  assert.deepEqual(metadata.columns.map(column => column.key), referenceKeys);
  assert.deepEqual(metadata.columns.map(column => column.label), referenceLabels.map(label => label.replace(/RMB/g, '原币种')));
  assert.equal(metadata.columns.some(column => column.key === 'currency'), false);
  assert.equal(metadata.columns.some(column => column.label.includes('RMB')), false);
  const bytes = await exportQuotation(project, products, () => null, template);
  const workbook = await load(bytes), current = view(workbook, template, {}, '商户甲', currencies);
  assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), ['商户甲', '说明']);
  assert.deepEqual((current.sheet.getRow(current.header).values as string[]).slice(1), metadata.columns.map(column => column.label));
  products.forEach((item, index) => {
    const price = current.cell('unitPrice', index), amount = current.cell('amount', index);
    assert.equal(price.value, item.unitPrice); assert.equal(effective(amount), item.quantity! * item.unitPrice!);
    assert.equal(typeof price.value, 'number'); assert.equal(typeof effective(amount), 'number');
    assert.equal(price.numFmt, `"${item.currency} "#,##0.000`); assert.equal(amount.numFmt, price.numFmt);
    assert.equal(price.formula, undefined); assert.equal(price.font.color?.argb, 'FF374151');
  });
  assert.equal(current.sheet.getCell(current.header, current.number('unitPrice')).font.color?.argb, 'FF1E3A5F');
  metadata.columns.forEach((column, index) => assert.equal(current.sheet.getColumn(index + 1).width ?? 9, column.width));
  const zip = await JSZip.loadAsync(bytes);
  const styles = await zip.file('xl/styles.xml')!.async('string');
  for (const currency of currencies) assert.ok(styles.includes(`&quot;${currency} &quot;#,##0.000`));
  assert.deepEqual({ template, products }, snapshot);
  assert.deepEqual(quotationExportMetadata(template).columns.map(column => column.label), referenceLabels);
});

test('人民币或无币种上下文保持参考标签，筛选范围外外币不影响实际导出', async () => {
  const template = defaultProcurementTemplate(), options: QuotationExportOptions = { scope: 'confirmed' };
  for (const currencies of [undefined, [], ['CNY']]) {
    assert.deepEqual(quotationExportMetadata(template, options, currencies).columns.map(column => column.label), referenceLabels);
  }
  const workbook = await load(await exportQuotation(project, [
    product({ confirmed: true, currency: 'CNY', quantity: 2, unitPrice: 5 }),
    product({ id: 'excluded', confirmed: false, currency: 'USD', unitPrice: 7 }),
  ], () => null, template, options));
  const current = view(workbook, template, options, '商户甲', ['CNY']);
  assert.deepEqual((current.sheet.getRow(current.header).values as string[]).slice(1), referenceLabels);
  assert.equal(current.cell('unitPrice').numFmt, '#,##0.00');
  assert.equal(effective(current.cell('amount')), 10);
});

test('参考主表A:G居中有框，图片体积条码保持辅助层级，人民币表头明示后数值不重复币种', async () => {
  const template = defaultProcurementTemplate(), snapshot = structuredClone(template);
  const item = product({ name: 'BQY15280', sku: 'BQY15280', exportRemarks: '纸盒独立包装', cartons: 2,
    cartonQty: 24, quantity: 0, unitPrice: 13.35, cartonCbm: .13, barcode: '18' });
  const workbook = await load(await exportQuotation(project, [item], () => null, template));
  const current = view(workbook, template), metadata = quotationExportMetadata(template, {}, ['CNY'], [item]);
  assert.equal(metadata.headerSpan, 7); assert.equal(current.sheet.getCell('G1').master.address, 'A1');
  assert.equal(metadata.layout.fieldHeight, 32); assert.equal(current.sheet.getRow(current.header).height, 32);
  assert.equal(current.sheet.getCell(current.header, 1).alignment.vertical, 'middle');
  assert.equal(current.sheet.getCell('H1').isMerged, false);
  assert.ok(metadata.columns.reduce((width, column) => width + column.width, 0) <= 145);
  assert.equal(current.cell('description').value, '纸盒独立包装');
  for (const key of ['sku', 'cartons', 'pcsPerCarton', 'quantity', 'unitPrice', 'amount', 'description']) {
    assert.equal(current.cell(key).alignment.horizontal, 'center'); assert.equal(current.cell(key).border.bottom?.style, 'thin');
  }
  for (const key of ['image', 'cartonCbm', 'cbm', 'barcode']) assert.equal(current.cell(key).border.bottom, undefined);
  for (const key of ['unitPrice', 'amount']) {
    assert.equal(current.cell(key).numFmt, '#,##0.00');
    assert.equal(metadata.columns.find(column => column.key === key)!.currencyPrefix, false);
  }
  assert.equal(effective(current.cell('amount')), 0); assert.equal(current.sheet.getRow(current.header + 1).height, 36);
  template.columns.find(column => column.key === 'unitPrice')!.label = '现场单价';
  const plainHeader = view(await load(await exportQuotation(project, [item], () => null, template)), template);
  assert.equal(plainHeader.cell('unitPrice').numFmt, '"CNY "#,##0.00');
  template.columns.find(column => column.key === 'unitPrice')!.label = snapshot.columns.find(column => column.key === 'unitPrice')!.label;
  assert.deepEqual(template, snapshot);
});

test('参考字段表头压到32pt，显式较高行高及自定义多行表头继续保留', async () => {
  const item = product({ currency: 'USD', unitPrice: 2, quantity: 24 });
  const template = referenceTemplate(), snapshot = structuredClone(template);
  const standard = view(await load(await exportQuotation(project, [item], () => null, template)), template);
  assert.equal(standard.sheet.getRow(standard.header).height, 32);
  for (const height of [64, 80]) {
    const custom = structuredClone(template); custom.layout.fieldHeight = height;
    const current = view(await load(await exportQuotation(project, [item], () => null, custom)), custom);
    assert.equal(current.sheet.getRow(current.header).height, height);
    assert.equal(quotationExportMetadata(custom, {}, ['USD'], [item]).layout.fieldHeight, height);
  }
  const custom = structuredClone(template); custom.columns.find(column => column.key === 'sku')!.label = '客户货号\n第二行\n第三行\n第四行';
  const multi = view(await load(await exportQuotation(project, [item], () => null, custom)), custom);
  assert.ok(multi.sheet.getRow(multi.header).height! > 32);
  assert.deepEqual(template, snapshot);
});

test('显式币种列保留独立币种显示及普通金额格式，自定义货币标签仅替换RMB', async () => {
  const template = allColumnsTemplate();
  template.columns.find(column => column.key === 'unitPrice')!.label = '现场单价\nrmb';
  template.columns.find(column => column.key === 'amount')!.label = '商品金额（已注明原币种）';
  const item = product({ currency: 'USD', quantity: 2, unitPrice: 4.5 }), snapshot = structuredClone(template);
  const current = view(await load(await exportQuotation(project, [item], () => null, template)), template, {}, '商户甲', ['USD']);
  assert.equal(current.sheet.getCell(current.header, current.number('unitPrice')).value, '现场单价\n原币种');
  assert.equal(current.sheet.getCell(current.header, current.number('amount')).value, '商品金额（已注明原币种）');
  assert.equal(current.cell('currency').value, 'USD'); assert.equal(current.cell('unitPrice').value, 4.5);
  assert.equal(effective(current.cell('amount')), 9);
  assert.equal(current.cell('unitPrice').numFmt, '#,##0.00'); assert.equal(current.cell('amount').numFmt, '#,##0.00');
  assert.deepEqual(template, snapshot);
});

test('数量优先填写值，否则仅箱数及装箱数已知时推导，金额体积缺值留空且保留零', async () => {
  const cases: { fields: Partial<Product>; quantity: number | null; amount: number | null; cbm: number | null }[] = [
    { fields: { cartons: 3, cartonQty: 24, unitPrice: 12.5, cartonCbm: .042 }, quantity: 72, amount: 900, cbm: .126 },
    { fields: { quantity: 50, cartons: 3, cartonQty: 24, unitPrice: 12.5, cartonCbm: .042 }, quantity: 50, amount: 625, cbm: .126 },
    { fields: { quantity: 0, cartons: 3, cartonQty: 24, unitPrice: 12.5 }, quantity: 0, amount: 0, cbm: null },
    { fields: { cartons: 0, cartonQty: 24, unitPrice: 12.5, cartonCbm: .042 }, quantity: 0, amount: 0, cbm: 0 },
    { fields: { cartons: 3, cartonQty: 0, unitPrice: 12.5, cartonCbm: 0 }, quantity: 0, amount: 0, cbm: 0 },
    { fields: { cartons: 3, cartonQty: 24, unitPrice: 0, cartonCbm: .042 }, quantity: 72, amount: 0, cbm: .126 },
    { fields: { cartons: null, cartonQty: 24, unitPrice: 12.5, cartonCbm: .042, moq: 100 }, quantity: null, amount: null, cbm: null },
    { fields: { cartons: 3, cartonQty: null, unitPrice: 12.5, cartonCbm: .042, moq: 100 }, quantity: null, amount: null, cbm: .126 },
    { fields: { cartons: 3, cartonQty: 24, unitPrice: null, cartonCbm: null }, quantity: 72, amount: null, cbm: null },
    { fields: { quantity: 17, unitPrice: 2, moq: 100 }, quantity: 17, amount: 34, cbm: null },
    { fields: { cartons: 0, cartonQty: null, unitPrice: 0, cartonCbm: null }, quantity: null, amount: null, cbm: null },
    { fields: { moq: 100, unitPrice: 12.5 }, quantity: null, amount: null, cbm: null },
  ];
  const items = cases.map(({ fields }, index) => product({ id: String(index), ...fields }));
  const snapshot = structuredClone(items), template = referenceTemplate();
  const workbook = await load(await exportQuotation(project, items, () => null, template));
  const { cell } = view(workbook, template);
  cases.forEach(({ fields, quantity, amount, cbm }, index) => {
    assert.equal(cell('cartons', index).value, fields.cartons ?? null, 'cartons ' + index);
    assert.equal(effective(cell('quantity', index)), quantity, 'quantity ' + index);
    assert.equal(effective(cell('amount', index)), amount, 'amount ' + index);
    if (cbm === null) assert.equal(effective(cell('cbm', index)), null, 'cbm ' + index);
    else assert.ok(Math.abs(Number(effective(cell('cbm', index))) - cbm) < 1e-12, 'cbm ' + index);
    assert.equal(cell('amount', index).numFmt, '#,##0.00'); assert.equal(cell('cbm', index).numFmt, '0.000000');
  });
  items.forEach((item, index) => { for (const column of view(workbook, template).metadata.columns) {
    const derived=['amount','cbm'].includes(column.key) || column.key==='quantity' && item.quantity==null;
    if(derived)assert.match(cell(column.key,index).formula,/^IF\(COUNT\(/);else assert.equal(cell(column.key,index).formula,undefined);
  } });
  assert.deepEqual(items, snapshot);
});

test('旧商品缺少新增属性时保持空白，不从MOQ或自定义同名键替代核心值', async () => {
  const legacy = { ...product({ cartonQty: 24, cartonCbm: .042, moq: 100, unitPrice: 12.5 }),
    custom: { sku: 'CUSTOM_SKU', quantity: '999', amount: '9999' } } as Partial<Product>;
  delete legacy.cartons; delete legacy.quantity; delete legacy.barcode;
  delete legacy.exportRemarks;
  const template = referenceTemplate();
  const { cell } = view(await load(await exportQuotation(project, [legacy as Product], () => null, template)), template);
  for (const key of ['cartons', 'quantity', 'amount', 'cbm']) assert.equal(effective(cell(key)), null);
  assert.equal(cell('sku').text, ''); assert.equal(cell('barcode').text, '');
  delete legacy.custom;
  template.customFields = [{ key: 'client_ref', label: '客户货号', width: 20 }];
  const missing = view(await load(await exportQuotation(project, [legacy as Product], () => null, template)), template);
  assert.equal(missing.cell('client_ref').value, null);
});

test('禁用列及私有自定义值不进入xlsx XML，公开自定义值仅取自product.custom并保持文本', async () => {
  const template = referenceTemplate();
  template.columns.find(column => column.key === 'barcode')!.enabled = false;
  template.customFields = [
    { key: 'client_ref', label: '客户货号', width: 20 }, { key: 'empty_value', label: '空字符串', width: 20 },
    { key: 'missing', label: '未填写', width: 20 }, { key: 'constructor', label: '公司代码', width: 20 },
    { key: 'supplier_contact', label: '私有联系方式', width: 20 },
  ];
  const item = product({ currency: 'EUR', barcode: 'HIDDEN_BARCODE', description: 'RAW_PRIVATE', notes: 'NOTE_PRIVATE', evaluation: 'EVAL_PRIVATE', supplierContact: 'CONTACT_PRIVATE',
    custom: { client_ref: '=HYPERLINK("literal")', empty_value: '', supplier_contact: 'CUSTOM_CONTACT_PRIVATE', unused: 'UNCONFIGURED_PRIVATE' } });
  const bytes = await exportQuotation(project, [item], () => { throw new Error('image disabled'); }, template, { images: false });
  const { sheet, metadata, cell, header } = view(await load(bytes), template, { images: false });
  assert.equal(metadata.columns.some(column => ['barcode', 'image', 'currency', 'supplier', 'decision', 'supplier_contact'].includes(column.key)), false);
  assert.equal(sheet.columnCount, metadata.columns.length);
  assert.equal(cell('client_ref').value, '=HYPERLINK("literal")'); assert.equal(cell('client_ref').formula, undefined);
  assert.equal(cell('empty_value').text, ''); assert.equal(cell('missing').value, null); assert.equal(cell('constructor').value, null);
  assert.equal(sheet.getRow(header + 1).cellCount, metadata.columns.length);
  const zip = await JSZip.loadAsync(bytes);
  const xml = (await Promise.all(Object.values(zip.files).filter(file => file.name.endsWith('.xml')).map(file => file.async('string')))).join('\n');
  for (const secret of ['HIDDEN_BARCODE', 'RAW_PRIVATE', 'NOTE_PRIVATE', 'EVAL_PRIVATE', 'CONTACT_PRIVATE', 'CUSTOM_CONTACT_PRIVATE', 'UNCONFIGURED_PRIVATE', '私有联系方式']) assert.equal(xml.includes(secret), false, secret);
  assert.equal(xml.includes('<dataValidation '), false);
});

test('显式业务列按请求顺序去重追加，非法字段及受众拒绝，客户受众不放出内部字段', async () => {
  const template = referenceTemplate(); template.customFields = [{ key: 'client_ref', label: '客户货号', width: 20 }];
  const options: QuotationExportOptions = { businessFields: ['material', 'name', 'material', 'evaluation', 'supplierContact'] };
  const { metadata } = view(await load(await exportQuotation(project, [product()], () => null, template, options)), template, options);
  assert.deepEqual(metadata.columns.map(column => column.key), [...referenceKeys, 'client_ref', 'business:material', 'business:name']);
  assert.throws(() => quotationExportMetadata(template, { businessFields: ['invalid' as never] }), (error: unknown) => error instanceof AppError && error.code === 'VALIDATION');
  assert.throws(() => quotationExportMetadata(template, { audience: 'invalid' as never }), (error: unknown) => error instanceof AppError && error.code === 'VALIDATION');
});

test('按商户分 sheet，现场单价原币种保留，MOQ不参与采购计算且未知值留空', async () => {
  const template = allColumnsTemplate();
  const options: QuotationExportOptions = { businessFields: ['moq', 'leadTimeDays', 'tradeTerms'] };
  const products = [
    product({ sku: '', moq: 100, cartonQty: 24, cartonCbm: .042, unitPrice: 12.5, confirmed: true, colors: '白', material: '陶瓷', dimensions: '高15cm', tradeTerms: '出厂价', leadTimeDays: 18 }),
    product({ id: 'usd', sku: '0002', currency: 'USD', unitPrice: 0, cartonQty: 0, cartonCbm: 0 }),
    product({ id: 'unknown', supplier: '商户乙', currency: 'EUR' }),
  ];
  const original = structuredClone({ project, products, template });
  const workbook = await load(await exportQuotation(project, products, () => null, template, options));
  assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), ['商户甲', '商户乙', '说明']);
  const { sheet, cell, number, metadata } = view(workbook, template, options, '商户甲', products.map(product => product.currency));
  assert.equal(sheet.getCell('A5').value, '商品资料表 / PRODUCT RECORD');
  assert.equal(cell('sku').text, '');
  assert.match(cell('description').text, /陶瓷杯.*白.*陶瓷.*高15cm/);
  assert.equal(cell('unitPrice').value, 12.5); assert.equal(cell('currency').value, 'CNY');
  assert.equal(cell('unitPrice', 1).value, 0); assert.equal(cell('currency', 1).value, 'USD');
  assert.equal(cell('pcsPerCarton').value, 24); assert.equal(cell('pcsPerCarton', 1).value, 0);
  assert.equal(cell('cartonCbm').value, .042); assert.equal(cell('cartonCbm', 1).value, 0);
  assert.equal(cell('business:moq').value, 100); assert.equal(cell('business:leadTimeDays').value, 18);
  assert.equal(cell('business:tradeTerms').value, '出厂价');
  assert.equal(cell('decision').value, '已核对'); assert.equal(cell('decision', 1).value, '待核对');
  assert.deepEqual(cell('decision').dataValidation.formulae, ['"待核对,已核对"']);
  for (const key of ['cartons', 'quantity', 'amount', 'cbm']) {
    assert.equal(effective(cell(key)), null); assert.equal(effective(cell(key, 1)), null);
  }
  assert.equal(cell('barcode').text, ''); assert.equal(cell('barcode', 1).text, '');
  assert.equal(sheet.getCell(6, number('unitPrice')).value, metadata.columns.find(column => column.key === 'unitPrice')!.label);
  assert.match(String(sheet.getCell(6, number('unitPrice')).note), /现场记录价格/);
  const unknown = view(workbook, template, options, '商户乙');
  for (const key of ['unitPrice', 'pcsPerCarton', 'cartonCbm', 'business:moq', 'business:leadTimeDays']) assert.equal(effective(unknown.cell(key)), null);
  assert.equal(unknown.cell('currency').value, 'EUR');
  for (const name of ['商户甲', '商户乙']) {
    const current = view(workbook, template, options, name);
    for (let r = current.header + 1; current.sheet.getRow(r).getCell(number('description')).text; r++) current.sheet.getRow(r).eachCell(cell => {
      if(cell.formula)assert.match(cell.formula,/^IF\(COUNT\(/);
    });
  }
  assert.match(allText(workbook), /不同币种不混加/); assert.match(allText(workbook), /缺少计算所需数值时留空/);
  assert.deepEqual({ project, products, template }, original);
});

test('selection不写入内部内容，internal默认保留完整记录且显式请求覆盖默认字段', async () => {
  const template = allColumnsTemplate();
  template.customFields = [{ key: 'notes', label: '私有备注', width: 20 }];
  const item = { ...product({ description: 'RAW_PRIVATE', notes: 'NOTE_PRIVATE', evaluation: 'EVAL_PRIVATE', rating: 4,
    supplierContact: 'CONTACT_PRIVATE', cartonDimensions: '40×30×35cm', colors: '蓝色', favorite: true,
    taskName: '内部任务', taskMarket: '内部市场', taskDate: '2026-10-17', demo: true,
    exportRemarks: '客户可见标签要求',
    photos: [{ id: 'one', url: '', name: 'one.jpg' }, { id: 'two', url: '', name: 'two.jpg' }] }), custom: { notes: 'CUSTOM_PRIVATE' } };
  const options: QuotationExportOptions = { businessFields: ['description', 'notes', 'evaluation', 'rating', 'supplierContact', 'dimensions'] };
  const image = await sharp({create:{width:20,height:20,channels:3,background:'#ffffff'}}).png().toBuffer();
  const selected = await load(await exportQuotation(project, [item], () => image, template, options));
  const selectedView = view(selected, template, options);
  assert.match(selectedView.cell('description').text, /陶瓷杯.*蓝色.*40×30×35cm/);
  assert.match(selectedView.cell('description').text, /客户可见标签要求/);
  for (const secret of ['RAW_PRIVATE', 'NOTE_PRIVATE', 'EVAL_PRIVATE', 'CONTACT_PRIVATE', 'CUSTOM_PRIVATE']) assert.equal(allText(selected).includes(secret), false);
  for (const key of ['notes', 'business:description', 'business:notes', 'business:evaluation', 'business:rating', 'business:supplierContact']) {
    assert.equal(selectedView.metadata.columns.some(column => column.key === key), false, key + ' must be absent, not hidden');
  }
  const internalDefault = await load(await exportQuotation(project, [item], () => image, template, { audience: 'internal' }));
  const defaultView = view(internalDefault, template, { audience: 'internal' });
  assert.deepEqual(defaultView.metadata.columns.filter(column => column.businessField).map(column => column.businessField),
    ['name', 'supplierContact', 'colors', 'material', 'dimensions', 'weightG', 'moq', 'cartonDimensions', 'leadTimeDays', 'tradeTerms', 'description', 'notes', 'favorite', 'rating', 'evaluation', 'photoCount', 'project', 'market', 'date', 'recordDate', 'demo']);
  assert.equal(defaultView.cell('notes').value, 'CUSTOM_PRIVATE');
  assert.equal(defaultView.cell('business:description').value, 'RAW_PRIVATE');
  assert.equal(defaultView.cell('business:notes').value, 'NOTE_PRIVATE');
  assert.equal(defaultView.cell('business:evaluation').value, 'EVAL_PRIVATE');
  assert.equal(defaultView.cell('business:rating').value, 4);
  assert.equal(defaultView.cell('business:supplierContact').value, 'CONTACT_PRIVATE');
  assert.equal(defaultView.cell('business:name').value, '陶瓷杯');
  assert.equal(defaultView.cell('business:favorite').value, '已收藏');
  assert.equal(defaultView.cell('business:photoCount').value, 2);
  assert.equal(defaultView.cell('business:project').value, '内部任务');
  assert.equal(defaultView.cell('business:market').value, '内部市场');
  assert.equal(defaultView.cell('business:date').value, '2026-10-17');
  assert.equal(defaultView.cell('business:recordDate').value, '2026-10-18');
  assert.equal(defaultView.cell('business:demo').value, '模拟数据');
  const emptyOptions: QuotationExportOptions = { audience: 'internal', businessFields: [] };
  const noExtras = view(await load(await exportQuotation(project, [item], () => image, template, emptyOptions)), template, emptyOptions);
  assert.equal(noExtras.metadata.columns.some(column => column.businessField), false);
  assert.equal(noExtras.cell('notes').value, 'CUSTOM_PRIVATE');
  const internalOptions: QuotationExportOptions = { audience: 'internal', businessFields: ['description', 'notes', 'evaluation', 'rating', 'supplierContact'] };
  const internal = await load(await exportQuotation(project, [item], () => image, template, internalOptions));
  const internalView = view(internal, template, internalOptions);
  assert.equal(internalView.cell('business:description').value, 'RAW_PRIVATE');
  assert.equal(internalView.cell('business:notes').value, 'NOTE_PRIVATE');
  assert.equal(internalView.cell('business:evaluation').value, 'EVAL_PRIVATE');
  assert.equal(internalView.cell('business:rating').value, 4);
  assert.equal(internalView.cell('business:supplierContact').value, 'CONTACT_PRIVATE');
  assert.equal(internalView.cell('notes').value, 'CUSTOM_PRIVATE');
  assert.deepEqual(internalView.metadata.columns.filter(column => column.businessField).map(column => column.businessField), internalOptions.businessFields);
  assert.equal(internalView.metadata.columns.some(column => column.key === 'business:moq'), false);
});

test('模板顺序不被商品名称改变，禁用说明列完全省略，名称仅显式追加且不替代REF', async () => {
  const template = allColumnsTemplate();
  template.columns.find(column => column.key === 'description')!.enabled = false;
  template.columns = [...template.columns].reverse();
  const workbook = await load(await exportQuotation(project, [product({ sku: '', name: '没有货号的商品', moq: 100 })], () => null, template));
  const { cell, sheet, metadata } = view(workbook, template);
  assert.deepEqual(metadata.columns.map(column => column.key), template.columns.filter(column => column.enabled).map(column => column.key));
  assert.equal(sheet.getColumn(1).hidden, false); assert.equal(cell('sku').text, '');
  assert.equal(metadata.columns.some(column => column.key === 'description' || column.businessField), false);
  assert.equal(allText(workbook).includes('没有货号的商品'), false);
  const options: QuotationExportOptions = { businessFields: ['name', 'moq', 'name'] };
  const explicit = view(await load(await exportQuotation(project, [product({ name: '没有货号的商品', moq: 100 })], () => null, template, options)), template, options);
  assert.deepEqual(explicit.metadata.columns.slice(-2).map(column => column.key), ['business:name', 'business:moq']);
  assert.equal(explicit.cell('business:name').value, '没有货号的商品'); assert.equal(explicit.cell('business:moq').value, 100);
  assert.equal(explicit.cell('sku').text, '');
});

test('多行表头、公司字体字号、列顺序宽度、自定义值和打印设置按模板适配', async () => {
  const template = allColumnsTemplate();
  template.version = 2; template.company = '样例公司\n第二行'; template.companyEnglish = 'EXAMPLE COMPANY';
  template.address = 'Room 620 Yiwu'; template.contact = 'TEL:000'; template.documentTitle = '客户选品 / SELECTION';
  template.paymentTerms = '待协商'; template.shippingMark = '客户001'; template.packingRequirements = '独立包装';
  template.layout.headerRows[0] = { ...template.layout.headerRows[0], font: '宋体', size: 24, height: 30, bold: false, align: 'left' };
  template.layout.headerRows[2].enabled = false;
  template.layout.headerRows.push({ key: 'header_customer', label: '客户信息', text: '客户编号001\n核对规格', enabled: true, font: 'Arial', size: 12, bold: true, align: 'right', height: 18 });
  template.layout.latinFont = 'Arial'; template.layout.chineseFont = '黑体'; template.layout.bodySize = 13;
  template.layout.fieldSize = 11; template.layout.totalSize = 10; template.layout.bodyHeight = 64;
  template.layout.headerSpan = 30;
  template.layout.moneyDecimals = 3; template.layout.volumeDecimals = 4; template.layout.alignment = 'left'; template.layout.border = 'medium';
  template.columns = [...template.columns.slice(4), ...template.columns.slice(0, 4)];
  template.columns.find(column => column.key === 'sku')!.width = 25;
  template.columns.find(column => column.key === 'unitPrice')!.label = '现场记录价格\n原币种';
  template.customFields = [{ key: 'client_ref', label: '客户货号', width: 24 }, { key: 'inspection', label: '验货要求', width: 20 }];
  const item = { ...product({ sku: '000123', unitPrice: 12.5, cartonCbm: .042 }), custom: { client_ref: '=literal' } };
  const workbook = await load(await exportQuotation(project, [item], () => null, template));
  const { sheet, cell, number, header, metadata } = view(workbook, template);
  assert.equal(sheet.getCell('A1').value, '样例公司\n第二行'); assert.equal(sheet.getCell('A1').font.name, '宋体');
  assert.equal(sheet.getCell('A1').font.size, 24); assert.equal(sheet.getCell('A1').font.bold ?? false, false);
  assert.equal(sheet.getCell('A1').alignment.horizontal, 'left'); assert.ok(sheet.getRow(1).height! > 30);
  assert.equal(sheet.getCell('A2').value, 'EXAMPLE COMPANY'); assert.equal(sheet.getCell('A2').font.size, 18);
  assert.equal(sheet.getCell('A3').value, 'TEL:000'); assert.equal(sheet.getCell('A4').value, template.documentTitle);
  assert.equal(sheet.getCell('A5').value, '客户编号001\n核对规格'); assert.equal(sheet.getCell('A5').alignment.horizontal, 'right');
  assert.equal(sheet.getColumn(number('sku')).width, 25);
  assert.deepEqual(metadata.columns.map(column => column.key), [...template.columns.map(column => column.key), 'client_ref', 'inspection']);
  assert.equal(cell('sku').value, '000123'); assert.equal(cell('sku').font.name, 'Arial');
  assert.equal(cell('description').font.name, '黑体'); assert.equal(cell('description').font.size, 13);
  assert.equal(cell('description').alignment.horizontal, 'left'); assert.equal(cell('description').border.bottom!.style, 'medium');
  assert.equal(cell('unitPrice').numFmt, '#,##0.000'); assert.equal(cell('cartonCbm').numFmt, '0.0000');
  assert.equal(cell('client_ref').value, '=literal'); assert.equal(cell('client_ref').formula, undefined);
  assert.equal(cell('inspection').value, null); assert.equal(sheet.getColumn(number('client_ref')).width, 24);
  assert.equal(sheet.getCell(1, metadata.columns.length).master.address, 'A1');
  assert.equal(sheet.getCell(1, metadata.columns.length + 1).isMerged, false);
  assert.equal(sheet.getRow(header).getCell(number('sku')).font.size, 11);
  assert.equal(sheet.pageSetup.printTitlesRow, '1:6');
  const frozen = sheet.views[0]; assert.equal(frozen.state, 'frozen');
  assert.ok('ySplit' in frozen); assert.equal(frozen.ySplit, 6);
  assert.equal(sheet.pageSetup.orientation, 'landscape'); assert.equal(sheet.pageSetup.fitToPage, true);
  assert.equal(sheet.pageSetup.fitToWidth, 1);
  assert.match(sheet.pageSetup.printArea!, new RegExp('^A1:' + sheet.getColumn(metadata.columns.length).letter));
  assert.match(allText(workbook), /公司付款条款：待协商/); assert.match(allText(workbook), /公司唛头：客户001/);
});

test('商户TOTAL按币种分别汇总，缺值留空、明确0计入且不把单价相加', async () => {
  const template = referenceTemplate();
  const products = [
    product({ id: 'a', currency: 'CNY', cartons: 2, cartonQty: 24, quantity: 50, unitPrice: 2.5, cartonCbm: .1 }),
    product({ id: 'b', currency: 'CNY', cartons: 0, quantity: 0, unitPrice: 0, cartonCbm: 0 }),
    product({ id: 'c', currency: 'USD', cartons: null, quantity: 3, unitPrice: 10, cartonCbm: .1 }),
  ];
  const current = view(await load(await exportQuotation(project, products, () => null, template)), template);
  const totals: ExcelJS.Row[] = [];
  current.sheet.eachRow(row => { if (row.getCell(current.number('sku')).text.startsWith('TOTAL')) totals.push(row); });
  assert.equal(totals.length, 2);
  const value = (row: ExcelJS.Row, key: string) => row.getCell(current.number(key));
  assert.equal(value(totals[0], 'sku').value, 'TOTAL CNY');
  assert.equal(value(totals[0], 'quantity').result, 50);
  assert.equal(value(totals[0], 'amount').result, 125);
  assert.equal(value(totals[0], 'cartons').result, 2);
  assert.equal(value(totals[0], 'cbm').result, .2);
  assert.equal(value(totals[0], 'unitPrice').value, null);
  assert.match(value(totals[0], 'quantity').formula!, /COUNT\(D7:D8\)=2/);
  assert.equal(value(totals[1], 'quantity').result, 3);
  assert.equal(value(totals[1], 'amount').result, 30);
  assert.ok(value(totals[1], 'cartons').result == null || value(totals[1], 'cartons').result === '');
  assert.ok(value(totals[1], 'cbm').result == null || value(totals[1], 'cbm').result === '');
  assert.match(value(totals[1], 'amount').numFmt, /USD/);
  assert.equal(current.sheet.autoFilter, `A${current.header}:K${current.header + 3}`);
});

test('商品缺采购数量或单价时不生成貌似完整的商品合计', async () => {
  const template = referenceTemplate();
  const current = view(await load(await exportQuotation(project, [product({quantity: 1, unitPrice: 4}), product({id:'unknown'})], () => null, template)), template);
  const row = current.sheet.getRow(current.header + 4);
  assert.equal(row.getCell(current.number('sku')).value, 'TOTAL');
  for (const key of ['quantity', 'amount', 'cartons', 'cbm']) {
    const cell = row.getCell(current.number(key));
    assert.match(cell.formula!, /^IF\(COUNT/);
    assert.ok(cell.result == null || cell.result === '');
  }
});

test('500件同店TOTAL压缩连续范围，交错币种也不超过Excel函数参数上限', async () => {
  const template = referenceTemplate();
  for (const mixed of [false, true]) {
    const items = Array.from({ length: 500 }, (_, index) => product({id: String(index), currency: mixed && index % 2 ? 'USD' : 'CNY', quantity: 1, unitPrice: 2}));
    const current = view(await load(await exportQuotation(project, items, () => null, template)), template);
    const totals: ExcelJS.Cell[] = [];
    current.sheet.eachRow(row => { if (row.getCell(current.number('sku')).text.startsWith('TOTAL')) totals.push(row.getCell(current.number('amount'))); });
    assert.equal(totals.length, mixed ? 2 : 1);
    for (const cell of totals) {
      assert.equal(cell.result, mixed ? 500 : 1000);
      const argumentsList = /COUNT\(([^)]+)\)/.exec(cell.formula!)![1].split(',');
      assert.ok(argumentsList.length <= 255);
      if (!mixed) assert.deepEqual(argumentsList, ['F7:F506']);
    }
  }
});

test('窄模板仅在输出中扩宽价格金额，保留字号币种精度且表头给筛选按钮留空间', async () => {
  const template = referenceTemplate();
  template.layout.fieldHeight = 18; template.layout.fieldSize = 11;
  template.columns.forEach(column => { if (['unitPrice', 'amount'].includes(column.key)) column.width = 10; });
  const item = product({ quantity: 360, unitPrice: 8.3 });
  const snapshot = structuredClone(template);
  const current = view(await load(await exportQuotation(project, [item], () => null, template)), template);
  for (const key of ['unitPrice', 'amount']) {
    assert.ok(current.sheet.getColumn(current.number(key)).width! >= (key === 'unitPrice' ? 11 : 14));
    assert.notEqual(current.cell(key).alignment.shrinkToFit, true);
    assert.equal(current.cell(key).font.size, template.layout.bodySize);
    assert.equal(current.cell(key).alignment.horizontal, 'center');
    assert.notEqual(current.cell(key).alignment.wrapText, true);
    assert.equal(current.cell(key).numFmt, '#,##0.00');
  }
  assert.equal(effective(current.cell('amount')), item.quantity! * item.unitPrice!);
  assert.ok(current.sheet.getRow(current.header).height! >= 32);
  assert.deepEqual(template, snapshot);
});

test('禁用宽列不占据表格，headerSpan按实际列数限制，字段与正文多行自动增高', async () => {
  const template = allColumnsTemplate();
  template.company = '公司名称'.repeat(35);
  template.layout.headerSpan = 15; template.layout.fieldHeight = 16; template.layout.fieldSize = 10;
  template.layout.bodyHeight = 40; template.layout.headerRows[0].size = 12;
  template.columns.forEach(column => { column.width = 5; if (['image', 'description', 'barcode', 'cartonCbm', 'cbm'].includes(column.key)) { column.enabled = false; column.width = 80; } });
  template.columns.find(column => column.key === 'sku')!.label = '货号\n第二行\n第三行\n第四行';
  const workbook = await load(await exportQuotation(project, [product({ sku: '商品\n第二行\n第三行\n第四行\n第五行' })], () => null, template));
  const hidden = view(workbook, template);
  assert.equal(hidden.metadata.columns.some(column => column.key === 'image'), false);
  assert.equal(hidden.metadata.columns.some(column => column.width === 80), false);
  assert.ok(hidden.sheet.getRow(1).height! > 30);
  assert.equal(hidden.sheet.getCell(1, hidden.metadata.columns.length).master.address, 'A1');
  assert.equal(hidden.sheet.getCell(1, hidden.metadata.columns.length + 1).isMerged, false);
  assert.ok(hidden.sheet.getRow(hidden.header).height! > 40); assert.ok(hidden.cell('sku').fullAddress.row > hidden.header);
  assert.ok(hidden.sheet.getRow(hidden.header + 1).height! > 40);
  const visibleTemplate = structuredClone(template);
  visibleTemplate.columns.forEach(column => { column.enabled = true; });
  const visible = view(await load(await exportQuotation(project, [product()], () => null, visibleTemplate)), visibleTemplate);
  assert.ok(hidden.sheet.getRow(1).height! > visible.sheet.getRow(1).height!);
});

test('全部商品照片顺序嵌入同一行，异步读取和移动图片列正确，禁用图片不读取', async () => {
  const buffer = await sharp({ create: { width: 200, height: 100, channels: 3, background: '#00aa88' } }).png().toBuffer();
  const template = allColumnsTemplate();
  template.columns = [...template.columns.filter(column => column.key !== 'image'), template.columns.find(column => column.key === 'image')!];
  template.columns.find(column => column.key === 'image')!.width = 10;
  template.layout.bodyHeight = 60;
  const item = product({ photos: [{ id: 'first', url: '', name: 'first.png' }, { id: 'second', url: '', name: 'second.png' }] });
  const calls: string[] = [];
  const workbook = await load(await exportQuotation(project, [item], async id => { calls.push(id); await Promise.resolve(); return buffer; }, template));
  const { sheet, number, header } = view(workbook, template);
  assert.deepEqual(calls, ['first','second']); assert.equal(sheet.getImages().length, 2);
  const image = sheet.getImages()[0], position = image.range as unknown as { tl: ExcelJS.Anchor; ext: { width: number; height: number }; editAs: string };
  assert.equal(position.tl.nativeCol, number('image') - 1); assert.equal(position.tl.nativeRow, header);
  assert.equal(position.editAs, 'oneCell'); assert.ok(position.ext.width > 110); assert.ok(position.ext.width <= 113.3); assert.ok(position.ext.height <= 112.1);
  assert.ok(Math.abs(position.ext.width / position.ext.height - 2) < .01);
  assert.equal(workbook.getImage(Number(image.imageId)).extension, 'jpeg');
  assert.ok(sheet.getRow(header + 1).height! >= template.layout.bodyHeight); assert.ok(sheet.getRow(header + 1).height! <= 409);
  const second = sheet.getImages()[1].range as unknown as { tl: ExcelJS.Anchor; ext: { width:number; height:number } };
  assert.equal(second.tl.nativeRow,header);assert.equal(second.tl.nativeCol,number('image')-1);
  assert.equal(second.tl.nativeRowOff,position.tl.nativeRowOff);assert.ok(second.tl.nativeColOff>position.tl.nativeColOff);
  assert.ok(second.ext.height <= 112.1);
  for (const hidden of [false, true]) {
    const settings = structuredClone(template); if (hidden) settings.columns.find(column => column.key === 'image')!.enabled = false;
    const options = hidden ? {} : { images: false };
    const disabled = await load(await exportQuotation(project, [item], () => { throw new Error('must not read'); }, settings, options));
    const current = view(disabled, settings, options);
    assert.equal(current.sheet.getImages().length, 0); assert.equal(current.metadata.columns.some(column => column.key === 'image'), false);
  }
});

test('内容适配有上限、长货号和多图预览与导出同源，不改模板与商品', async () => {
  const template = referenceTemplate();
  const photo = await sharp({ create: { width: 180, height: 180, channels: 3, background: '#008877' } }).png().toBuffer();
  const items = [1, 2, 6].map((count, index) => product({ id: String(index), sku: index ? 'TEST-'.repeat(40) : 'BQY15280',
    exportRemarks: index ? '较长的包装备注'.repeat(40) : '纸盒独立包装', cartons: 2, cartonQty: 24, quantity: index === 2 ? 0 : 50,
    unitPrice: 12345.67, currency: 'EUR', photos: Array.from({ length: count }, (_, n) => ({ id: index + '-' + n, name: '合成图.png', url: '' })) }));
  const snapshot = structuredClone({ template, items });
  const metadata = quotationExportMetadata(template, {}, ['EUR'], items);
  const workbook = await load(await exportQuotation(project, items, () => photo, template));
  const current = view(workbook, template, {}, '商户甲', ['EUR']);
  metadata.columns.forEach((column, index) => assert.equal(current.sheet.getColumn(index + 1).width ?? 9, column.width));
  assert.ok(metadata.columns.find(column => column.key === 'sku')!.width <= 32);
  assert.ok(metadata.columns.find(column => column.key === 'description')!.width <= 36);
  assert.equal(metadata.columns.find(column => column.key === 'image')!.width, 37.5);
  assert.ok(metadata.columns.reduce((width, column) => width + column.width, 0) <= 163);
  assert.equal(metadata.layout.printMode, 'fit');
  assert.equal(current.sheet.pageSetup.fitToPage, true); assert.equal(current.sheet.pageSetup.fitToWidth, 1);
  const drawings = current.sheet.getImages(); assert.equal(drawings.length, 9);
  let drawingIndex = 0; const productRows: number[] = [];
  for (let index = 0; index < items.length; index++) {
    const rowNumber = drawings[drawingIndex].range.tl.nativeRow + 1, row = current.sheet.getRow(rowNumber), height = row.height! * 4 / 3;
    productRows.push(rowNumber);
    drawingIndex += items[index].photos.length;
    assert.ok(row.height! <= 409); assert.ok(row.height! >= (index === 0 ? 102 : index === 1 ? 102 : 288));
    const images = drawings.filter(image => image.range.tl.nativeRow === rowNumber - 1);
    const boxes = images.map(image => {
      const range = image.range as unknown as { tl: ExcelJS.Anchor; ext: { width: number; height: number } };
      assert.equal(range.tl.nativeCol, current.number('image') - 1);
      assert.ok(range.ext.width >= 111); assert.ok(range.ext.height >= 111);
      const left = range.tl.nativeColOff / 9525, top = range.tl.nativeRowOff / 9525;
      assert.ok(left >= 0 && top >= 0); assert.ok(left + range.ext.width <= metadata.columns.find(column => column.key === 'image')!.width * 7 + .1); assert.ok(top + range.ext.height <= height + .1);
      return { left, top, right: left + range.ext.width, bottom: top + range.ext.height };
    });
    boxes.forEach((box, n) => boxes.slice(n + 1).forEach(other => assert.ok(box.right <= other.left || other.right <= box.left || box.bottom <= other.top || other.bottom <= box.top)));
  }
  assert.equal(current.sheet.getRow(productRows[2]).getCell(current.number('quantity')).value, 0);
  assert.equal(effective(current.sheet.getRow(productRows[2]).getCell(current.number('amount'))), 0);
  assert.deepEqual({ template, items }, snapshot);
});

test('异常大数值受总宽预算约束且只缩放自身，不拖小普通商户工作表', async () => {
  const template = referenceTemplate(); template.layout.bodySize = 10; template.layout.totalSize = 10;
  template.layout.moneyDecimals = 2; template.layout.volumeDecimals = 6;
  const items = [
    product({ id: 'large', supplier: '异常值商户', cartons: 100000000, cartonQty: 100000000,
      quantity: null, unitPrice: 100000000, cartonCbm: 100000000 }),
    product({ id: 'normal', supplier: '普通商户', cartons: 2, cartonQty: 24, quantity: 48, unitPrice: 12.5, cartonCbm: .04 }),
  ];
  const metadata = quotationExportMetadata(template, {}, ['CNY'], items);
  assert.ok(metadata.columns.reduce((width, column) => width + column.width, 0) <= 163);
  const workbook = await load(await exportQuotation(project, items, () => null, template));
  for (const name of ['异常值商户', '普通商户']) {
    const current = view(workbook, template, {}, name, ['CNY']);
    assert.ok(current.metadata.columns.reduce((width, column) => width + column.width, 0) <= 163);
    metadata.columns.forEach((column, index) => assert.equal(current.sheet.getColumn(index + 1).width ?? 9, column.width));
  }
  const abnormal = view(workbook, template, {}, '异常值商户', ['CNY']);
  const normal = view(workbook, template, {}, '普通商户', ['CNY']);
  assert.equal(abnormal.cell('amount').alignment.shrinkToFit, true);
  assert.notEqual(normal.cell('amount').alignment.shrinkToFit, true);
});

test('超过Excel单行上限的备注拆成连续行并保持完整内容与合计主行', async () => {
  const template = referenceTemplate(), remarks = '超长包装与客户标签说明'.repeat(500);
  const item = product({ name: 'LONG', sku: 'LONG', exportRemarks: remarks, cartons: 2, quantity: 48, unitPrice: 3 });
  const current = view(await load(await exportQuotation(project, [item], () => null, template, { images: false })), template, { images: false });
  const descriptionColumn = current.number('description'), collected: string[] = [];
  let rowNumber = current.header + 1;
  while (current.sheet.getRow(rowNumber).getCell(descriptionColumn).text) {
    const row = current.sheet.getRow(rowNumber++);
    assert.ok(row.height! <= 409);
    collected.push(row.getCell(descriptionColumn).text);
  }
  assert.ok(collected.length > 1); assert.equal(collected.join(''), remarks);
  assert.equal(current.sheet.autoFilter, undefined);
  const total = current.sheet.getRow(rowNumber + 1);
  assert.equal(total.getCell(current.number('sku')).value, 'TOTAL');
  assert.equal(total.getCell(current.number('amount')).result, 144);
  assert.match(total.getCell(current.number('amount')).formula!, new RegExp(`F${current.header + 1}`));
});

test('极端数值保留原值与字号，在总宽预算内对单元格和TOTAL局部缩放', async () => {
  const template = referenceTemplate(); template.layout.bodySize = 20; template.layout.totalSize = 20;
  template.layout.moneyDecimals = 6; template.layout.volumeDecimals = 6;
  const items = Array.from({ length: 2 }, (_, index) => product({ id: String(index), cartons: 100000000,
    cartonQty: 100000000, quantity: null, unitPrice: 100000000, cartonCbm: 100000000 }));
  const metadata = quotationExportMetadata(template, {}, ['CNY'], items);
  const current = view(await load(await exportQuotation(project, items, () => null, template)), template);
  assert.ok(metadata.columns.reduce((width, column) => width + column.width, 0) <= 163);
  for (const [key, minimum, maximum] of [['quantity', 9.5, 48], ['amount', 14, 96], ['cbm', 8.5, 80]] as const) {
    const column = current.number(key), width = current.sheet.getColumn(column).width!;
    assert.ok(width >= minimum && width <= maximum);
    assert.equal(width, metadata.columns.find(value => value.key === key)!.width);
    const totalRow = current.header + items.length + 2, cell = current.sheet.getCell(totalRow, column);
    assert.equal(cell.font.size, 20); assert.equal(cell.alignment.shrinkToFit, true);
    assert.equal(cell.result, key === 'amount' ? 2e24 : 2e16);
  }
});

test('默认短文本无图行紧凑，长文字和8/20pt字号按内容增高，保存或显式行高保留', async () => {
  const item = product({ name: '杯', sku: 'S', exportRemarks: '纸盒' });
  for (const size of [8, 20]) {
    const template = referenceTemplate(); template.layout.bodySize = size; template.layout.fieldSize = size;
    const metadata = quotationExportMetadata(template, { images: false }, ['CNY'], [item]);
    const current = view(await load(await exportQuotation(project, [item], () => { throw new Error('disabled'); }, template, { images: false })), template, { images: false });
    assert.equal(metadata.layout.bodyHeight, 36);
    const bodyHeight = current.sheet.getRow(current.header + 1).height!;
    if (size === 8) assert.equal(bodyHeight, 36); else assert.ok(bodyHeight > 36 && bodyHeight <= 80);
    assert.equal(current.sheet.getRow(current.header).height, metadata.layout.fieldHeight);
    assert.ok(metadata.layout.fieldHeight >= 32); if (size === 20) assert.ok(metadata.layout.fieldHeight > 32);
    const long = view(await load(await exportQuotation(project, [{ ...item, exportRemarks: '较长商品包装说明'.repeat(80) }], () => null, template, { images: false })), template, { images: false });
    assert.ok(long.sheet.getRow(long.header + 1).height! > current.sheet.getRow(current.header + 1).height!);
    assert.ok(long.sheet.getRow(long.header + 1).height! <= 409);
  }
  for (const [version, bodyHeight] of [[1, 98], [0, 64]]) {
    const template = referenceTemplate(); template.version = version; template.layout.bodyHeight = bodyHeight;
    const current = view(await load(await exportQuotation(project, [item], () => null, template, { images: false })), template, { images: false });
    assert.equal(current.sheet.getRow(current.header + 1).height, bodyHeight);
  }
});

test('照片只读一次并按比例收紧网格，单/双/六张方图或竖图不变，横图不裁切且空图跳过', async () => {
  for (const [width, height] of [[180, 180], [100, 500], [2000, 100]]) {
    const buffer = await sharp({ create: { width, height, channels: 3, background: '#448877' } }).png().toBuffer();
    for (const count of [1, 2, 6]) {
      const template = referenceTemplate(), ids = Array.from({ length: count }, (_, index) => String(index));
      const item = product({ name: '杯', sku: 'S', photos: ids.map(id => ({ id, url: '', name: '合成图.png' })) }), calls: string[] = [];
      const workbook = await load(await exportQuotation(project, [item], id => { calls.push(id); return buffer; }, template));
      const current = view(workbook, template), row = current.sheet.getRow(current.header + 1), pictures = current.sheet.getImages();
      assert.deepEqual(calls, ids); assert.equal(pictures.length, count);
      const expected = count === 6 ? 288 : 102;
      if (width <= height) assert.equal(row.height, expected); else assert.ok(row.height! < (count === 6 ? 60 : 40));
      assert.ok(row.height! <= 409);
      for (const picture of pictures) {
        const range = picture.range as unknown as { tl: ExcelJS.Anchor; ext: { width: number; height: number } };
        assert.ok(Math.abs((range.ext.width / range.ext.height)/(width / height)-1) < .01,'resize rounding within 1%, no cropping');
        assert.ok(range.tl.nativeRowOff / 9525 + range.ext.height <= row.height! * 4 / 3 + .01);
      }
    }
  }
  const buffer = await sharp({ create: { width: 100, height: 100, channels: 3, background: '#448877' } }).png().toBuffer(), calls: string[] = [];
  const item = product({ photos: [{ id: 'missing', url: '', name: '' }, { id: 'valid', url: '', name: '' }] });
  await assert.rejects(()=>exportQuotation(project, [item], id => { calls.push(id); return id === 'valid' ? buffer : null; }, referenceTemplate()),error=>error instanceof AppError && error.code==='INVALID_PHOTO');
  assert.deepEqual(calls, ['missing']);
});

test('多图累计40MB限制覆盖第二张照片，首图不可用也保留后续有效照片',async()=>{
 const bytes=await sharp({create:{width:20,height:20,channels:3,background:'#ffffff'}}).png().toBuffer();
 const item=product({photos:[{id:'one',url:'',name:'one.png'},{id:'two',url:'',name:'two.png'}]});
 await assert.rejects(()=>exportQuotation(project,[item],async id=>id==='one'?null:bytes,undefined),error=>error instanceof AppError && error.code==='INVALID_PHOTO');
 await assert.rejects(()=>exportQuotation(project,[item],id=>id==='one'?bytes:Buffer.alloc(40*1024*1024),undefined),/图片超过40MB/);
});

test('商户名称Excel合法化与冲突处理，不覆盖说明且保留商户原名', async () => {
  const suppliers = ['A/B', 'A?B', 'Store', 'store', '说明', '', "'" + '长商户'.repeat(15) + "'", 'History'];
  const template = allColumnsTemplate();
  const workbook = await load(await exportQuotation(project, suppliers.map((supplier, index) => product({ id: String(index), supplier })), () => null, template));
  const names = workbook.worksheets.map(sheet => sheet.name);
  assert.equal(names.length, suppliers.length + 1); assert.equal(new Set(names.map(name => name.toLowerCase())).size, names.length);
  names.forEach(name => { assert.ok(name.length <= 31); assert.equal(/[\\/*?:\[\]]/.test(name), false); assert.equal(/^'|'$/.test(name), false); });
  suppliers.forEach((supplier, index) => {
    const current = view(workbook, template, {}, workbook.worksheets[index].name);
    assert.equal(current.cell('supplier').text, supplier);
  });
  assert.equal(workbook.getWorksheet('说明')!.getCell('A1').value, '任务');
});

test('首图缺失留空，读取错误传播，500件与40MB限制沿用既有导出边界', async () => {
  const withPhoto = product({ photos: [{ id: 'first', url: '', name: 'first.jpg' }] });
  await assert.rejects(()=>exportQuotation(project, [withPhoto], async () => null, undefined),error=>error instanceof AppError && error.code==='INVALID_PHOTO');
  const workbook = await load(await exportQuotation(project, [withPhoto], async () => null, undefined,{images:false}));
  assert.equal(workbook.getWorksheet('商户甲')!.getImages().length,0);
  await assert.rejects(() => exportQuotation(project, [withPhoto], async () => { throw new Error('photo failed'); }, undefined), /photo failed/);
  await assert.rejects(() => exportQuotation(project, [withPhoto], () => Buffer.alloc(40 * 1024 * 1024 + 1), undefined),
    (error: unknown) => error instanceof AppError && error.code === 'EXPORT_LIMIT');
  await assert.rejects(() => exportQuotation(project, Array.from({ length: 501 }, () => product()), () => null, undefined), /最多500件/);
  await assert.rejects(() => exportQuotation(project, [], () => null, undefined), (error: unknown) => error instanceof AppError && error.code === 'EMPTY_EXPORT');
  await assert.rejects(() => exportQuotation(project, [product()], () => null, undefined, { scope: 'confirmed' }), /没有可导出/);
});

test('用户文本始终为字面值、未加价换汇，预览metadata与实际布局一致且可序列化', async () => {
  const template = allColumnsTemplate(); template.version = 1; template.documentTitle = '=客户标题';
  template.layout.printMode = 'scale'; template.layout.scale = 70; template.layout.paper = 'Letter';
  template.layout.orientation = 'portrait'; template.layout.repeatHeader = false; template.layout.border = 'none';
  const options: QuotationExportOptions = { audience: 'internal', images: false, businessFields: ['tradeTerms', 'name', 'tradeTerms', 'description', 'notes'] };
  const item = product({ name: '=HYPERLINK("bad")', description: '=original', notes: '=note', unitPrice: 12.345, currency: 'EUR', tradeTerms: '=terms' });
  const workbook = await load(await exportQuotation(project, [item], () => null, template, options));
  const { sheet, cell, metadata, header } = view(workbook, template, options, '商户甲', [item.currency]);
  assert.equal(cell('business:name').value, '=HYPERLINK("bad")'); assert.equal(cell('business:description').value, '=original');
  assert.equal(cell('business:notes').value, '=note'); assert.equal(cell('business:tradeTerms').value, '=terms');
  assert.equal(cell('unitPrice').value, 12.345); assert.equal(cell('currency').value, 'EUR');
  assert.equal(cell('business:name').formula, undefined); assert.equal(sheet.getCell('A5').value, '=客户标题');
  assert.equal(cell('business:name').border.bottom, undefined); assert.equal(sheet.pageSetup.fitToPage, false);
  assert.equal(sheet.pageSetup.scale, 70); assert.equal(sheet.pageSetup.paperSize as number, 1);
  assert.equal(sheet.pageSetup.orientation, 'portrait'); assert.equal(sheet.pageSetup.printTitlesRow, undefined);
  assert.equal(metadata.columns.filter(column => column.key === 'business:name').length, 1);
  assert.equal(metadata.columns.some(column => column.key === 'name'), false);
  metadata.columns.forEach((column, index) => {
    assert.equal(sheet.getCell(header, index + 1).value, column.label);
    // ExcelJS omits its default width (9) when writing column definitions.
    assert.equal(sheet.getColumn(index + 1).width ?? 9, column.width); assert.equal(sheet.getColumn(index + 1).hidden, column.hidden);
  });
  assert.deepEqual(JSON.parse(JSON.stringify(metadata)), metadata); assert.equal(metadata.priceSource, '现场记录价格');
  assert.equal(metadata.audience, 'internal'); assert.equal(metadata.images, false); assert.equal(metadata.groupBy, 'supplier');
  assert.equal(metadata.headerRows.find(row => row.key === 'documentTitle')!.text, '=客户标题');
});

test('service传入版本0或保存后的模板均用新导出，未注入模板保留原路径并传递owner与筛选', async () => {
  const products = [product({ confirmed: true }), product({ id: 'pending', supplier: '商户乙' })];
  const calls: unknown[][] = [];
  const records = { ...repository,
    getProject: async (owner: string, id: string) => { calls.push(['project', owner, id]); return project; },
    recordsForExport: async (owner: string, id: string | undefined, date?: string, favorite?: boolean) => { calls.push(['products', owner, id, date, favorite]); return products; },
    readPhoto: async () => Buffer.alloc(0),
  };
  const service = new MarketService(records, { enabled: () => false, extract: async () => ({ fields: {}, mode: 'rules', warning: '' }) });
  const plain = await service.export('owner', project.id, { images: false });
  const legacy = await load(plain.bytes); assert.ok(legacy.getWorksheet('看货记录')); assert.equal('metadata' in plain, false);
  for (const version of [0, 2]) {
    const template = defaultProcurementTemplate(); template.version = version;
    const result = await service.export('owner', project.id, { template, audience: 'internal', scope: 'confirmed', images: false, date: project.date, favorite: true });
    const workbook = await load(result.bytes);
    assert.ok(workbook.getWorksheet('商户甲')); assert.equal(workbook.getWorksheet('商户乙'), undefined);
    assert.equal(result.metadata!.audience, 'internal'); assert.equal(result.metadata!.templateVersion, version);
    assert.deepEqual(calls.at(-1), ['products', 'owner', project.id, project.date, true]);
  }
  const daily = await service.export('owner', undefined, { template: defaultProcurementTemplate(), date: project.date, images: false });
  assert.equal(daily.project.name, project.date + ' 看货记录'); assert.equal(daily.metadata!.audience, 'selection');
  const favorite = await service.export('owner', undefined, { template: defaultProcurementTemplate(), favorite: true, images: false });
  assert.equal(favorite.project.name, '收藏选品'); assert.deepEqual(products, [product({ confirmed: true }), product({ id: 'pending', supplier: '商户乙' })]);
});


test('公司表头及字段和商品颜色写入真实Excel，旧设置仍使用黑色', async () => {
  const template = defaultProcurementTemplate();template.company='示例公司';
  template.layout.headerRows[0].color='#245C46';template.layout.fieldColor='#1E3A5F';template.layout.bodyColor='#374151';
  const workbook=await load(await exportQuotation(project,[product({unitPrice:12,currency:'CNY'})],()=>null,template));
  const current=view(workbook,template);
  assert.equal(current.sheet.getCell(1,1).font.color?.argb,'FF245C46');
  assert.equal(current.sheet.getCell(current.header,current.number('sku')).font.color?.argb,'FF1E3A5F');
  assert.equal(current.cell('sku').font.color?.argb,'FF374151');
});
