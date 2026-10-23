import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import sharp from "sharp";
import ExcelJS from "exceljs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkBuddyIdentityProvider, WorkBuddyModelProvider, parseSSE, workbuddyEnabled } from "../src/server/workbuddy";
import { issueSession, authenticate, revokeSession } from "../src/server/auth";
import { createApp } from "../src/server/app";
import { MarketService } from "../src/server/service";
import { loadCloudSession, saveCloudSession } from "../src/server/cloud-session";
import { AppError } from '../src/lib/errors';
import { closeDB, db } from "../src/lib/db";
import { parseRuntimeConfig } from '../src/server/config';
import type { SessionPersistence } from '../src/server/workbuddy';
import { defaultProcurementTemplate } from '../src/lib/procurement-template';

const keys = ["APP_DATA_DIR", "MODEL_PROVIDER", "WB_CLOUD_ENDPOINT", "WB_CLOUD_PUBLISHABLE_KEY", "WB_SESSION_ENCRYPTION_KEY", "WECHAT_APP_ID", "MODEL_NAME"];
const original = Object.fromEntries(keys.map(k => [k, process.env[k]]));
const root = mkdtempSync(join(tmpdir(), "huoji-gateway-"));
process.env.APP_DATA_DIR = root;
after(() => { closeDB(); rmSync(root, { recursive: true, force: true }); for (const k of keys) { if (original[k] === undefined) delete process.env[k]; else process.env[k] = original[k]; } });
beforeEach(() => {
  process.env.MODEL_PROVIDER = "workbuddy"; process.env.WB_CLOUD_ENDPOINT = "https://gateway.example.test";
  process.env.WB_CLOUD_PUBLISHABLE_KEY = "test-public-app-identifier"; process.env.WB_SESSION_ENCRYPTION_KEY = randomBytes(32).toString("hex");
  process.env.WECHAT_APP_ID = "test-new-app-id"; delete process.env.MODEL_NAME;
});
const output = { name: "杯子", colors: null, material: null, dimensions: null, weightG: null, unitPrice: 12, currency: "CNY", moq: 100, cartonQty: null };
const cloudRaw = (subject: string, token = `cloud:${subject}`, expires = 3600) => ({ sub: subject, access_token: token, refresh_token: `refresh:${subject}`, expires_in: expires });
function stream(text = JSON.stringify(output), finish = "stop", done = true) {
  const chunks = [JSON.stringify({ choices: [{ delta: { content: text.slice(0, 5) }, finish_reason: null }] }), JSON.stringify({ choices: [{ delta: { content: text.slice(5) }, finish_reason: finish }] })];
  return chunks.map(c => `data: ${c}\r\n\r\n`).join("") + (done ? "data: [DONE]\r\n\r\n" : "");
}
function sse(text?: string) { return new Response(stream(text), { headers: { "content-type": "text/event-stream; charset=utf-8" } }); }
function context(value: ReturnType<typeof issueSession>) { return authenticate(`Bearer ${value.token}`); }
const models = () => Response.json({ data: [{ id: "text", supportsImages: false }, { id: "vision", supportsImages: true }, { id: "disabled", disabled: true, supportsImages: true }] });

test("gateway login exchanges the NEW AppID once and never returns cloud tokens to client", async () => {
  const calls: { url: string; body: unknown; headers: Headers }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
    return Response.json(cloudRaw("alice"));
  };
  const app = await createApp({ identity: new WorkBuddyIdentityProvider(fetcher), service: new MarketService(undefined, new WorkBuddyModelProvider(fetcher)) });
  try {
    const response = await app.inject({ method: "POST", url: "/api/auth/wechat", payload: { code: "one-time-code" } });
    assert.equal(response.statusCode, 200, response.body); assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body, { code: "one-time-code", appid: "test-new-app-id" });
    assert.ok(calls[0].url.endsWith("/.cloud/auth/v1/login-wechat"));
    assert.equal(calls[0].headers.get("x-wb-webapp-access-key"), "test-public-app-identifier");
    assert.equal(calls[0].headers.get("authorization"), null);
    assert.ok(!response.body.includes("cloud:alice")); assert.ok(!response.body.includes("refresh:alice"));
    const c = context(response.json()), stored = db().prepare("SELECT encrypted FROM gateway_sessions WHERE token_hash=?").get(c.tokenHash) as { encrypted: string };
    assert.ok(stored.encrypted && !stored.encrypted.includes("cloud:alice"));
    assert.equal(loadCloudSession(c).subject, "alice");
  } finally { await app.close(); }
});

