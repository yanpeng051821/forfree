import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import sharp from 'sharp';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProcurement, lineCalculation, procurementView, procurementFromProducts } from '../src/lib/procurement';
import { ProcurementStore, validateProcurementZip } from '../src/lib/procurement-store';
import { ProcurementTemplateStore, defaultProcurementTemplate, normalizeProcurementTemplate, templateSaveSchema } from '../src/lib/procurement-template';
import { exportProcurement } from '../src/lib/procurement-export';
import { createApp } from '../src/server/app';
import { MarketService } from '../src/server/service';
import { parseRuntimeConfig } from '../src/server/config';
import { issueSession } from '../src/server/auth';
import { closeDB } from '../src/lib/db';
import { emptyFields } from '../src/lib/types';

const root = mkdtempSync(join(tmpdir(), 'huoji-procurement-'));
const previous = process.env.APP_DATA_DIR; process.env.APP_DATA_DIR = root;
after(() => { closeDB(); rmSync(root, { recursive: true, force: true }); if (previous === undefined) delete process.env.APP_DATA_DIR; else process.env.APP_DATA_DIR = previous; });

// These document regressions exercise a saved pre-reference template. Keep its
// full column contract explicit instead of borrowing the evolving defaults.
function legacyDocumentTemplate() {
  const template = defaultProcurementTemplate();
  template.columns = [
    ['image', '图片'], ['supplier', '商户'], ['sku', '货号'], ['decision', '处理决定'],
    ['cartons', '箱数'], ['pcsPerCarton', '每箱数量'], ['quantity', '采购数量'],
    ['unitPrice', '采购单价'], ['currency', '币种'], ['amount', '商品金额'],
    ['cartonCbm', '单箱体积(m³)'], ['cbm', '总体积(m³)'],
    ['description', '商品与包装说明'], ['barcode', '条码'],
  ].map(([key, label]) => ({ ...template.columns.find(column => column.key === key)!, key, label, enabled: true }));
  return template;
}

