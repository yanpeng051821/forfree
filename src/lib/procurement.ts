import ExcelJS from 'exceljs';
import sharp from 'sharp';
import { createHash, randomUUID } from 'node:crypto';
import { AppError } from './errors';
import type { Product, Project } from './types';
import { defaultProcurementTemplate, tableFonts, type ProcurementTemplate } from './procurement-template';

export type Decision = 'pending' | 'include' | 'cancel';
export type ProcurementLine = {
  id: string; supplier: string; sku: string; description: string; barcode: string;
  cartons: number | null; pcsPerCarton: number | null; unitPrice: number | null;
  cartonCbm: number | null; currency: string; decision: Decision; note: string;
  source: string; sourceIncluded: boolean; sourceMark: string;
  sourceQuantity: number | null; sourceAmount: number | null; sourceCbm: number | null;
  // A quantity explicitly recorded in the field takes precedence over carton arithmetic.
  // Older documents omit this field and continue to calculate cartons × pieces.
  quantity?: number | null;
  images: string[]; warnings: string[];
  custom?: Record<string, string>;
};
export type ProcurementSupplier = {
  name: string; source: string; sourceCartons: number | null; sourceAmount: number | null; sourceCbm: number | null;
  freight: number | null; freightSource: string; information: string; warnings: string[];
};
export type ProcurementIssue = { source: string; supplier: string; sku: string; message: string };
export type Procurement = {
  format: 1; id: string; version: number; name: string; sourceName: string; sourceHash: string;
  createdAt: string; updatedAt: string; suppliers: ProcurementSupplier[]; lines: ProcurementLine[];
  issues: ProcurementIssue[]; skippedSheets: string[];
  template?: ProcurementTemplate;
};
const round = (value: number, places = 2) => Math.round((value + Number.EPSILON) * 10 ** places) / 10 ** places;
function text(cell: ExcelJS.Cell): string {
  const v = cell.value;
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if ('richText' in v) return v.richText.map(t => t.text).join('').trim();
    if ('formula' in v || 'sharedFormula' in v) return v.result === undefined ? '' : String(v.result).trim();
    if ('text' in v) return String(v.text).trim();
  }
  return String(v).trim();
}
function number(cell: ExcelJS.Cell): number | null {
  const v = cell.value;
  const value = v && typeof v === 'object' && ('formula' in v || 'sharedFormula' in v) ? v.result : v;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\s*\d+(?:\.\d+)?\s*$/.test(value)) return Number(value);
  return null;
}
export function lineCalculation(line: ProcurementLine) {
  const quantity = line.quantity ?? (line.cartons === null || line.pcsPerCarton === null ? null : line.cartons * line.pcsPerCarton);
  return { quantity, amount: quantity === null || line.unitPrice === null ? null : round(quantity * line.unitPrice), cbm: line.cartons === null || line.cartonCbm === null ? null : round(line.cartons * line.cartonCbm, 6) };
}
export function procurementView(doc: Procurement) {
  const lines = doc.lines.map(line => ({ ...line, ...lineCalculation(line) }));
  const currencies = [...new Set(lines.map(l => l.currency))];
  const suppliers = doc.suppliers.map(supplier => {
    const own = lines.filter(line => line.supplier === supplier.name);
    const selected = own.filter(line => line.decision === 'include');
    const incomplete = selected.some(line => line.amount === null);
    const goodsAmount = incomplete ? null : round(selected.reduce((sum, line) => sum + (line.amount || 0), 0));
    return { ...supplier, count: own.length, pending: own.filter(line => line.decision === 'pending').length, selected: selected.length,
      cartons: selected.some(line => line.cartons === null) ? null : selected.reduce((sum, line) => sum + (line.cartons || 0), 0),
      goodsAmount, amount: !selected.length ? null : goodsAmount === null || supplier.freight === null ? null : round(goodsAmount + supplier.freight),
      cbm: selected.some(line => line.cbm === null) ? null : round(selected.reduce((sum, line) => sum + (line.cbm || 0), 0), 6) };
  });
  const selected = lines.filter(line => line.decision === 'include');
  return { ...doc, lines, suppliers, summary: {
    suppliers: suppliers.length, lines: lines.length, pending: lines.filter(line => line.decision === 'pending').length,
    included: selected.length, cancelled: lines.filter(line => line.decision === 'cancel').length,
    sourceAmount: suppliers.some(s => s.sourceAmount === null) ? null : round(suppliers.reduce((n, s) => n + (s.sourceAmount || 0), 0)),
    amount: !selected.length || currencies.length !== 1 || suppliers.some(s => s.selected > 0 && s.amount === null) ? null : round(suppliers.reduce((n, s) => n + (s.amount || 0), 0)),
    currency: currencies.length === 1 ? currencies[0] : '', issues: doc.issues.length,
  } };
}

