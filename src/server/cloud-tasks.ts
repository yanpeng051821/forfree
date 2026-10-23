import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../lib/errors';
import { fieldsSchema } from '../lib/schema';
import type { Procurement } from '../lib/procurement';
import type { ProductFields } from '../lib/types';
import { dateRangeShape, validRecordDateRange, dateRangeMessage } from './contracts';

export type UploadKind = 'workbook' | 'photo';
export type UploadState = 'prepared' | 'committed' | 'abandoned';
export type JobKind = 'workbook-import' | 'workbook-export' | 'product-export' | 'extraction';
export type JobState = 'pending' | 'running' | 'succeeded' | 'failed';
export type JobFinishState = 'succeeded' | 'failed';
export type JobError = { code: string; message: string };

export const WORKBOOK_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const PHOTO_MIME = 'image/jpeg';
export const WORKBOOK_MAX_BYTES = 40 * 1024 * 1024;
export const PHOTO_MAX_BYTES = 8 * 1024 * 1024;
export const UPLOAD_TICKET_TTL_MS = 10 * 60 * 1000;
export const JOB_TTL_MS = 5 * 60 * 1000;
export const EXPORT_ASYNC_LINE_THRESHOLD = 150;
export const EXPORT_ASYNC_IMAGE_THRESHOLD = 40;
export const STAGED_PHOTO_FOLDER = 'photos';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const timestamp = z.string().refine(value => Number.isFinite(Date.parse(value)));
const partialFieldsSchema = z.record(z.string(), z.unknown()).transform((input, context): Partial<ProductFields> => {
  const parsed = fieldsSchema.partial().safeParse(input);
  if (!parsed.success) {
    context.addIssue({ code: 'custom', message: 'Invalid extraction fields' });
    return z.NEVER;
  }
  const fields: Partial<ProductFields> = {};
  for (const [key, value] of Object.entries(parsed.data)) {
    if (Object.hasOwn(input, key)) Object.defineProperty(fields, key, { value, enumerable: true, configurable: true, writable: true });
  }
  return fields;
});
export const extractionResultSchema = z.strictObject({
  fields: partialFieldsSchema,
  mode: z.enum(['model', 'rules']),
  warning: z.string().max(5000),
  estimates: z.array(z.string().max(500)).max(30).optional(),
});
const errorSchema = z.strictObject({ code: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/), message: z.string().min(1).max(1000) });
const ticketSchema = z.strictObject({
  uploadId: z.string().regex(UUID), objectKey: z.string(), kind: z.enum(['workbook', 'photo']),
  sizeBytes: z.number().int().positive(), sha256: z.string().regex(SHA256).nullable(),
  state: z.enum(['prepared', 'committed', 'abandoned']), createdAt: timestamp, expiresAt: timestamp,
});
const jobSchema = z.strictObject({
  jobId: z.string().regex(UUID), kind: z.enum(['workbook-import', 'workbook-export', 'product-export', 'extraction']),
  state: z.enum(['pending', 'running', 'succeeded', 'failed']), resultReference: z.string().nullable(),
  error: errorSchema.nullable(), createdAt: timestamp, updatedAt: timestamp, expiresAt: timestamp,
  version: z.number().int().nonnegative(),
}).superRefine((record, context) => {
  if (record.state === 'succeeded' ? record.resultReference === null || record.error !== null
    : record.resultReference !== null || (record.state === 'failed' ? record.error === null : record.error !== null)) {
    context.addIssue({ code: 'custom', message: 'Invalid job state/result' });
  }
});
export type UploadTicket = z.infer<typeof ticketSchema>;
export type JobRecord = z.infer<typeof jobSchema>;
/** 文件本体、照片与原始描述不进入任务表。 */
export interface ProductExportInput {
  projectId?: string;
  supplier?: string;
  date?: string;
  dateFrom?: string;
  dateTo?: string;
  scope?: 'all' | 'confirmed';
  audience?: 'selection' | 'internal';
  images?: boolean;
  favorite?: boolean;
}
export interface JobInput extends ProductExportInput { objectKey?: string; filename?: string; procurementId?: string }
export const productExportInputSchema = z.strictObject({
  ...dateRangeShape,
  projectId: z.string().regex(UUID).optional(),
  supplier: z.string().trim().max(200).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value).optional(),
  scope: z.enum(['all', 'confirmed']).optional(), audience: z.enum(['selection', 'internal']).optional(), images: z.boolean().optional(), favorite: z.boolean().optional(),
}).refine(validRecordDateRange,dateRangeMessage).refine(value => Boolean(value.projectId || value.date || value.dateFrom || value.favorite), '请选择任务、日期或收藏');
export interface ExtraCommands {
  'upload/prepare': {
    payload: { uploadId: string; kind: UploadKind; objectKey: string; sizeBytes: number; contentType: string; sha256: string | null; filename: string } | { uploadId: string; lookup: true };
    data: UploadTicket;
  };
  'upload/commit': { payload: { uploadId: string; sizeBytes: number; sha256: string | null }; data: UploadTicket };
  'upload/abandon': { payload: { uploadId: string; reason: string }; data: UploadTicket };
  'job/create': { payload: { jobId: string; kind: JobKind; state: 'pending'; input: JobInput }; data: JobRecord };
  'job/get': { payload: { jobId: string }; data: JobRecord };
  'job/start': { payload: { jobId: string; expectedVersion: number; runToken: string }; data: JobRecord };
  'job/finish': { payload: { jobId: string; expectedVersion: number; runToken: string; state: JobFinishState; resultReference: string | null; error: JobError | null }; data: JobRecord };
}
export type ExtraOperation = keyof ExtraCommands;
export function parseUploadTicket(value: unknown): UploadTicket {
  const parsed = ticketSchema.safeParse(value);
  if (!parsed.success) throw new AppError('DB_RESPONSE_INVALID', '上传凭证响应无效', 502);
  return parsed.data;
}
export function parseJobRecord(value: unknown): JobRecord {
  const parsed = jobSchema.safeParse(value);
  if (!parsed.success) throw new AppError('DB_RESPONSE_INVALID', '任务响应无效', 502);
  return parsed.data;
}

