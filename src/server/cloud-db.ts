import type { ExtraCommands } from './cloud-tasks';
import { createHash } from 'node:crypto';
import { AppError } from '../lib/errors';
import { withinBudget, type RequestBudget } from './request-budget';
import type { Product, ProductFields, Project, ProjectSummary, UserProfile, UserProfileFields } from '../lib/types';
import type { ProductFilter, RecordDateRange, SaveProductCommand } from '../lib/db';
import type { Procurement } from '../lib/procurement';
import type { ProcurementTemplate, ProcurementTemplateFields } from '../lib/procurement-template';

export const HUOJI_BUCKET = 'huoji-private';
export type CloudBlobStore = Pick<import('./cloud-blobs').BlobStore, 'read' | 'write' | 'remove' | 'info'>;
export type CloudContext = { owner: string; tokenHash: string; expiresAt?: number };
export type CloudMedia = { id: string; name: string; objectKey: string; productId: string | null; expiresAt: string | null };
export type CloudPage = { items: Product[]; nextCursor: string | null; summary: ProjectSummary; matchedCount: number };
export type CloudProcurement = { document: Procurement; originalKey: string | null };
export type CloudEnvelope<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string; status: number } };
export type CloudRpcParameters = { p_operation: string; p_owner: string | null; p_token_hash: string | null; p_payload: Record<string, unknown> };
/** 主控注入使用 service_role 的 @cloudbase/node-sdk app.rdb()；这里不初始化SDK或读取环境变量。 */
export interface CloudRpcClient {
  rpc(name: 'huoji_command', parameters: CloudRpcParameters, budget?: RequestBudget): PromiseLike<{ data: unknown; error: unknown }>;
}
export interface CloudCommands extends ExtraCommands {
  capabilities: { payload: Record<string, never>; data: { dateRangeExport: boolean } };
  health: { payload: Record<string, never>; data: { healthy: boolean } };
  login: { payload: { subject: string; tokenHash: string; expiresAt: string; cloudEncrypted: string | null }; data: { owner: string; tokenHash: string; expiresAt: string; profile: UserProfile } };
  sessionAuthenticate: { payload: { tokenHash: string }; data: { owner: string; tokenHash: string; expiresAt: string } };
  sessionRevoke: { payload: Record<string, never>; data: { revoked: boolean } };
  cloudSessionLoad: { payload: Record<string, never>; data: { subject: string; encrypted: string | null } };
  cloudSessionSave: { payload: { encrypted: string; expectedEncrypted?: string; deadlineAt?: string }; data: { saved: boolean } };
  getProfile: { payload: Record<string, never>; data: UserProfile };
  saveProfile: { payload: { fields: UserProfileFields; version: number }; data: UserProfile };
  'projects/list': { payload: Record<string, never>; data: Project[] };
  'projects/get': { payload: { id: string }; data: Project };
  'projects/create': { payload: Pick<Project, 'name' | 'market' | 'date' | 'supplier' | 'supplierContact'> & { requestKey: string; digest: string }; data: Project };
  'product/get': { payload: { id: string }; data: Product };
  'product/page': { payload: ProductFilter & { projectId?: string; cursor?: string; limit: number }; data: CloudPage };
  'merchant/visits': { payload:{date:string}; data:import('../lib/db').MerchantVisit[] };
  'merchant/list': { payload: RecordDateRange & { projectId?: string; date?: string; favorite?: boolean }; data: import('../lib/db').MerchantSummary[] };
  'product/listExport': { payload: RecordDateRange & { projectId?: string; date?: string; favorite?: boolean; supplier?: string }; data: Product[] };
  'product/save': { payload: SaveProductCommand & { digest: string; checkOnly?: boolean }; data: Product | null };
  'product/delete': { payload: { id: string; version: number }; data: { deleted: boolean } };
  'product/trash': {payload:{id:string;version:number};data:Product};
  'product/restore': {payload:{id:string;version:number};data:Product};
  'product/trashPage': {payload:{cursor?:string;limit:number;q?:string};data:{items:Product[];matchedCount:number;nextCursor:string|null}};
  'product/favorite': { payload: { id: string; version: number; favorite: boolean }; data: Product };
  recordDays: { payload: Record<string, never>; data: { date: string; count: number }[] };
  'media/stage': { payload: { id: string; name: string; objectKey: string }; data: CloudMedia };
  'media/get': { payload: { id: string }; data: CloudMedia };
  'media/listExpired': { payload: { limit?: number }; data: CloudMedia[] };
  'media/retire': { payload: { id: string; purge?: boolean }; data: { retired: boolean } };
  'procurement/list': { payload: Record<string, never>; data: Procurement[] };
  'procurement/get': { payload: { id: string }; data: CloudProcurement };
  'procurement/create': { payload: { document: Procurement; originalKey: string | null }; data: CloudProcurement };
  'procurement/update': { payload: { id: string; version: number; document: Procurement }; data: CloudProcurement };
  'procurement/delete': { payload: { id: string; version: number }; data: { deleted: boolean; objectKeys: string[] } };
  'template/get': { payload: Record<string, never>; data: ProcurementTemplate | null };
  'template/save': { payload: { version: number; fields: ProcurementTemplateFields }; data: ProcurementTemplate };
}
export type CloudOperation = keyof CloudCommands;
export type CloudProductFields = ProductFields;

