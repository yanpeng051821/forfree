import { effective } from "./excel-value";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { checkReadiness, createApp } from "../src/server/app";
import { parseRuntimeConfig } from "../src/server/config";
import { MarketService } from "../src/server/service";
import { AppError } from "../src/lib/errors";
import { db, closeDB, collectGarbage, listProjects, saveProduct, stagePhoto, repository } from "../src/lib/db";
import { issueSession } from "../src/server/auth";
import { isPublicAddress, validateServiceURL } from "../src/lib/outbound";
import { migrate } from "../src/lib/migrations";
import { DatabaseSync } from "node:sqlite";
import { emptyFields } from "../src/lib/types";
import { defaultProcurementTemplate } from '../src/lib/procurement-template';
import { quotationExportMetadata } from '../src/lib/quotation-export';

const originalDir = process.env.APP_DATA_DIR;
const root = mkdtempSync(join(tmpdir(), "huoji-server-"));
process.env.APP_DATA_DIR = root;
after(() => { closeDB(); rmSync(root, { recursive: true, force: true }); if (originalDir === undefined) delete process.env.APP_DATA_DIR; else process.env.APP_DATA_DIR = originalDir; });
const service = new MarketService(undefined, { enabled: () => false, extract: async () => { throw new Error("unused"); } });
const makeApp = () => createApp({ identity: { exchange: async code => `mock:${code}` }, service });
const headers = (token: string) => ({ authorization: `Bearer ${token}` });
const jsonHeaders = (token: string) => ({ ...headers(token), "content-type": "application/json" });
const referenceColumns = defaultProcurementTemplate().columns.filter(column => column.enabled);
const referenceLabel = (key: string) => { const column = referenceColumns.find(column => column.key === key); assert.ok(column, key); return column.label; };
function quotationRows(workbook: import('exceljs').Workbook, images = true, appended: string[] = []) {
  return workbook.worksheets.flatMap(sheet => {
    const frozen = (sheet.views || []).find(view => view.state === 'frozen');
    if (!frozen) return [];
    assert.ok('ySplit' in frozen && typeof frozen.ySplit === 'number');
    const header = frozen.ySplit, columns = sheet.getRow(header).values as string[];
    assert.deepEqual(columns.slice(1), [...referenceColumns.filter(column => images || column.key !== 'image').map(column => column.label), ...appended]);
    const descriptionColumn = columns.indexOf(referenceLabel('description')); assert.ok(descriptionColumn > 0);
    const rows: import('exceljs').Row[] = [];
    for (let r = header + 1; r <= sheet.rowCount && sheet.getRow(r).getCell(descriptionColumn).text; r++) rows.push(sheet.getRow(r));
    return rows.map(row => {
      assert.ok(row.getCell(descriptionColumn).text);
      return { sheet, row, columns, description: row.getCell(descriptionColumn).text, value: (label: string) => {
        const column = columns.indexOf(label); assert.ok(column > 0, 'missing column ' + label);
        return effective(row.getCell(column));
      } };
    });
  });
}

test("存活、就绪探针和安全响应头不暴露运行配置", async () => {
  const app = await makeApp();
  try {
    const live = await app.inject({ method: "GET", url: "/livez" });
    const health = await app.inject({ method: "GET", url: "/health" });
    assert.equal(live.statusCode, 200);
    assert.deepEqual(health.json(), live.json());
    assert.equal(live.headers["x-content-type-options"], "nosniff");
    assert.equal(live.headers["x-frame-options"], "DENY");
    assert.equal(live.headers["referrer-policy"], "no-referrer");
    assert.ok(live.headers["x-request-id"]);
    const ready = await app.inject({ method: "GET", url: "/readyz" });
    assert.equal(ready.statusCode, 200, ready.body);
    assert.equal(ready.json().status, "ready");
    assert.deepEqual(ready.json().checks.database, { ok: true });
    assert.deepEqual(ready.json().checks.procurementDirectory, { ok: true });
    assert.deepEqual(ready.json().checks.templateDirectory, { ok: true });
    assert.equal(JSON.stringify(ready.json()).includes(root), false);
  } finally { await app.close(); }

  const blocked = join(root, "not-a-directory");
  writeFileSync(blocked, "x");
  const config = parseRuntimeConfig({}, { identityInjected: true, serviceInjected: true });
  const result = checkReadiness({ ...config, appDataDir: blocked });
  assert.equal(result.status, "not_ready");
  assert.equal(result.checks.dataDirectory.ok, false);
  assert.equal(result.checks.photoDirectory.ok, false);

  for (const directory of ['procurement', 'procurement-templates']) {
    const dataRoot = join(root, 'blocked-' + directory);
    mkdirSync(dataRoot); writeFileSync(join(dataRoot, directory), 'not a directory');
    const result = checkReadiness({ ...config, appDataDir: dataRoot });
    assert.equal(result.status, 'not_ready');
    assert.equal(directory === 'procurement' ? result.checks.procurementDirectory.ok : result.checks.templateDirectory.ok, false);
  }

  const production = parseRuntimeConfig({ NODE_ENV: "production", HOST: "127.0.0.1", MODEL_PROVIDER: "openai" }, { identityInjected: true, serviceInjected: true });
  const unready = await createApp({ identity: { exchange: async code => code }, service, config: { ...production, authReady: false } });
  try {
    const response = await unready.inject({ method: "GET", url: "/readyz" });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().checks.authentication.ok, false);
    assert.equal(response.headers["strict-transport-security"], "max-age=31536000; includeSubDomains");
  } finally { await unready.close(); }
});

