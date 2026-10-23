import { randomUUID } from 'node:crypto';
import { AppError } from '../lib/errors';
import { assertCloudOwner, type CloudContext, type CloudDatabase } from './cloud-db';
import type { BlobInfo, BlobStore } from './cloud-blobs';
import {
  assertOwnedObjectKey, assertSignedUrl, parseUploadTicket, isSha256, isUuid, maxBytesFor, mimeFor,
  sanitizeFilename, uploadObjectKey,
  type UploadKind, type UploadTicket,
} from './cloud-tasks';

export interface UploadRequest {
  kind: UploadKind;
  filename: string;
  sizeBytes: number;
  contentType: string;
  sha256?: string | null;
}
/** 返回给客户端的直传许可；签名地址只交给发起上传的账号，不写入日志。 */
export interface UploadGrant {
  uploadId: string;
  objectKey: string;
  method: 'PUT';
  uploadUrl: string;
  headers: Record<string, string>;
  expiresAt: string;
}
export interface UploadCommit { objectKey: string; sizeBytes: number; sha256: string | null }
interface StoredUpload { owner: string; uploadId: string; ticket: UploadTicket; declaredSize: number; sha256: string | null; deadline: number }

/**
 * 上传票据的进程内索引。持久真值在 RPC 票据里，这里只是缓存：
 * 同步路由保留此有界索引；commit 和异步导入从 prepare lookup 读取持久票据。
 */
