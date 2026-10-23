import { resolve, join } from "node:path";
import { validateServiceURL } from "../lib/outbound";

export type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;
export type ModelProviderName = "openai" | "workbuddy";

export type RuntimeConfig = {
  production: boolean;
  dataBackend: "sqlite" | "cloudbase";
  cloudbaseEnvId: string;
  cloudbaseApiKey: string;
  cloudStorageBucket: string;
  host: string;
  port: number;
  allowDevLogin: boolean;
  trustedProxyHops: 0 | 1 | 2;
  modelProvider: ModelProviderName;
  appDataDir: string;
  wechatAppId: string;
  wechatAppSecret: string;
  modelApiKey: string;
  modelName: string;
  modelBaseUrl: string;
  workbuddyEndpoint: string;
  workbuddyPublishableKey: string;
  workbuddySessionEncryptionKey: string;
  authReady: boolean;
  modelReady: boolean;
};

export type RuntimeConfigOptions = {
  identityInjected?: boolean;
  serviceInjected?: boolean;
};

export class RuntimeConfigError extends Error {
  constructor(message: string) { super(`运行配置无效：${message}`); }
}

export function isLocalHost(host: string): boolean {
  return ["127.0.0.1", "::1", "localhost"].includes(host.toLowerCase());
}

function booleanValue(env: RuntimeEnvironment, name: string): boolean {
  const value = env[name];
  if (value === undefined || value === "" || value === "false") return false;
  if (value === "true") return true;
  throw new RuntimeConfigError(`${name} 仅允许 true 或 false`);
}

function serviceEndpoint(value: string, name: string): string {
  if (!value) return "";
  let url: URL;
  try { url = new URL(value); } catch { throw new RuntimeConfigError(`${name} 地址无效`); }
  try { validateServiceURL(url); } catch { throw new RuntimeConfigError(`${name} 必须是公网 HTTPS 地址`); }
  if (url.search) throw new RuntimeConfigError(`${name} 不能包含查询参数`);
  return value.replace(/\/$/, "");
}