test("model discovery selects vision models, accepts complete SSE and removes unknowns", async () => {
  const grant = await new WorkBuddyIdentityProvider(async () => Response.json(cloudRaw("vision-user"))).exchange("code");
  const c = context(issueSession(grant));
  let selected: { model: string; stream: boolean; max_tokens: number; messages: { content: { image_url: { url: string } }[] }[] } | undefined;
  const provider = new WorkBuddyModelProvider(async (input, init) => {
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer cloud:vision-user");
    if (String(input).endsWith("/models")) return models();
    selected = JSON.parse(String(init?.body)); return sse();
  });
  const result = await provider.extract("12元一个", ["data:image/jpeg;base64,YQ=="], c);
  assert.ok(selected);
  assert.equal(selected.model, "vision"); assert.equal(selected.stream, true);
  assert.equal(selected.messages[1].content[1].image_url.url, "data:image/jpeg;base64,YQ==");
  assert.equal(selected.max_tokens, 1500); assert.equal(result.fields.weightG, undefined); assert.equal(result.fields.moq, 100);
});

test("API extracts through gateway using trusted per-session context", async () => {
  const fetcher: typeof fetch = async input => String(input).includes("login-wechat") ? Response.json(cloudRaw("api-user")) : String(input).endsWith("/models") ? models() : sse();
  const app = await createApp({ identity: new WorkBuddyIdentityProvider(fetcher), service: new MarketService(undefined, new WorkBuddyModelProvider(fetcher)) });
  try {
    const login = (await app.inject({ method: "POST", url: "/api/auth/wechat", payload: { code: "code" } })).json();
    const response = await app.inject({ method: "POST", url: "/api/extract", headers: { authorization: `Bearer ${login.token}` }, payload: { description: "杯子" } });
    assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().fields.unitPrice, 12);
    assert.equal((await app.inject({ method: "POST", url: "/api/extract", headers: { authorization: `Bearer ${login.token}` }, payload: { description: "杯子", tokenHash: "forged" } })).statusCode, 400);
  } finally { await app.close(); }
});

