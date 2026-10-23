import ExcelJS from 'exceljs';
import sharp from 'sharp';
import { chinaDate } from './dates';
import { AppError } from './errors';
import { defaultProcurementTemplate, normalizeProcurementTemplate, type ProcurementTemplate } from './procurement-template';
import type { Product, Project } from './types';

const businessColumns = {
  name: { label: '商品名称', width: 22 },
  supplierContact: { label: '商户联系方式', width: 26 },
  colors: { label: '颜色', width: 20 },
  material: { label: '材质', width: 16 },
  dimensions: { label: '商品尺寸（含单位）', width: 24 },
  weightG: { label: '单件重量(g)', width: 16 },
  moq: { label: '起订量（非采购数量）', width: 22 },
  cartonDimensions: { label: '外箱尺寸（含单位）', width: 24 },
  leadTimeDays: { label: '大货交期(天)', width: 16 },
  tradeTerms: { label: '现场记录报价条款', width: 26 },
  description: { label: '商品原始描述', width: 36 },
  notes: { label: '现场备注', width: 32 },
  favorite: { label: '收藏', width: 12 },
  rating: { label: '选品评分', width: 12 },
  evaluation: { label: '选品评价', width: 36 },
  photoCount: { label: '照片数量', width: 12 },
  project: { label: '看货任务', width: 24 },
  market: { label: '市场', width: 20 },
  date: { label: '任务日期', width: 14 },
  recordDate: { label: '记录日期', width: 14 },
  demo: { label: '示例数据', width: 12 },
} as const;

export type QuotationBusinessField = keyof typeof businessColumns;
export type QuotationExportOptions = {
  images?: boolean;
  scope?: 'all' | 'confirmed';
  audience?: 'selection' | 'internal';
  businessFields?: QuotationBusinessField[];
};
type Column = { key: string; label: string; width: number; enabled: boolean; businessField?: QuotationBusinessField; currencyPrefix?: boolean; primary?: boolean };
const priceNotice = '单价为用户现场记录价格，按原币种和报价条款保留；未加价、换汇或生成新报价，不同币种不混加。';
const purchaseNotice = '本表用于现场选品与分享；“已核对”仅指商品记录已核对，不代表订单已确认或采购计入。数量优先使用用户填写值，否则按箱数×每箱数量计算；金额为数量×单价，总体积为箱数×单箱体积。缺少计算所需数值时留空，起订量不作为采购数量。';
const containsChinese = (text: string) => /[\u3400-\u9fff]/.test(text);
const decimalFormat = (places: number, grouped = false) => (grouped ? '#,##0' : '0') + (places ? '.' + '0'.repeat(places) : '');
const formattedNumericText = (value: number, key: string, currency: string, currencyPrefix: boolean | undefined, layout: ProcurementTemplate['layout']) => {
  const money = ['unitPrice', 'amount'].includes(key), volume = ['cartonCbm', 'cbm'].includes(key);
  const places = money ? layout.moneyDecimals : volume ? layout.volumeDecimals : 0;
  const text = value.toLocaleString('en-US', { minimumFractionDigits: places, maximumFractionDigits: places, useGrouping: money });
  return money && currencyPrefix ? currency + ' ' + text : text;
};

// Estimate wrapping against visible widths, including explicit line breaks.
function textHeight(text: string, size: number, pixels: number, minimum: number) {
  const lines = text.split('\n').reduce((count, line) => count + Math.max(1, Math.ceil(
    [...line].reduce((width, character) => width + size * (containsChinese(character) ? 1.3 : .7), 0) / Math.max(20, pixels),
  )), 0);
  return Math.min(409, Math.max(minimum, lines * size * 1.3));
}

