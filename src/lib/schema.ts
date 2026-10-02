import { z } from "zod";
export const fieldsSchema = z.object({
  name: z.string().trim().min(1, "请填写商品名称").max(120),
  supplier: z.string().trim().max(200).default(""),
  colors: z.string().trim().max(200).default(""),
  material: z.string().trim().max(200).default(""),
  dimensions: z.string().trim().max(200).default(""),
  weightG: z.number().finite().nonnegative().max(100000000).nullable().default(null),
  unitPrice: z.number().finite().nonnegative().max(100000000).nullable().default(null),
  currency: z.enum(["CNY", "USD", "EUR"]).default("CNY"),
  moq: z.number().int().nonnegative().max(100000000).nullable().default(null),
  cartonQty: z.number().int().positive().max(100000000).nullable().default(null),
  description: z.string().max(10000).default(""),
  notes: z.string().max(5000).default(""),
  confirmed: z.boolean().default(false),
});
export const projectSchema = z.object({ name: z.string().trim().min(1, "请填写任务名称").max(120), market: z.string().trim().max(120), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value, "日期无效") });
export const extractionSchema = z.object({
  name: z.string().max(120).nullable(), colors: z.string().max(200).nullable(), material: z.string().max(200).nullable(),
  dimensions: z.string().max(200).nullable(), weightG: z.number().finite().nonnegative().nullable(),
  unitPrice: z.number().finite().nonnegative().nullable(), currency: z.enum(["CNY","USD","EUR"]).nullable(),
  moq: z.number().int().nonnegative().nullable(), cartonQty: z.number().int().positive().nullable(),
}).strict();