test("shared-model workflow covers multi-photo records, replay, edit, XLSX and logout", async () => {
  let modelCalls = 0;
  const fetcher: typeof fetch = async (input, init) => {
    if (String(input).includes("login-wechat")) return Response.json(cloudRaw("workflow"));
    if (String(input).endsWith("/models")) return models();
    const body = JSON.parse(String(init?.body));
    assert.equal(body.messages[1].content.filter((part: { type: string }) => part.type === "image_url").length, 2);
    modelCalls++; return sse();
  };
  const app = await createApp({ identity: new WorkBuddyIdentityProvider(fetcher), service: new MarketService(undefined, new WorkBuddyModelProvider(fetcher)) });
  try {
    const login = (await app.inject({ method: "POST", url: "/api/auth/wechat", payload: { code: "workflow-code" } })).json();
    const headers = { authorization: `Bearer ${login.token}` };
    const project = (await app.inject({ method: "POST", url: "/api/projects", headers, payload: { requestKey: randomUUID(), name: "共享模型选品", market: "模拟", date: "2026-10-15" } })).json();
    const photoIds: string[] = [];
    for (const color of ["#245c46", "#dfb3a3"]) {
      const image = await sharp({ create: { width: 60, height: 60, channels: 3, background: color } }).png().toBuffer();
      const boundary = "gateway-flow-boundary";
      const payload = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="cup.png"\r\nContent-Type: application/octet-stream\r\n\r\n`), image, Buffer.from(`\r\n--${boundary}--\r\n`)]);
      const response = await app.inject({ method: "POST", url: "/api/photos", headers: { ...headers, "content-type": `multipart/form-data; boundary=${boundary}` }, payload });
      assert.equal(response.statusCode, 201, response.body); photoIds.push(response.json().id);
    }
    const extraction = await app.inject({ method: "POST", url: "/api/extract", headers, payload: { description: "杯子，12元一个，100个起订", photoIds } });
    assert.equal(extraction.statusCode, 200, extraction.body); assert.equal(modelCalls, 1);
    const command = { requestKey: randomUUID(), projectId: project.id, fields: { ...extraction.json().fields, supplier: "模拟供应商", confirmed: true }, photoIds };
    const first = await app.inject({ method: "POST", url: "/api/products", headers, payload: command });
    assert.equal(first.statusCode, 201, first.body); const product = first.json();
    const replay = await app.inject({ method: "POST", url: "/api/products", headers, payload: command });
    assert.deepEqual(replay.json(), product); assert.equal(product.photos.length, 2);
    const edit = await app.inject({ method: "POST", url: "/api/products", headers, payload: { ...command, requestKey: randomUUID(), id: product.id, version: 1, fields: { ...command.fields, unitPrice: 15 } } });
    assert.equal(edit.json().version, 2);
    const exported = await app.inject({ method: "GET", url: `/api/export?projectId=${project.id}`, headers });
    assert.equal(exported.statusCode, 200);
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(exported.rawPayload as unknown as ExcelJS.Buffer);
    const sheet = workbook.getWorksheet('模拟供应商')!;
    const frozen = sheet.views.find(view => view.state === 'frozen');
    assert.ok(frozen && 'ySplit' in frozen && typeof frozen.ySplit === 'number');
    const header = frozen.ySplit, columns = sheet.getRow(header).values as (string | undefined)[];
    const reference = defaultProcurementTemplate().columns.filter(column => column.enabled);
    assert.deepEqual(columns.slice(1), reference.map(column => column.label));
    const label = (key: string) => { const column = reference.find(column => column.key === key); assert.ok(column); return column.label; };
    const descriptionColumn = columns.indexOf(label('description')); assert.ok(descriptionColumn > 0);
    const rows: ExcelJS.Row[] = [];
    for (let r = header + 1; r <= sheet.rowCount && sheet.getRow(r).getCell(descriptionColumn).text; r++) rows.push(sheet.getRow(r));
    assert.equal(rows.length, 1); assert.equal(sheet.getImages().length, command.photoIds.length);
    const row = sheet.getRow(header + 1);
    assert.equal(row.getCell(descriptionColumn).value, [command.fields.name, command.fields.colors, command.fields.material, command.fields.dimensions].filter(Boolean).join(' / '));
    const value = (label: string) => { const column = columns.indexOf(label); assert.ok(column > 0); return row.getCell(column).value; };
    assert.equal(value(label('unitPrice')), 15); assert.equal(value(label('quantity')), null);
    assert.equal(value(label('amount')), null); assert.equal(value(label('pcsPerCarton')), command.fields.cartonQty ?? null);
    assert.ok(!columns.includes('商品名称')); assert.ok(!columns.includes('起订量（非采购数量）')); assert.ok(!columns.includes('币种'));
    const template = defaultProcurementTemplate(); template.columns.find(column => column.key === 'currency')!.enabled = true;
    const explicit = await new MarketService().export(login.user.id, project.id, { template, images: false, businessFields: ['moq'] });
    const explicitWorkbook = new ExcelJS.Workbook(); await explicitWorkbook.xlsx.load(explicit.bytes as unknown as ExcelJS.Buffer);
    const explicitSheet = explicitWorkbook.getWorksheet('模拟供应商')!, explicitColumns = explicitSheet.getRow(header).values as string[];
    assert.deepEqual(explicitColumns.slice(1), [...reference.filter(column => column.key !== 'image').map(column => column.label), '币种', '起订量（非采购数量）']);
    const explicitRow = explicitSheet.getRow(header + 1);
    assert.equal(explicitRow.getCell(explicitColumns.indexOf('币种')).value, 'CNY');
    assert.equal(explicitRow.getCell(explicitColumns.indexOf('起订量（非采购数量）')).value, 100);
    assert.equal(explicit.metadata!.columns.filter(column => column.businessField).length, 1);
    assert.equal(edit.json().photos.length, 2, 'both source photos remain saved while only the first is embedded');
    const deleted = await app.inject({ method: "DELETE", url: `/api/products/${product.id}`, headers, payload: { version: 2 } });
    assert.equal(deleted.statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: product.photos[0].url, headers })).statusCode, 404);
    const local = context(login);
    await app.inject({ method: "POST", url: "/api/auth/logout", headers });
    assert.equal(db().prepare("SELECT encrypted FROM gateway_sessions WHERE token_hash=?").get(local.tokenHash), undefined);
    assert.equal((await app.inject({ method: "POST", url: "/api/extract", headers, payload: { description: "杯子" } })).statusCode, 401);
  } finally { await app.close(); }
});

test("cloud sessions are isolated, survive restart and are removed on logout", async () => {
  const identity = new WorkBuddyIdentityProvider(async (_input, init) => Response.json(cloudRaw(JSON.parse(String(init?.body)).code)));
  const a = context(issueSession(await identity.exchange("alice"))), b = context(issueSession(await identity.exchange("bob")));
  assert.equal(loadCloudSession(a).subject, "alice"); assert.equal(loadCloudSession(b).subject, "bob");
  assert.throws(() => loadCloudSession({ ...a, owner: b.owner }), /登录/);
  closeDB(); assert.equal(loadCloudSession(a).subject, "alice");
  revokeSession(a.tokenHash);
  assert.equal(db().prepare("SELECT encrypted FROM gateway_sessions WHERE token_hash=?").get(a.tokenHash), undefined);
  assert.throws(() => loadCloudSession(a), /登录/);
  assert.equal(loadCloudSession(b).subject, "bob");
});

test("refresh rotates only matching cloud identity and does not resurrect logged-out sessions", async () => {
  const grant = await new WorkBuddyIdentityProvider(async () => Response.json(cloudRaw("refresh-user", "old", 1))).exchange("code");
  const c = context(issueSession(grant)); let refreshCount = 0;
  const provider = new WorkBuddyModelProvider(async (input, init) => {
    if (String(input).endsWith("/token")) { refreshCount++; assert.equal(JSON.parse(String(init?.body)).grant_type, "refresh_token"); return Response.json(cloudRaw("refresh-user", "new")); }
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer new");
    return String(input).endsWith("/models") ? models() : sse();
  });
  await provider.extract("杯", [], c); assert.equal(refreshCount, 1); assert.equal(loadCloudSession(c).accessToken, "new");
  saveCloudSession(c, { ...loadCloudSession(c), expiresAt: Date.now() - 1 });
  const changed = new WorkBuddyModelProvider(async () => Response.json(cloudRaw("other")));
  await assert.rejects(() => changed.extract("杯", [], c), /身份已变化/);
  const logoutDuringRefresh = new WorkBuddyModelProvider(async () => { revokeSession(c.tokenHash); return Response.json(cloudRaw("refresh-user")); });
  await assert.rejects(() => logoutDuringRefresh.extract("杯", [], c), /登录/);
  assert.equal(db().prepare("SELECT encrypted FROM gateway_sessions WHERE token_hash=?").get(c.tokenHash), undefined);
});

test("JSON compatibility and finite fallback share a deadline; quota does not retry", async () => {
  const grant = await new WorkBuddyIdentityProvider(async () => Response.json(cloudRaw("fallback"))).exchange("code"), c = context(issueSession(grant));
  const requests: { json: boolean; signal: AbortSignal | null | undefined }[] = [];
  const provider = new WorkBuddyModelProvider(async (input, init) => {
    if (String(input).endsWith("/models")) return models();
    const body = JSON.parse(String(init?.body)); requests.push({ json: !!body.response_format, signal: init?.signal });
    return requests.length === 1 ? sse("invalid JSON") : sse();
  });
  await provider.extract("杯", [], c); assert.equal(requests.length, 2); assert.equal(requests[0].json, true); assert.equal(requests[1].json, false); assert.equal(requests[0].signal, requests[1].signal);
  let calls = 0;
  const quota = new WorkBuddyModelProvider(async input => { if (String(input).endsWith("/models")) return models(); calls++; return new Response("", { status: 429 }); });
  await assert.rejects(() => quota.extract("杯", [], c), e => e instanceof Error && "code" in e && e.code === "MODEL_QUOTA"); assert.equal(calls, 1);
});

test("HTTP JSON parameter rejection retries once without response_format", async () => {
  const grant = await new WorkBuddyIdentityProvider(async () => Response.json(cloudRaw("http-json"))).exchange("code"), c = context(issueSession(grant));
  for (const status of [400, 422]) {
    const sent: Record<string, unknown>[] = [];
    const provider = new WorkBuddyModelProvider(async (input, init) => {
      if (String(input).endsWith("/models")) return models();
      const body = JSON.parse(String(init?.body)); sent.push(body);
      return sent.length === 1 ? Response.json({ error: { code: "unsupported_parameter", param: "response_format", message: "response_format is not supported" } }, { status }) : sse();
    });
    await provider.extract("杯", [], c);
    assert.equal(sent.length, 2); assert.ok(sent[0].response_format); assert.equal(sent[1].response_format, undefined);
  }
  let attempts = 0;
  const invalid = new WorkBuddyModelProvider(async input => { if (String(input).endsWith("/models")) return models(); attempts++; return Response.json({ error: { message: "invalid image" } }, { status: 400 }); });
  await assert.rejects(() => invalid.extract("杯", [], c), /暂不可用/); assert.equal(attempts, 1);
});

test("logout aborts in-flight model transport and does not affect another session", async () => {
  const identity = new WorkBuddyIdentityProvider(async (_input, init) => Response.json(cloudRaw(JSON.parse(String(init?.body)).code)));
  const a = context(issueSession(await identity.exchange("cancel-a"))), b = context(issueSession(await identity.exchange("cancel-b")));
  let signal: AbortSignal | undefined;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const provider = new WorkBuddyModelProvider(async (input, init) => {
    if (String(input).endsWith("/models")) return models();
    signal = init?.signal || undefined;
    return new Promise<Response>((_resolve, reject) => {
      signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }); started();
    });
  });
  const pending = provider.extract("杯", [], a);
  const rejected = assert.rejects(() => pending, /登录已退出/);
  await ready; revokeSession(a.tokenHash);
  await rejected; assert.equal(signal!.aborted, true); assert.equal(loadCloudSession(b).subject, "cancel-b");
});

test("refresh accepts absent rotated handle but rejects missing identity instead of guessing", async () => {
  const grant = await new WorkBuddyIdentityProvider(async () => Response.json(cloudRaw("refresh-shape", "old", 1))).exchange("code"), c = context(issueSession(grant));
  const provider = new WorkBuddyModelProvider(async input => {
    if (String(input).endsWith("/token")) return Response.json({ sub: "refresh-shape", access_token: "renewed", expires_in: 3600 });
    return String(input).endsWith("/models") ? models() : sse();
  });
  await provider.extract("杯", [], c);
  assert.equal(loadCloudSession(c).refreshToken, "refresh:refresh-shape");
  saveCloudSession(c, { ...loadCloudSession(c), expiresAt: Date.now() - 1 });
  const malformed = new WorkBuddyModelProvider(async () => Response.json({ access_token: "missing-user", expires_in: 3600 }));
  await assert.rejects(() => malformed.extract("杯", [], c), /响应无效/);
  assert.equal(loadCloudSession(c).accessToken, "renewed");
});

test('共享模型续期401或invalid_grant与403权限拒绝明确区分', async () => {
  const grant = await new WorkBuddyIdentityProvider(async () => Response.json(cloudRaw('recovery-user', 'old', 1))).exchange('code'), c = context(issueSession(grant));
  for (const status of [400, 401]) {
    const p = new WorkBuddyModelProvider(async () => Response.json({ error: 'invalid_grant', error_description: 'expired' }, { status }));
    await assert.rejects(p.extract('杯', [], c), e => e instanceof AppError && e.code === 'MODEL_LOGIN_REQUIRED');
    assert.equal(loadCloudSession(c).accessToken, 'old');
  }
  saveCloudSession(c, { ...loadCloudSession(c), expiresAt: Date.now() + 120000 });
  const denied = new WorkBuddyModelProvider(async () => new Response('', { status: 403 }));
  await assert.rejects(denied.extract('杯', [], c), e => e instanceof AppError && e.code === 'MODEL_FORBIDDEN');
  assert.equal(loadCloudSession(c).accessToken, 'old');
});

test('异步会话适配器等待刷新保存与最终有效性校验，不使用本机持久化', async () => {
  const runtime = parseRuntimeConfig();
  const grant = await new WorkBuddyIdentityProvider(async () => Response.json(cloudRaw('async-user', 'old', 1)), runtime).exchange('code');
  let cloud = grant.cloudSession, live = true, released = false;
  const events: string[] = [];
  const c = { owner: randomUUID(), tokenHash: 'e'.repeat(64) };
  const adapter: SessionPersistence = {
    beginModelOperation: async received => { assert.deepEqual(received, c); await Promise.resolve(); events.push('begin'); return { signal: AbortSignal.timeout(30000), release: () => { released = true; } }; },
    loadCloudSession: async () => { await Promise.resolve(); events.push('load'); return cloud; },
    saveCloudSession: async (_context, value) => { await Promise.resolve(); events.push('save'); cloud = value; },
    assertLive: async () => { await Promise.resolve(); events.push('live'); if (!live) throw new Error('异步会话已退出'); },
  };
  const provider = new WorkBuddyModelProvider(async (input, init) => {
    if (String(input).endsWith('/token')) { events.push('refresh'); return Response.json(cloudRaw('async-user', 'renewed')); }
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer renewed');
    assert.ok(events.includes('save'), '持久化完成后才进入模型调用');
    if (String(input).endsWith('/models')) return models();
    events.push('model'); return sse();
  }, runtime, adapter);
  assert.equal((await provider.extract('杯', [], c)).mode, 'model');
  assert.equal(cloud.accessToken, 'renewed'); assert.equal(released, true);
  assert.ok(events.indexOf('save') < events.indexOf('model')); assert.equal(events.at(-1), 'live');
  live = false; released = false;
  await assert.rejects(provider.extract('杯', [], c), /异步会话已退出/);
  assert.equal(released, true);
});

test("SSE parser rejects truncation, length stop, malformed frames and schema guessing", () => {
  assert.equal(JSON.parse(parseSSE(stream())).name, "杯子");
  assert.throws(() => parseSSE(stream(undefined, "stop", false)), /完整结束/);
  assert.throws(() => parseSSE(stream(undefined, "length")), /不完整/);
  assert.throws(() => parseSSE("data: invalid\n\ndata: [DONE]\n\n"), /格式/);
  assert.throws(() => parseSSE("data: null\n\ndata: [DONE]\n\n"), /格式/);
  assert.throws(() => parseSSE('data: {"choices":{}}\n\ndata: [DONE]\n\n'), /格式/);
  assert.throws(() => parseSSE(stream(undefined, "content_filter")), /手工填写/);
  assert.throws(() => parseSSE("x".repeat(513 * 1024)), /过大/);
});

test("new AppID missing or configuration changed blocks old cloud authorization", async () => {
  const grant = await new WorkBuddyIdentityProvider(async () => Response.json(cloudRaw("scope-user"))).exchange("code"), c = context(issueSession(grant));
  process.env.WECHAT_APP_ID = "another-new-app-id";
  await assert.rejects(() => new WorkBuddyModelProvider(async () => sse()).extract("杯", [], c), /绑定已变化/);
  delete process.env.WECHAT_APP_ID; assert.equal(workbuddyEnabled(), false);
  await assert.rejects(() => new WorkBuddyIdentityProvider().exchange("code"), /新 AppID/);
});