// Excel caps one row at 409pt. Split only genuine overflow so ordinary product
// rows stay one row while long remarks remain readable in print and sharing.
function textSegments(text: string, size: number, pixels: number) {
  if (!text) return [''];
  const linePixels = Math.max(20, pixels), maxLines = Math.max(1, Math.floor((409 - 12) / (size * 1.3)));
  const segments: string[] = [];
  let segment = '', lineWidth = 0, lines = 1;
  const flush = () => {
    if (segment) segments.push(segment);
    segment = ''; lineWidth = 0; lines = 1;
  };
  for (const character of [...text]) {
    if (character === '\n') {
      if (lines >= maxLines) flush();
      else { segment += character; lineWidth = 0; lines++; }
      continue;
    }
    const width = size * (containsChinese(character) ? 1.3 : .7);
    if (lineWidth > 0 && lineWidth + width > linePixels) {
      if (lines >= maxLines) flush();
      else { lineWidth = 0; lines++; }
    }
    segment += character; lineWidth += width;
  }
  if (segment || !segments.length) segments.push(segment);
  return segments;
}

function description(product: Product) {
  // The reference's remark column holds product/packing details. Raw onsite text,
  // personal notes, evaluations and supplier contacts remain internal.
  return [product.name.trim() === product.sku.trim() ? '' : product.name, product.colors, product.material, product.dimensions,
    product.cartonDimensions ? '外箱：' + product.cartonDimensions : '', product.exportRemarks].filter(Boolean).join(' / ');
}

function productValues(product: Product): Record<string, ExcelJS.CellValue> {
  const cartons = product.cartons ?? null;
  const quantity = product.quantity ?? (cartons !== null && product.cartonQty != null ? cartons * product.cartonQty : null);
  return { image: null, supplier: product.supplier, sku: product.sku, description: description(product),
    decision: product.confirmed ? '已核对' : '待核对', unitPrice: product.unitPrice, currency: product.currency,
    pcsPerCarton: product.cartonQty, cartonCbm: product.cartonCbm, cartons, quantity,
    amount: quantity !== null && product.unitPrice != null ? quantity * product.unitPrice : null,
    cbm: cartons !== null && product.cartonCbm != null ? cartons * product.cartonCbm : null, barcode: product.barcode ?? '' };
}

const readableWidths: Record<string, [number, number]> = {
  sku: [11.5, 32], cartons: [7.75, 40], pcsPerCarton: [6.25, 40], quantity: [9.5, 48],
  unitPrice: [11, 48], amount: [14, 96], description: [17, 36], image: [22.75, 40],
  cartonCbm: [8.5, 64], cbm: [8.5, 80], barcode: [9, 32],
};
const numericKeys = new Set(['cartons', 'pcsPerCarton', 'quantity', 'unitPrice', 'amount', 'cartonCbm', 'cbm']);
const textPixels = (text: string, size: number) => Math.max(0, ...text.split('\n').map(line =>
  [...line].reduce((width, character) => width + size * (containsChinese(character) ? 1.3 : .7), 0)));

