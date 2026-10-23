import { createHash } from "node:crypto";
import { z } from "zod";
import { AppError } from "../lib/errors";
import { instruction, parseExtractionFields } from "../lib/extraction";
import { secureFetch } from "../lib/outbound";
import type { Extraction } from "../lib/types";
import type { IdentityProvider } from "./auth";
import { assertLive, beginModelOperation, loadCloudSession, saveCloudSession, type CloudSession, type ModelContext } from "./cloud-session";
import { parseRuntimeConfig, type RuntimeConfig, type RuntimeEnvironment } from "./config";

export function modelBackend(env: RuntimeEnvironment = process.env): "openai" | "workbuddy" {
  return parseRuntimeConfig(env, { identityInjected: true, serviceInjected: true }).modelProvider;
}
function configuration(runtime?: RuntimeConfig) {
  let config: RuntimeConfig;
  try { config = runtime || parseRuntimeConfig(); }
  catch { throw new AppError("AUTH_NOT_CONFIGURED", "共享模型服务尚未配置，请在申请新 AppID 后完成云端绑定", 503); }
  const endpoint = config.workbuddyEndpoint, publishableKey = config.workbuddyPublishableKey, appId = config.wechatAppId;
  if (config.modelProvider !== "workbuddy" || !endpoint || !publishableKey || !appId || !/^[a-f0-9]{64}$/i.test(config.workbuddySessionEncryptionKey)) {
    throw new AppError("AUTH_NOT_CONFIGURED", "共享模型服务尚未配置，请在申请新 AppID 后完成云端绑定", 503);
  }
  const scope = createHash("sha256").update(`${endpoint}:${publishableKey}:${appId}`).digest("hex");
  return { endpoint, publishableKey, appId, scope };
}
export function workbuddyEnabled(runtime?: RuntimeConfig) { try { configuration(runtime); return true; } catch { return false; } }
const sessionSchema = z.object({ sub: z.string().min(1).max(256), access_token: z.string().min(1).max(16000), refresh_token: z.string().max(16000).optional(), expires_in: z.number().int().positive().max(604800), is_anonymous: z.boolean().optional() });
function parseSession(raw: unknown, scope: string): CloudSession {
  const result = sessionSchema.safeParse(raw);
  if (!result.success || result.data.is_anonymous === true) throw new AppError("UPSTREAM_INVALID", "共享服务登录响应无效，请重新登录", 502);
  return { accessToken: result.data.access_token, refreshToken: result.data.refresh_token || "", expiresAt: Date.now() + result.data.expires_in * 1000, subject: result.data.sub, scope };
}
function headers(key: string, token?: string) { return { "Content-Type": "application/json", "x-wb-webapp-access-key": key, ...(token ? { Authorization: `Bearer ${token}` } : {}) }; }
// 云网关按微信小程序的 Referer 校验请求来源；后端代理调用必须显式带上，
// 否则 wx.login 的 code 会被判为"issued for another client"（401 invalid_grant）。
function refererHeaders(key: string, appId: string, token?: string) {
  return { ...headers(key, token), Referer: `https://servicewechat.com/${appId}/devtools/page-frame.html` };
}
async function upstreamError(response: Response, modelSession = false): Promise<never> {
  let invalidGrant = false;
  if (response.status === 400) {
    try { const value = await response.clone().json() as { error?: unknown }; invalidGrant = value.error === 'invalid_grant'; } catch {}
  }
  if (response.status === 401 || invalidGrant) throw new AppError(modelSession ? "MODEL_LOGIN_REQUIRED" : "LOGIN_REQUIRED", "AI 服务会话已失效，需要重新验证微信身份", modelSession ? 428 : 401);
  if (response.status === 403) throw new AppError(modelSession ? "MODEL_FORBIDDEN" : "AUTH_FORBIDDEN", "当前应用或账号没有共享模型权限，请联系管理员检查授权", 403);
  if (response.status === 429) throw new AppError("MODEL_QUOTA", "共享模型服务额度不足或请求过多，请稍后重试", 429);
  throw new AppError("UPSTREAM_FAILED", "共享模型服务暂不可用，原始输入已保留", 502);
}
async function jsonParameterUnsupported(response: Response): Promise<boolean> {
  if (![400, 422].includes(response.status)) return false;
  try {
    const raw = await response.text();
    if (raw.length > 16000) return false;
    const value = JSON.parse(raw);
    const error = value?.error;
    if (!error || typeof error !== "object") return false;
    const parameter = String(error.param || error.parameter || "");
    const code = String(error.code || "");
    const message = String(error.message || "");
    return (/^(?:response_format|json_object)$/.test(parameter) && /unsupported|not_supported/i.test(code)) ||
      (/response_format|json_object|json mode/i.test(message) && /unsupported|not supported|does not support|不支持/i.test(message));
  } catch { return false; }
}
async function json(response: Response, modelSession = false): Promise<unknown> {
  if (!response.ok) return upstreamError(response, modelSession);
  try { return await response.json(); } catch { throw new AppError("UPSTREAM_INVALID", "共享服务响应无效，请稍后重试", 502); }
}
export class WorkBuddyIdentityProvider implements IdentityProvider {
  constructor(private fetcher: typeof fetch = secureFetch, private runtime?: RuntimeConfig) {}
  async exchange(code: string, signal: AbortSignal = AbortSignal.timeout(15000)) {
    const config = configuration(this.runtime);
    const raw = await json(await this.fetcher(`${config.endpoint}/.cloud/auth/v1/login-wechat`, {
      method: "POST", headers: refererHeaders(config.publishableKey, config.appId), body: JSON.stringify({ code, appid: config.appId }), signal,
    }));
    const cloudSession = parseSession(raw, config.scope);
    return { subject: `workbuddy:${config.appId}:${cloudSession.subject}`, cloudSession };
  }
}
const modelSchema = z.object({ id: z.string().min(1).max(200), enabled: z.boolean().optional(), disabled: z.boolean().optional(), chat: z.boolean().optional(), supportsImages: z.boolean().optional(), disabledMultimodal: z.boolean().optional(), onlyReasoning: z.boolean().optional() });
export function parseSSE(raw: string): string {
  if (Buffer.byteLength(raw) > 512 * 1024) throw new AppError("UPSTREAM_INVALID", "共享模型响应过大", 502);
  let full = "", done = false, finished = false;
  for (const event of raw.replace(/\r\n/g, "\n").split(/\n\n+/)) {
    const data = event.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    if (!data) continue;
    if (done) throw new AppError("UPSTREAM_INVALID", "共享模型流结束后仍返回内容", 502);
    if (data.trim() === "[DONE]") { done = true; continue; }
    let value;
    try { value = JSON.parse(data); } catch { throw new AppError("UPSTREAM_INVALID", "共享模型流格式不正确", 502); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError("UPSTREAM_INVALID", "共享模型流格式不正确", 502);
    if (value.error) throw new AppError("UPSTREAM_INVALID", "共享模型生成失败，请稍后重试", 502);
    if (value.choices !== undefined && !Array.isArray(value.choices)) throw new AppError("UPSTREAM_INVALID", "共享模型候选格式不正确", 502);
    const choice = value.choices?.[0];
    if (choice?.finish_reason === "content_filter") throw new AppError("MODEL_REJECTED", "模型未能返回可用内容，请手工填写", 422);
    if (choice?.finish_reason && choice.finish_reason !== "stop") throw new AppError("UPSTREAM_INVALID", "共享模型结果不完整或受限，请手工填写", 502);
    if (choice?.finish_reason === "stop") finished = true;
    if (choice?.delta?.content !== undefined && choice.delta.content !== null) {
      if (typeof choice.delta.content !== "string") throw new AppError("UPSTREAM_INVALID", "共享模型内容格式无效", 502);
      full += choice.delta.content;
      if (full.length > 24000) throw new AppError("UPSTREAM_INVALID", "共享模型输出超过限制", 502);
    }
  }
  if (!done || !finished || !full.trim()) throw new AppError("UPSTREAM_INVALID", "共享模型响应未完整结束，请重试", 502);
  return full;
}
export function parseModelFields(raw: string): Extraction {
  let value;
  try { value = JSON.parse(raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim()); }
  catch { throw new AppError("UPSTREAM_INVALID", "智能整理结果格式不正确，请手工核对", 502); }
  return { fields: parseExtractionFields(value), mode: "model", warning: "已通过共享模型服务整理明确的图文信息，请人工核对；未知信息保持空白。" };
}
export interface SessionPersistence {
  loadCloudSession(context: ModelContext): CloudSession | Promise<CloudSession>;
  saveCloudSession(context: ModelContext, value: CloudSession, expected?: CloudSession): void | Promise<void>;
  assertLive(context: ModelContext): void | Promise<void>;
  beginModelOperation(context: ModelContext): { signal: AbortSignal; release(): void } | Promise<{ signal: AbortSignal; release(): void }>;
}
const localSessions: SessionPersistence = { loadCloudSession, saveCloudSession, assertLive, beginModelOperation };

export class WorkBuddyModelProvider {
  private refreshing = new Map<string, Promise<CloudSession>>();
  constructor(private fetcher: typeof fetch = secureFetch, private runtime?: RuntimeConfig, private sessions: SessionPersistence = localSessions) {}
  enabled() { return workbuddyEnabled(this.runtime); }
  private async session(context: ModelContext, signal: AbortSignal): Promise<CloudSession> {
    const config = configuration(this.runtime), existing = await this.sessions.loadCloudSession(context);
    if (existing.scope !== config.scope) throw new AppError("LOGIN_REQUIRED", "共享服务绑定已变化，请重新登录", 401);
    if (existing.expiresAt > Date.now() + 30000) return existing;
    if (!existing.refreshToken) throw new AppError("MODEL_LOGIN_REQUIRED", "AI 服务会话已失效，需要重新验证微信身份", 428);
    let pending = this.refreshing.get(context.tokenHash);
    if (!pending) {
      pending = (async () => {
        const raw = await json(await this.fetcher(`${config.endpoint}/.cloud/auth/v1/token`, { method: "POST", headers: refererHeaders(config.publishableKey, config.appId), body: JSON.stringify({ grant_type: "refresh_token", refresh_token: existing.refreshToken }), signal }), true);
        const renewed = parseSession(raw, config.scope);
        if (renewed.subject !== existing.subject) throw new AppError("LOGIN_REQUIRED", "共享服务身份已变化，请重新登录", 401);
        if (!renewed.refreshToken) renewed.refreshToken = existing.refreshToken;
        await this.sessions.assertLive(context); await this.sessions.saveCloudSession(context, renewed, existing);
        return renewed;
      })().finally(() => this.refreshing.delete(context.tokenHash));
      this.refreshing.set(context.tokenHash, pending);
    }
    return pending;
  }
  async extract(description: string, images: string[], context?: ModelContext): Promise<Extraction> {
    if (!context) throw new AppError("LOGIN_REQUIRED", "请通过微信登录后使用共享模型", 401);
    const operation = await this.sessions.beginModelOperation(context);
    try { return await this.run(description, images, context, operation.signal); }
    catch (error) {
      if (operation.signal.aborted) {
        if (operation.signal.reason instanceof AppError) throw operation.signal.reason;
        throw new AppError("UPSTREAM_TIMEOUT", "共享模型整理超时，请手工填写或稍后重试", 504);
      }
      throw error;
    } finally { operation.release(); }
  }
  private async run(description: string, images: string[], context: ModelContext, signal: AbortSignal): Promise<Extraction> {
    const config = configuration(this.runtime), cloud = await this.session(context, signal);
    const authHeaders = refererHeaders(config.publishableKey, config.appId, cloud.accessToken);
    await this.sessions.assertLive(context);
    const raw = await json(await this.fetcher(`${config.endpoint}/.cloud/llm/models`, { headers: authHeaders, signal }), true);
    const source = Array.isArray(raw) ? raw : (raw as { data?: unknown })?.data;
    if (!Array.isArray(source) || source.length > 1000) throw new AppError("UPSTREAM_INVALID", "模型目录格式无效", 502);
    let models = source.map(value => modelSchema.safeParse(value)).filter(value => value.success).map(value => value.data!).filter(model => model.id !== "auto" && model.enabled !== false && !model.disabled && model.chat !== false && (!images.length || (model.supportsImages === true && model.disabledMultimodal !== true)));
    const requested = this.runtime?.modelName || process.env.MODEL_NAME;
    if (requested) models = models.filter(model => model.id === requested);
    models.sort((a, b) => Number(a.onlyReasoning === true) - Number(b.onlyReasoning === true));
    if (!models.length) throw new AppError("NO_MODEL", images.length ? "共享服务没有可用图文模型，请手工填写" : "共享服务没有可用模型", 503);
    let last: unknown;
    for (const model of models.slice(0, 3)) {
      for (const jsonMode of [true, false]) {
        await this.sessions.assertLive(context);
        if (signal.aborted) throw new AppError("UPSTREAM_TIMEOUT", "共享模型整理超时，请手工填写或稍后重试", 504);
        try {
          const response = await this.fetcher(`${config.endpoint}/.cloud/llm/chat/completions`, {
            method: "POST", headers: { ...authHeaders, Accept: "text/event-stream" }, signal,
            body: JSON.stringify({ model: model.id, stream: true, max_tokens: 1500, ...(model.onlyReasoning ? {} : { temperature: 0 }), ...(jsonMode ? { response_format: { type: "json_object" } } : {}), messages: [
              { role: "system", content: instruction }, { role: "user", content: [{ type: "text", text: description || "仅提取照片标签中明确的信息" }, ...images.map(url => ({ type: "image_url", image_url: { url } }))] },
            ] }),
          });
          if (!response.ok) {
            if (jsonMode && await jsonParameterUnsupported(response)) throw new AppError("JSON_MODE_UNSUPPORTED", "当前模型不支持 JSON 参数，改用提示词整理", 502);
            await upstreamError(response, true);
          }
          if (!(response.headers.get("content-type") || "").includes("text/event-stream")) throw new AppError("UPSTREAM_INVALID", "共享模型未返回预期的流式结果", 502);
          const result = parseModelFields(parseSSE(await response.text()));
          await this.sessions.assertLive(context);
          return result;
        } catch (error) {
          last = error;
          if (!(error instanceof AppError) || !["UPSTREAM_INVALID", "JSON_MODE_UNSUPPORTED"].includes(error.code)) throw error;
        }
      }
    }
    throw last || new AppError("UPSTREAM_INVALID", "共享模型整理失败，请手工填写", 502);
  }
}