async function fixture() {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('商户甲');
  // Wide source formatting must not cause a whole-XFD traversal.
  sheet.getColumn(16384).width = 12;
  sheet.getRow(6).values = ['REF.', 'CTNS（箱数）', 'PCS/CTN', 'QUANTITY', 'PRICE (RMB)', 'AMOUNT(RMB)', '备注', '图片', '体积', '', '条码号'];
  sheet.getRow(7).values = ['00123', 2, 24, { formula: 'B7*C7', result: 48 }, 2.5, { formula: 'D7*E7', result: 120 }, '内盒6个，标签不用加条码', '', .1, { formula: 'I7*B7', result: .2 }];
  sheet.getRow(8).values = ['', '', '', '', '', 15, '运费'];
  sheet.getRow(10).values = ['TOTAL', { formula: 'SUM(B7:B9)', result: 2 }, '', '', '', { formula: 'SUM(F7:F9)', result: 135 }, '', '', '', { formula: 'SUM(J7:J9)', result: .2 }];
  sheet.getRow(12).values = ['付款方式：30']; sheet.mergeCells('A12:G12');
  sheet.getRow(20).values = ['BACK-1', 1, 10, { formula: 'B20*C20', result: 10 }, 3, { formula: 'D20*E20', result: 30 }, '', '', .2, { formula: 'I20*B20', result: .2 }, '取消'];
  sheet.getRow(21).values = ['BACK-2', 1, 12, { formula: 'B21*C21', result: 12 }, 4, { formula: 'D21*E21', result: 48 }, '', '', .3, { formula: 'I21*B21', result: .3 }];
  sheet.mergeCells('K20:K21');
  const buffer = await sharp({ create: { width: 30, height: 40, channels: 3, background: '#778899' } }).jpeg().toBuffer();
  const image = wb.addImage({ buffer: buffer as unknown as ExcelJS.Buffer, extension: 'jpeg' });
  sheet.addImage(image, { tl: { col: 7, row: 6 }, ext: { width: 50, height: 60 } });
  sheet.addImage(image, { tl: { col: 3, row: 13 }, ext: { width: 50, height: 60 } }); // side mark not a product
  const empty = wb.addWorksheet('空模板'); empty.getRow(6).values = sheet.getRow(6).values;
  empty.getRow(10).values = ['TOTAL', { formula: 'SUM(B7:B9)', result: 0 }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}

test('采购导入保留合计下方商品、合并取消范围、文字要求、前导零货号及对应商品图', async () => {
  const bytes = await fixture(); validateProcurementZip(bytes);
  const doc = await readProcurement(bytes, '匿名采购.xlsx');
  assert.equal(doc.suppliers.length, 1); assert.equal(doc.lines.length, 3);
  assert.deepEqual(doc.skippedSheets, ['空模板']);
  assert.equal(doc.lines[0].sku, '00123'); assert.equal(doc.lines[0].images.length, 1);
  assert.equal(doc.lines[1].sourceIncluded, false); assert.equal(doc.lines[2].sourceMark, '取消');
  assert.equal(doc.suppliers[0].freight, 15); assert.match(doc.suppliers[0].information, /付款方式：30/);
  assert.equal(doc.lines[0].description, '内盒6个，标签不用加条码');
  assert.deepEqual(lineCalculation(doc.lines[0]), { quantity: 48, amount: 120, cbm: .2 });
  assert.equal(procurementView(doc).summary.sourceAmount, 135);
  assert.equal(procurementView(doc).summary.amount, null, 'no selected goods must not bill freight');
  doc.lines[0].decision = 'include'; assert.equal(procurementView(doc).summary.amount, 135);
  doc.lines[0].unitPrice = null; assert.equal(procurementView(doc).summary.amount, null);
});

test('原表公式缓存不一致、条码重复和体积异常会暴露；缺失运费不会当0', async () => {
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await fixture() as unknown as ExcelJS.Buffer);
  const sheet = wb.getWorksheet('商户甲')!;
  sheet.getCell('F7').value = { formula: 'D7*E7', result: 999 };
  sheet.getCell('I7').value = .9; sheet.getCell('K7').value = '00001';
  sheet.unMergeCells('K20:K21'); sheet.getCell('K20').value = '00001'; sheet.getCell('F8').value = null; sheet.getCell('G8').value = '';
  const doc = await readProcurement(Buffer.from(await wb.xlsx.writeBuffer()), 'bad.xlsx');
  assert.equal(doc.suppliers[0].freight, null);
  assert.ok(doc.lines[0].warnings.some(w => /金额.*不一致/.test(w)));
  assert.ok(doc.lines[0].warnings.some(w => /体积≥/.test(w)));
  assert.ok(doc.lines[0].warnings.some(w => /条码重复/.test(w)));
  assert.ok(doc.suppliers[0].warnings.some(w => /合计金额.*不一致/.test(w)));
});

test('采购记录与表格设置按账号隔离并防止过期版本覆盖', async () => {
  const store = new ProcurementStore(root), templates = new ProcurementTemplateStore(root);
  const original = await fixture(), doc = await readProcurement(original, 'test.xlsx');
  store.create('a', doc, original);
  assert.equal(store.list('b').length, 0); assert.throws(() => store.read('b', doc.id), /无权访问/);
  assert.deepEqual(store.original('a', doc.id), original);
  store.update('a', doc.id, 1, d => { d.lines[0].note = '人工确认'; });
  const duplicate = store.create('a', await readProcurement(original, 'again.xlsx'), original);
  assert.equal(duplicate.id, doc.id); assert.equal(duplicate.version, 2); assert.equal(duplicate.lines[0].note, '人工确认');
  assert.throws(() => store.update('a', doc.id, 1, () => {}), /已更新/);
  const { version: _, ...fields } = defaultProcurementTemplate();
  fields.company = '测试公司'; fields.customFields = [{ key: 'client_sku', label: '客户货号', width: 20 }];
  templates.save('a', 0, fields); assert.equal(templates.read('b').version, 0);
  assert.throws(() => templates.save('a', 0, fields), /已更新/);
  fields.columns.find(c => c.key === 'amount')!.enabled = false;
  assert.throws(() => templates.save('a', 1, fields), /核心字段/);
  store.delete('a', doc.id, 2); assert.equal(store.list('a').length, 0);
});

