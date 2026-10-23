import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Fastify, { type FastifyRequest } from "fastify";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import { ZodError, z } from "zod";
import { db, getProfile, saveProfile, setFavorite, recordDays } from "../lib/db";
import { AppError } from "../lib/errors";
import { productFields, ProductOrganizeQueue, applyProductOrganization } from "./product-organize";
import { authenticate, issueSession, revokeSession, reauthorizeModel, WechatIdentityProvider, type IdentityProvider } from "./auth";
import { MarketService, selectedModelProvider } from "./service";
import { WorkBuddyIdentityProvider } from "./workbuddy";
import { quotationExportMetadata } from "../lib/quotation-export";
import { createProjectSchema, favoriteSchema, deleteSchema, extractSchema, exportQuerySchema, exportPreviewQuerySchema, idParamsSchema, loginSchema, profileSchema, productPageQuerySchema, projectQuerySchema, saveProductSchema, uuid } from "./contracts";
import { parseRuntimeConfig, type RuntimeConfig } from "./config";
import { registerProcurementRoutes } from './procurement-routes';
import { CloudDatabase, type CloudContext } from './cloud-db';
import { CloudAuth } from './cloud-auth';
import { CloudRecords } from './cloud-records';
import { CloudProcurementStore, CloudTemplateStore } from './cloud-procurement';
import type { BlobStore } from './cloud-blobs';
import { CloudUploadBroker, UploadRegistry } from './workbook-upload';
import { CloudJobs } from './cloud-jobs';
import { ProcurementTemplateStore } from '../lib/procurement-template';
import { WORKBOOK_MAX_BYTES } from './cloud-tasks';
import { assertBudget, modelRecoveryBudget, withinBudget, type RequestBudget } from './request-budget';

/**
 * 直传票据与持久任务实例必须绑定当前会话的 owner/tokenHash，不能跨请求共享，
 * 所以依赖里注入的是"按会话构造"的工厂而不是实例；票据索引由 createApp 持有，
 * 便于用 uploadId 换回 objectKey（主控补 upload/get 后可改为直接查库）。
 */
export type CloudUploadBrokerFactory = (auth: CloudContext, registry: UploadRegistry) => CloudUploadBroker;
export type CloudJobsFactory = (auth: CloudContext, uploads: CloudUploadBroker) => CloudJobs;
export type CloudDependencies = {
  db: CloudDatabase;
  blobs: BlobStore;
  auth: CloudAuth;
  storageHealth?: () => boolean | Promise<boolean>;
  uploadBroker?: CloudUploadBrokerFactory;
  jobs?: CloudJobsFactory;
};

const uploadKindSchema = z.enum(["workbook", "photo"]);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/, "文件摘要无效");
const uploadPrepareSchema = z.strictObject({
  kind: uploadKindSchema,
  filename: z.string().min(1, "请选择文件").max(300),
  sizeBytes: z.number().int().positive("文件大小无效"),
  contentType: z.string().min(1).max(127),
  sha256: sha256Schema.optional(),
});
const uploadIdSchema = z.strictObject({ uploadId: uuid });
const uploadCommitSchema = z.strictObject({ uploadId: uuid, sha256: sha256Schema.optional() });
const jobParamsSchema = z.strictObject({ jobId: uuid });

// 小程序容器通道只能发文本且单次上限100KiB，照片因此按分片以base64提交。
// 前端按48KiB原始字节切片（base64约64KB），后端解码后仍按64KiB复核，留出协议余量。
const PHOTO_MAX_BYTES = 8 * 1024 * 1024;
const PHOTO_CHUNK_BYTES = 64 * 1024;
const PHOTO_CHUNK_TTL_MS = 5 * 60 * 1000;
const PHOTO_CHUNK_BODY_LIMIT = 96 * 1024;
const BASE64_TEXT = /^[A-Za-z0-9+/]+={0,2}$/;
const photoChunkSchema = z.strictObject({
  uploadId: uuid,
  index: z.number().int().min(0).max(399),
  total: z.number().int().min(1).max(400),
  name: z.string().max(200),
  data: z.string().min(1).max(90_000),
}).refine(value => value.index < value.total, "分片序号无效");
export type CloudReadinessResult = {
  status: "ready" | "not_ready";
  checks: {
    database: { ok: boolean; reason: string };
    storage: { ok: boolean; checked: boolean };
    authentication: { ok: boolean; required: boolean };
    model: { ok: boolean; provider: "openai" | "workbuddy" };
  };
};
export async function checkCloudReadiness(config: RuntimeConfig, cloud: CloudDependencies): Promise<CloudReadinessResult> {
  let database = false, storage = false, reason = "none";
  try { database = (await cloud.db.health()).healthy === true; }
  catch (error) {
    database = false;
    // 仅暴露错误类别与HTTP状态，绝不返回密钥、请求头、响应体或用户内容。
    const code = (error as { code?: unknown })?.code;
    reason = typeof code === "string" ? code : String((error as Error)?.name || "error");
  }
  if (cloud.storageHealth) { try { storage = await cloud.storageHealth(); } catch { storage = false; } }
  const authentication = !config.production || config.authReady;
  const model = !config.production || config.modelReady;
  return {
    status: database && storage && authentication && model ? "ready" : "not_ready",
    checks: { database: { ok: database, reason }, storage: { ok: storage, checked: Boolean(cloud.storageHealth) }, authentication: { ok: authentication, required: config.production }, model: { ok: model, provider: config.modelProvider } },
  };
}