test("零跳代理忽略转发头且限流按会话与路由隔离", async () => {
  const config = parseRuntimeConfig({ TRUSTED_PROXY_HOPS: "0" }, { identityInjected: true, serviceInjected: true });
  const app = await createApp({ identity: { exchange: async code => `rate:${code}` }, service, config });
  const a = issueSession("rate-owner-a"), b = issueSession("rate-owner-b");
  try {
    const request = (token: string) => app.inject({
      method: "POST",
      url: "/api/extract",
      headers: { ...headers(token), "x-forwarded-for": "198.51.100.23" },
      remoteAddress: "127.0.0.1",
      payload: { description: "杯子" },
    });
    for (let index = 0; index < 10; index++) assert.equal((await request(a.token)).statusCode, 200);
    assert.equal((await request(a.token)).statusCode, 429);
    assert.equal((await request(b.token)).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: `/api/export?projectId=${randomUUID()}`, headers: headers(a.token) })).statusCode, 404);

    for (let index = 0; index < 10; index++) {
      assert.equal((await app.inject({ method: "POST", url: "/api/auth/wechat", remoteAddress: "127.0.0.1", headers: { "x-forwarded-for": `203.0.113.${index + 1}` }, payload: { code: `login-${index}` } })).statusCode, 200);
    }
    assert.equal((await app.inject({ method: "POST", url: "/api/auth/wechat", remoteAddress: "127.0.0.1", headers: { "x-forwarded-for": "203.0.113.99" }, payload: { code: "limited" } })).statusCode, 429);
  } finally { await app.close(); }
});

