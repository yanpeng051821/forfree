import ExcelJS from 'exceljs';
import sharp from 'sharp';
import { procurementView, lineCalculation, type Procurement } from './procurement';
import { normalizeProcurementTemplate } from './procurement-template';
import { appendWorkbook } from './workbook-append';

export async function exportProcurement(doc: Procurement, original?: Buffer) {
  const workbook = new ExcelJS.Workbook(); workbook.calcProperties.fullCalcOnLoad = true;
  const view = procurementView(doc), template = normalizeProcurementTemplate(doc.template), layout = template.layout;
  const rows = layout.headerRows.filter(row => row.enabled), header = rows.length + 1, first = header + 1, last = Math.max(first, header + doc.lines.length);
  const decimal = (places: number, grouped = false) => (grouped ? '#,##0' : '0') + (places ? '.' + '0'.repeat(places) : '');
  const moneyFormat = decimal(layout.moneyDecimals, true), cbmFormat = decimal(layout.volumeDecimals);
  const border = (cell: ExcelJS.Cell) => {
    if (layout.border === 'none') return;
    const edge: ExcelJS.Border = { style: layout.border, color: { argb: 'FF000000' } };
    cell.border = { top: edge, bottom: edge, left: edge, right: edge };
  };
  function sheet(name: string, headers: string[], widths: number[], businessColumns = headers.length, visible?: boolean[]) {
    const result = workbook.addWorksheet(name);
    widths.forEach((width, i) => { result.getColumn(i + 1).width = width; });
    const span = layout.headerSpan === 0 ? businessColumns : Math.min(layout.headerSpan, businessColumns);
    rows.forEach((setting, index) => {
      const r = index + 1;
      if (span > 1) result.mergeCells(r, 1, r, span);
      const cell = result.getCell(r, 1);
      const values: Record<string, string> = { company: template.company, companyEnglish: template.companyEnglish, address: template.address, contact: template.contact, documentTitle: template.documentTitle };
      cell.value = values[setting.key] ?? setting.text;
      cell.font = { name: setting.font, size: setting.size, bold: setting.bold, color: { argb: 'FF' + (setting.color || '#000000').slice(1).toUpperCase() } };
      cell.alignment = { horizontal: setting.align, vertical: 'middle', wrapText: true };
      if (setting.key === 'documentTitle' && layout.border !== 'none') cell.border = { bottom: { style: layout.border, color: { argb: 'FF000000' } } };
      const available = widths.slice(0, span).reduce((n, width, i) => n + (visible?.[i] === false ? 0 : width * 7), 0);
      const estimate = String(cell.value).split('\n').reduce((n, text) => n + Math.max(1, Math.ceil([...text].reduce((w, ch) => w + setting.size * (/[\u3400-\u9fff]/.test(ch) ? 1.3 : .7), 0) / Math.max(30, available))), 0);
      result.getRow(r).height = Math.min(409, Math.max(setting.height, estimate * setting.size * 1.15));
    });
    result.getRow(header).values = headers;
    result.getRow(header).height = Math.max(layout.fieldHeight, ...headers.map((text, i) => Math.ceil(text.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil([...line].length * layout.fieldSize / Math.max(20, widths[i] * 5))), 0) * layout.fieldSize * 1.3)));
    result.views = [{ state: 'frozen', ySplit: header, showGridLines: false }];
    result.pageSetup = { orientation: layout.orientation, paperSize: layout.paper === 'A4' ? 9 : undefined, fitToPage: layout.printMode === 'fit', fitToWidth: 1, fitToHeight: 0, scale: layout.scale, ...(layout.repeatHeader ? { printTitlesRow: `1:${header}` } : {}), margins: { left: .7, right: .7, top: .75, bottom: .75, header: .3, footer: .3 } };
    return result;
  }
  const columns = [...template.columns.map(c => ({ key: c.key, label: c.label, width: c.width || 16, enabled: c.enabled })), ...template.customFields.map(c => ({ key: c.key, label: c.label, width: c.width, enabled: true }))];
  const provenance = ['原表范围', '原表是否计入', '原表标记', '原表数量', '原表金额', '原表总体积', '人工核对备注', '导入核对提示', '计入金额缺项', '计入体积缺项'];
  const detail = sheet('商品明细', [...columns.map(c => c.label), ...provenance], [...columns.map(c => c.width), 32, 16, 26, 14, 16, 18, 32, 46, 12, 12], columns.length, columns.map(c => c.enabled));
  columns.forEach((c, i) => { detail.getColumn(i + 1).hidden = !c.enabled; });
  const numberFor = (key: string) => columns.findIndex(c => c.key === key) + 1;
  const col = (key: string) => detail.getColumn(numberFor(key)).letter;
  const ref = (key: string, row: number) => col(key) + row;
  const missingAmount = detail.getColumn(columns.length + 9).letter, missingCbm = detail.getColumn(columns.length + 10).letter;
  const ranges = (c: string) => `'商品明细'!$${c}$${first}:$${c}$${last}`;
  const selectedSum = (c: string, r: number) => `SUMIFS(${ranges(c)},${ranges(col('supplier'))},A${r},${ranges(col('decision'))},"计入")`;
  const selectedCount = (r: number) => `COUNTIFS(${ranges(col('supplier'))},A${r},${ranges(col('decision'))},"计入")`;
  for (const [i, line] of doc.lines.entries()) {
    const r = first + i, calc = lineCalculation(line);
    const core: Record<string, ExcelJS.CellValue> = { image: '', supplier: line.supplier, sku: line.sku, decision: { pending: '待核对', include: '计入', cancel: '取消' }[line.decision], cartons: line.cartons, pcsPerCarton: line.pcsPerCarton, unitPrice: line.unitPrice, currency: line.currency, cartonCbm: line.cartonCbm, description: line.description, barcode: line.barcode,
      quantity: line.quantity ?? { formula: `IF(COUNT(${ref('cartons', r)},${ref('pcsPerCarton', r)})<2,"",${ref('cartons', r)}*${ref('pcsPerCarton', r)})`, result: calc.quantity ?? '' },
      amount: { formula: `IF(COUNT(${ref('quantity', r)},${ref('unitPrice', r)})<2,"",ROUND(${ref('quantity', r)}*${ref('unitPrice', r)},2))`, result: calc.amount ?? '' },
      cbm: { formula: `IF(COUNT(${ref('cartons', r)},${ref('cartonCbm', r)})<2,"",${ref('cartons', r)}*${ref('cartonCbm', r)})`, result: calc.cbm ?? '' } };
    detail.getRow(r).values = [...columns.map(c => core[c.key] ?? line.custom?.[c.key] ?? ''), line.source, line.sourceIncluded ? '是' : '否', line.sourceMark, line.sourceQuantity, line.sourceAmount, line.sourceCbm, line.note, line.warnings.join('；'),
      { formula: `IF(AND(${ref('decision', r)}="计入",COUNT(${ref('quantity', r)},${ref('unitPrice', r)})<2),1,0)`, result: line.decision === 'include' && calc.amount === null ? 1 : 0 },
      { formula: `IF(AND(${ref('decision', r)}="计入",COUNT(${ref('cartons', r)},${ref('cartonCbm', r)})<2),1,0)`, result: line.decision === 'include' && calc.cbm === null ? 1 : 0 }];
    detail.getRow(r).height = line.images.length > 1 ? layout.multiImageHeight : layout.bodyHeight;
    detail.getCell(r, numberFor('decision')).dataValidation = { type: 'list', allowBlank: false, formulae: ['"待核对,计入,取消"'] };
    for (const key of ['unitPrice', 'amount']) detail.getCell(ref(key, r)).numFmt = moneyFormat;
    for (const key of ['cartonCbm', 'cbm']) detail.getCell(ref(key, r)).numFmt = cbmFormat;
    detail.getCell(r, columns.length + 5).numFmt = moneyFormat; detail.getCell(r, columns.length + 6).numFmt = cbmFormat;
    if (template.columns.find(c => c.key === 'image')?.enabled) {
      for (const [j, data] of line.images.entries()) {
        const buffer = Buffer.from(data.split(',')[1], 'base64'), metadata = await sharp(buffer).metadata();
        const availableWidth = Math.max(24, (template.columns.find(c => c.key === 'image')?.width || 22.75) * 7 - 12);
        const availableHeight = detail.getRow(r).height! * 4 / 3 / line.images.length - 8;
        const ratio = Math.min(availableWidth / (metadata.width || 100), availableHeight / (metadata.height || 100));
        const id = workbook.addImage({ buffer: buffer as unknown as ExcelJS.Buffer, extension: 'jpeg' });
        detail.addImage(id, { tl: { col: numberFor('image') - 1 + .03, row: r - 1 + j / line.images.length + .02 }, ext: { width: (metadata.width || 100) * ratio, height: (metadata.height || 100) * ratio }, editAs: 'oneCell' });
      }
    }
  }
  detail.autoFilter = { from: { row: header, column: 1 }, to: { row: last, column: columns.length + 8 } };
  if (doc.lines.length) detail.addConditionalFormatting({ ref: `${ref('decision', first)}:${ref('decision', last)}`, rules: [{ type: 'containsText', operator: 'containsText', text: '待核对', priority: 1, style: { font: { color: { argb: 'FFFF0000' } } } }] });
  detail.getColumn(missingAmount).hidden = true; detail.getColumn(missingCbm).hidden = true;
  const summary = sheet('采购汇总', ['商户', '商品数', '待核对', '原表箱数', '原表金额(RMB)', '原表体积(m³)', '计入箱数', '计入商品金额', '运费', '计入金额', '计入体积(m³)', '核对提示'], [24, 12, 12, 14, 20, 20, 14, 20, 14, 20, 20, 55]);
  view.suppliers.forEach((s, i) => {
    const r = first + i;
    summary.getRow(r).values = [s.name, s.count, { formula: `COUNTIFS(${ranges(col('supplier'))},A${r},${ranges(col('decision'))},"待核对")`, result: s.pending }, s.sourceCartons, s.sourceAmount, s.sourceCbm,
      { formula: `IF(COUNTIFS(${ranges(col('supplier'))},A${r},${ranges(col('decision'))},"计入",${ranges(col('cartons'))},"")>0,"",${selectedSum(col('cartons'), r)})`, result: s.cartons ?? '' }, { formula: `IF(${selectedSum(missingAmount, r)}>0,"",${selectedSum(col('amount'), r)})`, result: s.goodsAmount ?? '' }, s.freight,
      { formula: `IF(OR(${selectedCount(r)}=0,COUNT(H${r}:I${r})<2),"",H${r}+I${r})`, result: s.amount ?? '' }, { formula: `IF(${selectedSum(missingCbm, r)}>0,"",${selectedSum(col('cbm'), r)})`, result: s.cbm ?? '' }, s.warnings.join('；')];
    summary.getRow(r).height = 42;
  });
  const end = first + view.suppliers.length;
  summary.getCell(end, 1).value = '合计';
  for (const c of [2, 3, 4, 5, 6, 7, 8, 9, 11]) {
    const letter = summary.getColumn(c).letter, values = view.suppliers.map((s, index) => [s.count, s.pending, s.sourceCartons, s.sourceAmount, s.sourceCbm, s.cartons, s.goodsAmount, s.freight, null, s.cbm][c - 2]);
    summary.getCell(end, c).value = { formula: `IF(COUNT(${letter}${first}:${letter}${end - 1})<>ROWS(${letter}${first}:${letter}${end - 1}),"",SUM(${letter}${first}:${letter}${end - 1}))`, result: values.some(v => v === null) ? '' : values.reduce<number>((n, v) => n + Number(v || 0), 0) };
  }
  const unresolved = view.suppliers.map((_, i) => `IF(AND(${selectedCount(first + i)}>0,NOT(ISNUMBER(J${first + i}))),1,0)`).join('+') || '0';
  summary.getCell(end, 10).value = { formula: `IF(OR(COUNTIFS(${ranges(col('decision'))},"计入")=0,(${unresolved})>0),"",SUM(J${first}:J${end - 1}))`, result: view.summary.amount ?? '' };
  for (let r = first; r <= end; r++) { [5, 8, 9, 10].forEach(c => { summary.getCell(r, c).numFmt = moneyFormat; }); [6, 11].forEach(c => { summary.getCell(r, c).numFmt = cbmFormat; }); }
  const business = sheet('商户要求', ['商户', '原表要求与联系方式', '运费来源', '待核对事项'], [24, 110, 40, 55]);
  view.suppliers.forEach((s, i) => { business.getRow(first + i).values = [s.name, s.information, s.freightSource || '未单列', s.warnings.join('；')]; business.getRow(first + i).height = Math.min(409, Math.max(200, (s.information.split('\n').length + 4) * layout.bodySize * 1.5)); });
  const audit = sheet('核对记录', ['商户', '货号', '原表范围', '核对项'], [24, 20, 35, 85]);
  doc.issues.forEach((issue, i) => { audit.getRow(first + i).values = [issue.supplier, issue.sku, issue.source, issue.message]; audit.getRow(first + i).height = 36; });
  if (!doc.issues.length) audit.getCell(first, 1).value = '未发现导入异常；商品处理决定仍需核对。';
  for (const result of workbook.worksheets) {
    for (let r = header; r <= result.rowCount; r++) {
      const total = result === summary && r === end;
      for (let c = 1; c <= result.columnCount; c++) {
        const cell = result.getCell(r, c);
        cell.font = { name: /[\u3400-\u9fff]/.test(cell.text) ? layout.chineseFont : layout.latinFont, size: r === header ? layout.fieldSize : total ? layout.totalSize : layout.bodySize, bold: r === header || total, color: { argb: 'FF' + ((r === header ? layout.fieldColor : total ? layout.totalColor : layout.bodyColor) || '#000000').slice(1).toUpperCase() } };
        cell.alignment = { horizontal: r === header ? 'center' : layout.alignment, vertical: 'middle', wrapText: true }; border(cell);
      }
    }
    result.pageSetup.printArea = `A1:${result.getColumn(result === detail ? columns.length : result.columnCount).letter}${result.rowCount}`;
    const footer = result.rowCount + 2, span = result === detail ? columns.length : result.columnCount;
    if (span > 1) result.mergeCells(footer, 1, footer, span);
    result.getCell(footer, 1).value = '来源：' + doc.sourceName + (result === summary ? '；仅人工选择“计入”的商品及已确认运费纳入本次金额。' : '');
    result.getCell(footer, 1).font = { name: layout.chineseFont, size: 10 }; result.getCell(footer, 1).alignment = { wrapText: true };
  }
  const generated = Buffer.from(await workbook.xlsx.writeBuffer());
  return original ? appendWorkbook(original, generated) : generated;
}