// 调用侧摘要保留旧键排序规范；SQL回执另用规范jsonb重算，不信任调用侧digest。
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new AppError('VALIDATION', '载荷不能包含不可序列化的值');
  return encoded;
}
export const commandDigest = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex');
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
export function assertCloudOwner(context: CloudContext, owner: string): void {
  if (!owner || owner !== context.owner || !/^[a-f0-9]{64}$/.test(context.tokenHash)) throw new AppError('LOGIN_REQUIRED', '会话账号不一致，请重新登录', 401);
}
function validateJson(value: unknown, ancestors = new Set<object>(), depth = 0): void {
  if (depth > 64) throw new AppError('VALIDATION', 'JSON嵌套过深');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || !value || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) || ancestors.has(value)) throw new AppError('VALIDATION', '载荷必须是有效JSON');
  ancestors.add(value);
  for (const child of Array.isArray(value) ? value : Object.values(value).filter(v => v !== undefined)) validateJson(child, ancestors, depth + 1);
  ancestors.delete(value);
}
function rpcFailure(error: unknown): AppError {
  if (object(error)) {
    const code = typeof error.code === 'string' ? error.code : '';
    if (code === '42501') return new AppError('FORBIDDEN', '数据库角色无权访问', 403);
    if (code === '23505' || code === '40001' || code === '40P01') return new AppError('CONFLICT', '记录已更新，请重新读取后再修改', 409);
    if (code === '57014') return new AppError('DB_TIMEOUT', '数据库操作超时，请用原请求编号重试', 503);
  }
  return new AppError('DB_UNAVAILABLE', '数据库暂不可用，请用原请求编号重试', 503);
}
export class CloudDatabase {
  constructor(private readonly client: CloudRpcClient, readonly maxPayloadBytes = 4 * 1024 * 1024) {}
  health() { return this.call('health', null, null, {}); }
  async call<O extends CloudOperation>(operation: O, owner: string | null, tokenHash: string | null, payload: CloudCommands[O]['payload'], budget?: RequestBudget): Promise<CloudCommands[O]['data']> {
    validateJson(payload);
    if (!object(payload) || Object.prototype.hasOwnProperty.call(payload, 'owner') || Object.prototype.hasOwnProperty.call(payload, 'ownerId') || Object.prototype.hasOwnProperty.call(payload, 'owner_id')) throw new AppError('VALIDATION', '业务载荷不能指定账号');
    const json = JSON.stringify(payload);
    if (Buffer.byteLength(json) > this.maxPayloadBytes) throw new AppError('PAYLOAD_LIMIT', '数据库请求过大，请拆分元数据或外置附件', 413);
    // 去掉undefined，保证mock与真实SDK得到同样的JSON载荷。
    const parameters: CloudRpcParameters = { p_operation: operation, p_owner: owner, p_token_hash: tokenHash, p_payload: JSON.parse(json) as Record<string, unknown> };
    let response: unknown;
    try { response = await withinBudget(() => this.client.rpc('huoji_command', parameters, budget), budget); }
    catch (error) { if (error instanceof AppError && error.code === 'MODEL_RECOVERY_TIMEOUT') throw error; throw rpcFailure(error); }
    if (!object(response)) throw new AppError('DB_RESPONSE_INVALID', '数据库响应无效', 502);
    if (response.error) throw rpcFailure(response.error);
    const envelope = response.data;
    try { validateJson(envelope); } catch { throw new AppError('DB_RESPONSE_INVALID', '数据库响应不是有效JSON', 502); }
    if (!object(envelope) || typeof envelope.ok !== 'boolean') throw new AppError('DB_RESPONSE_INVALID', '数据库响应无效', 502);
    if (!envelope.ok) {
      const error = envelope.error;
      if (!object(error) || typeof error.code !== 'string' || typeof error.message !== 'string' || !Number.isInteger(error.status) || Number(error.status) < 400 || Number(error.status) > 599) throw new AppError('DB_RESPONSE_INVALID', '数据库错误响应无效', 502);
      throw new AppError(error.code, error.message, Number(error.status));
    }
    if (!('data' in envelope)) throw new AppError('DB_RESPONSE_INVALID', '数据库响应缺少数据', 502);
    return envelope.data as CloudCommands[O]['data'];
  }
}