test('整理Excel有活动公式、自定义字段、隐藏可选列和全部商品图片，不将用户文字当公式', async () => {
  const doc = await readProcurement(await fixture(), 'test.xlsx');
  doc.lines[0].decision = 'include'; doc.lines[0].note = '=1+1';
  doc.template = legacyDocumentTemplate(); doc.template.columns.find(c => c.key === 'barcode')!.enabled = false;
  doc.template.columns.find(c => c.key === 'sku')!.label = '商家货号';
  doc.template.customFields = [{ key: 'client_sku', label: '客户货号', width: 20 }]; doc.lines[0].custom = { client_sku: '000077' };
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await exportProcurement(doc) as unknown as ExcelJS.Buffer);
  const detail = wb.getWorksheet('商品明细')!;
  assert.equal(detail.getCell('C6').value, '商家货号'); assert.equal(detail.getCell('O7').value, '000077');
  assert.equal(detail.getCell('V7').value, '=1+1'); assert.equal(detail.getColumn(14).hidden, true);
  assert.equal(detail.getCell('G7').formula, 'IF(COUNT(E7,F7)<2,"",E7*F7)');
  assert.equal(detail.getCell('G7').result, 48); assert.equal(detail.getImages().length, 1);
  assert.equal(detail.getCell('G7').font.name, 'Times New Roman'); assert.equal(detail.getCell('M7').font.name, '宋体');
  assert.equal(detail.getCell('G7').font.size, 12); assert.equal(detail.getCell('G7').border.bottom!.style, 'thin');
  const headerFill = detail.getCell('C6').fill;
  assert.equal(headerFill?.type === 'pattern' && headerFill.pattern === 'solid', false);
  assert.equal(wb.getWorksheet('采购汇总')!.getCell('J7').result, 135);
  assert.match(wb.getWorksheet('采购汇总')!.getCell('J8').formula, /COUNTIFS/);
});

test('带原表导出完整保留商户页、图片、字体索引与空模板，并追加整理视图', async () => {
  const source = await fixture(), doc = await readProcurement(source, 'test.xlsx');
  doc.template = legacyDocumentTemplate();
  const result = await exportProcurement(doc, source);
  const [before, after] = await Promise.all([JSZip.loadAsync(source), JSZip.loadAsync(result)]);
  for (const [path, member] of Object.entries(before.files)) {
    if (member.dir || ['xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/sharedStrings.xml', '[Content_Types].xml', 'docProps/app.xml'].includes(path)) continue;
    assert.deepEqual(await after.file(path)!.async('nodebuffer'), await member.async('nodebuffer'), path);
  }
  const xml = await after.file('xl/workbook.xml')!.async('string');
  assert.match(xml, /name="商户甲"/); assert.match(xml, /name="空模板"/); assert.match(xml, /name="商品明细"/);
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(result as unknown as ExcelJS.Buffer);
  assert.equal(wb.worksheets.length, 6); assert.equal(wb.getWorksheet('商户甲')!.getCell('A7').value, '00123');
  assert.equal(wb.getWorksheet('商户甲')!.getImages().length, 2);
  assert.equal(wb.getWorksheet('商品明细')!.getCell('G7').result, 48);
  assert.equal(wb.getWorksheet('商品明细')!.getCell('G7').font.name, 'Times New Roman');
  assert.equal(wb.getWorksheet('商品明细')!.getImages().length, 1);
});

test('ZIP拒绝伪装文件和声明解压大小过大', async () => {
  assert.throws(() => validateProcurementZip(Buffer.from('hello')), /xlsx/);
  const bytes = await fixture(); const altered = Buffer.from(bytes);
  const position = altered.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); altered.writeUInt32LE(100 * 1024 * 1024, position + 24);
  assert.throws(() => validateProcurementZip(altered), /解压后过大/);
});