export type ReadinessResult = {
  status: "ready" | "not_ready";
  checks: {
    database: { ok: boolean };
    dataDirectory: { ok: boolean };
    photoDirectory: { ok: boolean };
    procurementDirectory: { ok: boolean };
    templateDirectory: { ok: boolean };
    authentication: { ok: boolean; required: boolean };
    model: { ok: boolean; provider: "openai" | "workbuddy" };
  };
};

function writableDirectory(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const probe = join(path, `.ready-${process.pid}-${randomUUID()}`);
  try { writeFileSync(probe, "", { flag: "wx", mode: 0o600 }); }
  finally { try { unlinkSync(probe); } catch {} }
}

export function checkReadiness(config: RuntimeConfig): ReadinessResult {
  if (config.dataBackend === "cloudbase") throw new AppError("CLOUD_CONFIG", "云模式必须使用异步云就绪检查", 503);
  const checked = (work: () => void) => {
    try { work(); return true; } catch { return false; }
  };
  const database = checked(() => {
    const quick = db().prepare("PRAGMA quick_check").all() as { quick_check: string }[];
    if (!quick.length || quick.some(row => row.quick_check !== "ok")) throw new Error("quick_check");
    if ((db().prepare("PRAGMA foreign_key_check").all() as unknown[]).length) throw new Error("foreign_key_check");
  });
  const dataDirectory = checked(() => writableDirectory(config.appDataDir));
  const photoDirectory = checked(() => writableDirectory(join(config.appDataDir, "photos")));
  const procurementDirectory = checked(() => writableDirectory(join(config.appDataDir, "procurement")));
  const templateDirectory = checked(() => writableDirectory(join(config.appDataDir, "procurement-templates")));
  const authentication = !config.production || config.authReady;
  const model = !config.production || config.modelReady;
  const ok = database && dataDirectory && photoDirectory && procurementDirectory && templateDirectory && authentication && model;
  return {
    status: ok ? "ready" : "not_ready",
    checks: {
      database: { ok: database },
      dataDirectory: { ok: dataDirectory },
      photoDirectory: { ok: photoDirectory },
      procurementDirectory: { ok: procurementDirectory },
      templateDirectory: { ok: templateDirectory },
      authentication: { ok: authentication, required: config.production },
      model: { ok: model, provider: config.modelProvider },
    },
  };
}