test("单实例作业并发上限分别为 upload 2、export 2，AI 整理走异步任务", async () => {
  const users = Array.from({ length: 5 }, (_, index) => issueSession(`job-owner-${index}`));
  const gated = <T>(target: number, value: T) => {
    let startedCount = 0;
    let signalStarted!: () => void;
    const started = new Promise<void>(resolve => { signalStarted = resolve; });
    const releases: (() => void)[] = [];
    return {
      started,
      run: async () => new Promise<T>(resolve => {
        releases.push(() => resolve(value));
        startedCount++;
        if (startedCount === target) signalStarted();
      }),
      release: () => releases.splice(0).forEach(release => release()),
    };
  };
  const uploadGate = gated(2, { id: randomUUID(), name: "test.jpg", url: `/api/photos/${randomUUID()}` });
  // AI 整理已异步化：闸门只用于 upload/export 的并发断言，抽取即时返回。
  const extractImmediate = async () => ({ fields: {}, mode: "rules" as const, warning: "test" });
  const extractGate = { release: () => { } };
  const exportGate = gated(2, { project: { id: randomUUID(), name: "test", market: "", date: "2026-10-16", demo: false, createdAt: new Date().toISOString() }, bytes: Buffer.from("xlsx") });
  const jobService = new MarketService(undefined, { enabled: () => true, extract: extractImmediate });
  jobService.upload = uploadGate.run;
  jobService.export = exportGate.run;
  const app = await createApp({ identity: { exchange: async code => code }, service: jobService });
  const uploadRequest = (token: string, index: number) => {
    const boundary = `job-upload-${index}`;
    const payload = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="test.jpg"\r\nContent-Type: image/jpeg\r\n\r\nx\r\n--${boundary}--\r\n`);
    return app.inject({ method: "POST", url: "/api/photos", headers: { ...headers(token), "content-type": `multipart/form-data; boundary=${boundary}` }, payload });
  };
  try {
    const uploads = [uploadRequest(users[0].token, 0), uploadRequest(users[1].token, 1)];
    await uploadGate.started;
    assert.equal((await uploadRequest(users[2].token, 2)).statusCode, 429);
    uploadGate.release();
    assert.deepEqual((await Promise.all(uploads)).map(response => response.statusCode), [201, 201]);

    // AI 整理已改为异步任务（202 + jobId），并发由作业队列约束，不再在此同步等待。
    const extracts = users.slice(0, 4).map(user => app.inject({ method: "POST", url: "/api/extract", headers: headers(user.token), payload: { description: "test" } }));
    // 本机模式同步返回 200，云模式异步返回 202；两者都表示整理已被接受。
    assert.ok((await Promise.all(extracts)).every(response => response.statusCode === 200 || response.statusCode === 202));

    const exports = users.slice(0, 2).map(user => app.inject({ method: "GET", url: `/api/export?projectId=${randomUUID()}`, headers: headers(user.token) }));
    await exportGate.started;
    assert.equal((await app.inject({ method: "GET", url: `/api/export?projectId=${randomUUID()}`, headers: headers(users[2].token) })).statusCode, 429);
    exportGate.release();
    assert.ok((await Promise.all(exports)).every(response => response.statusCode === 200));
  } finally {
    uploadGate.release(); extractGate.release(); exportGate.release();
    await app.close();
  }
});

test("产品列表使用稳定、不透明且隔离 owner 的游标分页", async () => {
  const a = issueSession("page-owner-a"), b = issueSession("page-owner-b");
  const projectA = repository.createProject(a.user.id, { name: "分页A", market: "", date: "2026-10-16" }, randomUUID());
  const projectB = repository.createProject(b.user.id, { name: "分页B", market: "", date: "2026-10-16" }, randomUUID());
  const ids: string[] = [];
  for (let index = 0; index < 5; index++) {
    ids.push(repository.saveProduct(a.user.id, { requestKey: randomUUID(), projectId: projectA.id, fields: { ...emptyFields, name: `商品${index}` }, photoIds: [] }).id);
  }
  db().prepare("UPDATE products SET created_at=? WHERE project_id=?").run("2026-10-16T00:00:00.000Z", projectA.id);
  const expected = repository.listProducts(a.user.id, projectA.id).map(product => product.id);
  const app = await makeApp();
  try {
    const received: string[] = [];
    let cursor: string | null = null;
    do {
      const queryString: string = new URLSearchParams({ projectId: projectA.id, limit: "2", ...(cursor ? { cursor } : {}) }).toString();
      const response = await app.inject({ method: "GET", url: `/api/products?${queryString}`, headers: headers(a.token) });
      assert.equal(response.statusCode, 200, response.body);
      const page = response.json() as { items: { id: string }[]; nextCursor: string | null };
      assert.ok(Array.isArray(page.items));
      received.push(...page.items.map((product: { id: string }) => product.id));
      cursor = page.nextCursor;
      if (cursor) {
        assert.match(cursor, /^[A-Za-z0-9_-]{43}$/);
        assert.ok(!ids.includes(cursor));
        assert.equal(cursor.includes(a.user.id), false);
      }
    } while (cursor);
    assert.deepEqual(received, expected);
    assert.equal(new Set(received).size, 5);

    const first = (await app.inject({ method: "GET", url: `/api/products?projectId=${projectA.id}&limit=2`, headers: headers(a.token) })).json();
    assert.equal((await app.inject({ method: "GET", url: `/api/products?projectId=${projectA.id}&limit=101`, headers: headers(a.token) })).statusCode, 400);
    assert.equal((await app.inject({ method: "GET", url: `/api/products?projectId=${projectA.id}&cursor=${"x".repeat(22)}`, headers: headers(a.token) })).statusCode, 400);
    const alien = await app.inject({ method: "GET", url: `/api/products?projectId=${projectB.id}&cursor=${first.nextCursor}`, headers: headers(b.token) });
    assert.equal(alien.statusCode, 400);
    assert.equal(alien.json().error.code, "INVALID_CURSOR");
  } finally { await app.close(); }
});

test("API authentication, user isolation, idempotent replay, conflicts, protected media and export", async () => {
  const app = await makeApp();
  try {
    assert.equal((await app.inject({ method: "GET", url: "/api/projects" })).statusCode, 401);
    const login = await app.inject({ method: "POST", url: "/api/auth/wechat", payload: { code: "alice" } });
    assert.equal(login.statusCode, 200);
    const a = login.json() as ReturnType<typeof issueSession>, b = issueSession("mock:bob");
    const payload = { requestKey: randomUUID(), name: "API任务", market: "测试市场", date: "2026-10-15" };
    const create = await app.inject({ method: "POST", url: "/api/projects", headers: headers(a.token), payload });
    assert.equal(create.statusCode, 201, create.body);
    const project = create.json();
    const again = await app.inject({ method: "POST", url: "/api/projects", headers: headers(a.token), payload });
    assert.deepEqual(again.json(), project);
    const wrongOwner = await app.inject({ method: "POST", url: "/api/projects", headers: headers(a.token), payload: { ...payload, owner: b.user.id } });
    assert.equal(wrongOwner.statusCode, 400);
    const changed = await app.inject({ method: "POST", url: "/api/projects", headers: headers(a.token), payload: { ...payload, name: "另一内容" } });
    assert.equal(changed.statusCode, 409);
    assert.deepEqual((await app.inject({ method: "GET", url: "/api/projects", headers: headers(b.token) })).json(), []);
    const bytes = await sharp({ create: { width: 40, height: 60, channels: 3, background: "#00aa88" } }).jpeg().toBuffer();
    const boundary = "test-boundary";
    const upload = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="cup.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`), bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const uploaded = await app.inject({ method: "POST", url: "/api/photos", headers: { ...headers(a.token), "content-type": `multipart/form-data; boundary=${boundary}` }, payload: upload });
    assert.equal(uploaded.statusCode, 201, uploaded.body);
    const photo = uploaded.json();
    const command = { requestKey: randomUUID(), projectId: project.id, fields: { ...emptyFields, name: "杯子", supplier: "模拟商户", unitPrice: 12 }, photoIds: [photo.id] };
    const saved = await app.inject({ method: "POST", url: "/api/products", headers: headers(a.token), payload: command });
    assert.equal(saved.statusCode, 201, saved.body);
    const product = saved.json();
    assert.equal(product.version, 1);
    const replays = await Promise.all([1, 2, 3].map(() => app.inject({ method: "POST", url: "/api/products", headers: headers(a.token), payload: command })));
    replays.forEach(r => assert.deepEqual(r.json(), product));
    closeDB();
    assert.deepEqual((await app.inject({ method: "POST", url: "/api/products", headers: headers(a.token), payload: command })).json(), product);
    assert.equal((await app.inject({ method: "GET", url: photo.url })).statusCode, 401);
    assert.equal((await app.inject({ method: "GET", url: photo.url, headers: headers(a.token) })).headers["cache-control"], "no-store");
    for (const url of [`/api/products/${product.id}`, `/api/products?projectId=${project.id}`, photo.url, `/api/export?projectId=${project.id}`, `/api/suppliers?projectId=${project.id}`]) {
      assert.equal((await app.inject({ method: "GET", url, headers: headers(b.token) })).statusCode, 404, url);
    }
    assert.equal((await app.inject({ method: "POST", url: "/api/extract", headers: headers(b.token), payload: { photoIds: [photo.id], description: "杯子" } })).statusCode, 404);
    assert.equal((await app.inject({ method: "POST", url: "/api/products", headers: headers(b.token), payload: { ...command, requestKey: randomUUID() } })).statusCode, 404);
    assert.equal((await app.inject({ method: "DELETE", url: `/api/products/${product.id}`, headers: headers(b.token), payload: { version: 1 } })).statusCode, 404);
    const extraction = await app.inject({ method: "POST", url: "/api/extract", headers: headers(a.token), payload: { description: "单个300克，每箱24个，100个起订", photoIds: [photo.id] } });
    assert.equal(extraction.json().fields.weightG, 300); assert.equal(extraction.json().fields.moq, 100);
    const edited = await app.inject({ method: "POST", url: "/api/products", headers: headers(a.token), payload: { ...command, requestKey: randomUUID(), id: product.id, version: 1, fields: { ...command.fields, unitPrice: 15 } } });
    assert.equal(edited.json().version, 2);
    const stale = await app.inject({ method: "POST", url: "/api/products", headers: headers(a.token), payload: { ...command, requestKey: randomUUID(), id: product.id, version: 1 } });
    assert.equal(stale.statusCode, 409);
    const exported = await app.inject({ method: "GET", url: `/api/export?projectId=${project.id}`, headers: headers(a.token) });
    assert.equal(exported.statusCode, 200); assert.ok(exported.rawPayload.length > 1000);
    assert.deepEqual((await app.inject({ method: "GET", url: `/api/suppliers?projectId=${project.id}`, headers: headers(a.token) })).json(), ["模拟商户"]);
    assert.equal((await app.inject({ method: "DELETE", url: `/api/products/${product.id}`, headers: jsonHeaders(a.token), payload: JSON.stringify({ version: 2 }) })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: photo.url, headers: headers(a.token) })).statusCode, 404);
    assert.equal((await app.inject({ method: "POST", url: "/api/auth/logout", headers: headers(a.token) })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: "/api/projects", headers: headers(a.token) })).statusCode, 401);
  } finally { await app.close(); }
});

