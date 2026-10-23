import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRuntimeConfig } from "../src/server/config";

const productionOpenAI = {
  NODE_ENV: "production",
  HOST: "127.0.0.1",
  MODEL_PROVIDER: "openai",
  WECHAT_APP_ID: "test-app-id",
  WECHAT_APP_SECRET: "test-app-secret",
} as const;

const workbuddy = {
  MODEL_PROVIDER: "workbuddy",
  WECHAT_APP_ID: "test-app-id",
  WB_CLOUD_ENDPOINT: "https://gateway.example.test",
  WB_CLOUD_PUBLISHABLE_KEY: "publishable-test-key",
  WB_SESSION_ENCRYPTION_KEY: "a".repeat(64),
} as const;

test("运行配置可注入环境对象且不修改全局环境", () => {
  const before = process.env.HOST;
  const env = Object.freeze({ ...productionOpenAI, PORT: "4321", TRUSTED_PROXY_HOPS: "0" });
  const config = parseRuntimeConfig(env);
  assert.equal(config.dataBackend, "sqlite");
  assert.equal(config.cloudStorageBucket, "huoji-private");
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 4321);
  assert.equal(config.trustedProxyHops, 0);
  assert.equal(process.env.HOST, before);
});

test("生产环境拒绝开发登录并要求公开监听显式配置代理跳数", () => {
  assert.throws(() => parseRuntimeConfig({ ...productionOpenAI, ALLOW_DEV_LOGIN: "true" }), /开发登录/);
  assert.throws(() => parseRuntimeConfig({ ...productionOpenAI, HOST: "0.0.0.0" }), /TRUSTED_PROXY_HOPS/);
  for (const hops of ["0", "1", "2"] as const) {
    assert.equal(parseRuntimeConfig({ ...productionOpenAI, HOST: "0.0.0.0", TRUSTED_PROXY_HOPS: hops }).trustedProxyHops, Number(hops));
  }
  for (const hops of ["-1", "3", "all"]) assert.throws(() => parseRuntimeConfig({ ...productionOpenAI, TRUSTED_PROXY_HOPS: hops }), /仅允许 0、1 或 2/);
});

test("workbuddy 模式强制完整且安全的共享服务配置", () => {
  const config = parseRuntimeConfig(workbuddy);
  assert.equal(config.modelProvider, "workbuddy");
  assert.equal(config.authReady, true);
  assert.equal(config.modelReady, true);
  for (const key of ["WECHAT_APP_ID", "WB_CLOUD_ENDPOINT", "WB_CLOUD_PUBLISHABLE_KEY", "WB_SESSION_ENCRYPTION_KEY"] as const) {
    const env = { ...workbuddy, [key]: "" };
    assert.throws(() => parseRuntimeConfig(env), new RegExp(key));
  }
  assert.throws(() => parseRuntimeConfig({ ...workbuddy, WB_CLOUD_ENDPOINT: "http://127.0.0.1/private" }), /公网 HTTPS/);
  assert.throws(() => parseRuntimeConfig({ ...workbuddy, WB_CLOUD_ENDPOINT: "https://gateway.example.test?secret=value" }), /查询参数/);
  assert.throws(() => parseRuntimeConfig({ ...workbuddy, WB_SESSION_ENCRYPTION_KEY: "not-a-secret-key" }), error => {
    assert.ok(error instanceof Error);
    assert.equal(error.message.includes("not-a-secret-key"), false);
    return true;
  });
});

const cloudProduction = {
  ...productionOpenAI,
  ...workbuddy,
  DATA_BACKEND: 'cloudbase',
  HOST: '0.0.0.0',
  TRUSTED_PROXY_HOPS: '1',
  TCB_ENV: 'test-cloud-env',
  CLOUDBASE_APIKEY: 'test-private-key',
  CLOUD_STORAGE_BUCKET: 'huoji-private',
} as const;

