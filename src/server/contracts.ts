import { z } from "zod";
import { fieldsSchema, projectSchema } from "../lib/schema";

export const uuid = z.uuid();
const photoIds = z.array(uuid).max(6).refine(ids => new Set(ids).size === ids.length, "照片不能重复");
export const createProjectSchema = projectSchema.extend({ requestKey: uuid, supplier: z.string().trim().max(200).optional(), supplierContact: z.string().trim().max(200).optional() }).strict();
export const saveProductSchema = z.strictObject({
  requestKey: uuid, projectId: uuid, id: uuid.optional(), version: z.number().int().positive().optional(),
  fields: fieldsSchema, photoIds: photoIds.default([]),
}).refine(value => Boolean(value.id) === (value.version !== undefined), "编辑商品必须提供版本，新建商品不能提供版本");
export const extractSchema = z.strictObject({ description: z.string().max(10000).default(""), photoIds: photoIds.default([]) });
export const loginSchema = z.strictObject({ code: z.string().min(1).max(256) });
export const profileFieldsSchema = z.strictObject({
  avatar: z.string().max(32768).regex(/^(?:|data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2})$/).optional(),
  name: z.string().trim().max(80), company: z.string().trim().max(200),
  role: z.enum(["buyer", "merchant", "both"]), phone: z.string().trim().max(80), wechat: z.string().trim().max(120),
  defaultCurrency: z.enum(["CNY", "USD", "EUR"]),
});
export const profileSchema = profileFieldsSchema.extend({ version: z.number().int().nonnegative() }).strict();
export const deleteSchema = z.strictObject({ version: z.number().int().positive() });
export const favoriteSchema = z.strictObject({ version: z.number().int().positive(), favorite: z.boolean() });
export const projectQuerySchema = z.strictObject({ projectId: uuid });
const recordDate = projectSchema.shape.date.optional();
const rangeDate = projectSchema.shape.date.refine(value => !value.startsWith('0000'), '日期无效').optional();
export const dateRangeShape = { dateFrom: rangeDate, dateTo: rangeDate };
export function validRecordDateRange(value: { date?: string; dateFrom?: string; dateTo?: string }): boolean {
  return (!value.dateFrom && !value.dateTo) || Boolean(value.dateFrom && value.dateTo && !value.date && value.dateFrom <= value.dateTo);
}
export const dateRangeMessage = '起止日期必须同时填写、开始不晚于结束，且不能同时指定单日';
export const supplierFilter = z.string().trim().max(200).optional();
export const productPageQuerySchema = z.strictObject({
  projectId: uuid.optional(),
  date: recordDate, ...dateRangeShape, supplier: supplierFilter,
  favorite: z.enum(['yes', 'no']).default('no'),
  cursor: z.string().min(1).max(128).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  q: z.string().trim().max(200).default(""),
  status: z.enum(["all", "pending", "confirmed", "missingPrice"]).default("all"),
}).refine(validRecordDateRange, dateRangeMessage).refine(value => Boolean(value.projectId || value.date || value.dateFrom || value.favorite === 'yes'), '请选择任务、日期或收藏');
export const exportQuerySchema = z.strictObject({
  audience: z.enum(["selection", "internal"]).default("selection"),
  projectId: uuid.optional(), date: recordDate, ...dateRangeShape, supplier: supplierFilter,
  favorite: z.enum(['yes', 'no']).default('no'),
  scope: z.enum(["all", "confirmed"]).default("all"),
  images: z.enum(["yes", "no"]).default("yes"),
}).refine(validRecordDateRange, dateRangeMessage).refine(value => Boolean(value.projectId || value.date || value.dateFrom || value.favorite === 'yes'), '请选择任务、日期或收藏');
// Preview may be requested before a scope is chosen; range validation still applies.
export const exportPreviewQuerySchema = z.strictObject(exportQuerySchema.shape).refine(validRecordDateRange, dateRangeMessage);
export const idParamsSchema = z.strictObject({ id: uuid });