test('公司模板兼容旧设置、每行表头样式与列顺序适配，计算不会随列移动而错位', async () => {
  const t = legacyDocumentTemplate(); t.company = '公司中文名'; t.companyEnglish = 'TEST COMPANY'; t.address = 'Room 1 Yiwu'; t.contact = 'TEL: 000';
  t.layout.headerRows[0].font = '宋体'; t.layout.headerRows[0].size = 24; t.layout.headerRows[0].height = 30;
  t.layout.headerRows[2].enabled = false;
  t.layout.headerRows.push({ key: 'header_customer', label: '客户信息', text: '客户编号 001', enabled: true, font: '宋体', size: 11, height: 18, bold: false, align: 'left' });
  t.layout.headerRows[0].color = '#245C46'; t.layout.fieldColor = '#1E3A5F'; t.layout.bodyColor = '#374151'; t.layout.totalColor = '#9B4B3D';
  t.layout.latinFont = 'Arial'; t.layout.chineseFont = '黑体'; t.layout.bodySize = 13; t.layout.moneyDecimals = 3;
  t.columns = [...t.columns.slice(4), ...t.columns.slice(0, 4)]; t.columns.find(c => c.key === 'sku')!.width = 25;
  t.customFields = [{ key: 'client_sku', label: '客户货号', width: 24 }];
  const doc = await readProcurement(await fixture(), 'test.xlsx'); doc.template = t; doc.lines[0].decision = 'include'; doc.lines[0].custom = { client_sku: '0001' };
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await exportProcurement(doc) as unknown as ExcelJS.Buffer);
  const d = wb.getWorksheet('商品明细')!;
  assert.equal(d.getCell('A1').value, '公司中文名'); assert.equal(d.getCell('A1').font.size, 24); assert.equal(d.getCell('A1').font.name, '宋体');
  assert.equal(d.getCell('A1').font.color?.argb,'FF245C46'); assert.equal(d.getCell('M6').font.color?.argb,'FF1E3A5F'); assert.equal(d.getCell('M7').font.color?.argb,'FF374151');
  assert.equal(d.getCell('A2').font.size, 18); assert.equal(d.getCell('A3').value, 'TEL: 000'); assert.equal(d.getCell('A4').value, t.documentTitle);
  assert.equal(d.getCell('A5').value, '客户编号 001'); assert.equal(d.getCell('A5').alignment.horizontal, 'left');
  assert.equal(d.getCell('O1').master.address, 'A1'); assert.equal(d.getCell('P1').isMerged, false, 'header stops before audit columns');
  assert.equal(d.getCell('M6').value, '货号'); assert.equal(d.getColumn(13).width, 25); assert.equal(d.getCell('M7').value, '00123');
  assert.equal(d.getCell('C7').formula, 'IF(COUNT(A7,B7)<2,"",A7*B7)'); assert.equal(d.getCell('F7').result, 120);
  assert.equal(d.getCell('O7').value, '0001'); assert.equal(d.getCell('D7').numFmt, '#,##0.000'); assert.equal(d.getCell('D7').font.name, 'Arial');
  assert.equal(d.getCell('I7').font.name, '黑体'); assert.equal(d.pageSetup.printTitlesRow, '1:6'); assert.equal(d.getImages().length, 1);
  assert.equal(wb.getWorksheet('采购汇总')!.getCell('J7').result, 135);
  const legacy = structuredClone(t) as Partial<typeof t>; delete legacy.layout; delete legacy.documentTitle;
  assert.equal(normalizeProcurementTemplate(legacy as typeof t).layout.bodySize, 12);
  const invalid = structuredClone(t); invalid.layout.headerRows[0].height = 10;
  const { version, ...fields } = invalid; assert.throws(() => templateSaveSchema.parse({ version, fields }), /行高/);
});

