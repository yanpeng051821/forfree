import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { conflict } from './errors';

export const procurementColumns = [
  { key: 'image', label: '图片', required: false }, { key: 'supplier', label: '商户', required: false },
  { key: 'sku', label: '货号', required: true }, { key: 'decision', label: '处理决定', required: false },
  { key: 'cartons', label: '箱数', required: true }, { key: 'pcsPerCarton', label: '每箱数量', required: true },
  { key: 'quantity', label: '采购数量', required: true }, { key: 'unitPrice', label: '采购单价', required: true },
  { key: 'currency', label: '币种', required: false }, { key: 'amount', label: '商品金额', required: true },
  { key: 'cartonCbm', label: '单箱体积(m³)', required: false }, { key: 'cbm', label: '总体积(m³)', required: false },
  { key: 'description', label: '商品与包装说明', required: false }, { key: 'barcode', label: '条码', required: false },
];
const customSchema = z.strictObject({ key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), label: z.string().trim().min(1).max(80), width: z.number().min(5).max(80).default(20) });
export const tableFonts = ['Times New Roman', '宋体', 'Arial', 'Calibri', '黑体', '微软雅黑'] as const;
export const headerKeys = ['company', 'companyEnglish', 'address', 'contact', 'documentTitle'] as const;
export function defaultProcurementLayout() {
  return {
    headerRows: headerKeys.map((key, i) => ({ key, label: ['中文公司名', '英文公司名', '地址', '电话 / 传真', '单据标题'][i], text: '', enabled: true, font: 'Times New Roman' as typeof tableFonts[number], size: [26, 18, 11, 11, 16][i], bold: true, align: 'center' as const, height: [33, 22.5, 15.75, 15.75, 20.25][i] })),
    headerSpan: 0, fieldSize: 10, fieldHeight: 25.5, latinFont: 'Times New Roman' as typeof tableFonts[number], chineseFont: '宋体' as typeof tableFonts[number],
    bodySize: 12, bodyHeight: 98, multiImageHeight: 128, totalSize: 11, alignment: 'center' as 'left' | 'center' | 'right',
    border: 'thin' as 'none' | 'thin' | 'medium', moneyDecimals: 2, volumeDecimals: 6,
    orientation: 'landscape' as 'portrait' | 'landscape', paper: 'A4' as 'A4' | 'Letter', printMode: 'fit' as 'fit' | 'scale', scale: 85, repeatHeader: true,
  };
}
const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, '请选择有效字体颜色');
const fontSchema = z.enum(tableFonts), alignSchema = z.enum(['left', 'center', 'right']);
const layoutSchema = z.strictObject({
  headerRows: z.array(z.strictObject({ key: z.string().max(40), label: z.string().trim().min(1).max(40), text: z.string().max(500), enabled: z.boolean(), font: fontSchema, size: z.number().min(6).max(40), bold: z.boolean(), color: colorSchema.optional(), align: alignSchema, height: z.number().min(10).max(120) })).min(5).max(8),
  headerSpan: z.number().int().min(0).max(30), fieldSize: z.number().min(8).max(20), fieldHeight: z.number().min(15).max(100), latinFont: fontSchema, chineseFont: fontSchema,
  bodySize: z.number().min(8).max(20), bodyHeight: z.number().min(40).max(300), multiImageHeight: z.number().min(60).max(409), totalSize: z.number().min(8).max(20), alignment: alignSchema,
  fieldColor: colorSchema.optional(), bodyColor: colorSchema.optional(), totalColor: colorSchema.optional(),
  border: z.enum(['none', 'thin', 'medium']), moneyDecimals: z.number().int().min(0).max(6), volumeDecimals: z.number().int().min(0).max(6),
  orientation: z.enum(['portrait', 'landscape']), paper: z.enum(['A4', 'Letter']), printMode: z.enum(['fit', 'scale']), scale: z.number().int().min(10).max(100), repeatHeader: z.boolean(),
}).superRefine((layout, context) => {
  const keys = layout.headerRows.map(row => row.key);
  if (new Set(keys).size !== keys.length || headerKeys.some(key => !keys.includes(key)) || keys.some(key => !headerKeys.includes(key as typeof headerKeys[number]) && !/^header_[a-z0-9_]+$/.test(key))) context.addIssue({ code: 'custom', message: '表头行标识不完整或重复' });
  if (!layout.headerRows.find(row => row.key === 'documentTitle')?.enabled) context.addIssue({ code: 'custom', message: '请保留单据标题行' });
  if (layout.headerRows.some(row => row.height < row.size * 1.15)) context.addIssue({ code: 'custom', message: '表头行高至少为字号的1.15倍，避免文字被截断' });
  if (layout.fieldHeight < layout.fieldSize * 1.2 || layout.multiImageHeight < layout.bodyHeight) context.addIssue({ code: 'custom', message: '请增大表头行高，且多图行高不能小于单图行高' });
});
const widths: Record<string, number> = { image: 22.75, supplier: 22, sku: 11.4667, decision: 14, cartons: 7.75, pcsPerCarton: 6.25, quantity: 8.375, unitPrice: 9, currency: 8, amount: 10.875, cartonCbm: 12, cbm: 12, description: 16.9417, barcode: 17.6083 };
const templateFields = z.strictObject({
  company: z.string().trim().max(200), companyEnglish: z.string().trim().max(200),
  address: z.string().trim().max(500), contact: z.string().trim().max(200),
  paymentTerms: z.string().trim().max(500), shippingMark: z.string().trim().max(500), packingRequirements: z.string().trim().max(2000),
  documentTitle: z.string().trim().min(1).max(120).default('采购记录 / PROCUREMENT RECORD'),
  layout: layoutSchema.default(defaultProcurementLayout),
  columns: z.array(z.strictObject({ key: z.string(), label: z.string().trim().min(1).max(80), enabled: z.boolean(), width: z.number().min(5).max(80).optional() })).length(procurementColumns.length),
  customFields: z.array(customSchema).max(8),
}).superRefine((value, context) => {
  const keys = value.columns.map(c => c.key);
  if (new Set(keys).size !== keys.length || procurementColumns.some(c => !keys.includes(c.key))) context.addIssue({ code: 'custom', message: '表格字段不完整' });
  if (procurementColumns.some(c => c.required && value.columns.find(x => x.key === c.key)?.enabled !== true)) context.addIssue({ code: 'custom', message: '采购核心字段必须保留' });
  const labels = [...value.columns.filter(c => c.enabled).map(c => c.label), ...value.customFields.map(c => c.label)];
  if (new Set(labels).size !== labels.length || new Set(value.customFields.map(c => c.key)).size !== value.customFields.length) context.addIssue({ code: 'custom', message: '字段名称或标识不能重复' });
  if (value.customFields.some(c => procurementColumns.some(core => core.key === c.key))) context.addIssue({ code: 'custom', message: '扩展列标识不能占用采购字段' });
});
export const templateSaveSchema = z.strictObject({ version: z.number().int().nonnegative(), fields: templateFields });
export type ProcurementTemplateFields = z.infer<typeof templateFields>;
export type ProcurementTemplate = ProcurementTemplateFields & { version: number };
export const referenceColumnOrder = ['sku','cartons','pcsPerCarton','quantity','unitPrice','amount','description','image','cartonCbm','cbm','barcode','supplier','decision','currency'];
export function referenceProcurementColumns() {
  const labels: Record<string,string> = {sku:'REF.',cartons:'CTNS（箱数）',pcsPerCarton:'PCS/ CTN',quantity:'QUANTITY(数量）',unitPrice:'PRICE (价格RMB)',amount:'AMOUNT (RMB总金额)',description:'备注',image:'图片',cartonCbm:'体积',cbm:'总体积(m³)',barcode:'条码号'};
  return referenceColumnOrder.map(key=>({key,label:labels[key] || procurementColumns.find(c=>c.key===key)!.label,enabled:Object.hasOwn(labels,key),width:widths[key]}));
}
export function defaultProcurementTemplate(): ProcurementTemplate {
  return { version: 0, company: '', companyEnglish: '', address: '', contact: '', documentTitle: '采购记录 / PROCUREMENT RECORD', layout: defaultProcurementLayout(), paymentTerms: '', shippingMark: '', packingRequirements: '', columns: referenceProcurementColumns(), customFields: [] };
}
export function normalizeProcurementTemplate(value?: ProcurementTemplate): ProcurementTemplate {
  const defaults = defaultProcurementTemplate();
  if (!value) return defaults;
  const { version, ...fields } = value;
  const { version: defaultVersion, ...defaultFields } = defaults;
  const parsed = templateFields.parse({ ...defaultFields, ...fields });
  return { ...parsed, columns: parsed.columns.map(c => ({ ...c, width: c.width ?? widths[c.key] })), version: value.version || 0 };
}
export class ProcurementTemplateStore {
  constructor(private root: string) {}
  private path(owner: string) {
    const directory = join(this.root, 'procurement-templates');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    return join(directory, createHash('sha256').update(owner).digest('hex') + '.json');
  }
  read(owner: string): ProcurementTemplate { const path = this.path(owner); return existsSync(path) ? normalizeProcurementTemplate(JSON.parse(readFileSync(path, 'utf8'))) : defaultProcurementTemplate(); }
  save(owner: string, version: number, fields: ProcurementTemplateFields) {
    const current = this.read(owner);
    if (current.version !== version) conflict('表格设置已更新，请重新打开后修改');
    const parsed = templateFields.parse(fields);
    const next = { ...parsed, version: version + 1 }, path = this.path(owner), temporary = path + '.' + randomUUID() + '.tmp';
    try { writeFileSync(temporary, JSON.stringify(next), { flag: 'wx', mode: 0o600 }); renameSync(temporary, path); }
    finally { rmSync(temporary, { force: true }); }
    return next;
  }
}