export async function createApp(options: {
  identity?: IdentityProvider;
  service?: MarketService;
  logger?: boolean;
  config?: RuntimeConfig;
  cloud?: CloudDependencies;
} = {}) {
  const config = options.config || parseRuntimeConfig(process.env, {
    identityInjected: options.identity !== undefined,
    serviceInjected: options.service !== undefined,
  });
  const cloud = config.dataBackend === "cloudbase" ? options.cloud : undefined;
  if (config.dataBackend === "cloudbase" && !cloud) throw new AppError("CLOUD_CONFIG", "云数据依赖未配置，不能回退本机数据库", 503);
  if (options.cloud && config.dataBackend !== "cloudbase") throw new AppError("CLOUD_CONFIG", "注入云依赖必须显式启用 DATA_BACKEND=cloudbase", 503);
  const app = Fastify({
    logger: options.logger === true ? { redact: { paths: ['req.headers', 'headers', '*.authorization', '*.cookie', '*.token', '*.accessToken', '*.refreshToken', '*.cloudbaseApiKey', '*.wechatAppSecret', '*.workbuddySessionEncryptionKey'], remove: true } } : false,
    bodyLimit: 64 * 1024,
    requestTimeout: 60000,
    connectionTimeout: 10000,
    trustProxy: config.trustedProxyHops as never,
  });
  const identity = options.identity || (config.modelProvider === "workbuddy"
    ? new WorkBuddyIdentityProvider(undefined, config)
    : new WechatIdentityProvider(config.wechatAppId, config.wechatAppSecret));
  const model = options.service?.model || selectedModelProvider(config, cloud?.auth);
  const service = cloud ? undefined : options.service || new MarketService(undefined, model);
  const contexts = new WeakMap<FastifyRequest, CloudContext & { expiresAt: number }>();
  const services = new WeakMap<FastifyRequest, MarketService>();
  const session = (req: FastifyRequest) => {
    const context = contexts.get(req);
    if (!context) throw new AppError("LOGIN_REQUIRED", "请先登录", 401);
    return context;
  };
  const scopedService = (req: FastifyRequest) => {
    if (service) return service;
    let scoped = services.get(req);
    if (!scoped) {
      scoped = new MarketService(new CloudRecords(cloud!.db, cloud!.blobs, session(req)), model);
      services.set(req, scoped);
    }
    return scoped;
  };
  const activeUploads = new Set<string>();
  const activeExtracts = new Set<string>();
  const organizeQueue = new ProductOrganizeQueue();
  const activeExports = new Set<string>();
  // 分片暂存只存内存（不落盘）：单实例内按 owner+uploadId 隔离，5分钟未收齐即过期。
  // 暂存键含 owner，另用 uploadId→owner 索引显式拒绝跨账号复用同一 uploadId。
  type StagedPhoto = { owner: string; uploadId: string; total: number; name: string; chunks: Map<number, Buffer>; bytes: number; updatedAt: number };
  const stagedPhotos = new Map<string, StagedPhoto>();
  const stagedPhotoOwners = new Map<string, string>();
  const stagedPhotoKey = (owner: string, uploadId: string) => `${owner}\u0000${uploadId}`;
  const sweepStagedPhotos = (now: number) => {
    for (const [key, staged] of stagedPhotos) {
      if (now - staged.updatedAt < PHOTO_CHUNK_TTL_MS) continue;
      stagedPhotos.delete(key);
      if (stagedPhotoOwners.get(staged.uploadId) === staged.owner) stagedPhotoOwners.delete(staged.uploadId);
    }
  };
  const dropStagedPhoto = (staged: StagedPhoto) => {
    stagedPhotos.delete(stagedPhotoKey(staged.owner, staged.uploadId));
    if (stagedPhotoOwners.get(staged.uploadId) === staged.owner) stagedPhotoOwners.delete(staged.uploadId);
  };
  // 只认 JPEG/PNG 魔数：前端压缩产物固定为 jpg，重编码前的原始格式也必须可辨识。
  const photoMime = (bytes: Buffer) => {
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
    if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
    return null;
  };
  const authenticatedRateKey = (req: FastifyRequest) => {
    const auth = contexts.get(req);
    return auth ? `session:${auth.owner}:${auth.tokenHash}` : `ip:${req.ip}`;
  };
  const ownerRateKey = authenticatedRateKey;
  // 生产云模式缺直传或任务依赖即启动失败，绝不静默退回本机存储或小文件同步链路。
  if (cloud && config.production && (!cloud.uploadBroker || !cloud.jobs)) throw new AppError("CLOUD_CONFIG", "云直传与持久任务依赖未注入，不能启动云模式", 503);
  // 上传票据索引按应用持有：prepare 与 commit/导入分属不同请求，必须能凭 uploadId 取回对象键。
  const uploadRegistry = new UploadRegistry(2048);
  const brokers = new WeakMap<FastifyRequest, CloudUploadBroker>();
  const jobBrokers = new WeakMap<FastifyRequest, CloudJobs>();
  const scopedUploads = (req: FastifyRequest) => {
    if (!cloud?.uploadBroker) throw new AppError("CLOUD_CONFIG", "云直传依赖未注入，请改用本机模式或补齐云端配置", 503);
    let value = brokers.get(req);
    if (!value) { value = cloud.uploadBroker(session(req), uploadRegistry); brokers.set(req, value); }
    return value;
  };
  const scopedJobs = (req: FastifyRequest) => {
    if (!cloud?.jobs) throw new AppError("CLOUD_CONFIG", "持久任务依赖未注入，请改用本机模式或补齐云端配置", 503);
    let value = jobBrokers.get(req);
    if (!value) { value = cloud.jobs(session(req), scopedUploads(req)); jobBrokers.set(req, value); }
    return value;
  };
  // multipart 与分片两条入口共用同一段落库/存储逻辑，避免维护第二套保存路径。
  const savePhoto = (req: FastifyRequest, owner: string, filename: string, mimetype: string, bytes: Buffer) =>
    scopedService(req).upload(owner, new File([new Uint8Array(bytes)], filename, { type: mimetype }));
  // 同一账号同时只处理一张照片，且全局最多2张；分片请求只在收齐落库时占用名额。
  const withPhotoUpload = async <T>(owner: string, work: () => Promise<T>) => {
    if (activeUploads.has(owner) || activeUploads.size >= 2) throw new AppError("BUSY", "照片正在处理，请稍后重试", 429);
    activeUploads.add(owner);
    try { return await work(); } finally { activeUploads.delete(owner); }
  };
  // 根级鉴权钩子先于限流插件；公开登录按可信代理配置取得的 IP 限流。
  const recoveryBudgets = new WeakMap<FastifyRequest, RequestBudget>();
  app.addHook("onRequest", async req => {
    const path = req.routeOptions.url;
    if (["/livez", "/health", "/readyz", "/api/config", "/api/auth/wechat", "/api/auth/dev"].includes(path || "")) return;
    if (!path) return;
    const budget = path === '/api/auth/model-session' ? modelRecoveryBudget() : undefined;
    if (budget) recoveryBudgets.set(req, budget);
    contexts.set(req, cloud ? await cloud.auth.authenticate(req.headers.authorization, budget) : await authenticate(req.headers.authorization));
  });

  await app.register(multipart, { limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 0, parts: 1 } });
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute", keyGenerator: authenticatedRateKey });
  app.addHook("onSend", async (req, reply) => {
    reply
      .header("X-Request-ID", req.id)
      .header("X-Content-Type-Options", "nosniff")
      .header("X-Frame-Options", "DENY")
      .header("Referrer-Policy", "no-referrer")
      .header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
      .header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
      .header("Cache-Control", "no-store");
    if (config.production) reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  });
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof AppError) return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
    if (error instanceof ZodError) return reply.code(400).send({ error: { code: "VALIDATION", message: error.issues[0]?.message || "请求格式不正确" } });
    const value = error as { code?: string; statusCode?: number };
    if (value.statusCode && value.statusCode < 500) return reply.code(value.statusCode).send({ error: { code: value.code || "BAD_REQUEST", message: value.statusCode === 429 ? "操作过于频繁，请稍后再试" : value.statusCode === 413 ? "上传文件或请求过大" : "请求格式不正确" } });
    req.log.error({ code: value.code || "INTERNAL", requestId: req.id }, "request failed");
    return reply.code(500).send({ error: { code: "INTERNAL", message: "服务暂不可用，输入已保留，请稍后重试" } });
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: { code: "NOT_FOUND", message: "接口不存在" } }));

  const live = async () => ({ status: "ok" });
  app.get("/livez", { config: { rateLimit: false } }, live);
  app.get("/health", { config: { rateLimit: false } }, live);
  app.get("/readyz", { config: { rateLimit: false } }, async (_req, reply) => {
    const result = cloud ? await checkCloudReadiness(config, cloud) : checkReadiness(config);
    return reply.code(result.status === "ready" ? 200 : 503).send(result);
  });
  app.get("/api/config", async () => ({ modelEnabled: model.enabled(), maxPhotos: 6, auth: "wechat", devLoginEnabled: config.allowDevLogin }));

  const loginRateLimit = { max: 10, timeWindow: "1 minute", groupId: "login", keyGenerator: (req: FastifyRequest) => `login:${config.wechatAppId || "unconfigured"}:${req.ip}` };
  app.post("/api/auth/wechat", { config: { rateLimit: loginRateLimit } }, async req => {
    const { code } = loginSchema.parse(req.body);
    const grant = await identity.exchange(code);
    return cloud ? await cloud.auth.issueSession(grant) : issueSession(grant);
  });
  app.post("/api/auth/dev", { config: { rateLimit: loginRateLimit } }, async req => {
    if (!config.allowDevLogin || !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.ip)) throw new AppError("NOT_FOUND", "接口不存在", 404);
    z.strictObject({}).parse(req.body || {});
    return cloud ? await cloud.auth.issueSession("__development__") : issueSession("__development__");
  });

  await app.register(async secured => {
    secured.post('/api/auth/model-session', { config: { rateLimit: { max: 6, timeWindow: '1 minute', groupId: 'model-session', keyGenerator: ownerRateKey } } }, async req => {
      if (config.modelProvider !== 'workbuddy') throw new AppError('NOT_FOUND', '接口不存在', 404);
      const context = session(req), { code } = loginSchema.parse(req.body);
      const budget = recoveryBudgets.get(req)!;
      let grant;
      try { grant = await withinBudget(() => identity instanceof WorkBuddyIdentityProvider ? identity.exchange(code, AbortSignal.any([budget.signal, AbortSignal.timeout(8000)])) : identity.exchange(code), budget); }
      catch (error) {
        assertBudget(budget);
        if (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)) throw new AppError('MODEL_RECOVERY_TIMEOUT', 'AI验证超时，输入已保留，请稍后重新整理', 504);
        if (error instanceof AppError && error.code === 'LOGIN_REQUIRED') throw new AppError('MODEL_LOGIN_REQUIRED', '微信验证未完成，请重试AI整理或重新登录', 428);
        throw error;
      }
      assertBudget(budget);
      if (cloud) await cloud.auth.reauthorizeModel(context, grant, budget);
      else reauthorizeModel(context, grant);
      return { restored: true };
    });
    await registerProcurementRoutes(secured, config.appDataDir, scopedService, {
      session,
      cloudFactory: cloud ? req => ({ store: new CloudProcurementStore(cloud.db, cloud.blobs, session(req)), templates: new CloudTemplateStore(cloud.db, session(req)) }) : undefined,
      uploads: cloud?.uploadBroker ? req => ({
        // 只认本账号自己的票据；跨账号的 uploadId 一律当不存在。
        objectKeyOf: async (owner, uploadId) => (await scopedUploads(req).ticket(owner, uploadId)).objectKey,
        requireCommitted: (owner, objectKey) => scopedUploads(req).committed(owner, objectKey),
        read: async (owner, objectKey) => {
          await scopedUploads(req).committed(owner, objectKey);
          const bytes = await cloud!.blobs.read(objectKey);
          // 已提交对象仍可能是超大文件：进入解析前按同一上限复核一次。
          if (bytes.length > WORKBOOK_MAX_BYTES) throw new AppError("WORKBOOK_LIMIT", "Excel不能超过40MB", 413);
          return bytes;
        },
      }) : undefined,
      jobs: cloud?.jobs ? req => scopedJobs(req) : undefined,
    });
    // 对象直传与持久任务只在云模式注册；本机模式没有对象存储与任务表。
    const uploadRateLimit = { max: 30, timeWindow: "1 minute", groupId: "upload-session", keyGenerator: ownerRateKey };
    const jobRateLimit = { max: 60, timeWindow: "1 minute", groupId: "jobs", keyGenerator: ownerRateKey };
    if (cloud) {
      // 三步直传：登记并签发短期 PUT，字节直达对象存储，不经网关20MB/60秒入口。
      secured.post("/api/uploads/prepare", { config: { rateLimit: uploadRateLimit } }, async req => {
        const grant = await scopedUploads(req).prepare(session(req).owner, uploadPrepareSchema.parse(req.body));
        // 只回传客户端直传所需字段：对象键与签名细节不进响应体，也不进日志。
        return { uploadId: grant.uploadId, method: grant.method, uploadUrl: grant.uploadUrl, headers: grant.headers, expiresAt: grant.expiresAt };
      });
      // commit 的大小一律以登记值/对象实际元信息为准，不接受客户端自报大小。
      secured.post("/api/uploads/commit", { config: { rateLimit: uploadRateLimit } }, async req => {
        const auth = session(req), body = uploadCommitSchema.parse(req.body);
        const ticket = await scopedUploads(req).ticket(auth.owner, body.uploadId);
        const commit = await scopedUploads(req).commit(auth.owner, body.uploadId, ticket.sizeBytes, body.sha256 ?? null);
        return { objectKey: commit.objectKey };
      });
      secured.post("/api/uploads/abandon", { config: { rateLimit: uploadRateLimit } }, async req => {
        const { uploadId } = uploadIdSchema.parse(req.body);
        await scopedUploads(req).abandon(session(req).owner, uploadId);
        return { abandoned: true };
      });
      // 任务视图只含任务号与结果引用，不暴露对象路径；下载在成功后才签发短期地址。
      secured.get("/api/jobs/:jobId", { config: { rateLimit: jobRateLimit } }, async req => {
        const { jobId } = jobParamsSchema.parse(req.params);
        return scopedJobs(req).get(session(req).owner, jobId);
      });
      secured.get("/api/jobs/:jobId/download", { config: { rateLimit: { max: 20, timeWindow: "1 minute", groupId: "job-download", keyGenerator: ownerRateKey } } }, async req => {
        const { jobId } = jobParamsSchema.parse(req.params);
        return scopedJobs(req).download(session(req).owner, jobId);
      });
    }
    if (cloud) {
      secured.post('/api/export-jobs', { config: { rateLimit: { max: 5, timeWindow: '1 minute', groupId: 'export', keyGenerator: ownerRateKey } } }, async (req, reply) => {
        const { projectId, date, dateFrom, dateTo, supplier, scope, images, favorite, audience } = exportQuerySchema.parse(req.body), owner = session(req).owner;
        if (activeExports.has(owner) || activeExports.size >= 2) throw new AppError('BUSY', '导出正在进行，请稍后再试', 429);
        activeExports.add(owner);
        try {
          const service = scopedService(req);
          if (dateFrom && !(await new CloudRecords(cloud.db, cloud.blobs, session(req)).capabilities(owner)).dateRangeExport) throw new AppError('DATE_RANGE_UNSUPPORTED', '当前服务暂不支持跨日期导出，请更新服务后重试', 409);
          const job = await scopedJobs(req).startProductExport(owner, { projectId, date, dateFrom, dateTo, supplier, scope, images: images === 'yes', favorite: favorite === 'yes', audience }, async () => {
            return (await service.export(owner, projectId, { supplier, scope, images: images === 'yes', date, dateFrom, dateTo, favorite: favorite === 'yes', audience, template: await new CloudTemplateStore(cloud.db, session(req)).read(owner) })).bytes;
          }, () => { activeExports.delete(owner); });
          return reply.code(202).send({ jobId: job.jobId, state: job.state });
        } catch (error) { activeExports.delete(owner); throw error; }
      });
      // 文件独立分段读取，每次二进制响应有上限，可由容器通道下载完整Excel。
      type CachedExport = { owner: string; bytes: Buffer; expiresAt: number };
      const exports = new Map<string, CachedExport>();
      secured.get('/api/jobs/:jobId/file', { config: { rateLimit: { max: 60, timeWindow: '1 minute', groupId: 'export-file', keyGenerator: ownerRateKey } } }, async (req, reply) => {
        const { jobId } = jobParamsSchema.parse(req.params), owner = session(req).owner;
        const query = z.strictObject({ offset: z.coerce.number().int().min(0).optional() }).parse(req.query);
        const jobs = scopedJobs(req), job = await jobs.get(owner, jobId);
        if (!['product-export', 'workbook-export'].includes(job.kind) || job.state !== 'succeeded') throw new AppError('NOT_FOUND', '文件尚未生成或不可访问', 404);
        const now = Date.now(), key = owner + ':' + jobId;
        for (const [id, value] of exports) if (value.expiresAt <= now) exports.delete(id);
        let cached = exports.get(key);
        if (!cached) {
          const bytes = await jobs.downloadFile(owner, jobId);
          if (bytes.length > 80 * 1024 * 1024) throw new AppError('EXPORT_LIMIT', '导出文件超过80MB，请减少带图商品数量', 413);
          cached = { owner, bytes, expiresAt: now + 120000 };
          if (exports.size < 2) exports.set(key, cached);
        }
        if (query.offset === undefined) return { size: cached.bytes.length, chunkSize: 4 * 1024 * 1024 };
        if (query.offset >= cached.bytes.length) throw new AppError('VALIDATION', '文件读取位置无效', 400);
        return reply.type('application/octet-stream').send(cached.bytes.subarray(query.offset, query.offset + 4 * 1024 * 1024));
      });
    }
    const profile = (req: FastifyRequest) => cloud ? new CloudRecords(cloud.db, cloud.blobs, session(req)).getProfile(session(req).owner) : getProfile(session(req).owner);
    secured.get("/api/auth/me", async req => { const auth = session(req); return { user: { id: auth.owner, profile: await profile(req) }, expiresAt: auth.expiresAt }; });
    secured.post('/api/profile/avatar', { bodyLimit: 96 * 1024, config: { rateLimit: { max: 10, timeWindow: '1 minute', keyGenerator: ownerRateKey } } }, async req => {
      const { image } = z.strictObject({ image: z.string().min(1).max(65536).regex(/^[A-Za-z0-9+/]+={0,2}$/) }).parse(req.body);
      const bytes = Buffer.from(image, 'base64');
      if (!bytes.length || bytes.toString('base64') !== image) throw new AppError('INVALID_AVATAR', '头像文件无效，请重新选择', 400);
      try {
        const decoder = sharp(bytes, { limitInputPixels: 4 * 1024 * 1024 });
        const meta = await decoder.metadata();
        if (!['jpeg', 'png', 'webp'].includes(meta.format || '') || (meta.pages || 1) > 1) throw new Error('Invalid format');
        const jpeg = await decoder.rotate().resize(96, 96, { fit: 'cover' }).flatten({ background: '#f1f2f4' }).jpeg({ quality: 75 }).toBuffer();
        const avatar = 'data:image/jpeg;base64,' + jpeg.toString('base64');
        if (avatar.length > 32768) throw new Error('Size');
        return { avatar };
      } catch { throw new AppError('INVALID_AVATAR', '头像文件无法读取，请重新选择', 400); }
    });
    secured.post("/api/profile", async req => {
      const { version, ...fields } = profileSchema.parse(req.body);
      return cloud ? await new CloudRecords(cloud.db, cloud.blobs, session(req)).saveProfile(session(req).owner, fields, version) : saveProfile(session(req).owner, fields, version);
    });
    secured.post("/api/auth/logout", async req => { if (cloud) await cloud.auth.revokeSession(session(req)); else revokeSession(session(req).tokenHash); return { loggedOut: true }; });
    secured.get("/api/projects", async req => scopedService(req).records.listProjects(session(req).owner));
    secured.get("/api/projects/:id/summary", async req => {
      const projectId=idParamsSchema.parse(req.params).id;
      const {date,dateFrom,dateTo,supplier,favorite}=productPageQuerySchema.parse({...req.query as object,projectId});
      return scopedService(req).records.projectSummary(session(req).owner,projectId,{date,dateFrom,dateTo,supplier,favorite:favorite==='yes'});
    });
    secured.post("/api/projects", async (req, reply) => {
      const { requestKey, ...fields } = createProjectSchema.parse(req.body);
      return reply.code(201).send(await scopedService(req).records.createProject(session(req).owner, fields, requestKey));
    });
    secured.get('/api/capabilities', async req => cloud ? new CloudRecords(cloud.db, cloud.blobs, session(req)).capabilities(session(req).owner) : { dateRangeExport: true });
    secured.get('/api/record-days', async req => cloud ? await new CloudRecords(cloud.db, cloud.blobs, session(req)).recordDays(session(req).owner) : recordDays(session(req).owner));
    secured.post('/api/products/:id/favorite', async req => { const { favorite, version } = favoriteSchema.parse(req.body); return cloud ? await new CloudRecords(cloud.db, cloud.blobs, session(req)).setFavorite(session(req).owner, idParamsSchema.parse(req.params).id, favorite, version) : setFavorite(session(req).owner, idParamsSchema.parse(req.params).id, favorite, version); });
    secured.get("/api/products", async req => {
      const { projectId, date, dateFrom, dateTo, supplier, cursor, limit, q, status, favorite } = productPageQuerySchema.parse(req.query);
      return scopedService(req).records.pageProducts(session(req).owner, projectId, cursor, limit, { q, status, date, dateFrom, dateTo, supplier, favorite: favorite === "yes" });
    });
    secured.get("/api/products/:id", async req => scopedService(req).records.getProduct(session(req).owner, idParamsSchema.parse(req.params).id));
    secured.get('/api/trash',async req=>{const query=z.strictObject({cursor:z.string().max(128).optional(),limit:z.coerce.number().int().min(1).max(100).default(30),q:z.string().trim().max(200).default('')}).parse(req.query);return scopedService(req).records.pageTrash(session(req).owner,query.cursor,query.limit,query.q);});
    secured.post('/api/products/:id/trash',async req=>scopedService(req).records.trashProduct(session(req).owner,idParamsSchema.parse(req.params).id,deleteSchema.parse(req.body).version));
    secured.post('/api/products/:id/restore',async req=>scopedService(req).records.trashProduct(session(req).owner,idParamsSchema.parse(req.params).id,deleteSchema.parse(req.body).version,true));
    secured.post("/api/products", async (req, reply) => reply.code(201).send(await scopedService(req).records.saveProduct(session(req).owner, saveProductSchema.parse(req.body))));
    secured.post('/api/products/:id/organize', {config:{rateLimit:{max:20,timeWindow:'1 minute',groupId:'organize-product',keyGenerator:ownerRateKey}}}, async (req,reply) => {
      const {id}=idParamsSchema.parse(req.params), {version}=deleteSchema.parse(req.body), context=session(req), owner=context.owner, service=scopedService(req);
      let product=await service.records.getProduct(owner,id);
      if(product.deletedAt)throw new AppError('PRODUCT_TRASHED','商品在回收站，请先恢复',409);
      if(product.organizeState==='queued' && product.organizeJobId && cloud) {
        try {
          const prior=await scopedJobs(req).get(owner,product.organizeJobId);
          if(['pending','running'].includes(prior.state)) return reply.code(202).send({product,jobId:prior.jobId,state:prior.state});
        } catch(error) { if(!(error instanceof AppError) || error.code!=='NOT_FOUND') throw error; }
      }
      if(product.version!==version) throw new AppError('CONFLICT','商品已更新，请重新打开后整理',409);
      if(!product.description.trim() && !product.photos.length) throw new AppError('VALIDATION','添加照片或现场描述后再整理',400);
      const release=organizeQueue.reserve(owner), jobId=randomUUID();
      try {
        const fields=Object.assign(productFields(product),{organizeState:'queued',organizeJobId:jobId});
        product=await service.records.saveProduct(owner,{requestKey:randomUUID(),id,projectId:product.projectId,version:product.version,fields,photoIds:product.photos.map(p=>p.id)});
        const snapshot=product;
        const run=async (checkpoint:()=>Promise<void>)=>organizeQueue.run(owner,async()=>{
          try { await checkpoint();return await applyProductOrganization(service,owner,snapshot,context,checkpoint); }
          catch(error){
            try {
              const latest=await service.records.getProduct(owner,id);
              if(latest.version===snapshot.version && latest.organizeJobId===jobId) {
                const fields=Object.assign(productFields(latest),{organizeState:'failed',organizeJobId:jobId,organizeError:error instanceof AppError?error.message:'整理失败，可稍后重试'});
                await service.records.saveProduct(owner,{requestKey:randomUUID(),id,projectId:latest.projectId,version:latest.version,fields,photoIds:latest.photos.map(p=>p.id)});
              }
            } catch { /* Data remains saved; durable job failure is the authoritative status. */ }
            throw error;
          }
        });
        if(!cloud) { await run(async()=>{});release();return{product:await service.records.getProduct(owner,id),jobId:null,state:'succeeded'}; }
        const job=await scopedJobs(req).startExtraction(owner,{description:product.description,photoIds:product.photos.map(p=>p.id)},run,release,jobId);
        return reply.code(202).send({product,jobId:job.jobId,state:job.state});
      } catch(error) {
        release();
        // Submission itself can fail after the original product and queued marker were saved.
        try {
          const latest=await service.records.getProduct(owner,id);
          if(latest.version===product.version && latest.organizeJobId===jobId && latest.organizeState==='queued') {
            const fields=Object.assign(productFields(latest),{organizeState:'failed',organizeJobId:jobId,organizeError:'后台整理未启动，商品已保存，可重试'});
            await service.records.saveProduct(owner,{requestKey:randomUUID(),id,projectId:latest.projectId,version:latest.version,fields,photoIds:latest.photos.map(p=>p.id)});
          }
        } catch { /* Never replace the original failure or discard the saved record. */ }
        throw error;
      }
    });
    secured.delete("/api/products/:id", async req => scopedService(req).records.deleteProduct(session(req).owner, idParamsSchema.parse(req.params).id, deleteSchema.parse(req.body).version));
    secured.post("/api/photos", { config: { rateLimit: { max: 20, timeWindow: "1 minute", groupId: "upload", keyGenerator: ownerRateKey } } }, async (req, reply) => {
      const owner = session(req).owner;
      return withPhotoUpload(owner, async () => {
        const file = await req.file();
        if (!file || file.fieldname !== "photo") throw new AppError("INVALID_PHOTO", "请选择一张照片");
        const bytes = await file.toBuffer();
        if (file.file.truncated) throw new AppError("INVALID_PHOTO", "每张照片不能超过8MB", 413);
        return reply.code(201).send(await savePhoto(req, owner, file.filename, file.mimetype, bytes));
      });
    });
    // 容器通道只能发文本：分片以base64提交，按index顺序拼接后走与 /api/photos 相同的保存逻辑。
    secured.post("/api/photos/chunks", {
      bodyLimit: PHOTO_CHUNK_BODY_LIMIT,
      config: { rateLimit: { max: 400, timeWindow: "1 minute", groupId: "photo-chunks", keyGenerator: ownerRateKey } },
    }, async (req, reply) => {
      const owner = session(req).owner, body = photoChunkSchema.parse(req.body), now = Date.now();
      sweepStagedPhotos(now);
      const knownOwner = stagedPhotoOwners.get(body.uploadId);
      if (knownOwner && knownOwner !== owner) throw new AppError("UPLOAD_NOT_FOUND", "上传凭证不存在，请重新上传", 404);
      if (!BASE64_TEXT.test(body.data) || body.data.length % 4 !== 0) throw new AppError("INVALID_CHUNK", "照片分片数据无效", 400);
      const chunk = Buffer.from(body.data, "base64");
      if (!chunk.length || chunk.length > PHOTO_CHUNK_BYTES) throw new AppError("INVALID_CHUNK", "照片分片过大，请重新上传", 413);
      let staged = stagedPhotos.get(stagedPhotoKey(owner, body.uploadId));
      if (staged && (staged.total !== body.total || staged.name !== body.name)) throw new AppError("CHUNK_CONFLICT", "分片参数不一致，请重新上传", 409);
      if (!staged) {
        staged = { owner, uploadId: body.uploadId, total: body.total, name: body.name, chunks: new Map(), bytes: 0, updatedAt: now };
        stagedPhotos.set(stagedPhotoKey(owner, body.uploadId), staged);
        stagedPhotoOwners.set(body.uploadId, owner);
      }
      const previous = staged.chunks.get(body.index);
      // 累计超过8MB立即拒绝并清空暂存，避免内存被异常客户端占满。
      if (staged.bytes - (previous ? previous.length : 0) + chunk.length > PHOTO_MAX_BYTES) {
        dropStagedPhoto(staged);
        throw new AppError("PHOTO_TOO_LARGE", "照片不能超过 8MB", 413);
      }
      staged.bytes += chunk.length - (previous ? previous.length : 0);
      staged.chunks.set(body.index, chunk);
      staged.updatedAt = now;
      if (staged.chunks.size < staged.total) return reply.code(202).send({ received: staged.chunks.size, total: staged.total, complete: false });
      const parts: Buffer[] = [];
      for (let index = 0; index < staged.total; index++) {
        const part = staged.chunks.get(index);
        if (!part) return reply.code(202).send({ received: staged.chunks.size, total: staged.total, complete: false });
        parts.push(part);
      }
      const bytes = Buffer.concat(parts), mimetype = photoMime(bytes);
      // 无论成功还是拒绝，暂存立即释放；失败时客户端需重新上传全部分片。
      dropStagedPhoto(staged);
      if (!mimetype) throw new AppError("INVALID_PHOTO", "请选择 JPG 或 PNG 照片", 415);
      // 名称沿用客户端文件名，长度已在契约层限制，保存前再截断以兼容空名。
      const name = staged.name.trim() || "photo.jpg";
      return withPhotoUpload(owner, async () => reply.code(201).send(await savePhoto(req, owner, name, mimetype, bytes)));
    });
    secured.get("/api/photos/:id", async (req, reply) => reply.type("image/jpeg").send(await scopedService(req).records.readPhoto(session(req).owner, idParamsSchema.parse(req.params).id)));
    secured.get('/api/photos/:id/thumbnail', async (req,reply) => {
      const bytes=await scopedService(req).records.readPhoto(session(req).owner,idParamsSchema.parse(req.params).id);
      const thumbnail=await sharp(bytes).resize({width:480,height:480,fit:'inside',withoutEnlargement:true}).jpeg({quality:70}).toBuffer();
      return reply.header('Cache-Control','private, max-age=3600').type('image/jpeg').send(thumbnail);
    });
    // 容器通道单次请求硬上限15秒，而模型超时是30秒：云模式一律转持久任务，请求只回任务号，
    // 客户端用 GET /api/jobs/:jobId 轮询结果。本机模式没有容器上限也没有任务表，保留同步语义。
    secured.post("/api/extract", { config: { rateLimit: { max: 10, timeWindow: "1 minute", groupId: "extract", keyGenerator: ownerRateKey } } }, async (req, reply) => {
      const { description, photoIds } = extractSchema.parse(req.body), owner = session(req).owner;
      if (!cloud) return scopedService(req).extract(owner, description, photoIds, session(req));
      if (activeExtracts.has(owner) || activeExtracts.size >= 4) throw new AppError("BUSY", "整理正在进行，请稍后再试", 429);
      activeExtracts.add(owner);
      try {
        const service = scopedService(req), context = session(req);
        const job = await scopedJobs(req).startExtraction(owner, { description, photoIds }, async () => {
          return service.extract(owner, description, photoIds, context);
        }, () => { activeExtracts.delete(owner); });
        return reply.code(202).send({ jobId: job.jobId, state: job.state });
      } catch (error) { activeExtracts.delete(owner); throw error; }
    });
    secured.get('/api/merchant-visits', async req => {
      const {date}=z.strictObject({date:productPageQuerySchema.shape.date.unwrap()}).parse(req.query);
      return scopedService(req).records.listMerchantVisits(session(req).owner,date);
    });
    secured.get('/api/merchants', async req => {
      const { projectId, date, dateFrom, dateTo, favorite } = productPageQuerySchema.parse(req.query);
      return scopedService(req).records.listMerchants(session(req).owner,projectId,date,favorite==='yes',{dateFrom,dateTo});
    });
    secured.get("/api/suppliers", async req => scopedService(req).suppliers(session(req).owner, projectQuerySchema.parse(req.query).projectId));
    secured.get('/api/export-preview', async req => {
      const { images, audience, projectId, date, dateFrom, dateTo, supplier, favorite, scope } = exportPreviewQuerySchema.parse(req.query);
      const owner = session(req).owner;
      const template = cloud ? await new CloudTemplateStore(cloud.db, session(req)).read(owner) : new ProcurementTemplateStore(config.appDataDir).read(owner);
      const products=projectId || date || dateFrom || favorite==='yes' ? (await scopedService(req).records.recordsForExport(owner,projectId,date,favorite==='yes',supplier,{dateFrom,dateTo})).filter(p=>!p.deletedAt && (supplier===undefined || p.supplier===supplier) && (scope!=='confirmed' || p.confirmed)) : [];
      return quotationExportMetadata(template, { images: images === 'yes', audience }, products.map(p=>p.currency), products);
    });
    secured.get("/api/export", { config: { rateLimit: { max: 5, timeWindow: "1 minute", groupId: "export", keyGenerator: ownerRateKey } } }, async (req, reply) => {
      const owner = session(req).owner, { projectId, date, dateFrom, dateTo, supplier, scope, images, favorite, audience } = exportQuerySchema.parse(req.query);
      if (activeExports.has(owner) || activeExports.size >= 2) throw new AppError("BUSY", "导出正在进行，请稍后再试", 429);
      activeExports.add(owner);
      try {
        const template = cloud ? await new CloudTemplateStore(cloud.db, session(req)).read(owner) : new ProcurementTemplateStore(config.appDataDir).read(owner);
        const { project, bytes } = await scopedService(req).export(owner, projectId, { supplier, scope, images: images === "yes", date, dateFrom, dateTo, favorite: favorite === "yes", audience, template });
        if (cloud && bytes.length > 20 * 1024 * 1024) throw new AppError("DOWNLOAD_LIMIT", "云端缓冲下载最多20MB，大文件请使用后续下载任务", 413);
        const name = encodeURIComponent((supplier === undefined ? (date ? '看货记录' : project.supplier || project.name) : supplier || '未填写商户').replace(/[\\/\r\n]/g, '_') + '-' + (dateFrom ? dateFrom + '_' + dateTo : date || project.date) + '.xlsx');
        return reply.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").header("Content-Disposition", `attachment; filename*=UTF-8''${name}`).send(bytes);
      } finally { activeExports.delete(owner); }
    });
  });
  return app;
}