// Adapt a disposable normalized copy: neither stored templates nor source files
// are rewritten. Preview and workbook generation both use this same calculation.
function readableLayout(settings: ProcurementTemplate, columns: Column[], products: Product[]) {
  const layout = settings.layout;
  const values = products.map(productValues);
  const minimums = new Map<Column, number>();
  for (const column of columns) {
    const [minimum, maximum] = Object.hasOwn(readableWidths, column.key) ? readableWidths[column.key] : [Math.min(20, column.width), Math.max(48, column.width)];
    minimums.set(column, minimum);
    let width = Math.max(minimum, Math.min(maximum, column.width));
    if (column.key === 'image') {
      if (products.some(product => product.photos.length > 1)) width = Math.max(width, 37.5);
    } else {
      const texts = products.map((product, index) => {
        const value = column.businessField ? product[column.businessField as keyof Product]
          : Object.hasOwn(values[index], column.key) ? values[index][column.key]
            : product.custom && Object.hasOwn(product.custom, column.key) ? product.custom[column.key] : null;
        if (value === null || value === undefined) return '';
        if (typeof value !== 'number') return typeof value === 'object' ? '' : String(value);
        const money = ['unitPrice', 'amount'].includes(column.key), volume = ['cartonCbm', 'cbm'].includes(column.key);
        const places = money ? layout.moneyDecimals : volume ? layout.volumeDecimals : 0;
        return (money && column.currencyPrefix ? product.currency + ' ' : '') + value.toLocaleString('en-US', {
          minimumFractionDigits: places, maximumFractionDigits: places, useGrouping: money,
        });
      });
      // Include per-merchant totals so a long aggregate is not clipped after all
      // individual values fit. Unknown totals remain blank and do not add width.
      if (['cartons', 'quantity', 'amount', 'cbm'].includes(column.key)) {
        const totals = new Map<string, number | null>();
        products.forEach((product, index) => {
          const key = JSON.stringify([product.supplier, product.currency]), previous = totals.get(key) ?? 0;
          const value = values[index][column.key];
          totals.set(key, (totals.has(key) && totals.get(key) === null) || typeof value !== 'number' ? null : previous + value);
        });
        for (const [key, value] of totals) if (value !== null) {
          const currency = JSON.parse(key)[1], money = column.key === 'amount', places = money ? layout.moneyDecimals : column.key === 'cbm' ? layout.volumeDecimals : 0;
          texts.push((money && column.currencyPrefix ? currency + ' ' : '') + value.toLocaleString('en-US', { minimumFractionDigits: places, maximumFractionDigits: places, useGrouping: money }));
        }
      }
      const lines = numericKeys.has(column.key) ? 1 : column.key === 'description' ? 3 : 2;
      width = Math.max(width, Math.min(maximum, (Math.max(0, ...texts.map(text => textPixels(text, Math.max(layout.bodySize, layout.totalSize)))) / lines + 16) / 7));
    }
    column.width = column.key === 'image' ? width : Math.ceil(width * 2) / 2;
  }
  // A long remark, stock code or exceptional numeric value must not make every
  // merchant sheet print in tiny type. Keep one bounded workbook width, while
  // allowing added custom columns their declared minimum space.
  // Saved templates are an explicit company choice. Apply the automatic page
  // budget only to the default adaptive layout and leave saved widths intact.
  const widthBudget = settings.version === 0
    ? Math.max(163, columns.reduce((sum, column) => sum + minimums.get(column)!, 0)) : Number.POSITIVE_INFINITY;
  let excess = columns.reduce((sum, column) => sum + column.width, 0) - widthBudget;
  const priority = (column: Column) => column.key === 'description' ? 0 : column.key.startsWith('business:') ? 1 : column.key === 'sku' ? 2 : column.key === 'barcode' ? 3 : 4;
  const shrinkable = columns.filter(column => column.key !== 'image').sort((a, b) => {
    const numeric = Number(numericKeys.has(a.key)) - Number(numericKeys.has(b.key));
    return numeric || priority(a) - priority(b);
  });
  for (const column of shrinkable) {
    if (excess <= 0) break;
    const old = column.width;
    const minimum = Math.ceil(minimums.get(column)! * 2) / 2;
    column.width = Math.max(minimum, Math.floor((old - excess) * 2) / 2);
    excess -= old - column.width;
  }
}

const selectionFields: QuotationBusinessField[] = ['name', 'colors', 'material', 'dimensions', 'weightG', 'moq', 'cartonDimensions', 'leadTimeDays', 'tradeTerms'];
const privateCustomKeys = new Set(['description', 'notes', 'note', 'evaluation', 'rating', 'suppliercontact', 'favorite']);

