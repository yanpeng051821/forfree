import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { db } from "../lib/db";
import { AppError } from "../lib/errors";

export type CloudSession = { accessToken: string; refreshToken: string; expiresAt: number; subject: string; scope: string };
export type ModelContext = { owner: string; tokenHash: string };
const operations = new Map<string, Set<AbortController>>();
export function beginModelOperation(context: ModelContext) {
  assertLive(context);
  const controller = new AbortController();
  const active = operations.get(context.tokenHash) || new Set<AbortController>();
  active.add(controller); operations.set(context.tokenHash, active);
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]);
  return { signal, release() {
    active.delete(controller);
    if (!active.size) operations.delete(context.tokenHash);
  } };
}
export function cancelModelOperations(tokenHash: string) {
  for (const controller of operations.get(tokenHash) || []) controller.abort(new AppError("LOGIN_REQUIRED", "登录已退出，模型请求已取消", 401));
  operations.delete(tokenHash);
}
export function encryptionReady() { return /^[a-f0-9]{64}$/i.test(process.env.WB_SESSION_ENCRYPTION_KEY || ""); }
function encryptionKey() {
  if (!encryptionReady()) throw new AppError("AUTH_NOT_CONFIGURED", "模型网关会话加密尚未配置", 503);
  return Buffer.from(process.env.WB_SESSION_ENCRYPTION_KEY!, "hex");
}
export function assertLive(context: ModelContext) {
  if (!db().prepare("SELECT token_hash FROM sessions WHERE token_hash=? AND owner_id=? AND expires_at>?").get(context.tokenHash, context.owner, Date.now())) {
    throw new AppError("LOGIN_REQUIRED", "登录已过期或退出，请重新登录", 401);
  }
}
export function saveCloudSession(context: ModelContext, value: CloudSession, expected?: CloudSession) {
  assertLive(context);
  if (expected) {
    const current = loadCloudSession(context);
    if (current.accessToken !== expected.accessToken || current.refreshToken !== expected.refreshToken) throw new AppError('MODEL_SESSION_CHANGED', 'AI登录已更新，请重试整理', 409);
  }
  const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", encryptionKey(), nonce);
  cipher.setAAD(Buffer.from(`${context.owner}:${context.tokenHash}`));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  const sealed = Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString("base64");
  db().prepare("INSERT INTO gateway_sessions (token_hash,encrypted) VALUES (?,?) ON CONFLICT(token_hash) DO UPDATE SET encrypted=excluded.encrypted").run(context.tokenHash, sealed);
}
export function loadCloudSession(context: ModelContext): CloudSession {
  assertLive(context);
  const row = db().prepare("SELECT encrypted FROM gateway_sessions WHERE token_hash=?").get(context.tokenHash) as { encrypted: string } | undefined;
  if (!row) throw new AppError("LOGIN_REQUIRED", "请通过微信重新登录以启用共享模型服务", 401);
  try {
    const sealed = Buffer.from(row.encrypted, "base64"), decipher = createDecipheriv("aes-256-gcm", encryptionKey(), sealed.subarray(0, 12));
    decipher.setAAD(Buffer.from(`${context.owner}:${context.tokenHash}`)); decipher.setAuthTag(sealed.subarray(12, 28));
    const value = JSON.parse(Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]).toString("utf8")) as CloudSession;
    if (!value.accessToken || !value.subject || !value.scope || !Number.isFinite(value.expiresAt)) throw new Error("shape");
    return value;
  } catch { throw new AppError("LOGIN_REQUIRED", "模型服务会话无法恢复，请重新登录", 401); }
}
