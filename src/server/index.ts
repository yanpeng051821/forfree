import { createApp, type CloudDependencies } from "./app";
import { parseRuntimeConfig, RuntimeConfigError, type RuntimeConfig } from "./config";
import { CloudDatabase, type CloudRpcClient } from "./cloud-db";
import { CloudBlobStore } from "./cloud-blobs";
import { CloudAuth } from "./cloud-auth";
import { CloudUploadBroker } from "./workbook-upload";
import { CloudJobs } from "./cloud-jobs";
import { setTimeout as delay } from "node:timers/promises";
import { assertBudget, type RequestBudget } from "./request-budget";

interface CloudSDK {
  init(config: { env: string; accessKey: string }): { rdb(): { url?: string } };
}
const CLOUD_SDK = "@cloudbase/node-sdk";
/** 已实测的 CloudBase PG 网关 REST 路径；SDK 的 rdb 对象未提供 rpc 方法，按已验证模式直接构造。 */
const RDB_RPC_PATH = "/rpc/";
const gatewayBaseUrl = (envId: string) => `https://${envId}.api.tcloudbasegateway.com/v1/rdb/rest`;
class GatewayRpcClient implements CloudRpcClient {
  constructor(private readonly baseUrl: string, private readonly apiKey: string) {}
  async rpc(name: string, parameters: Record<string, unknown>, budget?: RequestBudget) {
    const url = `${this.baseUrl}${RDB_RPC_PATH}${name}`, host = new URL(url).host;
    let lastError: unknown;
    // 容器缩容到0后的首个请求可能受冷启动与CPU限流影响；仅对超时与网关5xx做有限重试。
    for (let attempt = 1; attempt <= 3; attempt++) {
      assertBudget(budget);
      try {
        const response = await fetch(url, {
          method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` }, body: JSON.stringify(parameters), signal: budget?.signal || AbortSignal.timeout(45000),
        });
        const text = await response.text();
        // 仅记录状态码与主机，绝不记录密钥、请求头、响应体或用户内容。
        if (!response.ok) {
          console.error(JSON.stringify({ level: "error", scope: "cloud-db", event: "rpc_http_error", host, status: response.status, attempt, length: text.length }));
          const error = Object.assign(new Error("数据库网关错误"), { code: `HTTP_${response.status}` });
          if (response.status >= 500 || response.status === 429) { lastError = error; await delay(400 * attempt, undefined, { signal: budget?.signal }); continue; }
          throw error;
        }
        try { return { data: JSON.parse(text), error: null }; }
        catch {
          console.error(JSON.stringify({ level: "error", scope: "cloud-db", event: "rpc_invalid_json", host, attempt, length: text.length }));
          throw Object.assign(new Error("数据库网关响应无效"), { code: "DB_RESPONSE_INVALID" });
        }
      } catch (error) {
        assertBudget(budget);
        lastError = error;
        const retryable = !(error instanceof Error) || !String(error.message).startsWith("数据库网关");
        console.error(JSON.stringify({ level: "error", scope: "cloud-db", event: "rpc_transport_failed", host, attempt, reason: String((error as Error)?.name || "unknown") }));
        if (!retryable || attempt === 3) throw error;
        await delay(400 * attempt, undefined, { signal: budget?.signal });
      }
    }
    throw lastError instanceof Error ? lastError : new Error("数据库网关不可用");
  }
}

/** 云依赖只在 DATA_BACKEND=cloudbase 时构造；任何缺失都抛错退出，不回退本机数据库。 */
export function createCloudDependencies(config: RuntimeConfig): CloudDependencies {
  if (!config.cloudbaseEnvId || !config.cloudbaseApiKey) throw new RuntimeConfigError("云模式必须配置 TCB_ENV 和 CLOUDBASE_APIKEY");
  if (!/^[a-f0-9]{64}$/i.test(config.workbuddySessionEncryptionKey)) throw new RuntimeConfigError("云模式必须配置 WB_SESSION_ENCRYPTION_KEY（64 位十六进制）");
  // SDK 由生产镜像依赖安装，仅在明确云模式时加载，本机模式不依赖其类型或初始化。
  let sdk: CloudSDK;
  try { sdk = require(CLOUD_SDK) as CloudSDK; }
  catch { throw new RuntimeConfigError(`云数据后端依赖 ${CLOUD_SDK} 不可用，容器镜像缺少该依赖`); }
  if (typeof sdk?.init !== "function") throw new RuntimeConfigError("CloudBase SDK 初始化接口不可用");
  let app: { rdb(): { url?: string } };
  try { app = sdk.init({ env: config.cloudbaseEnvId, accessKey: config.cloudbaseApiKey }); }
  // 不回显 SDK 原始错误，避免凭据或环境信息进入日志。
  catch { throw new RuntimeConfigError("CloudBase SDK 初始化失败，请检查 TCB_ENV 与 CLOUDBASE_APIKEY"); }
  if (typeof app?.rdb !== "function") throw new RuntimeConfigError("CloudBase SDK 不支持 PostgreSQL rdb");
  // 网关地址按环境ID确定，不依赖 SDK 内部字段变化。
  const baseUrl = gatewayBaseUrl(config.cloudbaseEnvId);
  if (!/^https:\/\/[a-z0-9][a-z0-9-]{0,62}\.api\.tcloudbasegateway\.com\/v1\/rdb\/rest$/i.test(baseUrl)) throw new RuntimeConfigError("云数据库网关地址无效");
  const db = new CloudDatabase(new GatewayRpcClient(baseUrl, config.cloudbaseApiKey));
  const blobs = new CloudBlobStore(config.cloudbaseEnvId, config.cloudbaseApiKey);
  // 存储健康检查只做可达性探测，不读取真实图片或采购文件。
  // 直传与任务实例按请求绑定 owner/tokenHash：这里只注入构造方式，任何缺失都在上面抛错退出，不回退本机。
  return {
    db, blobs, auth: new CloudAuth(db, config.workbuddySessionEncryptionKey), storageHealth: () => blobs.ping(),
    uploadBroker: (context, registry) => new CloudUploadBroker(db, blobs, context, registry),
    jobs: (context, uploads) => new CloudJobs(db, blobs, uploads, context),
  };
}
async function main() {
  const config = parseRuntimeConfig();
  const cloud = config.dataBackend === "cloudbase" ? createCloudDependencies(config) : undefined;
  const app = await createApp({ logger: true, config, cloud });
  let interval: ReturnType<typeof setInterval> | undefined;
  let sqlite: typeof import("../lib/db") | undefined;
  if (!cloud) {
    // 云模式没有任何本地状态目录，只有本机模式才需要 SQLite 与媒体回收。
    sqlite = await import("../lib/db");
    sqlite.collectGarbage();
    interval = setInterval(() => {
      try { sqlite?.collectGarbage(); } catch { app.log.error("本机媒体维护失败"); }
    }, 60 * 60 * 1000);
    interval.unref();
  }
  const shutdown = async () => { if (interval) clearInterval(interval); await app.close(); sqlite?.closeDB(); };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
  try { await app.listen({ host: config.host, port: config.port }); } catch (error) { await shutdown(); throw error; }
}
if (require.main === module) main().catch(error => {
  console.error(error instanceof Error ? error.message : "服务启动失败，请检查运行配置");
  process.exit(1);
});