test('识别原表五行不同含义及字体大小，并作为首次导入的模板建议', async () => {
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await fixture() as unknown as ExcelJS.Buffer);
  const s = wb.getWorksheet('商户甲')!;
  ['样例外贸公司', 'EXAMPLE TRADING', 'Room 620 Yiwu', 'TEL:000 FAX:001', 'PROFORMA INVOICE'].forEach((value, i) => {
    s.mergeCells(i + 1, 1, i + 1, 7); s.getCell(i + 1, 1).value = value; s.getCell(i + 1, 1).font = { name: 'Times New Roman', size: [26, 18, 11, 11, 16][i], bold: true }; s.getRow(i + 1).height = [33, 22.5, 15.75, 15.75, 20.25][i];
  });
  s.getColumn(1).width = 11.4667;
  s.getColumn(9).width = 5.625; s.getColumn(10).width = 6.75;
  const doc = await readProcurement(Buffer.from(await wb.xlsx.writeBuffer()), 'reference.xlsx');
  assert.equal(doc.template!.company, '样例外贸公司'); assert.equal(doc.template!.contact, 'TEL:000 FAX:001'); assert.equal(doc.template!.documentTitle, 'PROFORMA INVOICE');
  assert.deepEqual(doc.template!.layout.headerRows.map(row => row.size), [26, 18, 11, 11, 16]);
  assert.equal(doc.template!.columns.find(c => c.key === 'sku')!.width, 11.4667);
  assert.equal(doc.template!.columns.find(c => c.key === 'cartonCbm')!.width, 5.625);
  assert.equal(doc.template!.columns.find(c => c.key === 'cbm')!.width, 6.75);
  assert.equal(doc.template!.columns.find(c => c.key === 'cbm')!.label, '总体积(m³)', 'blank reference label keeps the usable default');
});

test('新解析的窄体积列模板沿用原格式与实际精度，不固定补六位或改动数值', async () => {
  const source = new ExcelJS.Workbook(); await source.xlsx.load(await fixture() as unknown as ExcelJS.Buffer);
  const s = source.getWorksheet('商户甲')!;
  s.getCell('A1').value = '测试公司'; s.getCell('A2').value = 'TEST COMPANY';
  s.getColumn(9).width = 5.625; s.getColumn(10).width = 6.75;
  s.getCell('I7').value = .013; s.getCell('I7').numFmt = '0.000';
  s.getCell('J7').value = { formula: 'I7*B7', result: .026 }; s.getCell('J7').numFmt = '0.000';
  const parse = async () => readProcurement(Buffer.from(await source.xlsx.writeBuffer()), 'narrow-reference.xlsx');
  const doc = await parse();
  assert.equal(doc.template!.layout.volumeDecimals, 3);
  assert.equal(doc.template!.columns.find(c => c.key === 'cartonCbm')!.width, 5.625);
  assert.equal(doc.template!.columns.find(c => c.key === 'cbm')!.width, 6.75);
  assert.equal(doc.lines[0].cartonCbm, .013); assert.equal(doc.lines[0].sourceCbm, .026);
  const exported = new ExcelJS.Workbook(); await exported.xlsx.load(await exportProcurement(doc) as unknown as ExcelJS.Buffer);
  const detail = exported.getWorksheet('商品明细')!;
  assert.equal(detail.getCell('I7').numFmt, '0.000'); assert.equal(detail.getCell('J7').numFmt, '0.000');
  assert.equal(detail.getCell('I7').value, .013); assert.equal(detail.getCell('J7').result, .026);
  s.getCell('I7').numFmt = '0.0000 "m³"';
  assert.equal((await parse()).template!.layout.volumeDecimals, 4, 'explicit formatting precision is retained');
  s.getCell('I7').value = .01234;
  const precise = await parse();
  assert.equal(precise.template!.layout.volumeDecimals, 5, 'actual values are not rounded to a shorter source display format');
  assert.equal(precise.lines[0].cartonCbm, .01234);
  assert.equal(defaultProcurementTemplate().layout.volumeDecimals, 6, 'global defaults and existing company templates are not rewritten');
});

