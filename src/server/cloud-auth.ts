import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../lib/errors';
import { emptyProfile } from '../lib/types';
import type { IdentityGrant, IdentityProvider } from './auth';
import type { CloudSession, ModelContext } from './cloud-session';
import { CloudDatabase, type CloudContext } from './cloud-db';
import { assertBudget, type RequestBudget } from './request-budget';

const sessionShape = z.strictObject({ accessToken: z.string().min(1), refreshToken: z.string(), expiresAt: z.number().finite(), subject: z.string().min(1), scope: z.string().min(1) });
export const hashBusinessToken = (token: string) => createHash('sha256').update(token).digest('hex');
export type CloudAuthOptions = { encryptionKey?: string; cancel?: (tokenHash: string) => void };
/** 不读取.env；加密密钥与已验证身份提供商由主控注入。AAD使用持久subject:tokenHash。 */
export class CloudAuth {
  private readonly operations = new Map<string, Set<AbortController>>();
  private readonly options: CloudAuthOptions;
  constructor(private readonly db: CloudDatabase, key: string | CloudAuthOptions = {}) {
    this.options = typeof key === 'string' ? { encryptionKey: key } : key;
  }
  private key(): Buffer {
    if (!/^[a-f0-9]{64}$/i.test(this.options.encryptionKey || '')) throw new AppError('AUTH_NOT_CONFIGURED', '模型网关会话加密尚未配置', 503);
    return Buffer.from(this.options.encryptionKey!, 'hex');
  }
  private seal(subject: string, tokenHash: string, value: CloudSession): string {
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key(), nonce);
    cipher.setAAD(Buffer.from(`${subject}:${tokenHash}`));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(sessionShape.parse(value)), 'utf8'), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64');
  }
  async issueGrant(grant: IdentityGrant) {
    const subject = typeof grant === 'string' ? grant : grant.subject;
    if (!subject || subject === '__legacy__' || subject.length > 512) throw new AppError('LOGIN_FAILED', '身份无效', 401);
    if (typeof grant !== 'string' && (!subject.startsWith('workbuddy:') || !subject.endsWith(':' + sessionShape.parse(grant.cloudSession).subject))) throw new AppError('LOGIN_FAILED', '共享服务身份不一致', 401);
    const token = randomBytes(32).toString('hex'), tokenHash = hashBusinessToken(token);
    const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
    const cloudEncrypted = typeof grant === 'string' ? null : this.seal(subject, tokenHash, grant.cloudSession);
    const result = await this.db.call('login', null, null, { subject, tokenHash, expiresAt: new Date(expiresAt).toISOString(), cloudEncrypted });
    if (result.tokenHash !== tokenHash || !Number.isFinite(Date.parse(result.expiresAt))) throw new AppError('DB_RESPONSE_INVALID', '登录响应无效', 502);
    return { token, expiresAt: Date.parse(result.expiresAt), user: { id: result.owner, profile: { ...emptyProfile, ...result.profile, version: Number(result.profile.version) } } };
  }
  issue(grant: IdentityGrant) { return this.issueGrant(grant); }
  issueSession(grant: IdentityGrant) { return this.issueGrant(grant); }
  async login(provider: IdentityProvider, code: string) { return this.issueGrant(await provider.exchange(code)); }
  async authenticate(authorization?: string, budget?: RequestBudget): Promise<CloudContext & { expiresAt: number }> {
    const match = /^Bearer ([a-f0-9]{64})$/.exec(authorization || '');
    if (!match) throw new AppError('LOGIN_REQUIRED', '请先登录', 401);
    const tokenHash = hashBusinessToken(match[1]);
    const result = await this.db.call('sessionAuthenticate', null, null, { tokenHash }, budget);
    if (result.tokenHash !== tokenHash || !result.owner || !Number.isFinite(Date.parse(result.expiresAt))) throw new AppError('DB_RESPONSE_INVALID', '认证响应无效', 502);
    return { owner: result.owner, tokenHash, expiresAt: Date.parse(result.expiresAt) };
  }
  async assertLive(context: ModelContext): Promise<void> {
    const result = await this.db.call('sessionAuthenticate', null, null, { tokenHash: context.tokenHash });
    if (result.owner !== context.owner || result.tokenHash !== context.tokenHash) throw new AppError('LOGIN_REQUIRED', '登录已过期或退出，请重新登录', 401);
  }
  async revoke(value: string | ModelContext): Promise<void> {
    const context = typeof value === 'string'
      ? await this.db.call('sessionAuthenticate', null, null, { tokenHash: value }) : value;
    try { await this.db.call('sessionRevoke', context.owner, context.tokenHash, {}); }
    finally {
      for (const controller of this.operations.get(context.tokenHash) || []) controller.abort(new AppError('LOGIN_REQUIRED', '登录已退出，模型请求已取消', 401));
      this.operations.delete(context.tokenHash);
      this.options.cancel?.(context.tokenHash);
    }
  }
  revokeSession(context: string | ModelContext) { return this.revoke(context); }
  load(context: ModelContext) { return this.loadCloudSession(context); }
  save(context: ModelContext, value: CloudSession) { return this.saveCloudSession(context, value); }
  private unseal(context: ModelContext, row: { subject: string; encrypted: string | null }): CloudSession {
    if (!row.encrypted) throw new AppError('LOGIN_REQUIRED', '请通过微信重新登录以启用共享模型服务', 401);
    const key = this.key();
    try {
      const sealed = Buffer.from(row.encrypted, 'base64');
      if (sealed.length < 29 || sealed.toString('base64') !== row.encrypted) throw new Error('密文格式无效');
      const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12));
      decipher.setAAD(Buffer.from(`${row.subject}:${context.tokenHash}`));
      decipher.setAuthTag(sealed.subarray(12, 28));
      return sessionShape.parse(JSON.parse(Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]).toString('utf8')));
    } catch { throw new AppError('LOGIN_REQUIRED', '模型服务会话无法恢复，请重新登录', 401); }
  }
  async loadCloudSession(context: ModelContext): Promise<CloudSession> {
    return this.unseal(context, await this.db.call('cloudSessionLoad', context.owner, context.tokenHash, {}));
  }
  async saveCloudSession(context: ModelContext, value: CloudSession, expected?: CloudSession): Promise<void> {
    // 续期前读持久绑定：不同subject/scope不能替换当前业务会话的云身份。
    const row = await this.db.call('cloudSessionLoad', context.owner, context.tokenHash, {}), existing = this.unseal(context, row);
    if (existing.subject !== value.subject || existing.scope !== value.scope) throw new AppError('LOGIN_REQUIRED', '共享服务身份或绑定已变化，请重新登录', 401);
    if (expected && (existing.accessToken !== expected.accessToken || existing.refreshToken !== expected.refreshToken)) throw new AppError('MODEL_SESSION_CHANGED', 'AI登录已更新，请重试整理', 409);
    await this.db.call('cloudSessionSave', context.owner, context.tokenHash, { encrypted: this.seal(row.subject, context.tokenHash, value), expectedEncrypted: row.encrypted! });
  }
  async reauthorizeModel(context: ModelContext, grant: IdentityGrant, budget?: RequestBudget): Promise<void> {
    const row = await this.db.call('cloudSessionLoad', context.owner, context.tokenHash, {}, budget);
    if (typeof grant === 'string' || grant.subject !== row.subject || !grant.subject.startsWith('workbuddy:') || !grant.subject.endsWith(':' + sessionShape.parse(grant.cloudSession).subject)) {
      throw new AppError('MODEL_IDENTITY_CHANGED', '微信身份与当前账号不一致，请退出后重新登录', 409);
    }
    const existing = this.unseal(context, row);
    if (existing.scope !== grant.cloudSession.scope || grant.cloudSession.expiresAt <= Date.now()) throw new AppError('MODEL_IDENTITY_CHANGED', 'AI服务绑定已变化，请退出后重新登录', 409);
    // Fresh verified wx.login grant restores only this business session; SQL rechecks live owner/token.
    assertBudget(budget);
    await this.db.call('cloudSessionSave', context.owner, context.tokenHash, { encrypted: this.seal(row.subject, context.tokenHash, grant.cloudSession), expectedEncrypted: row.encrypted!, ...(budget ? { deadlineAt: new Date(budget.deadlineAt).toISOString() } : {}) }, budget);
  }
  async beginModelOperation(context: ModelContext) {
    // 先登记再检查，覆盖认证请求期间退出的竞争窗口。
    const controller = new AbortController(), active = this.operations.get(context.tokenHash) || new Set<AbortController>();
    active.add(controller); this.operations.set(context.tokenHash, active);
    const release = () => { active.delete(controller); if (!active.size && this.operations.get(context.tokenHash) === active) this.operations.delete(context.tokenHash); };
    try { await this.assertLive(context); if (controller.signal.aborted) throw controller.signal.reason; }
    catch (error) { release(); throw error; }
    return { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]), release };
  }
}