export function isUuid(value: unknown): value is string { return typeof value === 'string' && UUID.test(value); }
export function requireUuid(value: unknown, code = 'VALIDATION', message = '标识无效'): string {
  if (!isUuid(value)) throw new AppError(code, message, 400);
  return value;
}
export function isSha256(value: unknown): value is string { return typeof value === 'string' && SHA256.test(value); }
export function sanitizeFilename(value: unknown, fallback: string): string {
  if (typeof value !== 'string') throw new AppError('INVALID_UPLOAD', '文件名无效', 400);
  const cleaned = value.replace(/[\x00-\x1f\x7f]/g, '').replace(/[\\/]+/g, '_').replace(/^\.+/, '').trim();
  return cleaned.slice(0, 160).trim() || fallback;
}
export function uploadObjectKey(owner: string, kind: UploadKind, id: string = randomUUID()): string {
  return kind === 'workbook' ? `${owner}/uploads/${id}.xlsx` : `${owner}/${STAGED_PHOTO_FOLDER}/${id}.jpg`;
}
export function exportObjectKey(owner: string, id: string = randomUUID()): string { return `${owner}/exports/${id}.xlsx`; }
export function assertOwnedObjectKey(owner: string, key: unknown, extension: '.xlsx' | '.jpg'): string {
  if (typeof key !== 'string') throw new AppError('INVALID_BLOB_KEY', '对象路径无效', 400);
  const segments = key.split('/');
  const folders = extension === '.jpg' ? ['photos', 'pictures'] : ['uploads', 'exports', 'procurement'];
  if (segments.length !== 3 || segments[0] !== owner || !UUID.test(owner) || !folders.includes(segments[1])
    || !UUID.test(segments[2].slice(0, -extension.length)) || !segments[2].endsWith(extension)) {
    throw new AppError('INVALID_BLOB_KEY', '对象路径无效', 400);
  }
  return key;
}
export function maxBytesFor(kind: UploadKind): number { return kind === 'workbook' ? WORKBOOK_MAX_BYTES : PHOTO_MAX_BYTES; }
export function mimeFor(kind: UploadKind): string { return kind === 'workbook' ? WORKBOOK_MIME : PHOTO_MIME; }
export function assertSignedUrl(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new AppError('CLOUD_STORAGE', '云对象存储地址无效', 502);
  let url: URL;
  try { url = new URL(value); } catch { throw new AppError('CLOUD_STORAGE', '云对象存储地址无效', 502); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new AppError('CLOUD_STORAGE', '云对象存储地址无效', 502);
  return value;
}
export function jobErrorOf(error: unknown): JobError {
  if (error instanceof AppError && error.status < 500) {
    const safe = errorSchema.safeParse({ code: error.code, message: error.message });
    if (safe.success) return safe.data;
  }
  return { code: 'JOB_FAILED', message: '任务执行失败，请稍后重试' };
}
export function shouldExportAsJob(doc: Procurement): boolean {
  const images = doc.lines.reduce((count, line) => count + line.images.length, 0);
  return doc.lines.length > EXPORT_ASYNC_LINE_THRESHOLD || images > EXPORT_ASYNC_IMAGE_THRESHOLD;
}