test("legacy migration keeps old records hidden and is repeatable", () => {
  const legacy = new DatabaseSync(":memory:");
  try {
    legacy.exec("CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,market TEXT,date TEXT,demo INTEGER,created_at TEXT); CREATE TABLE products(id TEXT PRIMARY KEY,project_id TEXT,fields TEXT,created_at TEXT,updated_at TEXT); CREATE TABLE photos(id TEXT,product_id TEXT,name TEXT,position INTEGER); INSERT INTO projects VALUES('old','旧记录','','2026-10-02',0,'now')");
    migrate(legacy); migrate(legacy);
    assert.equal((legacy.prepare("SELECT owner_id FROM projects").get() as { owner_id: string }).owner_id, "__legacy__");
    assert.equal((legacy.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 5);
    assert.equal((legacy.prepare('SELECT COUNT(*) AS count FROM pragma_table_info(\'products\') WHERE name=\'deleted_at\'').get() as { count: number }).count, 1);
    assert.equal((legacy.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='index' AND name='products_trash'").get() as { count: number }).count, 1);
  } finally { legacy.close(); }
  assert.ok(listProjects(issueSession("new-user").user.id).every(p => p.id !== "old"));
});

test("public-service validation rejects private, reserved and redirect-prone endpoints", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "9.2.3.4", "11.2.3.4", "21.2.3.4", "30.2.3.4", "172.16.0.1", "192.168.1.1", "169.254.169.254", "::1", "::ffff:127.0.0.1", "fc00::1", "2001:db8::1", "2002:7f00:1::"]) assert.equal(isPublicAddress(ip), false, ip);
  assert.equal(isPublicAddress("8.8.8.8"), true);
  for (const url of ["http://example.com", "https://localhost", "https://192.168.1.1", "https://10.1.2.3", "https://user:pass@example.com"]) assert.throws(() => validateServiceURL(new URL(url)), /公网 HTTPS/);
});

test("staged media expiry blocks save and cleanup; oversized JSON is rejected", async () => {
  const auth = issueSession("expiry-user"), photo = stagePhoto(auth.user.id, { name: "expired.jpg", bytes: Buffer.from("test") });
  db().prepare("UPDATE media SET expires_at=? WHERE id=?").run(Date.now() - 1000, photo.id);
  collectGarbage();
  assert.equal(db().prepare("SELECT id FROM media WHERE id=?").get(photo.id), undefined);
  const app = await makeApp();
  try {
    const response = await app.inject({ method: "POST", url: "/api/projects", headers: headers(auth.token), payload: { requestKey: randomUUID(), name: "x".repeat(70000), market: "", date: "2026-10-15" } });
    assert.equal(response.statusCode, 413);
  } finally { await app.close(); }
});

test("rejects expired sessions and malformed login", async () => {
  const auth = issueSession("expired-session");
  db().prepare("UPDATE sessions SET expires_at=? WHERE owner_id=?").run(Date.now() - 1, auth.user.id);
  const app = await makeApp();
  try {
    assert.equal((await app.inject({ method: "GET", url: "/api/auth/me", headers: headers(auth.token) })).statusCode, 401);
    assert.equal((await app.inject({ method: "POST", url: "/api/auth/wechat", payload: { code: "", owner: "forged" } })).statusCode, 400);
    assert.equal((await app.inject({ method: "GET", url: "/api/projects", headers: { authorization: "Bearer forged" } })).statusCode, 401);
  } finally { await app.close(); }
});

test("own photos cannot be reused across products and photo order is preserved", () => {
  const owner = issueSession("media-owner").user.id;
  const project = repository.createProject(owner, { name: "照片顺序", market: "", date: "2026-10-15" }, randomUUID());
  const one = stagePhoto(owner, { name: "one.jpg", bytes: Buffer.from("one") });
  const two = stagePhoto(owner, { name: "two.jpg", bytes: Buffer.from("two") });
  const command = { requestKey: randomUUID(), projectId: project.id, fields: { ...emptyFields, name: "杯" }, photoIds: [two.id, one.id] };
  const product = saveProduct(owner, command);
  assert.deepEqual(product.photos.map(p => p.id), [two.id, one.id]);
  assert.throws(() => saveProduct(owner, { ...command, requestKey: randomUUID() }), /归属无效/);
  assert.throws(() => saveProduct(owner, { ...command, requestKey: randomUUID(), photoIds: [one.id, one.id] }), /不重复/);
  assert.throws(() => saveProduct(owner, { ...command, photoIds: [] }), /内容已变化/);
});