function quotationFormat(template: ProcurementTemplate | undefined, options: QuotationExportOptions, currencies: string[] = [], products: Product[] = []) {
  const settings = normalizeProcurementTemplate(template), audience = options.audience ?? 'selection';
  const foreignCurrency = currencies.some(currency => currency !== 'CNY');
  if (!['selection', 'internal'].includes(audience)) throw new AppError('VALIDATION', '不支持的选品导出受众');
  const title = settings.version === 0 && settings.documentTitle === defaultProcurementTemplate().documentTitle
    ? '选品表 / PRODUCT SELECTION' : settings.documentTitle;
  const columns: Column[] = [
    // Disabled columns are omitted entirely, including their values and validations.
    ...settings.columns.filter(column => column.enabled && (column.key !== 'image' || options.images !== false))
      .map(column => ({ ...column, width: column.width ?? 16,
        label: foreignCurrency && ['unitPrice', 'amount'].includes(column.key) ? column.label.replace(/RMB/gi, '原币种') : column.label })),
    ...settings.customFields.filter(column => audience === 'internal' || !privateCustomKeys.has(column.key.toLowerCase().replace(/_/g, '')))
      .map(column => ({ ...column, enabled: true })),
  ];
  const fields = new Set(options.businessFields ?? (audience === 'internal' ? Object.keys(businessColumns) as QuotationBusinessField[] : []));
  for (const field of fields) {
    if (!Object.hasOwn(businessColumns, field)) throw new AppError('VALIDATION', '不支持的选品业务字段');
    if (audience === 'selection' && !selectionFields.includes(field)) continue;
    columns.push({ key: 'business:' + field, ...businessColumns[field], enabled: true, businessField: field });
  }
  const currencyVisible = columns.some(column => column.key === 'currency');
  const primary = new Set(['sku', 'cartons', 'pcsPerCarton', 'quantity', 'unitPrice', 'amount', 'description']);
  for (const column of columns) {
    column.primary = primary.has(column.key);
    if (['unitPrice', 'amount'].includes(column.key)) column.currencyPrefix = !currencyVisible &&
      !(currencies.length > 0 && currencies.every(currency => currency === 'CNY') && /\b(?:RMB|CNY)\b/i.test(column.label));
  }
  readableLayout(settings, columns, products.filter(product => options.scope !== 'confirmed' || product.confirmed));
  return { settings, audience, title, columns };
}

function fieldRowHeight(settings: ProcurementTemplate, columns: Column[]) {
  const layout = settings.layout;
  const heights = columns.filter(column => column.enabled).map(column => {
    const lines = column.label.split('\n').reduce((count, line) => count + Math.max(1,
      Math.ceil(textPixels(line, layout.fieldSize) / Math.max(20, column.width * 7 - 8))), 0);
    return lines * layout.fieldSize * 1.2 + 8;
  });
  return Math.min(409, Math.max(32, layout.fieldHeight, ...heights));
}

function bodyRowMinimum(settings: ProcurementTemplate) {
  return settings.version === 0 && settings.layout.bodyHeight === defaultProcurementTemplate().layout.bodyHeight ? 36 : settings.layout.bodyHeight;
}

/** Serializable preview of the exact formatting and columns used by exportQuotation. */
export function quotationExportMetadata(template: ProcurementTemplate | undefined, options: QuotationExportOptions = {}, currencies: string[] = [], products: Product[] = []) {
  const { settings, audience, title, columns } = quotationFormat(template, options, currencies, products);
  const values: Record<string, string> = { company: settings.company, companyEnglish: settings.companyEnglish,
    address: settings.address, contact: settings.contact, documentTitle: title };
  return {
    format: 'quotation' as const, audience, templateVersion: settings.version, documentTitle: title, groupBy: 'supplier' as const,
    priceSource: '现场记录价格', images: columns.some(column => column.key === 'image' && column.enabled),
    headerRows: settings.layout.headerRows.map(row => ({ ...row, text: values[row.key] ?? row.text })),
    columns: columns.map(column => ({ ...column, hidden: !column.enabled })),
    layout: { ...structuredClone(settings.layout), fieldHeight: fieldRowHeight(settings, columns), bodyHeight: bodyRowMinimum(settings), deduplicateSku: true },
    headerSpan: Math.min(settings.layout.headerSpan || 7, columns.length),
    // No purchase field is unconditionally blank; unavailable inputs still stay blank.
    blankPurchaseFields: [] as string[],
  };
}

function businessValue(field: QuotationBusinessField, product: Product, project: Project): ExcelJS.CellValue {
  switch (field) {
    case 'favorite': return product.favorite ? '已收藏' : '';
    case 'photoCount': return product.photos.length;
    case 'project': return product.taskName || project.name;
    case 'market': return product.taskMarket === undefined ? project.market : product.taskMarket;
    case 'date': return product.taskDate || project.date;
    case 'recordDate': return product.createdAt ? chinaDate(product.createdAt) : '';
    case 'demo': return product.demo || project.demo ? '模拟数据' : '';
    default: return product[field] ?? null;
  }
}

