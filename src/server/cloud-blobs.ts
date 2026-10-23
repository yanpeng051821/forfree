import { Buffer } from 'node:buffer';
import { AppError } from '../lib/errors';

export const CLOUD_BLOB_BUCKET = 'huoji-private';
export const MAX_BLOB_BYTES = 100 * 1024 * 1024;
const MAX_JSON_BYTES = 64 * 1024;
const TIMEOUT_MS = 45_000;
const SIGN_SECONDS = 60;
const ENV_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?![\s\S])/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?![\s\S])/;
const MIME = /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+(?![\s\S])/;
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
// 固定形态的探测键，仅用于判断存储服务可达，不代表任何真实文件或账号。
const PROBE_OWNER = '00000000-0000-4000-8000-000000000000';
const PROBE_PHOTO = '00000000-0000-4000-8000-000000000000';

export interface BlobInfo { size: number; mime: string; etag: string }
export interface SignedUpload {
  url: string;
  method: 'PUT';
  headers: { 'Content-Type'?: string };
  expiresAt: string;
}
export interface SignedDownload { url: string; expiresAt: string }
export interface BlobStore {
  write(key: string, bytes: Uint8Array, mime: string): Promise<void>;
  read(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
  info(key: string): Promise<BlobInfo>;
  signUpload(key: string, mime?: string): Promise<SignedUpload>;
  signDownload(key: string): Promise<SignedDownload>;
}

function storageError(): AppError {
  return new AppError('CLOUD_STORAGE', '云对象存储请求失败', 502);
}
function statusError(status: number): AppError {
  if (status === 401 || status === 403) return new AppError('CLOUD_PERMISSION', '云对象存储服务权限不可用', 503);
  if (status === 429) return new AppError('CLOUD_QUOTA', '云对象存储配额或请求频率受限', 429);
  if (status === 404) return new AppError('NOT_FOUND', '文件不存在或不可访问', 404);
  return storageError();
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function validMime(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 127 && MIME.test(value);
}
function keyMime(key: string): string {
  const segments = key.split('/');
  if (segments.length !== 3 || segments.some(segment => !segment || segment === '.' || segment === '..' || /[\\%\x00-\x20\x7f]/.test(segment)) || !UUID.test(segments[0])) {
    throw new AppError('INVALID_BLOB_KEY', '对象路径无效', 400);
  }
  const [owner, folder, file] = segments;
  const extension = folder === 'photos' || folder === 'pictures' ? '.jpg'
    : ['procurement', 'uploads', 'exports'].includes(folder) ? '.xlsx' : null;
  if (!owner || !extension || !file.endsWith(extension) || !UUID.test(file.slice(0, -extension.length))) {
    throw new AppError('INVALID_BLOB_KEY', '对象路径无效', 400);
  }
  return extension === '.jpg' ? 'image/jpeg' : XLSX_MIME;
}
function checkMime(key: string, mime: string): void {
  if (!validMime(mime) || mime !== keyMime(key)) throw new AppError('INVALID_BLOB_MIME', '文件类型与对象路径不匹配', 400);
}
function discard(response: Response): void {
  if (response.body) void response.body.cancel().catch(() => {});
}

export class CloudBlobStore implements BlobStore {
  readonly #base: URL;
  readonly #apiKey: string;
  readonly #fetcher: typeof globalThis.fetch;

  constructor(envId: string, apiKey: string, fetcher: typeof globalThis.fetch = globalThis.fetch) {
    if (typeof envId !== 'string' || !ENV_ID.test(envId) || typeof apiKey !== 'string' || !apiKey || !/^[\x21-\x7e]+(?![\s\S])/.test(apiKey) || typeof fetcher !== 'function') {
      throw new AppError('CLOUD_CONFIG', '云对象存储配置无效', 503);
    }
    this.#base = new URL(`https://${envId}.api.tcloudbasegateway.com`);
    this.#apiKey = apiKey;
    this.#fetcher = fetcher;
  }

  #url(kind: 'object' | 'object/info' | 'object/sign' | 'object/upload/sign', key: string): string {
    keyMime(key);
    return `${this.#base.origin}/v1/storages/${kind}/${CLOUD_BLOB_BUCKET}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }

  #trustedUrl(value: unknown): string {
    if (typeof value !== 'string' || !value.startsWith('https://') || /[\\\x00-\x20\x7f]/.test(value)) throw storageError();
    let parsed: URL;
    try { parsed = new URL(value); } catch { throw storageError(); }
    if (parsed.protocol !== 'https:' || parsed.host !== this.#base.host || parsed.username || parsed.password || parsed.hash) throw storageError();
    return value;
  }

  async #run<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let onAbort: (() => void) | undefined;
    const timeout = new Promise<never>((_, reject) => {
      onAbort = () => reject(storageError());
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    try { return await Promise.race([work(controller.signal), timeout]); }
    catch (error) { throw error instanceof AppError ? error : storageError(); }
    finally {
      clearTimeout(timer);
      if (onAbort) controller.signal.removeEventListener('abort', onAbort);
    }
  }

  async #request(url: string, init: RequestInit, signal: AbortSignal, authorized = true, allow404 = false): Promise<Response> {
    const target = this.#trustedUrl(url);
    const headers = new Headers(init.headers);
    if (authorized) headers.set('Authorization', `Bearer ${this.#apiKey}`);
    let response: Response;
    try {
      response = await this.#fetcher(target, { ...init, headers, signal, redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
    } catch { throw storageError(); }
    if (response.redirected) { discard(response); throw storageError(); }
    if (!response.ok && !(allow404 && response.status === 404)) {
      discard(response);
      throw statusError(response.status);
    }
    return response;
  }

  async #bytes(response: Response, limit: number, signal: AbortSignal): Promise<Buffer> {
    const length = response.headers.get('Content-Length');
    if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > limit)) {
      discard(response);
      throw storageError();
    }
    if (signal.aborted) { discard(response); throw storageError(); }
    if (!response.body) return Buffer.alloc(0);
    const reader = response.body.getReader();
    const cancel = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', cancel, { once: true });
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (signal.aborted) throw storageError();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > limit) { cancel(); throw storageError(); }
        chunks.push(Buffer.from(chunk.value));
      }
      return Buffer.concat(chunks, size);
    } catch {
      cancel();
      throw storageError();
    } finally {
      signal.removeEventListener('abort', cancel);
      reader.releaseLock();
    }
  }

  async #json(response: Response, signal: AbortSignal): Promise<Record<string, unknown>> {
    const type = response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') { discard(response); throw storageError(); }
    const bytes = await this.#bytes(response, MAX_JSON_BYTES, signal);
    let value: unknown;
    try { value = JSON.parse(bytes.toString('utf8')); } catch { throw storageError(); }
    if (!record(value) || value.error != null || value.code != null) throw storageError();
    return value;
  }

  async write(key: string, bytes: Uint8Array, mime: string): Promise<void> {
    const url = this.#url('object', key);
    checkMime(key, mime);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_BLOB_BYTES) {
      throw new AppError('BLOB_TOO_LARGE', '文件不得超过100MB', 413);
    }
    await this.#run(async signal => {
      const response = await this.#request(url, { method: 'POST', headers: { 'Content-Type': mime }, body: new Uint8Array(bytes) }, signal);
      const value = await this.#json(response, signal);
      const id = value.id ?? value.Id;
      if (typeof id !== 'string' || !UUID.test(id) || (value.Key !== undefined && value.Key !== `${CLOUD_BLOB_BUCKET}/${key}`)) throw storageError();
    });
  }

  async #sign(key: string, upload: boolean, signal: AbortSignal): Promise<SignedDownload> {
    const startedAt = Date.now();
    const url = this.#url(upload ? 'object/upload/sign' : 'object/sign', key);
    const init: RequestInit = upload
      ? { method: 'POST', headers: { 'x-upsert': 'false' } }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn: SIGN_SECONDS }) };
    const value = await this.#json(await this.#request(url, init, signal), signal);
    // 完整签名地址保持原样；拒绝跨域，不能把相对 signedURL 拼成地址。
    const signed = this.#trustedUrl(upload ? value.fullURL : value.fullSignedURL);
    for (const token of new URL(signed).searchParams.values()) if (token.includes(this.#apiKey)) throw storageError();
    return { url: signed, expiresAt: new Date(startedAt + SIGN_SECONDS * 1000).toISOString() };
  }

  async read(key: string): Promise<Buffer> {
    keyMime(key);
    return this.#run(async signal => {
      const signed = await this.#sign(key, false, signal);
      const response = await this.#request(signed.url, { method: 'GET' }, signal, false);
      return this.#bytes(response, MAX_BLOB_BYTES, signal);
    });
  }

  async remove(key: string): Promise<void> {
    const url = this.#url('object', key);
    await this.#run(async signal => { discard(await this.#request(url, { method: 'DELETE' }, signal, true, true)); });
  }

  /** 连通性探测：只判断对象存储是否可达，不读取任何真实文件，也不依赖对象是否存在。 */
  async ping(): Promise<boolean> {
    const probe = `${PROBE_OWNER}/photos/${PROBE_PHOTO}.jpg`;
    const url = this.#url('object/info', probe);
    try {
      const response = await this.#request(url, { method: 'GET' }, AbortSignal.timeout(TIMEOUT_MS), true, true);
      discard(response);
      return true;
    } catch { return false; }
  }

  async info(key: string): Promise<BlobInfo> {
    const url = this.#url('object/info', key);
    return this.#run(async signal => {
      const value = await this.#json(await this.#request(url, { method: 'GET' }, signal), signal);
      // PG 元信息只归一化为这三个字段，不透传 owner、路径或上游响应。
      // 当前云端对象信息把 size/content_type/etag 放顶层，metadata 可以为空。
      // 兼容旧网关的 metadata.size/mimetype/eTag，不能因空 metadata 覆盖顶层事实。
      const metadata = record(value.metadata) ? value.metadata : {};
      const size = value.size ?? metadata.size;
      const mime = value.content_type ?? value.mime ?? metadata.mimetype;
      const etag = value.etag ?? metadata.eTag;
      if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0 || size > MAX_BLOB_BYTES || !validMime(mime) || typeof etag !== 'string' || !etag || etag.length > 256 || /[\x00-\x1f\x7f]/.test(etag)) throw storageError();
      return { size, mime, etag };
    });
  }

  async signUpload(key: string, mime?: string): Promise<SignedUpload> {
    keyMime(key);
    if (mime !== undefined) checkMime(key, mime);
    return this.#run(async signal => {
      const signed = await this.#sign(key, true, signal);
      // 默认60秒的 PG HTTP 签名 PUT；没有证据证明它能绕过网关限制或直连 COS。
      return { ...signed, method: 'PUT', headers: mime === undefined ? {} : { 'Content-Type': mime } };
    });
  }

  async signDownload(key: string): Promise<SignedDownload> {
    keyMime(key);
    return this.#run(signal => this.#sign(key, false, signal));
  }
}
