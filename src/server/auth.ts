import { createHash, randomBytes, randomUUID } from "node:crypto";
import { db, getProfile, transaction } from "../lib/db";
import { cancelModelOperations, loadCloudSession, saveCloudSession, type CloudSession } from "./cloud-session";
import { AppError } from "../lib/errors";
import { secureFetch } from "../lib/outbound";
import { parseRuntimeConfig, type RuntimeConfig, type RuntimeEnvironment } from "./config";

export type IdentityGrant = string | { subject: string; cloudSession: CloudSession };
export interface IdentityProvider { exchange(code: string): Promise<IdentityGrant>; }
export class WechatIdentityProvider implements IdentityProvider {
  constructor(private appId = process.env.WECHAT_APP_ID || "", private secret = process.env.WECHAT_APP_SECRET || "") {}
  async exchange(code: string) {
    if (!this.appId || !this.secret) throw new AppError("AUTH_NOT_CONFIGURED", "微信登录尚未配置，请联系管理员", 503);
    const url = new URL("https://api.weixin.qq.com/sns/jscode2session");
    url.search = new URLSearchParams({ appid: this.appId, secret: this.secret, js_code: code, grant_type: "authorization_code" }).toString();
    const response = await secureFetch(url, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new AppError("AUTH_UNAVAILABLE", "微信登录暂不可用", 502);
    const value = await response.json() as { openid?: string; errcode?: number };
    if (!value.openid || value.errcode || value.openid.length > 128) throw new AppError("LOGIN_FAILED", "微信登录失败，请重新登录", 401);
    return value.openid;
  }
}
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
export function issueSession(grant: IdentityGrant) {
  const wechatId = typeof grant === "string" ? grant : grant.subject;
  if (!wechatId || wechatId === "__legacy__") throw new AppError("LOGIN_FAILED", "身份无效", 401);
  return transaction(() => {
    const connection = db();
    connection.prepare("INSERT OR IGNORE INTO users (id,wechat_id,created_at) VALUES (?,?,?)").run(randomUUID(), wechatId, new Date().toISOString());
    const user = connection.prepare("SELECT id FROM users WHERE wechat_id=?").get(wechatId) as { id: string };
    const token = randomBytes(32).toString("hex"), tokenHash = hash(token);
    const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
    connection.prepare("INSERT INTO sessions VALUES (?,?,?)").run(tokenHash, user.id, expiresAt);
    if (typeof grant !== "string") saveCloudSession({ owner: user.id, tokenHash }, grant.cloudSession);
    return { token, expiresAt, user: { ...user, profile: getProfile(user.id) } };
  });
}
export function authenticate(authorization?: string) {
  const match = /^Bearer ([a-f0-9]{64})$/.exec(authorization || "");
  if (!match) throw new AppError("LOGIN_REQUIRED", "请先登录", 401);
  const session = db().prepare("SELECT owner_id,expires_at FROM sessions WHERE token_hash=? AND expires_at>?").get(hash(match[1]), Date.now()) as { owner_id: string; expires_at: number } | undefined;
  if (!session) throw new AppError("LOGIN_REQUIRED", "登录已过期，请重新登录", 401);
  return { owner: session.owner_id, expiresAt: session.expires_at, tokenHash: hash(match[1]) };
}
export function revokeSession(tokenHash: string) {
  db().prepare("DELETE FROM sessions WHERE token_hash=?").run(tokenHash);
  cancelModelOperations(tokenHash);
}
export function reauthorizeModel(context: { owner: string; tokenHash: string }, grant: IdentityGrant) {
  const row = db().prepare('SELECT u.wechat_id FROM users u JOIN sessions s ON s.owner_id=u.id WHERE s.token_hash=? AND s.owner_id=? AND s.expires_at>?').get(context.tokenHash, context.owner, Date.now()) as { wechat_id: string } | undefined;
  if (!row) throw new AppError('LOGIN_REQUIRED', '登录已过期或退出，请重新登录', 401);
  if (typeof grant === 'string' || grant.subject !== row.wechat_id || !grant.subject.startsWith('workbuddy:') || !grant.subject.endsWith(':' + grant.cloudSession.subject)) throw new AppError('MODEL_IDENTITY_CHANGED', '微信身份与当前账号不一致，请退出后重新登录', 409);
  if (loadCloudSession(context).scope !== grant.cloudSession.scope || grant.cloudSession.expiresAt <= Date.now()) throw new AppError('MODEL_IDENTITY_CHANGED', 'AI服务绑定已变化，请退出后重新登录', 409);
  saveCloudSession(context, grant.cloudSession);
}
export function devLoginEnabled(source: RuntimeConfig | RuntimeEnvironment = process.env) {
  const config = "allowDevLogin" in source ? source : parseRuntimeConfig(source, { identityInjected: true, serviceInjected: true });
  return config.allowDevLogin;
}