test("development login is explicit and local-only", async () => {
  const old = { allow: process.env.ALLOW_DEV_LOGIN, host: process.env.HOST, mode: process.env.NODE_ENV };
  process.env.ALLOW_DEV_LOGIN = "true"; process.env.HOST = "127.0.0.1"; process.env.NODE_ENV = "development";
  const app = await makeApp();
  try {
    const config = await app.inject({ method: "GET", url: "/api/config" });
    assert.equal(config.json().devLoginEnabled, true);
    const local = await app.inject({ method: "POST", url: "/api/auth/dev", payload: {}, remoteAddress: "127.0.0.1" });
    assert.equal(local.statusCode, 200);
    assert.equal((await app.inject({ method: "POST", url: "/api/auth/dev", payload: {}, remoteAddress: "8.8.8.8" })).statusCode, 404);
  } finally {
    await app.close();
    for (const [key, value] of [["ALLOW_DEV_LOGIN", old.allow], ["HOST", old.host], ["NODE_ENV", old.mode]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("upstream error is recoverable and errors do not leak details", async () => {
  const auth = issueSession("error-user");
  const app = await createApp({ service: new MarketService(undefined, { enabled: () => true, extract: async () => { throw new AppError("UPSTREAM_TIMEOUT", "智能整理超时，请手工填写", 504); } }) });
  try {
    const response = await app.inject({ method: "POST", url: "/api/extract", headers: headers(auth.token), payload: { description: "杯子" } });
    assert.equal(response.statusCode, 504); assert.equal(response.json().error.code, "UPSTREAM_TIMEOUT");
    assert.equal((await app.inject({ method: "POST", url: "/api/auth/dev", payload: {} })).statusCode, 404);
  } finally { await app.close(); }
});

test('全任务筛选和汇总跨越第一页，按账号隔离且搜索符号按原文匹配', async () => {
  const a = issueSession('sourcing-filter-a'), b = issueSession('sourcing-filter-b');
  const project = repository.createProject(a.user.id, { name: '义乌筛选', market: '国际商贸城二区', date: '2026-10-16' }, randomUUID());
  const target = repository.saveProduct(a.user.id, { requestKey: randomUUID(), projectId: project.id, fields: { ...emptyFields, name: '目标陶瓷杯', sku: 'YW_%42', supplier: '博艺陶瓷', supplierContact: '陈女士 / 微信 demo', confirmed: true }, photoIds: [] });
  db().prepare('UPDATE products SET created_at=? WHERE id=?').run('2026-10-15T00:00:00.000Z', target.id);
  for (let i = 0; i < 32; i++) repository.saveProduct(a.user.id, { requestKey: randomUUID(), projectId: project.id, fields: { ...emptyFields, name: '普通商品' + i, unitPrice: i, supplier: '其他商户' }, photoIds: [] });
  const app = await makeApp();
  const request = (q: string) => app.inject({ method: 'GET', url: '/api/products?' + new URLSearchParams({ projectId: project.id, ...Object.fromEntries(new URLSearchParams(q)) }), headers: headers(a.token) });
  try {
    const first = (await request('')).json();
    assert.equal(first.items.length, 30); assert.ok(!first.items.some((p: { id: string }) => p.id === target.id));
    assert.deepEqual(first.summary, { total: 33, pending: 32, confirmed: 1, missingPrice: 1, suppliers: 2, photos: 0 });
    for (const q of ['q=YW_%25', 'q=陈女士', 'status=confirmed', 'status=missingPrice', 'q=陶瓷&status=confirmed']) {
      const result = (await request(q)).json();
      assert.equal(result.matchedCount, 1, q); assert.equal(result.items[0].id, target.id, q); assert.equal(result.summary.total, 33);
    }
    assert.equal((await request('q=%25')).json().matchedCount, 1);
    const projects = (await app.inject({ method: 'GET', url: '/api/projects', headers: headers(a.token) })).json();
    assert.deepEqual(projects.find((p: { id: string }) => p.id === project.id).summary, first.summary);
    assert.equal((await app.inject({ method: 'GET', url: `/api/projects/${project.id}/summary`, headers: headers(b.token) })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: `/api/products?projectId=${project.id}&q=陶瓷`, headers: headers(b.token) })).statusCode, 404);
  } finally { await app.close(); }
});

test('新增采购字段兼容旧记录，纯数据与仅确认导出内容正确', async () => {
  const account = issueSession('sourcing-export-owner');
  const project = repository.createProject(account.user.id, { name: '导出采购表', market: '义乌', date: '2026-10-16' }, randomUUID());
  const legacy = repository.saveProduct(account.user.id, { requestKey: randomUUID(), projectId: project.id, fields: { ...emptyFields, name: '旧记录' }, photoIds: [] });
  db().prepare('UPDATE products SET fields=? WHERE id=?').run(JSON.stringify({ name: '旧记录', supplier: '', unitPrice: null, confirmed: false }), legacy.id);
  const old = repository.getProduct(account.user.id, legacy.id);
  assert.equal(old.sku, ''); assert.equal(old.cartonCbm, null); assert.equal(old.leadTimeDays, null);
  const fields = { ...emptyFields, name: '陶瓷杯', sku: 'YW-42', supplier: '博艺陶瓷 · 二区102', supplierContact: '陈女士 / demo微信', tradeTerms: 'FOB 宁波', leadTimeDays: 18, cartonDimensions: '40×30×35cm', cartonCbm: 0.042, unitPrice: 12.5, confirmed: true };
  const app = await makeApp();
  try {
    const saved = await app.inject({ method: 'POST', url: '/api/products', headers: headers(account.token), payload: { requestKey: randomUUID(), projectId: project.id, fields, photoIds: [] } });
    assert.equal(saved.statusCode, 201, saved.body); assert.equal(saved.json().cartonCbm, 0.042);
    const result = await app.inject({ method: 'GET', url: `/api/export?projectId=${project.id}&scope=confirmed&images=no`, headers: headers(account.token) });
    assert.equal(result.statusCode, 200, result.body);
    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(result.rawPayload as unknown as import('exceljs').Buffer);
    const records = quotationRows(workbook, false); assert.deepEqual(records.map(record => record.description), ['陶瓷杯 / 外箱：40×30×35cm']);
    const { sheet, columns, value } = records[0];
    assert.equal(sheet.name, fields.supplier); assert.equal(sheet.getImages().length, 0);
    assert.ok(!columns.includes('图片'), 'images=no omits the column entirely');
    assert.ok(!columns.includes('商品名称')); assert.equal(value(referenceLabel('sku')), 'YW-42');
    assert.ok(!columns.includes('商户联系方式')); assert.ok(!columns.includes('现场备注'));
    assert.equal(value(referenceLabel('unitPrice')), 12.5);
    assert.equal(value(referenceLabel('quantity')), null); assert.equal(value(referenceLabel('amount')), null);
    assert.equal(value(referenceLabel('cartonCbm')), 0.042); assert.equal(value(referenceLabel('cbm')), null);
    assert.ok(!columns.includes('资料核对')); assert.ok(!columns.includes('大货交期(天)')); assert.ok(!columns.includes('现场记录报价条款'));
    assert.match(workbook.getWorksheet('说明')!.getCell('B6').text, /仅导出已人工核对/);
    const template = defaultProcurementTemplate();
    template.columns.find(column => column.key === 'decision')!.enabled = true;
    const explicit = await service.export(account.user.id, project.id, { template, scope: 'confirmed', images: false, businessFields: ['name', 'leadTimeDays', 'tradeTerms'] });
    assert.deepEqual(explicit.metadata!.columns.map(column => column.key), [...template.columns.filter(column => column.enabled && column.key !== 'image').map(column => column.key), 'business:name', 'business:leadTimeDays', 'business:tradeTerms']);
    const explicitWorkbook = new ExcelJS.Workbook(); await explicitWorkbook.xlsx.load(explicit.bytes as never);
    const explicitRecords = quotationRows(explicitWorkbook, false, ['资料核对', '商品名称', '大货交期(天)', '现场记录报价条款']);
    assert.equal(explicitRecords.length, 1); assert.equal(explicitRecords[0].value('商品名称'), '陶瓷杯');
    assert.equal(explicitRecords[0].value('资料核对'), '已核对'); assert.equal(explicitRecords[0].value(referenceLabel('cartonCbm')), 0.042);
    assert.equal(explicitRecords[0].value('大货交期(天)'), 18); assert.equal(explicitRecords[0].value('现场记录报价条款'), 'FOB 宁波');
    assert.equal((await app.inject({ method: 'GET', url: `/api/export?projectId=${project.id}&scope=selected`, headers: headers(account.token) })).statusCode, 400);
  } finally { await app.close(); }
});

test('个人资料按账号保存，严格校验，支持确认重试并拒绝覆盖新版本', async () => {
  const a = issueSession('profile-a'), b = issueSession('profile-b'), app = await makeApp();
  const fields = { name: '  李女士  ', company: '样例外贸公司', role: 'buyer', phone: '0579-12345678', wechat: 'sample', defaultCurrency: 'USD', version: 0 };
  const write = (payload: object, token = a.token) => app.inject({ method: 'POST', url: '/api/profile', headers: headers(token), payload });
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/api/auth/me', headers: headers(a.token) })).json().user.profile.version, 0);
    const saved = await write(fields); assert.equal(saved.statusCode, 200); assert.equal(saved.json().version, 1); assert.equal(saved.json().name, '李女士');
    assert.deepEqual((await write(fields)).json(), saved.json(), 'lost acknowledgement retry is safe');
    assert.equal(issueSession('profile-a').user.profile.defaultCurrency, 'USD', 'new login retrieves the saved profile');
    assert.equal((await app.inject({ method: 'GET', url: '/api/auth/me', headers: headers(b.token) })).json().user.profile.name, '');
    assert.equal((await write({ ...fields, owner: b.user.id })).statusCode, 400);
    assert.equal((await write({ ...fields, role: 'admin' })).statusCode, 400);
    assert.equal((await write({ ...fields, phone: 'x'.repeat(81) })).statusCode, 400);
    assert.equal((await write({ ...fields, name: '新姓名' })).statusCode, 409);
    assert.equal((await write({ ...fields, name: '新姓名', version: 1 })).json().version, 2);
    assert.equal((await app.inject({ method: 'POST', url: '/api/profile', payload: fields })).statusCode, 401);
  } finally { await app.close(); }
});

test('v2 数据库升级个人资料表保留商品与登录会话', () => {
  const connection = new DatabaseSync(':memory:');
  try {
    migrate(connection);
    // Build an actual v2 schema rather than only downgrading its version marker.
    connection.exec("DROP TABLE user_profiles; DROP INDEX products_trash; ALTER TABLE products DROP COLUMN deleted_at; PRAGMA user_version=2; INSERT INTO users VALUES('owner','wx-owner','now'); INSERT INTO projects(id,name,market,date,demo,created_at,owner_id) VALUES('project','原任务','','2026-10-16',0,'now','owner'); INSERT INTO products(id,project_id,fields,created_at,updated_at,version) VALUES('product','project','{}','now','now',1); INSERT INTO sessions VALUES('token','owner',9999999999999)");
    migrate(connection); migrate(connection);
    assert.equal((connection.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 5);
    assert.equal((connection.prepare('SELECT id FROM products').get() as { id: string }).id, 'product');
    assert.equal((connection.prepare('SELECT owner_id FROM sessions').get() as { owner_id: string }).owner_id, 'owner');
    assert.deepEqual(connection.prepare('SELECT * FROM user_profiles').all(), []);
    assert.equal((connection.prepare('SELECT deleted_at FROM products').get() as { deleted_at: null }).deleted_at, null);
    assert.equal((connection.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='index' AND name='products_trash'").get() as { count: number }).count, 1);
  } finally { connection.close(); }
});

test('按中国日跨任务回顾：午夜边界、修改保留日期、分页、搜索、账号隔离和当天导出', async () => {
  const a = issueSession('day-a'), b = issueSession('day-b'), app = await makeApp();
  const makeProject = (owner: string, name: string) => repository.createProject(owner, { name, market: '一区', date: '2026-10-01' }, randomUUID());
  const p1 = makeProject(a.user.id, '客户甲'), p2 = makeProject(a.user.id, '客户乙'), other = makeProject(b.user.id, '私有任务');
  const makeProduct = (owner: string, projectId: string, name: string, at: string, confirmed = false) => {
    const value = saveProduct(owner, { requestKey: randomUUID(), projectId, fields: { ...emptyFields, name, confirmed }, photoIds: [] });
    db().prepare('UPDATE products SET created_at=?,updated_at=? WHERE id=?').run(at, at, value.id); return value;
  };
  makeProduct(a.user.id, p1.id, '前一天', '2026-10-15T15:59:59.999Z');
  const start = makeProduct(a.user.id, p1.id, '日初杯子', '2026-10-15T16:00:00.000Z', true);
  const end = makeProduct(a.user.id, p2.id, '日末杯子', '2026-10-16T15:59:59.999Z');
  makeProduct(a.user.id, p1.id, '下一天', '2026-10-16T16:00:00.000Z');
  makeProduct(b.user.id, other.id, '他人记录', '2026-10-16T08:00:00.000Z');
  saveProduct(a.user.id, { requestKey: randomUUID(), projectId: p1.id, id: start.id, version: 1, fields: { ...emptyFields, name: '日初杯子', confirmed: true, unitPrice: 12 }, photoIds: [] });
  const get = (url: string, token = a.token) => app.inject({ method: 'GET', url, headers: headers(token) });
  try {
    const first = (await get('/api/products?date=2026-10-16&limit=1')).json();
    assert.deepEqual(first.items.map((x: { id: string }) => x.id), [end.id]); assert.equal(first.summary.total, 2); assert.equal(first.summary.confirmed, 1); assert.equal(first.matchedCount, 2); assert.ok(first.nextCursor);
    const second = (await get('/api/products?date=2026-10-16&limit=1&cursor=' + first.nextCursor)).json();
    assert.deepEqual(second.items.map((x: { id: string }) => x.id), [start.id]); assert.equal(second.nextCursor, null); assert.equal(second.items[0].taskName, '客户甲');
    assert.equal(first.items[0].taskName, '客户乙'); assert.equal(first.items[0].taskDate, '2026-10-01');
    assert.equal(second.items[0].taskDate, '2026-10-01');
    assert.equal((await get('/api/products?date=2026-10-17&cursor=' + first.nextCursor)).statusCode, 400);
    assert.equal((await get('/api/products?date=2026-10-16&q=杯子&status=confirmed')).json().items[0].id, start.id);
    assert.equal((await get('/api/products?date=2026-10-16&projectId=' + p2.id)).json().summary.total, 1);
    assert.equal((await get('/api/products?date=2026-10-16', b.token)).json().summary.total, 1);
    assert.equal((await get('/api/products?date=2026-02-30')).statusCode, 400);
    assert.equal((await get('/api/products')).statusCode, 400);
    const response = await get('/api/export?date=2026-10-16&images=no'); assert.equal(response.statusCode, 200);
    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(response.rawPayload as never);
    const records = quotationRows(workbook, false);
    assert.deepEqual(records.map(record => record.description), ['日末杯子', '日初杯子']);
    assert.equal(records[0].value(referenceLabel('unitPrice')), null); assert.equal(records[1].value(referenceLabel('unitPrice')), 12);
    const template = defaultProcurementTemplate(); template.columns.find(column => column.key === 'decision')!.enabled = true;
    const explicit = await service.export(a.user.id, undefined, { template, date: '2026-10-16', images: false, businessFields: ['project', 'date', 'recordDate'], audience: 'internal' });
    const explicitWorkbook = new ExcelJS.Workbook(); await explicitWorkbook.xlsx.load(explicit.bytes as never);
    const dated = quotationRows(explicitWorkbook, false, ['资料核对', '看货任务', '任务日期', '记录日期']);
    assert.deepEqual(dated.map(record => record.value('资料核对')), ['待核对', '已核对']);
    assert.deepEqual(dated.map(record => record.value('看货任务')), ['客户乙', '客户甲']);
    assert.deepEqual(dated.map(record => record.value('任务日期')), ['2026-10-01', '2026-10-01']);
    assert.deepEqual(dated.map(record => record.value('记录日期')), ['2026-10-16', '2026-10-16']);
    assert.equal(workbook.getWorksheet('说明')!.getCell('B1').value, '2026-10-16 看货记录');
    assert.equal((await get('/api/export?date=2026-10-16&projectId=' + other.id)).statusCode, 404);
  } finally { await app.close(); }
});

test('AI 图像路径传入本人照片并保留明确字段，不启用模型时仅整理文字', async () => {
  const owner = issueSession('vision-path').user.id, photo = stagePhoto(owner, { name: '标签.jpg', bytes: Buffer.from('sample-image-bytes') });
  let called = false;
  const vision = new MarketService(undefined, { enabled: () => true, extract: async (description, images) => {
    called = true; assert.equal(description, '标签'); assert.equal(images[0], 'data:image/jpeg;base64,' + Buffer.from('sample-image-bytes').toString('base64'));
    return { fields: { name: '标签商品', unitPrice: 12, weightG: null }, mode: 'model', warning: '需人工核对' };
  } });
  const result = await vision.extract(owner, '标签', [photo.id]); assert.ok(called); assert.equal(result.mode, 'model'); assert.equal(result.fields.weightG, null);
  const foreign = issueSession('vision-other').user.id; await assert.rejects(() => vision.extract(foreign, '', [photo.id]), (e: unknown) => e instanceof AppError && e.code === 'NOT_FOUND');
  const fallback = await service.extract(owner, '杯子，12元一个', [photo.id]); assert.equal(fallback.mode, 'rules'); assert.match(fallback.warning, /照片仅存档/);
});

test('收藏单独更新不改采购字段，版本冲突、重试和跨账号访问受保护', async () => {
  const a = issueSession('favorite-a'), b = issueSession('favorite-b'), app = await makeApp();
  const project = repository.createProject(a.user.id, { name: '收藏测试', market: '', date: '2026-10-16' }, randomUUID());
  const product = saveProduct(a.user.id, { requestKey: randomUUID(), projectId: project.id, fields: { ...emptyFields, name: '杯', unitPrice: 12, confirmed: true, rating: 4, evaluation: '适合自然风客户' }, photoIds: [] });
  saveProduct(a.user.id, { requestKey: randomUUID(), projectId: project.id, fields: { ...emptyFields, name: '未收藏商品', confirmed: true }, photoIds: [] });
  const write = (favorite: boolean, version: number, token = a.token) => app.inject({ method: 'POST', url: `/api/products/${product.id}/favorite`, headers: headers(token), payload: { favorite, version } });
  try {
    const saved = await write(true, 1); assert.equal(saved.statusCode, 200); assert.equal(saved.json().version, 2); assert.equal(saved.json().confirmed, true); assert.equal(saved.json().unitPrice, 12);
    assert.equal((await write(true, 1)).json().version, 2);
    assert.equal((await write(false, 1)).statusCode, 409);
    assert.equal((await write(false, 2, b.token)).statusCode, 404);
    const list = await app.inject({ method: 'GET', url: '/api/products?favorite=yes&q=自然风', headers: headers(a.token) });
    assert.equal(list.json().items[0].id, product.id); assert.equal(list.json().items[0].rating, 4);
    const foreign = await app.inject({ method: 'GET', url: '/api/products?favorite=yes', headers: headers(b.token) }); assert.equal(foreign.json().items.length, 0);
    const exported = await app.inject({ method: 'GET', url: '/api/export?favorite=yes&images=no', headers: headers(a.token) }); assert.equal(exported.statusCode, 200);
    const ExcelJS = (await import('exceljs')).default, workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(exported.rawPayload as never);
    const records = quotationRows(workbook, false); assert.deepEqual(records.map(record => record.description), ['杯']);
    for (const label of ['收藏', '选品评分', '选品评价', '商户联系方式']) assert.ok(!records[0].columns.includes(label));
    assert.equal(records[0].value(referenceLabel('unitPrice')), 12);
    const internal = await app.inject({ method: 'GET', url: '/api/export?favorite=yes&images=no&audience=internal', headers: headers(a.token) });
    assert.equal(internal.statusCode, 200);
    const internalWorkbook = new ExcelJS.Workbook(); await internalWorkbook.xlsx.load(internal.rawPayload as never);
    const internalMetadata = quotationExportMetadata(defaultProcurementTemplate(), { audience: 'internal', images: false });
    const internalRecords = quotationRows(internalWorkbook, false, internalMetadata.columns.filter(column => column.businessField).map(column => column.label));
    assert.deepEqual(internalRecords.map(record => record.description), ['杯']);
    assert.equal(internalRecords[0].value('选品评分'), 4); assert.equal(internalRecords[0].value('选品评价'), '适合自然风客户');
    const explicit = await service.export(a.user.id, undefined, { template: defaultProcurementTemplate(), favorite: true, images: false, audience: 'internal', businessFields: ['rating', 'evaluation'] });
    const explicitWorkbook = new ExcelJS.Workbook(); await explicitWorkbook.xlsx.load(explicit.bytes as never);
    const metadataRecords = quotationRows(explicitWorkbook, false, ['选品评分', '选品评价']);
    assert.deepEqual(metadataRecords.map(record => record.description), ['杯']);
    assert.equal(metadataRecords[0].value('选品评分'), 4); assert.equal(metadataRecords[0].value('选品评价'), '适合自然风客户');
    const selection = await service.export(a.user.id, undefined, { template: defaultProcurementTemplate(), favorite: true, images: false, audience: 'selection', businessFields: ['rating', 'evaluation', 'supplierContact'] });
    const selectedWorkbook = new ExcelJS.Workbook(); await selectedWorkbook.xlsx.load(selection.bytes as never);
    assert.deepEqual(quotationRows(selectedWorkbook, false).map(record => record.description), ['杯']);
    await assert.rejects(service.export(b.user.id, project.id, { template: defaultProcurementTemplate(), businessFields: ['rating'], audience: 'internal' }), /不存在/);
    assert.equal((await write(false, 2)).json().version, 3);
    assert.equal((await app.inject({ method: 'GET', url: '/api/products?favorite=yes', headers: headers(a.token) })).json().items.length, 0);
    const invalid = await app.inject({ method: 'POST', url: '/api/products', headers: headers(a.token), payload: { requestKey: randomUUID(), projectId: project.id, fields: { name: 'bad', rating: 6 } } }); assert.equal(invalid.statusCode, 400);
  } finally { await app.close(); }
});

test('日期标记按中国记录日聚合且账号隔离', async () => {
  const a = issueSession('rail-a'), b = issueSession('rail-b'), app = await makeApp();
  const project = repository.createProject(a.user.id, { name: '日期点', market: '', date: '2026-10-01' }, randomUUID());
  for (const [index, at] of ['2026-10-15T15:59:59.000Z', '2026-10-15T16:00:00.000Z', '2026-10-16T01:00:00.000Z'].entries()) {
    const product = saveProduct(a.user.id, { requestKey: randomUUID(), projectId: project.id, fields: { ...emptyFields, name: '商品' + index }, photoIds: [] });
    db().prepare('UPDATE products SET created_at=? WHERE id=?').run(at, product.id);
  }
  try {
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/record-days', headers: headers(a.token) })).json(), [{ date: '2026-10-16', count: 2 }, { date: '2026-10-15', count: 1 }]);
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/record-days', headers: headers(b.token) })).json(), []);
    assert.equal((await app.inject({ method: 'GET', url: '/api/record-days' })).statusCode, 401);
  } finally { await app.close(); }
});


test('头像规范化为小JPEG，资料保存与账号隔离，拒绝伪装图片', async () => {
  const a = issueSession('avatar-a'), b = issueSession('avatar-b'), app = await makeApp();
  try {
    const image = (await sharp({create:{width:160,height:160,channels:3,background:'#849b88'}}).png().toBuffer()).toString('base64');
    const normalized = await app.inject({method:'POST',url:'/api/profile/avatar',headers:headers(a.token),payload:{image}});
    assert.equal(normalized.statusCode,200,normalized.body);
    const avatar = normalized.json().avatar as string;
    assert.match(avatar,/^data:image\/jpeg;base64,/);assert.ok(avatar.length < 32768);
    const meta = await sharp(Buffer.from(avatar.split(',')[1],'base64')).metadata();assert.equal(meta.width,96);assert.equal(meta.height,96);
    const saved = await app.inject({method:'POST',url:'/api/profile',headers:headers(a.token),payload:{name:'头像测试',company:'',role:'buyer',phone:'',wechat:'',defaultCurrency:'CNY',version:0,avatar}});
    assert.equal(saved.statusCode,200,saved.body);assert.equal(saved.json().avatar,avatar);
    assert.equal((await app.inject({method:'GET',url:'/api/auth/me',headers:headers(b.token)})).json().user.profile.avatar,undefined);
    assert.equal((await app.inject({method:'POST',url:'/api/profile/avatar',headers:headers(a.token),payload:{image:Buffer.from('fake JPEG').toString('base64')}})).statusCode,400);
    assert.equal((await app.inject({method:'POST',url:'/api/profile/avatar',payload:{image}})).statusCode,401);
  } finally {await app.close();}
});