function worksheetName(supplier: string, used: Set<string>) {
  // Excel names are case-insensitive; reserve the explanation sheet and suffix collisions.
  const cleaned = supplier.replace(/[\x00-\x1f\\/*?:\[\]]/g, ' ').trim().replace(/^'+|'+$/g, '') || '未填写商户';
  const shorten = (text: string, length: number) => text.slice(0, length).replace(/[\uD800-\uDBFF]$/, '').replace(/'+$/g, '') || '商户';
  let name = shorten(cleaned, 31), index = 2;
  while (used.has(name.toLowerCase())) {
    const suffix = ` (${index++})`;
    name = shorten(cleaned, 31 - suffix.length) + suffix;
  }
  used.add(name.toLowerCase());
  return name;
}

/** Export saved field records using the company layout, without creating purchase lines. */
export async function exportQuotation(
  project: Project,
  products: Product[],
  readPhoto: (id: string) => Buffer | null | Promise<Buffer | null>,
  template: ProcurementTemplate | undefined,
  options: QuotationExportOptions = {},
): Promise<Buffer> {
  if (products.length > 500) throw new AppError('EXPORT_LIMIT', '单次导出最多500件商品，请拆分看货任务');
  const selected = products.filter(product => options.scope !== 'confirmed' || product.confirmed);
  if (!selected.length) throw new AppError('EMPTY_EXPORT', '当前任务没有可导出的商品');
  const { settings, title, columns } = quotationFormat(template, options, selected.map(product => product.currency), selected), layout = settings.layout;

  const workbook = new ExcelJS.Workbook();
  workbook.creator = '货记'; workbook.created = new Date();
  const suppliers = new Map<string, Product[]>();
  for (const product of selected) {
    const group = suppliers.get(product.supplier);
    if (group) group.push(product); else suppliers.set(product.supplier, [product]);
  }
  const usedNames = new Set(['说明', 'history']);
  const headerRows = layout.headerRows.filter(row => row.enabled), header = headerRows.length + 1;
  const span = layout.headerSpan === 0 ? Math.min(7, columns.length) : Math.min(layout.headerSpan, columns.length);
  const visiblePixels = columns.slice(0, span).reduce((sum, column) => sum + (column.enabled ? column.width * 7 : 0), 0);
  const moneyFormat = decimalFormat(layout.moneyDecimals, true), volumeFormat = decimalFormat(layout.volumeDecimals);
  const imageColumn = columns.findIndex(column => column.key === 'image' && column.enabled);
  let imageBytes = 0;

  function style(cell: ExcelJS.Cell, size: number, bold = false, color = (bold ? layout.fieldColor : layout.bodyColor) || '#000000') {
    cell.font = { name: containsChinese(cell.text) ? layout.chineseFont : layout.latinFont, size, bold, color: { argb: 'FF' + color.slice(1).toUpperCase() } };
    cell.alignment = { horizontal: bold ? 'center' : layout.alignment, vertical: 'middle', wrapText: true };
    if (layout.border !== 'none') {
      const edge: ExcelJS.Border = { style: layout.border, color: { argb: 'FF000000' } };
      cell.border = { top: edge, bottom: edge, left: edge, right: edge };
    }
  }

  for (const [supplier, items] of suppliers) {
    const sheet = workbook.addWorksheet(worksheetName(supplier, usedNames));
    sheet.columns = columns.map(column => ({ key: column.key, width: column.width, hidden: !column.enabled }));
    const headerValues: Record<string, string> = { company: settings.company, companyEnglish: settings.companyEnglish,
      address: settings.address, contact: settings.contact, documentTitle: title };
    headerRows.forEach((setting, index) => {
      const row = index + 1;
      if (span > 1) sheet.mergeCells(row, 1, row, span);
      const cell = sheet.getCell(row, 1);
      cell.value = headerValues[setting.key] ?? setting.text;
      cell.font = { name: setting.font, size: setting.size, bold: setting.bold, color: { argb: 'FF' + (setting.color || '#000000').slice(1).toUpperCase() } };
      cell.alignment = { horizontal: setting.align, vertical: 'middle', wrapText: true };
      sheet.getRow(row).height = textHeight(cell.text, setting.size, visiblePixels, setting.height);
      if (setting.key === 'documentTitle' && layout.border !== 'none') cell.border = { bottom: { style: layout.border } };
    });
    const fieldRow = sheet.getRow(header);
    fieldRow.values = columns.map(column => column.label);
    fieldRow.height = fieldRowHeight(settings, columns);
    columns.forEach((column, index) => {
      const cell = fieldRow.getCell(index + 1);
      style(cell, layout.fieldSize, true);
      cell.alignment = { ...cell.alignment, vertical: 'middle' };
      if (!column.primary) cell.border = layout.border === 'none' ? {} : { bottom: { style: layout.border, color: { argb: 'FF000000' } } };
      if (column.key === 'unitPrice') cell.note = priceNotice;
      if (['decision', 'cartons', 'quantity', 'amount', 'cbm'].includes(column.key)) cell.note = purchaseNotice;
    });
    sheet.views = [{ state: 'frozen', ySplit: header, showGridLines: false }];
    // OOXML uses 1 for Letter; ExcelJS's PaperSize enum omits that standard value.
    sheet.pageSetup = { orientation: layout.orientation, paperSize: layout.paper === 'A4' ? 9 : 1 as ExcelJS.PaperSize,
      fitToPage: layout.printMode === 'fit', fitToWidth: 1, fitToHeight: 0, scale: layout.scale,
      ...(layout.repeatHeader ? { printTitlesRow: `1:${header}` } : {}),
      margins: { left: .7, right: .7, top: .75, bottom: .75, header: .3, footer: .3 } };

    const itemRows: number[] = [];
    let hasContinuationRows = false;
    for (const product of items) {
      const core = productValues(product);
      const custom = product.custom;
      const photos: { buffer: Buffer; width: number; height: number; extension: 'png' | 'jpeg' }[] = [];
      if (imageColumn >= 0) for (const photo of product.photos) {
        const buffer = await readPhoto(photo.id);
        imageBytes += buffer?.length || 0;
        if (imageBytes > 40 * 1024 * 1024) throw new AppError('EXPORT_LIMIT', '导出图片超过40MB，请拆分看货任务');
        if (!buffer) continue;
        const metadata = await sharp(buffer).metadata();
        photos.push({ buffer, width: metadata.width || 100, height: metadata.height || 100,
          extension: metadata.format === 'png' ? 'png' : 'jpeg' });
      }
      // Keep nulls blank and user strings literal, even when they start with '='.
      const values = columns.map(column => column.businessField ? businessValue(column.businessField, product, project)
        : Object.hasOwn(core, column.key) ? core[column.key]
          : custom && Object.hasOwn(custom, column.key) ? custom[column.key] ?? null : null);
      const segments = values.map((value, index) => typeof value === 'string'
        ? textSegments(value, layout.bodySize, columns[index].width * 7 - 8) : [value]);
      const segmentCount = Math.max(1, ...segments.map(value => value.length));
      if (segmentCount > 1) hasContinuationRows = true;
      const imageColumns = photos.length > 1 ? 2 : 1, imageRows = Math.ceil(photos.length / imageColumns);
      const columnPixels = imageColumn >= 0 ? columns[imageColumn].width * 7 : 0;
      const frameWidth = Math.max(1, (columnPixels - (imageColumns + 1) * 12) / imageColumns);
      const gridRows = Array.from({ length: imageRows }, (_, index) => Math.max(...photos.slice(index * imageColumns, (index + 1) * imageColumns)
        .map(photo => Math.min(112, frameWidth * photo.height / photo.width))));
      const gridHeight = gridRows.reduce((sum, height) => sum + height, 0) + (imageRows + 1) * 12;
      let firstRow: ExcelJS.Row | undefined;
      for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex++) {
        const row = sheet.addRow(values.map((value, index) => typeof value === 'string'
          ? segments[index][segmentIndex] ?? null : segmentIndex === 0 ? value : null));
        firstRow ??= row;
        row.height = Math.max(bodyRowMinimum(settings), ...columns.filter(column => column.enabled)
          .map(column => textHeight(row.getCell(column.key).text, layout.bodySize, column.width * 7 - 8, 0) + 12));
        if (segmentIndex === 0 && imageRows) row.height = Math.max(row.height, gridHeight * .75);
        row.height = Math.min(409, row.height);
        columns.forEach((column, index) => {
          const cell = row.getCell(index + 1);
          style(cell, layout.bodySize);
          if (!column.primary) cell.border = {};
          if (['unitPrice', 'amount'].includes(column.key)) cell.numFmt = column.currencyPrefix ? `"${product.currency} "${moneyFormat}` : moneyFormat;
          if (['cartonCbm', 'cbm'].includes(column.key)) cell.numFmt = volumeFormat;
          if (typeof cell.value === 'number') {
            const available = Math.max(20, column.width * 7 - 8);
            const displayed = formattedNumericText(cell.value, column.key, product.currency, column.currencyPrefix, layout);
            cell.alignment = { ...cell.alignment, wrapText: false, shrinkToFit: textPixels(displayed, layout.bodySize) > available };
          }
        });
        if (segmentIndex === 0 && columns.some(column => column.key === 'decision')) {
          row.getCell('decision').dataValidation = { type: 'list', allowBlank: false, formulae: ['"待核对,已核对"'] };
        }
      }
      itemRows.push(firstRow!.number);
      for (const [index, photo] of photos.entries()) {
          const { buffer, width, height, extension } = photo;
          const rowPixels = firstRow!.height! * 4 / 3, gridRow = Math.floor(index / imageColumns);
          const ratio = Math.min(frameWidth / width, 112 / height);
          const left = 12 + (index % imageColumns) * (frameWidth + 12) + (frameWidth - width * ratio) / 2;
          const top = Math.max(0, (rowPixels - gridHeight) / 2) + 12 + gridRows.slice(0, gridRow).reduce((sum, value) => sum + value + 12, 0) + (gridRows[gridRow] - height * ratio) / 2;
          const id = workbook.addImage({ buffer: buffer as unknown as ExcelJS.Buffer, extension });
          // ExcelJS fractional anchors use approximate character/point units,
          // not the real column pixels. Native OOXML offsets prevent multi-image
          // grids overlapping after Excel or another reader opens the file.
          const anchor: ExcelJS.IAnchor = { col: imageColumn, row: firstRow!.number - 1,
            nativeCol: imageColumn, nativeRow: firstRow!.number - 1,
            nativeColOff: Math.round(left * 9525), nativeRowOff: Math.round(top * 9525) };
          sheet.addImage(id, { tl: anchor,
            ext: { width: width * ratio, height: height * ratio }, editAs: 'oneCell' });
      }
    }
    const last = sheet.rowCount;
    // Continuation rows intentionally leave identifiers and numbers blank. An
    // Excel sort/filter would detach them from their product, so only ordinary
    // one-row-per-product sheets expose an autofilter.
    if (!hasContinuationRows) sheet.autoFilter = { from: { row: header, column: 1 }, to: { row: last, column: columns.length } };
    // Keep merchant totals in the familiar reference columns. Separate
    // currencies and require every contributing number, including explicit 0.
    const currencies = [...new Set(items.map(item => item.currency))];
    const numericTotals = new Set(['cartons', 'quantity', 'amount', 'cbm']);
    const labelColumn = columns.findIndex(column => ['sku', 'description', 'image'].includes(column.key));
    sheet.addRow([]).height = 8;
    for (const currency of currencies) {
      const sourceRows = items.flatMap((item, index) => item.currency === currency ? [itemRows[index]] : []);
      if (labelColumn < 0) {
        const caption = sheet.addRow(['TOTAL ' + currency]);
        if (columns.length > 1) sheet.mergeCells(caption.number, 1, caption.number, columns.length);
        style(caption.getCell(1), layout.totalSize, true, layout.totalColor || '#000000');
      }
      const total = sheet.addRow(columns.map(() => null));
      total.height = Math.max(26, layout.totalSize * 1.6);
      columns.forEach((column, index) => {
        const cell = total.getCell(index + 1);
        style(cell, layout.totalSize, true, layout.totalColor || '#000000');
        if (!column.primary) cell.border = {};
        cell.alignment = { ...cell.alignment, horizontal: layout.alignment, wrapText: false, shrinkToFit: false };
        if (numericTotals.has(column.key)) {
          const refs: string[] = [];
          for (let start = 0; start < sourceRows.length;) {
            let end = start;
            while (end + 1 < sourceRows.length && sourceRows[end + 1] === sourceRows[end] + 1) end++;
            const first = sheet.getCell(sourceRows[start], index + 1).address;
            const last = sheet.getCell(sourceRows[end], index + 1).address;
            refs.push(start === end ? first : first + ':' + last);
            start = end + 1;
          }
          const values = sourceRows.map(row => sheet.getCell(row, index + 1).value);
          const known = values.every(value => typeof value === 'number' && Number.isFinite(value));
          cell.value = { formula: `IF(COUNT(${refs.join(',')})=${sourceRows.length},SUM(${refs.join(',')}),"")`,
            result: known ? (values as number[]).reduce((sum, value) => sum + value, 0) : '' };
          if (column.key === 'amount') cell.numFmt = column.currencyPrefix ? `"${currency} "${moneyFormat}` : moneyFormat;
          if (column.key === 'cbm') cell.numFmt = volumeFormat;
          if (known) {
            const displayed = formattedNumericText(cell.result as number, column.key, currency, column.currencyPrefix, layout);
            cell.alignment = { ...cell.alignment, shrinkToFit: textPixels(displayed, layout.totalSize) > Math.max(20, column.width * 7 - 8) };
          }
        } else if (column.key === 'currency') cell.value = currency;
      });
      if (labelColumn >= 0) total.getCell(labelColumn + 1).value = 'TOTAL' + (currencies.length > 1 ? ' ' + currency : '');
    }
    const totalsEnd = sheet.rowCount;
    const footerRows = [priceNotice, purchaseNotice,
      ...(settings.paymentTerms ? ['公司付款条款：' + settings.paymentTerms] : []),
      ...(settings.shippingMark ? ['公司唛头：' + settings.shippingMark] : []),
      ...(settings.packingRequirements ? ['公司包装要求：' + settings.packingRequirements] : [])];
    footerRows.forEach((text, index) => {
      const row = totalsEnd + 2 + index;
      if (span > 1) sheet.mergeCells(row, 1, row, span);
      const cell = sheet.getCell(row, 1); cell.value = text;
      cell.font = { name: layout.chineseFont, size: layout.totalSize, color: { argb: 'FF' + (layout.totalColor || '#000000').slice(1).toUpperCase() } };
      cell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
      sheet.getRow(row).height = textHeight(text, layout.totalSize, visiblePixels, 20);
    });
    sheet.pageSetup.printArea = `A1:${sheet.getColumn(columns.length).letter}${sheet.rowCount}`;
  }

  const info = workbook.addWorksheet('说明');
  info.columns = [{ width: 24 }, { width: 100 }];
  info.addRows([
    ['任务', project.name], ['用途', purchaseNotice], ['价格来源', priceNotice],
    ['图片', imageColumn < 0 ? '本次不嵌入图片。' : '每件商品的已保存照片按顺序嵌入图片列，多图在同一商品行内排列。'],
    ['未知字段', '未知数值和无值的自定义字段保持空白，不填零、不推测。'],
    ['核对状态', options.scope === 'confirmed' ? '本次仅导出已人工核对的商品记录。' : '待核对和已核对记录均可导出；状态不代表采购计入。'],
    ['草稿', '本机草稿未正式保存，不纳入导出。'],
    ['数据来源', project.demo || selected.some(product => product.demo) ? '包含演示商品与参考图片，请勿将演示报价和供应商用于实际采购。' : '用户现场采集'],
    ...[...suppliers.keys()].map((supplier, index) => ['商户 sheet：' + workbook.worksheets[index].name, supplier || '未填写商户']),
    ['导出时间', workbook.created.toISOString()],
  ]);
  info.eachRow(row => {
    row.height = textHeight(row.getCell(2).text, layout.bodySize, 700, 26);
    row.eachCell(cell => { style(cell, layout.bodySize); cell.alignment.horizontal = 'left'; });
  });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