test("云数据后端必须显式启用且生产凭据缺失立即失败", () => {
  const env = cloudProduction;
  const config = parseRuntimeConfig(env);
  assert.equal(config.dataBackend, 'cloudbase');
  assert.equal(config.cloudbaseEnvId, env.TCB_ENV);
  assert.equal(config.cloudbaseApiKey, env.CLOUDBASE_APIKEY);
  for (const key of ['TCB_ENV', 'CLOUDBASE_APIKEY'] as const) assert.throws(() => parseRuntimeConfig({ ...env, [key]: '' }, { identityInjected: true, serviceInjected: true }), new RegExp(key));
  assert.throws(() => parseRuntimeConfig({ ...env, DATA_BACKEND: 'unknown' }), /DATA_BACKEND/);
  assert.throws(() => parseRuntimeConfig({ ...env, CLOUD_STORAGE_BUCKET: 'public' }), /huoji-private/);
  assert.throws(() => parseRuntimeConfig({ ...env, CLOUDBASE_APIKEY: 'secret\nvalue' }), error => error instanceof Error && !error.message.includes('secret'));
  assert.equal(parseRuntimeConfig({ DATA_BACKEND: 'cloudbase' }, { identityInjected: true, serviceInjected: true }).cloudbaseApiKey, '');
});

test("云容器生产部署必须完整配置且不允许本机回退", () => {
  const config = parseRuntimeConfig(cloudProduction);
  assert.equal(config.dataBackend, 'cloudbase');
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.trustedProxyHops, 1);
  assert.equal(config.modelProvider, 'workbuddy');
  assert.equal(config.authReady, true);
  assert.equal(config.modelReady, true);
  for (const key of ['WECHAT_APP_ID', 'WB_CLOUD_ENDPOINT', 'WB_CLOUD_PUBLISHABLE_KEY', 'WB_SESSION_ENCRYPTION_KEY'] as const) {
    assert.throws(() => parseRuntimeConfig({ ...cloudProduction, [key]: '' }), new RegExp(key));
  }
  assert.throws(() => parseRuntimeConfig({ ...cloudProduction, MODEL_PROVIDER: 'openai' }), /MODEL_PROVIDER/);
  assert.throws(() => parseRuntimeConfig({ ...cloudProduction, HOST: '127.0.0.1' }), /HOST/);
  assert.throws(() => parseRuntimeConfig({ ...cloudProduction, TRUSTED_PROXY_HOPS: '0' }), /TRUSTED_PROXY_HOPS/);
  const { TRUSTED_PROXY_HOPS, ...withoutProxyHops } = cloudProduction;
  void TRUSTED_PROXY_HOPS;
  assert.throws(() => parseRuntimeConfig(withoutProxyHops), /TRUSTED_PROXY_HOPS/);
  assert.throws(() => parseRuntimeConfig({ ...cloudProduction, ALLOW_DEV_LOGIN: 'true' }), /开发登录/);
  assert.throws(() => parseRuntimeConfig({ ...cloudProduction, WB_SESSION_ENCRYPTION_KEY: 'short-secret-value' }), error => {
    assert.ok(error instanceof Error);
    assert.equal(error.message.includes('short-secret-value'), false);
    return true;
  });
});

test("production openai 真实登录 fail-fast，依赖注入测试可绕过外部凭据", () => {
  assert.throws(() => parseRuntimeConfig({ NODE_ENV: "production", HOST: "127.0.0.1", MODEL_PROVIDER: "openai" }), /WECHAT_APP_ID 和 WECHAT_APP_SECRET/);
  const injected = parseRuntimeConfig({ NODE_ENV: "production", HOST: "127.0.0.1", MODEL_PROVIDER: "openai", MODEL_BASE_URL: "not-an-endpoint" }, { identityInjected: true, serviceInjected: true });
  assert.equal(injected.authReady, true);
  assert.equal(injected.modelReady, true);
  assert.throws(() => parseRuntimeConfig({ ...productionOpenAI, MODEL_API_KEY: "only-key" }), /必须同时配置/);
});