test('隐藏可选列后表头按可见宽度换行，扩展列顺序和内容一致', async () => {
  const t = legacyDocumentTemplate(); t.company = '公司名称'.repeat(45);
  t.columns.forEach(c => { c.width = 5; if (['image', 'description', 'barcode', 'cartonCbm', 'cbm'].includes(c.key)) { c.enabled = false; c.width = 80; } });
  t.customFields = [{ key: 'inspection', label: '验货要求', width: 5 }, { key: 'client_ref', label: '客户编号', width: 5 }];
  const doc = await readProcurement(await fixture(), 'test.xlsx'); doc.template = t; doc.lines[0].custom = { inspection: '检查包装', client_ref: '0001' };
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await exportProcurement(doc) as unknown as ExcelJS.Buffer);
  const d = wb.getWorksheet('商品明细')!;
  assert.equal(d.getColumn(1).hidden, true); assert.ok(d.getRow(1).height! > 100, 'hidden wide columns do not make the title height too small');
  assert.equal(d.getCell('O6').value, '验货要求'); assert.equal(d.getCell('P6').value, '客户编号');
  assert.equal(d.getCell('O7').value, '检查包装'); assert.equal(d.getCell('P7').value, '0001');
  assert.equal(d.getCell('P1').master.address, 'A1'); assert.equal(d.getCell('Q1').isMerged, false);
});

test('看货生成采购不拿起订量当采购量，不继承商品核对状态为订单计入', async () => {
  const project = { id: 'p', name: 'test', market: '', date: '2026-10-16', demo: false, createdAt: '' };
  const product = { ...emptyFields, id: 'l', projectId: 'p', version: 1, photos: [], createdAt: '', updatedAt: '', name: '杯子', supplier: '店', supplierContact: '测试联系', moq: 100, cartonQty: 24, unitPrice: 2, confirmed: true };
  const doc = await procurementFromProducts(project, [product], () => Buffer.alloc(0));
  assert.equal(doc.lines[0].cartons, null); assert.equal(doc.lines[0].decision, 'pending');
  assert.equal(lineCalculation(doc.lines[0]).quantity, null); assert.equal(doc.suppliers[0].freight, null);
});

test('看货生成采购保留箱数与前导零条码，显式数量优先于装箱计算且不丢失零值', async () => {
  const project = { id: 'p', name: '已录数量', market: '', date: '2026-10-21', demo: false, createdAt: '' };
  const product = { ...emptyFields, id: 'l', projectId: 'p', version: 1, photos: [], createdAt: '', updatedAt: '', name: '杯子', supplier: '店', moq: 100, cartonQty: 24, cartons: 2, quantity: 50, barcode: '0000123', unitPrice: 2.5, cartonCbm: .1, confirmed: true };
  const doc = await procurementFromProducts(project, [product], () => Buffer.alloc(0));
  const line = doc.lines[0];
  assert.equal(line.cartons, 2); assert.equal(line.barcode, '0000123'); assert.equal(line.sourceQuantity, 50);
  assert.deepEqual(lineCalculation(line), { quantity: 50, amount: 125, cbm: .2 });
  assert.equal(line.decision, 'pending', 'field verification does not confirm purchase inclusion');
  assert.ok(line.warnings.some(w => /按已录数量保留/.test(w)));
  assert.ok(!line.warnings.some(w => /箱数待填写/.test(w)));
  const quantityOnly = await procurementFromProducts(project, [{ ...product, cartons: null, cartonQty: null }], () => Buffer.alloc(0));
  assert.deepEqual(lineCalculation(quantityOnly.lines[0]), { quantity: 50, amount: 125, cbm: null });
  const zero = await procurementFromProducts(project, [{ ...product, quantity: 0 }], () => Buffer.alloc(0));
  assert.deepEqual(lineCalculation(zero.lines[0]), { quantity: 0, amount: 0, cbm: .2 });
  const inferred = await procurementFromProducts(project, [{ ...product, quantity: null }], () => Buffer.alloc(0));
  assert.deepEqual(lineCalculation(inferred.lines[0]), { quantity: 48, amount: 120, cbm: .2 });
  assert.equal(inferred.lines[0].sourceQuantity, null, 'unknown recorded quantity is not fabricated as an original value');
  // Original workbook caches remain audit evidence, not explicit quantity overrides.
  const imported = await readProcurement(await fixture(), 'legacy.xlsx');
  imported.lines[0].sourceQuantity = 999;
  assert.deepEqual(lineCalculation(imported.lines[0]), { quantity: 48, amount: 120, cbm: .2 });
});