export function parseRuntimeConfig(env: RuntimeEnvironment = process.env, options: RuntimeConfigOptions = {}): RuntimeConfig {
  const production = env.NODE_ENV === "production";
  const dataBackend = env.DATA_BACKEND || "sqlite";
  if (dataBackend !== "sqlite" && dataBackend !== "cloudbase") throw new RuntimeConfigError("DATA_BACKEND 仅允许 sqlite 或 cloudbase");
  const cloudbaseEnvId = env.TCB_ENV || "";
  const cloudbaseApiKey = env.CLOUDBASE_APIKEY || "";
  const cloudStorageBucket = env.CLOUD_STORAGE_BUCKET || "huoji-private";
  if (dataBackend === "cloudbase") {
    if (production && !cloudbaseEnvId) throw new RuntimeConfigError("TCB_ENV 未配置");
    if (production && !cloudbaseApiKey) throw new RuntimeConfigError("CLOUDBASE_APIKEY 未配置");
    if (cloudbaseEnvId && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(cloudbaseEnvId)) throw new RuntimeConfigError("TCB_ENV 格式无效");
    if (cloudbaseApiKey && !/^[\x21-\x7e]+$/.test(cloudbaseApiKey)) throw new RuntimeConfigError("CLOUDBASE_APIKEY 格式无效");
    if (cloudStorageBucket !== "huoji-private") throw new RuntimeConfigError("CLOUD_STORAGE_BUCKET 必须是 huoji-private");
  }
  const host = (env.HOST || "127.0.0.1").trim();
  if (!host) throw new RuntimeConfigError("HOST 不能为空");
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RuntimeConfigError("PORT 必须是 1 到 65535 的整数");

  const allowDevLogin = booleanValue(env, "ALLOW_DEV_LOGIN");
  if (allowDevLogin && (production || !isLocalHost(host))) throw new RuntimeConfigError("开发登录仅可用于非生产本机服务");

  const trustedProxyRaw = env.TRUSTED_PROXY_HOPS;
  if (trustedProxyRaw !== undefined && !/^[012]$/.test(trustedProxyRaw)) throw new RuntimeConfigError("TRUSTED_PROXY_HOPS 仅允许 0、1 或 2");
  if (production && !isLocalHost(host) && trustedProxyRaw === undefined) throw new RuntimeConfigError("生产环境非本机监听必须显式配置 TRUSTED_PROXY_HOPS");
  const trustedProxyHops = Number(trustedProxyRaw || 0) as 0 | 1 | 2;

  const modelProvider = env.MODEL_PROVIDER || "openai";
  if (modelProvider !== "openai" && modelProvider !== "workbuddy") throw new RuntimeConfigError("MODEL_PROVIDER 仅允许 openai 或 workbuddy");

  const wechatAppId = env.WECHAT_APP_ID || "";
  const wechatAppSecret = env.WECHAT_APP_SECRET || "";
  const modelApiKey = env.MODEL_API_KEY || "";
  const modelName = env.MODEL_NAME || "";
  const rawModelBaseUrl = env.MODEL_BASE_URL || "https://api.openai.com/v1";
  const modelBaseUrl = modelProvider === "openai" && !options.serviceInjected
    ? serviceEndpoint(rawModelBaseUrl, "MODEL_BASE_URL")
    : rawModelBaseUrl.replace(/\/$/, "");
  const workbuddyEndpoint = modelProvider === "workbuddy" && (!options.identityInjected || !options.serviceInjected)
    ? serviceEndpoint(env.WB_CLOUD_ENDPOINT || "", "WB_CLOUD_ENDPOINT")
    : (env.WB_CLOUD_ENDPOINT || "").replace(/\/$/, "");
  const workbuddyPublishableKey = env.WB_CLOUD_PUBLISHABLE_KEY || "";
  const workbuddySessionEncryptionKey = env.WB_SESSION_ENCRYPTION_KEY || "";
  const workbuddyConfigured = Boolean(wechatAppId && workbuddyEndpoint && workbuddyPublishableKey && /^[a-f0-9]{64}$/i.test(workbuddySessionEncryptionKey));

  if (modelProvider === "workbuddy" && (!options.identityInjected || !options.serviceInjected) && !workbuddyConfigured) {
    if (!wechatAppId) throw new RuntimeConfigError("WECHAT_APP_ID 未配置");
    if (!workbuddyEndpoint) throw new RuntimeConfigError("WB_CLOUD_ENDPOINT 未配置");
    if (!workbuddyPublishableKey) throw new RuntimeConfigError("WB_CLOUD_PUBLISHABLE_KEY 未配置");
    if (!/^[a-f0-9]{64}$/i.test(workbuddySessionEncryptionKey)) throw new RuntimeConfigError("WB_SESSION_ENCRYPTION_KEY 必须是 64 位十六进制字符串");
  }

  // 云容器生产部署：凭据、身份与监听方式必须一次配齐，缺项即退出，不允许回退本机存储。
  if (production && dataBackend === "cloudbase") {
    if (modelProvider !== "workbuddy") throw new RuntimeConfigError("云生产模式 MODEL_PROVIDER 必须是 workbuddy");
    if (!wechatAppId) throw new RuntimeConfigError("云生产模式 WECHAT_APP_ID 未配置");
    if (!workbuddyEndpoint) throw new RuntimeConfigError("云生产模式 WB_CLOUD_ENDPOINT 未配置");
    if (!workbuddyPublishableKey) throw new RuntimeConfigError("云生产模式 WB_CLOUD_PUBLISHABLE_KEY 未配置");
    if (!/^[a-f0-9]{64}$/i.test(workbuddySessionEncryptionKey)) throw new RuntimeConfigError("云生产模式 WB_SESSION_ENCRYPTION_KEY 必须是 64 位十六进制字符串");
    if (host !== "0.0.0.0") throw new RuntimeConfigError("云生产模式 HOST 必须是 0.0.0.0，容器需监听全部网卡");
    if (trustedProxyHops < 1) throw new RuntimeConfigError("云生产模式 TRUSTED_PROXY_HOPS 必须显式配置为 1 或 2，网关转发下不能为 0");
  }

  const openaiPairComplete = Boolean(modelApiKey) === Boolean(modelName);
  if (modelProvider === "openai" && !options.serviceInjected && !openaiPairComplete) throw new RuntimeConfigError("MODEL_API_KEY 与 MODEL_NAME 必须同时配置或同时留空");
  const wechatConfigured = Boolean(wechatAppId && wechatAppSecret);
  if (production && modelProvider === "openai" && !options.identityInjected && !wechatConfigured) {
    throw new RuntimeConfigError("生产环境微信登录必须配置 WECHAT_APP_ID 和 WECHAT_APP_SECRET");
  }

  return {
    production,
    dataBackend,
    cloudbaseEnvId,
    cloudbaseApiKey,
    cloudStorageBucket,
    host,
    port,
    allowDevLogin,
    trustedProxyHops,
    modelProvider,
    appDataDir: resolve(env.APP_DATA_DIR || join(process.cwd(), ".data")),
    wechatAppId,
    wechatAppSecret,
    modelApiKey,
    modelName,
    modelBaseUrl,
    workbuddyEndpoint,
    workbuddyPublishableKey,
    workbuddySessionEncryptionKey,
    authReady: options.identityInjected === true || (modelProvider === "workbuddy" ? workbuddyConfigured : wechatConfigured),
    modelReady: options.serviceInjected === true || (modelProvider === "workbuddy" ? workbuddyConfigured : openaiPairComplete),
  };
}