export async function readProcurement(bytes: Buffer, filename: string): Promise<Procurement> {
  const workbook = new ExcelJS.Workbook();
  try { await workbook.xlsx.load(bytes as unknown as ExcelJS.Buffer); }
  catch { throw new AppError('INVALID_WORKBOOK', '无法读取 Excel，请选择未加密的 .xlsx 文件'); }
  const now = new Date().toISOString();
  const doc: Procurement = { format: 1, id: randomUUID(), version: 1, name: filename.replace(/\.xlsx$/i, ''), sourceName: filename, sourceHash: createHash('sha256').update(bytes).digest('hex'), createdAt: now, updatedAt: now, suppliers: [], lines: [], issues: [], skippedSheets: [] };
  const imageCache = new Map<string, string>();
  let volumeDecimals: number | null = null;
  const observeVolumePrecision = (cell: ExcelJS.Cell) => {
    const value = number(cell);
    if (value === null) return;
    const [mantissa, exponent = '0'] = String(value).toLowerCase().split('e');
    const actual = Math.max(0, (mantissa.split('.')[1]?.length || 0) - Number(exponent));
    // Ignore quoted units, escaped characters and conditional/color directives.
    const format = (cell.numFmt || '').split(';')[0].replace(/"[^"]*"|\\.|_.|\*.|\[[^\]]*\]/g, '');
    const formatted = format.match(/\.[0#?]+/)?.[0].length ?? 1;
    volumeDecimals = Math.min(6, Math.max(volumeDecimals ?? 0, actual, formatted - 1));
  };
  const issue = (supplier: string, source: string, message: string, sku = '') => doc.issues.push({ supplier, source, message, sku });
  for (const sheet of workbook.worksheets) {
    if (sheet.rowCount > 10000) throw new AppError('WORKBOOK_LIMIT', '工作表超过10000行，请拆分文件');
    // Inspect actual values in a bounded header window, not formatting that extends to XFD.
    let header = 0;
    for (let r = 1; r <= Math.min(30, sheet.rowCount); r++) {
      const labels = [1, 2, 3, 5, 6].map(c => text(sheet.getCell(r, c)).toUpperCase());
      if (/REF|货号/.test(labels[0]) && /CTNS|箱数/.test(labels[1]) && /PCS|每箱/.test(labels[2]) && /PRICE|单价|价格/.test(labels[3]) && /AMOUNT|金额/.test(labels[4])) { header = r; break; }
    }
    if (!header) {
      const hasData = sheet.getSheetValues().some(row => Array.isArray(row) && row.some(value => value !== null && value !== undefined && value !== ''));
      if (hasData) throw new AppError('UNSUPPORTED_WORKBOOK', `“${sheet.name}”字段无法匹配，目前支持 REF / CTNS / PCS/CTN / PRICE / AMOUNT 采购表`);
      doc.skippedSheets.push(sheet.name); continue;
    }
    if (!doc.template && header === 6 && /[\u3400-\u9fff]/.test(text(sheet.getCell('A1'))) && /[A-Za-z]/.test(text(sheet.getCell('A2')))) {
      const suggested = defaultProcurementTemplate();
      ['company', 'companyEnglish', 'address', 'contact', 'documentTitle'].forEach((key, i) => {
        const cell = sheet.getCell(i + 1, 1), setting = suggested.layout.headerRows[i];
        suggested[key as 'company' | 'companyEnglish' | 'address' | 'contact' | 'documentTitle'] = text(cell);
        if (tableFonts.includes(cell.font?.name as typeof tableFonts[number])) setting.font = cell.font.name as typeof tableFonts[number];
        setting.size = Math.min(40, Math.max(6, cell.font?.size || setting.size)); setting.bold = cell.font?.bold === true;
        setting.height = Math.max(setting.size * 1.15, Math.min(120, sheet.getRow(i + 1).height || setting.height));
        if (['left', 'center', 'right'].includes(cell.alignment?.horizontal || '')) setting.align = cell.alignment.horizontal as 'center';
      });
      suggested.documentTitle ||= '采购记录 / PROCUREMENT RECORD';
      suggested.layout.fieldHeight = sheet.getRow(6).height || 25.5;
      suggested.layout.bodyHeight = Math.min(300, Math.max(40, sheet.getRow(7).height || 98));
      suggested.layout.multiImageHeight = Math.max(128, suggested.layout.bodyHeight);
      // Source span remains intact on original sheets; generated columns adapt to their own width.
      const sourceCols: Record<string, number> = { sku: 1, cartons: 2, pcsPerCarton: 3, quantity: 4, unitPrice: 5, amount: 6, description: 7, image: 8, cartonCbm: 9, cbm: 10, barcode: 11 };
      suggested.columns.forEach(column => { if (sourceCols[column.key]) { column.width = Math.min(80, Math.max(5, sheet.getColumn(sourceCols[column.key]).width || column.width!)); column.label = text(sheet.getCell(header, sourceCols[column.key])) || column.label; } });
      doc.template = suggested;
    }
    if (!/RMB|CNY|人民币/i.test(text(sheet.getCell(header, 5)))) throw new AppError('CURRENCY_UNSUPPORTED', `“${sheet.name}”采购币种无法确认，当前导入需要价格列明确标记RMB或CNY`);
    const totals: number[] = [];
    for (let r = header + 1; r <= sheet.rowCount; r++) if (/^(TOTAL|合计|总计)$/i.test(text(sheet.getCell(r, 1)))) totals.push(r);
    if (totals.length > 1) throw new AppError('UNSUPPORTED_WORKBOOK', `“${sheet.name}”有多个合计区，请先拆成每商户一个明细区`);
    const total = totals[0] || 0;
    const sheetLines: ProcurementLine[] = [];
    const fees: { amount: number | null; source: string }[] = [];
    const notes: string[] = [];
    const markers: string[] = [];
    for (let r = header + 1; r <= sheet.rowCount; r++) {
      const row = sheet.getRow(r), sku = text(row.getCell(1));
      const cartons = number(row.getCell(2)), pcs = number(row.getCell(3)), price = number(row.getCell(5));
      const isLine = !!sku && !/^(TOTAL|合计|总计)$/i.test(sku) && !row.getCell(1).isMerged && (cartons !== null || pcs !== null || price !== null);
      if (isLine) {
        const status = [7, 8, 11].map(c => text(row.getCell(c))).filter(value => /取消|待确认/.test(value)).join(' / ');
        const mark = status || (total && r > total ? '合计行下方' : '');
        const included = !!total && r < total;
        const line: ProcurementLine = { id: randomUUID(), supplier: sheet.name, sku, description: text(row.getCell(7)), barcode: /取消|待确认/.test(text(row.getCell(11))) ? '' : text(row.getCell(11)), cartons, pcsPerCarton: pcs, unitPrice: price, cartonCbm: number(row.getCell(9)), currency: 'CNY', decision: 'pending', note: '', source: `${sheet.name}!A${r}:K${r}`, sourceIncluded: included, sourceMark: mark, sourceQuantity: number(row.getCell(4)), sourceAmount: number(row.getCell(6)), sourceCbm: number(row.getCell(10)), images: [], warnings: [] };
        observeVolumePrecision(row.getCell(9)); observeVolumePrecision(row.getCell(10));
        if (mark) line.warnings.push(mark.includes('取消') ? '原表标记取消，需核对后决定是否计入' : mark.includes('待确认') ? '原表标记待确认' : '合计下方商品未计入原表合计');
        if (cartons === null || pcs === null || price === null) line.warnings.push('箱数、每箱数量或采购单价缺失');
        if ((cartons !== null && (!Number.isInteger(cartons) || cartons < 0)) || (pcs !== null && (!Number.isInteger(pcs) || pcs <= 0)) || (price !== null && price < 0) || (line.cartonCbm !== null && line.cartonCbm < 0)) line.warnings.push('数量、单价或体积数值无效');
        const calculated = lineCalculation(line);
        for (const [label, cached, value, tolerance] of [['数量', line.sourceQuantity, calculated.quantity, 0], ['金额', line.sourceAmount, calculated.amount, .011], ['总体积', line.sourceCbm, calculated.cbm, .000001]] as const) {
          if (cached !== null && value !== null && Math.abs(cached - value) > tolerance) line.warnings.push(`原表${label}与重新计算不一致`);
        }
        if (line.cartonCbm !== null && line.cartonCbm >= .5) line.warnings.push('单箱体积≥0.5m³，请核对小数点和单位');
        // Merge masters provide the marker for every covered item row.
        const images = sheet.getImages().filter(image => image.range.tl.col >= 6.99 && image.range.tl.col < 8.01 && Math.floor(image.range.tl.row + .00001) + 1 === r);
        for (const item of images) {
          const media = workbook.getImage(Number(item.imageId));
          if (!media?.buffer) { line.warnings.push('图片格式无法读取'); continue; }
          const buffer = Buffer.from(media.buffer);
          const hash = createHash('sha256').update(buffer).digest('hex');
          if (!imageCache.has(hash)) {
            try { imageCache.set(hash, `data:image/jpeg;base64,${(await sharp(buffer, { limitInputPixels: 40_000_000 }).rotate().resize({ width: 720, height: 720, fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality: 84 }).toBuffer()).toString('base64')}`); }
            catch { line.warnings.push('图片无法解码，请核对原图'); }
          }
          const prepared = imageCache.get(hash);
          if (prepared && !line.images.includes(prepared)) line.images.push(prepared);
        }
        if (!line.images.length) line.warnings.push('未找到同一商品行的图片');
        if (line.images.length > 1) line.warnings.push('同一行有多张图，保留全部，需确认商品图与包装图');
        sheetLines.push(line);
        if (doc.lines.length + sheetLines.length > 500) throw new AppError('WORKBOOK_LIMIT', '单次最多整理500条商品，请拆分文件');
      } else if (r !== total) {
        const memo = [7, 8, 11].map(c => text(row.getCell(c))).join(' ');
        if (/运费/.test(memo) && (total === 0 || r < total)) fees.push({ amount: number(row.getCell(6)), source: `${sheet.name}!F${r}` });
        const values = new Set<string>();
        for (let c = 1; c <= 11; c++) {
          const cell = row.getCell(c);
          if (!cell.isMerged || cell.master.address === cell.address) {
            const value = text(cell);
            if (value && !/^0(?:\.0+)?$/.test(value)) values.add(value);
          }
        }
        if (total && r > total) for (const value of values) {
          notes.push(`${sheet.name}!${r}  ${value}`);
          if (/取消|待确认/.test(value)) markers.push(`${sheet.name}!${r} ${value}`);
        }
      }
    }
    if (!sheetLines.length) { doc.skippedSheets.push(sheet.name); continue; }
    for (const line of sheetLines) {
      if (sheetLines.filter(other => other.sku === line.sku).length > 1) line.warnings.push('同商户货号重复，保留各行，不自动合并');
      if (line.barcode && sheetLines.filter(other => other.barcode === line.barcode).length > 1) line.warnings.push('商户条码重复，请核对是否不同商品');
    }
    const supplier: ProcurementSupplier = { name: sheet.name, source: total ? `${sheet.name}!A${total}:J${total}` : sheet.name, sourceCartons: total ? number(sheet.getCell(total, 2)) : null, sourceAmount: total ? number(sheet.getCell(total, 6)) : null, sourceCbm: total ? number(sheet.getCell(total, 10)) : null, freight: !fees.length || fees.some(f => f.amount === null) ? null : round(fees.reduce((n, f) => n + (f.amount || 0), 0)), freightSource: fees.map(f => f.source).join(' / '), information: notes.join('\n'), warnings: [] };
    if (total) observeVolumePrecision(sheet.getCell(total, 10));
    if (!fees.length) supplier.warnings.push('原表未单列运费，请确认是否已含，无额外运费填写0');
    if (markers.length) {
      supplier.warnings.push('商户区域有取消或待确认标记，作用范围需人工核对');
      sheetLines.forEach(line => line.warnings.push('商户状态需核对'));
      markers.forEach(mark => issue(sheet.name, mark, '商户备注中的状态范围不明确，不自动取消商品'));
    }
    const base = sheetLines.filter(l => l.sourceIncluded);
    if (!total) supplier.warnings.push('未找到原表合计');
    for (const [label, cached, values, tolerance] of [['箱数', supplier.sourceCartons, base.map(l => l.cartons), 0], ['金额', supplier.sourceAmount, [...base.map(l => lineCalculation(l).amount), ...fees.map(f => f.amount)], .011], ['总体积', supplier.sourceCbm, base.map(l => lineCalculation(l).cbm), .000001]] as const) {
      if (cached !== null && values.every(value => value !== null) && Math.abs([...values].reduce<number>((n, value) => n + (value || 0), 0) - cached) > tolerance) supplier.warnings.push(`原表合计${label}与明细重算不一致`);
    }
    if (sheet.state !== 'visible') supplier.warnings.push('原工作表隐藏，已保留并提示核对');
    supplier.warnings.forEach(message => issue(sheet.name, supplier.source, message));
    sheetLines.forEach(line => line.warnings.forEach(message => issue(line.supplier, line.source, message, line.sku)));
    doc.suppliers.push(supplier); doc.lines.push(...sheetLines);
  }
  if (!doc.lines.length) throw new AppError('EMPTY_WORKBOOK', '未找到商品明细，请选择包含采购商品的表格');
  const seen = new Map<string, ProcurementLine[]>();
  for (const line of doc.lines) if (line.barcode) seen.set(line.barcode, [...(seen.get(line.barcode) || []), line]);
  for (const lines of seen.values()) if (new Set(lines.map(l => l.supplier)).size > 1) for (const line of lines) { const message = '条码在不同商户重复，请核对'; line.warnings.push(message); issue(line.supplier, line.source, message, line.sku); }
  if (doc.template && volumeDecimals !== null) doc.template.layout.volumeDecimals = volumeDecimals;
  return doc;
}

export async function procurementFromProducts(project: Project, products: Product[], readPhoto: (id: string) => Buffer | Promise<Buffer>): Promise<Procurement> {
  if (!products.length || products.length > 500) throw new AppError('WORKBOOK_LIMIT', '请选择包含1至500件商品的任务');
  const now = new Date().toISOString();
  const doc: Procurement = { format: 1, id: randomUUID(), version: 1, name: project.name + ' · 采购整理', sourceName: project.name + ' 看货记录', sourceHash: '', createdAt: now, updatedAt: now, suppliers: [], lines: [], issues: [], skippedSheets: [] };
  for (const product of products) {
    const supplier = product.supplier || '商户待填写';
    if (!doc.suppliers.some(s => s.name === supplier)) doc.suppliers.push({ name: supplier, source: '看货任务', sourceCartons: null, sourceAmount: null, sourceCbm: null, freight: null, freightSource: '', information: '', warnings: ['运费待填写'] });
    const s = doc.suppliers.find(s => s.name === supplier)!;
    if (product.supplierContact && !s.information.includes(product.supplierContact)) s.information += (s.information ? '\n' : '') + product.supplierContact;
    const images: string[] = [];
    for (const photo of product.photos) images.push(`data:image/jpeg;base64,${(await sharp(await readPhoto(photo.id)).resize({ width: 720, height: 720, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 84 }).toBuffer()).toString('base64')}`);
    const cartons = product.cartons ?? null, quantity = product.quantity ?? null;
    const warnings = cartons === null ? ['下单箱数待填写，起订量不作为采购数量'] : [];
    if (quantity !== null && cartons !== null && product.cartonQty !== null && quantity !== cartons * product.cartonQty) warnings.push('已录数量与箱数×每箱数量不一致，按已录数量保留');
    doc.lines.push({ id: randomUUID(), supplier, sku: product.sku || product.name, description: [product.name, product.colors, product.material, product.dimensions, product.notes].filter(Boolean).join(' / '), barcode: product.barcode ?? '', cartons, quantity, pcsPerCarton: product.cartonQty, unitPrice: product.unitPrice, cartonCbm: product.cartonCbm, currency: product.currency, decision: 'pending', note: '', source: '看货商品 ' + product.id, sourceIncluded: false, sourceMark: '', sourceQuantity: quantity, sourceAmount: null, sourceCbm: null, images, warnings });
  }
  return doc;
}