export class UploadRegistry {
  readonly #items = new Map<string, StoredUpload>();
  constructor(readonly capacity = 512) {}
  #key(owner: string, uploadId: string): string { return `${owner}/${uploadId}`; }
  put(value: StoredUpload): void {
    const key = this.#key(value.owner, value.uploadId);
    if (!this.#items.has(key) && this.#items.size >= this.capacity) {
      const oldest = this.#items.keys().next().value;
      if (oldest !== undefined) this.#items.delete(oldest);
    }
    this.#items.set(key, value);
  }
  find(owner: string, uploadId: string): StoredUpload | undefined {
    return this.#items.get(this.#key(owner, uploadId));
  }
  findByKey(owner: string, objectKey: string): StoredUpload | undefined {
    for (const item of this.#items.values()) if (item.owner === owner && item.ticket.objectKey === objectKey) return item;
    return undefined;
  }
  drop(owner: string, uploadId: string): void { this.#items.delete(this.#key(owner, uploadId)); }
}
/** 同进程内跨请求复用；键含 owner，账号之间互不可见。 */
export const sharedUploadRegistry = new UploadRegistry();

/**
 * 三步直传：prepare 登记并签发短期 PUT、commit 用对象实际元信息校验后生效、abandon 作废。
 * 只有 committed 的对象键才能进入导入或照片业务。
 */
export class CloudUploadBroker {
  readonly #rpc: CloudDatabase;
  readonly #blobs: BlobStore;
  readonly #auth: CloudContext;
  readonly #registry: UploadRegistry;
  constructor(db: CloudDatabase, blobs: BlobStore, auth: CloudContext, registry: UploadRegistry = sharedUploadRegistry) {
    this.#rpc = db;
    this.#blobs = blobs;
    this.#auth = { ...auth };
    this.#registry = registry;
  }

  async prepare(owner: string, request: UploadRequest): Promise<UploadGrant> {
    assertCloudOwner(this.#auth, owner);
    if (!isUuid(owner)) throw new AppError('LOGIN_REQUIRED', '会话账号不一致，请重新登录', 401);
    if (!request || (request.kind !== 'workbook' && request.kind !== 'photo')) throw new AppError('INVALID_UPLOAD', '上传类型不受支持', 400);
    const kind = request.kind, mime = mimeFor(kind), limit = maxBytesFor(kind);
    const sizeBytes = request.sizeBytes;
    if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) throw new AppError('INVALID_UPLOAD', '文件大小无效', 400);
    if (sizeBytes > limit) {
      throw new AppError(kind === 'workbook' ? 'WORKBOOK_LIMIT' : 'PHOTO_LIMIT', kind === 'workbook' ? 'Excel不能超过40MB' : '照片不能超过8MB', 413);
    }
    if (request.contentType !== mime) throw new AppError('INVALID_UPLOAD', '文件类型不受支持', 415);
    if (request.sha256 != null && !isSha256(request.sha256)) throw new AppError('INVALID_UPLOAD', '文件摘要无效', 400);
    const fallback = kind === 'workbook' ? '采购表.xlsx' : 'photo.jpg';
    const filename = sanitizeFilename(request.filename, fallback);
    if (kind === 'workbook' ? !/\.xlsx$/i.test(filename) : !/\.jpe?g$/i.test(filename)) {
      throw new AppError(kind === 'workbook' ? 'INVALID_WORKBOOK' : 'INVALID_PHOTO', kind === 'workbook' ? '请选择 .xlsx 采购表' : '请选择 .jpg 照片', 400);
    }
    const uploadId = randomUUID(), objectKey = uploadObjectKey(owner, kind, uploadId);
    // 先落持久票据再签发：避免签发成功却没有票据的无主上传。
    const ticket = parseUploadTicket(await this.#rpc.call('upload/prepare', owner, this.#auth.tokenHash, {
      uploadId, kind, objectKey, sizeBytes, contentType: mime, sha256: request.sha256 ?? null, filename,
    }));
    if (ticket.state !== 'prepared' || ticket.kind !== kind || ticket.sizeBytes !== sizeBytes || ticket.sha256 !== (request.sha256 ?? null) || Date.parse(ticket.expiresAt) <= Date.now() || ticket.objectKey !== objectKey || ticket.uploadId !== uploadId) throw new AppError('DB_RESPONSE_INVALID', '上传登记响应无效', 502);
    let signed, uploadUrl;
    try { signed = await this.#blobs.signUpload(objectKey, mime); uploadUrl = assertSignedUrl(signed.url); }
    catch (error) {
      await this.#rpc.call('upload/abandon', owner, this.#auth.tokenHash, { uploadId, reason: 'sign-failed' }).catch(() => {});
      throw error;
    }
    this.#registry.put({ owner, uploadId, ticket, declaredSize: sizeBytes, sha256: request.sha256 ?? null, deadline: Date.parse(ticket.expiresAt) });
    const headers: Record<string, string> = {};
    const contentType = signed.headers?.['Content-Type'];
    if (contentType) headers['Content-Type'] = contentType;
    return { uploadId, objectKey, method: 'PUT', uploadUrl, headers, expiresAt: signed.expiresAt };
  }

  /** 客户端自报的 actualSize 不作为依据：以对象存储的实际大小与类型为准。 */
  async commit(owner: string, uploadId: string, actualSize: number, sha256: string | null = null): Promise<UploadCommit> {
    assertCloudOwner(this.#auth, owner);
    if (!isUuid(owner)) throw new AppError('LOGIN_REQUIRED', '会话账号不一致，请重新登录', 401);
    if (!isUuid(uploadId)) throw new AppError('INVALID_UPLOAD', '上传凭证无效', 400);
    if (sha256 != null && !isSha256(sha256)) throw new AppError('INVALID_UPLOAD', '文件摘要无效', 400);
    const stored = await this.#load(owner, uploadId);
    if (stored.ticket.state === 'abandoned' && Date.now() >= stored.deadline) throw new AppError('UPLOAD_EXPIRED', '上传凭证已过期，请重新上传', 410);
    if (stored.ticket.state !== 'prepared') throw new AppError('CONFLICT', '上传凭证已结束，请重新上传', 409);
    if (Date.now() >= stored.deadline) {
      await this.#abandon(owner, uploadId, 'expired');
      throw new AppError('UPLOAD_EXPIRED', '上传凭证已过期，请重新上传', 410);
    }
    const mime = mimeFor(stored.ticket.kind), limit = maxBytesFor(stored.ticket.kind);
    let info: BlobInfo;
    try { info = await this.#blobs.info(stored.ticket.objectKey); }
    catch (error) {
      await this.#abandon(owner, uploadId, 'missing');
      throw error instanceof AppError ? error : new AppError('UPLOAD_NOT_FOUND', '未找到上传的文件，请重新上传', 404);
    }
    // 声明大小、实际大小与客户端回执三者必须一致，类型与上限再次复核。
    const mismatched = info.size !== stored.declaredSize || info.mime !== mime || info.size > limit
      || !Number.isInteger(actualSize) || actualSize !== info.size
      || (sha256 !== null && stored.sha256 !== null && sha256 !== stored.sha256);
    if (mismatched) {
      await this.#abandon(owner, uploadId, 'mismatch');
      throw new AppError('UPLOAD_MISMATCH', '上传文件的大小或类型与登记不一致，已取消本次上传', 400);
    }
    const ticket = parseUploadTicket(await this.#rpc.call('upload/commit', owner, this.#auth.tokenHash, { uploadId, sizeBytes: info.size, sha256: stored.sha256 }));
    if (ticket.state !== 'committed' || ticket.uploadId !== uploadId || ticket.objectKey !== stored.ticket.objectKey || ticket.sizeBytes !== info.size || ticket.sha256 !== stored.sha256) throw new AppError('DB_RESPONSE_INVALID', '上传回执无效', 502);
    stored.ticket = ticket;
    this.#registry.put(stored);
    return { objectKey: stored.ticket.objectKey, sizeBytes: info.size, sha256: stored.sha256 };
  }

  async abandon(owner: string, uploadId: string, reason = 'user'): Promise<void> {
    assertCloudOwner(this.#auth, owner);
    if (!isUuid(uploadId)) throw new AppError('INVALID_UPLOAD', '上传凭证无效', 400);
    const ticket = parseUploadTicket(await this.#rpc.call('upload/abandon', owner, this.#auth.tokenHash, { uploadId, reason }));
    if (ticket.uploadId !== uploadId || ticket.state !== 'abandoned') throw new AppError('DB_RESPONSE_INVALID', '上传作废响应无效', 502);
    this.#registry.drop(owner, uploadId);
  }

  /** 同步路由的有界索引检查；异步执行使用 committed() 查持久状态。 */
  requireCommitted(owner: string, objectKey: string): UploadTicket {
    assertCloudOwner(this.#auth, owner);
    assertOwnedObjectKey(owner, objectKey, objectKey.endsWith('.jpg') ? '.jpg' : '.xlsx');
    const stored = this.#registry.findByKey(owner, objectKey);
    if (!stored || stored.ticket.state !== 'committed') throw new AppError('UPLOAD_NOT_COMMITTED', '文件未完成上传确认，不能用于导入', 409);
    return stored.ticket;
  }

  async #load(owner: string, uploadId: string): Promise<StoredUpload> {
    const ticket = parseUploadTicket(await this.#rpc.call('upload/prepare', owner, this.#auth.tokenHash, { uploadId, lookup: true }));
    if (ticket.uploadId !== uploadId) throw new AppError('DB_RESPONSE_INVALID', '上传凭证响应无效', 502);
    const key = assertOwnedObjectKey(owner, ticket.objectKey, ticket.kind === 'photo' ? '.jpg' : '.xlsx');
    if (key !== uploadObjectKey(owner, ticket.kind, uploadId)) throw new AppError('DB_RESPONSE_INVALID', '上传对象响应无效', 502);
    const stored = { owner, uploadId, ticket, declaredSize: ticket.sizeBytes, sha256: ticket.sha256, deadline: Date.parse(ticket.expiresAt) };
    this.#registry.put(stored);
    return stored;
  }
  /** 路由可在新进程中凭 uploadId 恢复票据，不依赖 UploadRegistry。 */
  async ticket(owner: string, uploadId: string): Promise<UploadTicket> {
    assertCloudOwner(this.#auth, owner);
    if (!isUuid(uploadId)) throw new AppError('INVALID_UPLOAD', '上传凭证无效', 400);
    return (await this.#load(owner, uploadId)).ticket;
  }
  /** 异步业务入口跨进程查库；已提交票据不再受上传 PUT 的期限影响。 */
  async committed(owner: string, objectKey: string): Promise<UploadTicket> {
    assertCloudOwner(this.#auth, owner);
    assertOwnedObjectKey(owner, objectKey, objectKey.endsWith('.jpg') ? '.jpg' : '.xlsx');
    const uploadId = objectKey.split('/')[2].slice(0, objectKey.endsWith('.jpg') ? -4 : -5);
    const stored = await this.#load(owner, uploadId);
    if (stored.ticket.objectKey !== objectKey || stored.ticket.state !== 'committed') throw new AppError('UPLOAD_NOT_COMMITTED', '文件未完成上传确认，不能用于导入', 409);
    return stored.ticket;
  }
  /** 校验失败时尽力作废；持久期限兜底，清理对象由独立维护处理。 */
  async #abandon(owner: string, uploadId: string, reason: string): Promise<void> {
    this.#registry.drop(owner, uploadId);
    try { await this.#rpc.call('upload/abandon', owner, this.#auth.tokenHash, { uploadId, reason }); }
    catch { /* 失败票据会在下一次读取时按持久期限作废。 */ }
  }
}