test('采购Excel重算保留显式数量，只有数量和价格仍可计金额，未知体积保持空白', async () => {
  const project = { id: 'p', name: '显式数量导出', market: '', date: '2026-10-21', demo: false, createdAt: '' };
  const product = { ...emptyFields, id: 'l', projectId: 'p', version: 1, photos: [], createdAt: '', updatedAt: '', name: '杯子', supplier: '店', cartonQty: 24, cartons: 2, quantity: 50, unitPrice: 2.5, cartonCbm: .1 };
  const doc = await procurementFromProducts(project, [product, { ...product, id: 'quantity-only', cartons: null, cartonQty: null }], () => Buffer.alloc(0));
  doc.template = legacyDocumentTemplate(); doc.lines.forEach(line => { line.decision = 'include'; }); doc.suppliers[0].freight = 0;
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await exportProcurement(doc) as unknown as ExcelJS.Buffer);
  const detail = wb.getWorksheet('商品明细')!;
  assert.equal(detail.getCell('G7').value, 50, 'explicit quantity is a numeric value, so recalculation cannot replace it with 48');
  assert.equal(detail.getCell('J7').result, 125); assert.equal(detail.getCell('W7').result, 0);
  assert.equal(detail.getCell('W7').formula, 'IF(AND(D7="计入",COUNT(G7,H7)<2),1,0)');
  assert.equal(detail.getCell('G8').value, 50); assert.equal(detail.getCell('J8').result, 125);
  assert.equal(detail.getCell('W8').result, 0, 'missing carton count does not make an explicit quantity incomplete');
  assert.equal(detail.getCell('L8').result ?? '', ''); assert.equal(detail.getCell('X8').result, 1);
  assert.equal(wb.getWorksheet('采购汇总')!.getCell('H7').result, 250);
  assert.equal(wb.getWorksheet('采购汇总')!.getCell('J7').result, 250);
  assert.equal(wb.getWorksheet('采购汇总')!.getCell('K7').result ?? '', '');
  const legacy = await readProcurement(await fixture(), 'legacy.xlsx');
  legacy.template = legacyDocumentTemplate(); legacy.lines[0].sourceQuantity = 999; legacy.lines[0].decision = 'include';
  const old = new ExcelJS.Workbook(); await old.xlsx.load(await exportProcurement(legacy) as unknown as ExcelJS.Buffer);
  const oldDetail = old.getWorksheet('商品明细')!;
  assert.equal(oldDetail.getCell('G7').formula, 'IF(COUNT(E7,F7)<2,"",E7*F7)');
  assert.equal(oldDetail.getCell('G7').result, 48); assert.equal(oldDetail.getCell('J7').result, 120);
  assert.equal(oldDetail.getCell('R7').value, 999, 'source cache remains visible audit evidence only');
});

test('从商品生成采购等待异步图片读取，保持所有图片并传播读取失败', async () => {
  const project = { id: 'p', name: '异步图片', market: '', date: '2026-10-17', demo: false, createdAt: '' };
  const product = { ...emptyFields, id: 'l', projectId: 'p', version: 1, photos: [{ id: 'one', name: '1.jpg', url: '' }, { id: 'two', name: '2.jpg', url: '' }], createdAt: '', updatedAt: '' };
  const bytes = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#aabbcc' } }).jpeg().toBuffer();
  const calls: string[] = [];
  const doc = await procurementFromProducts(project, [product], async id => { await Promise.resolve(); calls.push(id); return bytes; });
  assert.deepEqual(calls, ['one', 'two']); assert.equal(doc.lines[0].images.length, 2);
  await assert.rejects(procurementFromProducts(project, [product], async () => { throw new Error('云图片读取失败'); }), /云图片读取失败/);
});

test('采购HTTP支持带图文件导入、所有者隔离、核对保存、模板与原表下载', async () => {
  const config = parseRuntimeConfig({ APP_DATA_DIR: root }, { identityInjected: true, serviceInjected: true });
  const app = await createApp({ config, identity: { exchange: async code => code }, service: new MarketService(undefined, { enabled: () => false, extract: async () => { throw new Error('unused'); } }) });
  const a = issueSession('proc-a'), b = issueSession('proc-b');
  const headers = (token: string) => ({ authorization: 'Bearer ' + token });
  try {
    const data = await fixture(), boundary = 'proc-test';
    const payload = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="workbook"; filename="order.xlsx"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`), data, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const response = await app.inject({ method: 'POST', url: '/api/procurement/import', headers: { ...headers(a.token), 'content-type': 'multipart/form-data; boundary=' + boundary }, payload });
    assert.equal(response.statusCode, 201, response.body); const doc = response.json();
    assert.equal(doc.lines[0].images, undefined); assert.equal(doc.lines[0].imageUrls.length, 1);
    for (const path of [`/api/procurement/${doc.id}`, `/api/procurement/${doc.id}/original`, `/api/procurement/${doc.id}/export`, doc.lines[0].imageUrls[0]]) assert.equal((await app.inject({ method: 'GET', url: path, headers: headers(b.token) })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: doc.lines[0].imageUrls[0], headers: headers(a.token) })).statusCode, 200);
    const line = doc.lines[0];
    const save = { version: 1, fields: { decision: 'include', cartons: 2, pcsPerCarton: 24, unitPrice: 2.5, cartonCbm: .1, note: '确认' } };
    const updated = await app.inject({ method: 'POST', url: `/api/procurement/${doc.id}/lines/${line.id}`, headers: headers(a.token), payload: save });
    assert.equal(updated.statusCode, 200, updated.body); assert.equal(updated.json().summary.amount, 135);
    assert.equal((await app.inject({ method: 'POST', url: `/api/procurement/${doc.id}/lines/${line.id}`, headers: headers(a.token), payload: save })).statusCode, 409);
    const invalid = await app.inject({ method: 'POST', url: `/api/procurement/${doc.id}/lines/${line.id}`, headers: headers(a.token), payload: { ...save, version: 2, fields: { ...save.fields, cartons: null } } });
    assert.equal(invalid.statusCode, 400);
    const exported = await app.inject({ method: 'GET', url: `/api/procurement/${doc.id}/export`, headers: headers(a.token) }); assert.equal(exported.statusCode, 200);
    const original = await app.inject({ method: 'GET', url: `/api/procurement/${doc.id}/original`, headers: headers(a.token) }); assert.deepEqual(original.rawPayload, data);
    const template = await app.inject({ method: 'GET', url: '/api/procurement-template', headers: headers(a.token) }); assert.equal(template.json().version, 0);
    const { version: oldVersion, ...settings } = template.json();
    settings.company = '采购公司'; settings.layout.headerRows[0].font = '宋体'; settings.customFields = [{ key: 'client_ref', label: '客户编号', width: 20 }];
    const savedSettings = await app.inject({ method: 'POST', url: '/api/procurement-template', headers: headers(a.token), payload: { version: oldVersion, fields: settings } });
    assert.equal(savedSettings.statusCode, 200, savedSettings.body);
    const applied = await app.inject({ method: 'POST', url: `/api/procurement/${doc.id}/template`, headers: headers(a.token), payload: { version: 2 } });
    assert.equal(applied.statusCode, 200, applied.body); assert.equal(applied.json().template.company, '采购公司'); assert.equal(applied.json().summary.amount, 135);
    const customSave = await app.inject({ method: 'POST', url: `/api/procurement/${doc.id}/lines/${line.id}`, headers: headers(a.token), payload: { version: 3, fields: { ...save.fields, custom: { client_ref: '00008' } } } });
    assert.equal(customSave.statusCode, 200, customSave.body);
    settings.customFields = [];
    assert.equal((await app.inject({ method: 'POST', url: '/api/procurement-template', headers: headers(a.token), payload: { version: 1, fields: settings } })).statusCode, 200);
    const retained = await app.inject({ method: 'POST', url: `/api/procurement/${doc.id}/template`, headers: headers(a.token), payload: { version: 4 } });
    assert.equal(retained.statusCode, 200); assert.equal(retained.json().template.customFields[0].key, 'client_ref'); assert.equal(retained.json().lines[0].custom.client_ref, '00008');
    const denied = await app.inject({ method: 'POST', url: `/api/procurement/${doc.id}/template`, headers: headers(b.token), payload: { version: 5 } }); assert.equal(denied.statusCode, 404);
  } finally { await app.close(); }
});
