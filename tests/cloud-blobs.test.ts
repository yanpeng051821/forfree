import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../src/lib/errors';
import { CloudBlobStore, CLOUD_BLOB_BUCKET, MAX_BLOB_BYTES, type BlobStore } from '../src/server/cloud-blobs';

const ENV = 'huoji-5g123456789abcde';
const BASE = `https://${ENV}.api.tcloudbasegateway.com`;
const API_KEY = 'test-service-api-key-secret';
const OWNER = '11111111-1111-4111-8111-111111111111';
const ID = '22222222-2222-4222-8222-222222222222';
const KEY = `${OWNER}/photos/${ID}.jpg`;
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const DOWNLOAD = `${BASE}/v1/storages/object/sign/${CLOUD_BLOB_BUCKET}/${KEY}?token=opaque%2Bdownload%2Ftoken`;
const UPLOAD = `${BASE}/v1/storages/object/upload/sign/${CLOUD_BLOB_BUCKET}/${KEY}?token=opaque-upload-token`;
interface Call { url: string; init: RequestInit; headers: Headers }

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}
function queue(...responses: Response[]) {
  const calls: Call[] = [];
  const fetcher: typeof globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, init, headers: new Headers(init.headers) });
    const response = responses.shift();
    if (!response) throw new Error('测试缺少模拟响应');
    return response;
  };
  return { calls, fetcher, store: new CloudBlobStore(ENV, API_KEY, fetcher) };
}
function safeError(code: string, status: number) {
  return (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    const serialized = `${String(error)} ${JSON.stringify(error)} ${error.stack}`;
    for (const secret of [API_KEY, 'opaque-download-token', 'opaque-upload-token', 'upstream-secret', BASE]) assert.ok(!serialized.includes(secret));
    return true;
  };
}
function authorized(call: Call, method: string, path: string) {
  assert.equal(call.url, BASE + path);
  assert.equal(call.init.method, method);
  assert.equal(call.headers.get('Authorization'), `Bearer ${API_KEY}`);
  assert.equal(call.init.redirect, 'error');
  assert.equal(call.init.credentials, 'omit');
  assert.equal(call.init.referrerPolicy, 'no-referrer');
  assert.equal(call.init.cache, 'no-store');
  assert.ok(call.init.signal instanceof AbortSignal);
  assert.equal(new URL(call.url).host, new URL(BASE).host);
}
function streamed(chunkSize: number, count: number, headers: Record<string, string> = {}) {
  const state = { sent: 0, cancelled: false };
  const chunk = new Uint8Array(chunkSize);
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.sent === count) controller.close();
      else { state.sent++; controller.enqueue(chunk); }
    },
    cancel() { state.cancelled = true; },
  });
  return { state, response: new Response(body, { headers }) };
}

// 仅离线 HTTP 契约测试；所有 fetch 都被替换，不验证云端桶、权限或网关能力。
test('构造器使用 canonical 环境标签，拒绝 URL、域名注入及非法服务 key', () => {
  const fake: typeof globalThis.fetch = async () => { throw new Error('不应调用网络'); };
  for (const env of ['', 'Huoji-abc', '-huoji', 'huoji-', 'huoji.test', 'localhost:80', 'https://env', 'env/path', 'env@host', 'env\\host', 'env\n', 'a'.repeat(64), '中文']) {
    assert.throws(() => new CloudBlobStore(env, API_KEY, fake), safeError('CLOUD_CONFIG', 503));
  }
  for (const secret of ['', ' key', 'key ', 'key\n', 'key\r\nHeader: injected', 'key\0', '密钥']) {
    assert.throws(() => new CloudBlobStore(ENV, secret, fake), safeError('CLOUD_CONFIG', 503));
  }
  assert.doesNotThrow(() => new CloudBlobStore(ENV, API_KEY, fake));
  assert.ok(!JSON.stringify(new CloudBlobStore(ENV, API_KEY, fake)).includes(API_KEY));
});

test('默认使用 global fetch，服务 key 仅存在于授权头', async context => {
  const fake = queue(json({ id: ID }));
  context.mock.method(globalThis, 'fetch', fake.fetcher);
  await new CloudBlobStore(ENV, API_KEY).write(KEY, Buffer.from([1, 2]), 'image/jpeg');
  assert.equal(fake.calls.length, 1);
  authorized(fake.calls[0], 'POST', `/v1/storages/object/${CLOUD_BLOB_BUCKET}/${KEY}`);
  assert.ok(!fake.calls[0].url.includes(API_KEY));
});

test('write 使用直接二进制 POST，允许五种 owner 路径并校验响应', async () => {
  for (const [folder, extension, mime] of [['photos', 'jpg', 'image/jpeg'], ['pictures', 'jpg', 'image/jpeg'], ['procurement', 'xlsx', XLSX], ['uploads', 'xlsx', XLSX], ['exports', 'xlsx', XLSX]]) {
    const key = `${OWNER}/${folder}/${ID}.${extension}`;
    const fake = queue(json({ Id: ID, Key: `${CLOUD_BLOB_BUCKET}/${key}` }, 201));
    const store: BlobStore = fake.store;
    const bytes = Buffer.from([0, 1, 255]);
    assert.equal(await store.write(key, bytes, mime), undefined);
    assert.equal(fake.calls.length, 1);
    authorized(fake.calls[0], 'POST', `/v1/storages/object/${CLOUD_BLOB_BUCKET}/${key}`);
    assert.equal(fake.calls[0].headers.get('Content-Type'), mime);
    assert.ok(fake.calls[0].init.body instanceof Uint8Array);
    assert.deepEqual(Buffer.from(fake.calls[0].init.body), bytes);
  }
});

test('所有方法在请求前拒绝 traversal、编码斜杠、无 owner 和非严格 UUID', async () => {
  const fake = queue();
  const invalid = [
    `photos/${ID}.jpg`, `procurement/${ID}.xlsx`, `${CLOUD_BLOB_BUCKET}/${KEY}`, `/${KEY}`, `${KEY}/`,
    `${OWNER}//photos/${ID}.jpg`, `${OWNER}/../${ID}.jpg`, `${OWNER}/./${ID}.jpg`,
    `${OWNER}/photos/../${ID}.jpg`, `${OWNER}\\photos\\${ID}.jpg`, `${OWNER}/photos/%2e%2e.jpg`,
    `${OWNER}/photos/${ID}%2f.jpg`, `${OWNER}/photos/${ID}%252f.jpg`, `${OWNER}/photos/${ID}.jpg?token=x`,
    `${OWNER}/photos/${ID}.jpg#x`, `${OWNER}/photos/${ID}.jpg\n`, `${OWNER}/photos/${ID}.jpg\0`,
    `${OWNER}/photos/${ID}.png`, `${OWNER}/other/${ID}.jpg`, `${OWNER}/uploads/${ID}.jpg`,
    `${'x'.repeat(36)}/photos/${ID}.jpg`, `${OWNER}/photos/${'f'.repeat(36)}.jpg`,
    `${OWNER.replace('-4111-', '-0111-')}/photos/${ID}.jpg`, `${OWNER.replace('-8111-', '-7111-')}/photos/${ID}.jpg`,
    `${OWNER}/photos/${ID.replace('-4222-', '-0222-')}.jpg`,
  ];
  for (const key of invalid) {
    const actions = [() => fake.store.read(key), () => fake.store.write(key, Buffer.alloc(1), 'image/jpeg'), () => fake.store.remove(key), () => fake.store.info(key), () => fake.store.signUpload(key), () => fake.store.signDownload(key)];
    for (const action of actions) await assert.rejects(action, safeError('INVALID_BLOB_KEY', 400));
  }
  assert.equal(fake.calls.length, 0);
});

test('MIME 必须匹配对象后缀，不能注入请求头', async () => {
  const fake = queue();
  for (const mime of ['text/html', 'image/png', 'image/jpeg\r\nAuthorization: injected', 'image/jpeg\n', '']) {
    await assert.rejects(() => fake.store.write(KEY, Buffer.alloc(1), mime), safeError('INVALID_BLOB_MIME', 400));
    await assert.rejects(() => fake.store.signUpload(KEY, mime), safeError('INVALID_BLOB_MIME', 400));
  }
  assert.equal(fake.calls.length, 0);
});

test('write 在发请求前拒绝超100MB，并允许恰好100MB', async () => {
  const fake = queue(json({ id: ID }));
  await assert.rejects(() => fake.store.write(KEY, new Uint8Array(MAX_BLOB_BYTES + 1), 'image/jpeg'), safeError('BLOB_TOO_LARGE', 413));
  assert.equal(fake.calls.length, 0);
  await fake.store.write(KEY, new Uint8Array(MAX_BLOB_BYTES), 'image/jpeg');
  assert.equal(fake.calls.length, 1);
  assert.ok(fake.calls[0].init.body instanceof Uint8Array);
  assert.equal(fake.calls[0].init.body.byteLength, MAX_BLOB_BYTES);
});

test('write 拒绝空响应、非 JSON、错误 envelope 及伪造对象标识', async () => {
  const responses = [new Response(null, { status: 204 }), new Response('upstream-secret'), json({}), json({ id: 'invalid' }), json({ id: ID, Key: 'another/key' }), json({ id: ID, error: 'upstream-secret' }), json({ code: 'STORAGE_PERMISSION_DENIED', message: API_KEY }), json([]), new Response('{', { headers: { 'Content-Type': 'application/json' } })];
  for (const response of responses) {
    const fake = queue(response);
    await assert.rejects(() => fake.store.write(KEY, Buffer.alloc(1), 'image/jpeg'), safeError('CLOUD_STORAGE', 502));
    assert.equal(fake.calls.length, 1);
  }
});

test('read 先签名后按原样 GET 完整私有链接，下载不携带服务 key', async () => {
  const fake = queue(json({ fullSignedURL: DOWNLOAD, signedURL: '/不应使用' }), new Response(Buffer.from([1, 0, 255])));
  const bytes = await fake.store.read(KEY);
  assert.ok(Buffer.isBuffer(bytes));
  assert.deepEqual(bytes, Buffer.from([1, 0, 255]));
  assert.equal(fake.calls.length, 2);
  authorized(fake.calls[0], 'POST', `/v1/storages/object/sign/${CLOUD_BLOB_BUCKET}/${KEY}`);
  assert.equal(fake.calls[0].headers.get('Content-Type'), 'application/json');
  assert.deepEqual(JSON.parse(String(fake.calls[0].init.body)), { expiresIn: 60 });
  const call = fake.calls[1];
  assert.equal(call.url, DOWNLOAD);
  assert.equal(call.init.method, 'GET');
  assert.equal(call.headers.get('Authorization'), null);
  assert.equal([...call.headers].length, 0);
  assert.equal(call.init.redirect, 'error');
  assert.equal(call.init.signal, fake.calls[0].init.signal);
  assert.ok(!call.url.includes(API_KEY));
});

test('签名上传无 expiresIn，x-upsert=false，仅返回 PUT 所需 Content-Type', async () => {
  const fake = queue(json({ fullURL: UPLOAD, signedURL: '/ignored', token: 'ignored' }));
  const start = Date.now();
  const result = await fake.store.signUpload(KEY, 'image/jpeg');
  assert.deepEqual(result, { url: UPLOAD, method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, expiresAt: result.expiresAt });
  assert.ok(Date.parse(result.expiresAt) >= start + 60_000);
  assert.ok(Date.parse(result.expiresAt) <= Date.now() + 60_000);
  assert.equal(fake.calls.length, 1);
  authorized(fake.calls[0], 'POST', `/v1/storages/object/upload/sign/${CLOUD_BLOB_BUCKET}/${KEY}`);
  assert.equal(fake.calls[0].headers.get('x-upsert'), 'false');
  assert.equal(fake.calls[0].init.body, undefined);
  assert.equal(fake.calls[0].headers.get('Content-Type'), null);
  assert.ok(!JSON.stringify(result).includes(API_KEY));
  const withoutMime = queue(json({ fullURL: UPLOAD }));
  assert.deepEqual((await withoutMime.store.signUpload(KEY)).headers, {});
});

test('签名下载返回完整原始 URL 和保守的默认60秒到期时间', async () => {
  const fake = queue(json({ fullSignedURL: DOWNLOAD }));
  const start = Date.now();
  const result = await fake.store.signDownload(KEY);
  assert.equal(result.url, DOWNLOAD);
  assert.equal(Object.keys(result).sort().join(','), 'expiresAt,url');
  assert.ok(Date.parse(result.expiresAt) >= start + 60_000);
  assert.ok(Date.parse(result.expiresAt) <= Date.now() + 60_000);
  assert.ok(!JSON.stringify(result).includes(API_KEY));
  authorized(fake.calls[0], 'POST', `/v1/storages/object/sign/${CLOUD_BLOB_BUCKET}/${KEY}`);
});

test('拒绝跨 host、内网、非 HTTPS、userinfo、端口和相对签名 URL，绝不发下载请求', async () => {
  const invalid = [
    'https://evil.test/path?token=upstream-secret', 'https://127.0.0.1/path', 'https://[::1]/path',
    `https://${ENV}.api.tcloudbasegateway.com.evil.test/path`, `https://other.api.tcloudbasegateway.com/path`,
    BASE.replace('https:', 'http:') + '/path', `https://user:password@${new URL(BASE).host}/path`,
    `${BASE}:8443/path`, `${BASE}/path#token`, '//evil.test/path', '/v1/storages/object/sign/path',
    `${BASE}\\@evil.test/path`, ` ${DOWNLOAD}`, `${DOWNLOAD}\n`, `${BASE}/path?token=${API_KEY}`,
    `${BASE}/path?token=${encodeURIComponent(API_KEY)}`, 'data:text/plain,upstream-secret',
  ];
  for (const url of invalid) {
    for (const operation of ['read', 'signDownload', 'signUpload'] as const) {
      const fake = queue(json({ fullURL: url, fullSignedURL: url }));
      await assert.rejects(() => fake.store[operation](KEY), safeError('CLOUD_STORAGE', 502));
      assert.equal(fake.calls.length, 1);
      assert.equal(new URL(fake.calls[0].url).host, new URL(BASE).host);
    }
  }
});

test('签名接口只接受对应完整 URL 字段，不拼 signedURL 或兜底另一个字段', async () => {
  for (const value of [{}, { signedURL: '/relative?token=opaque' }, { fullSignedURL: 123 }, { fullSignedURL: null }]) {
    const fake = queue(json(value));
    await assert.rejects(() => fake.store.read(KEY), safeError('CLOUD_STORAGE', 502));
    assert.equal(fake.calls.length, 1);
  }
  await assert.rejects(() => queue(json({ fullSignedURL: DOWNLOAD })).store.signUpload(KEY), safeError('CLOUD_STORAGE', 502));
  await assert.rejects(() => queue(json({ fullURL: UPLOAD })).store.signDownload(KEY), safeError('CLOUD_STORAGE', 502));
});

test('read 检查 Content-Length，超限或非法长度立即取消响应体', async () => {
  for (const length of [String(MAX_BLOB_BYTES + 1), '9007199254740993', '-1', 'invalid', '1.5']) {
    const body = streamed(1, 3, { 'Content-Length': length });
    const fake = queue(json({ fullSignedURL: DOWNLOAD }), body.response);
    await assert.rejects(() => fake.store.read(KEY), safeError('CLOUD_STORAGE', 502));
    assert.ok(body.state.cancelled);
    assert.equal(fake.calls.length, 2);
  }
});

test('read 有界流允许100MB，缺失或伪小 Content-Length 均不能绕过限制', async () => {
  const unit = 1024 * 1024;
  const atLimit = streamed(unit, 100);
  const accepted = await queue(json({ fullSignedURL: DOWNLOAD }), atLimit.response).store.read(KEY);
  assert.equal(accepted.length, MAX_BLOB_BYTES);
  for (const headers of [{}, { 'Content-Length': '1' }] as Record<string, string>[]) {
    const body = streamed(unit, 103, headers);
    await assert.rejects(() => queue(json({ fullSignedURL: DOWNLOAD }), body.response).store.read(KEY), safeError('CLOUD_STORAGE', 502));
    assert.ok(body.state.cancelled);
    assert.ok(body.state.sent <= 102);
  }
});

test('JSON 签名和元信息响应也有64KB上限', async () => {
  const known = streamed(1, 3, { 'Content-Length': String(64 * 1024 + 1), 'Content-Type': 'application/json' });
  await assert.rejects(() => queue(known.response).store.signDownload(KEY), safeError('CLOUD_STORAGE', 502));
  assert.ok(known.state.cancelled);
  const unknown = streamed(1024, 70, { 'Content-Type': 'application/json' });
  await assert.rejects(() => queue(unknown.response).store.info(KEY), safeError('CLOUD_STORAGE', 502));
  assert.ok(unknown.state.cancelled);
});

test('info 只输出经过 schema 检查的 size/mime/etag', async () => {
  for (const value of [
    { size: 3, content_type: 'image/jpeg', etag: '"abc"', metadata: {} },
    { metadata: { size: 3, mimetype: 'image/jpeg', eTag: '"abc"' }, owner_id: OWNER, name: KEY, token: API_KEY },
    { size: 3, mime: 'image/jpeg', etag: '"abc"', token: API_KEY },
  ]) {
    const fake = queue(json(value));
    assert.deepEqual(await fake.store.info(KEY), { size: 3, mime: 'image/jpeg', etag: '"abc"' });
    assert.equal(fake.calls.length, 1);
    authorized(fake.calls[0], 'GET', `/v1/storages/object/info/${CLOUD_BLOB_BUCKET}/${KEY}`);
  }
  const invalid = [
    {}, { size: '3', mime: 'image/jpeg', etag: 'abc' }, { size: -1, mime: 'image/jpeg', etag: 'abc' },
    { size: 1.5, mime: 'image/jpeg', etag: 'abc' }, { size: MAX_BLOB_BYTES + 1, mime: 'image/jpeg', etag: 'abc' },
    { size: 1, mime: 'image/jpeg\n', etag: 'abc' }, { size: 1, mime: 'invalid', etag: 'abc' },
    { size: 1, mime: 'image/jpeg', etag: '' }, { size: 1, mime: 'image/jpeg', etag: 123 },
    { size: 1, mime: 'image/jpeg', etag: 'abc\r\n' }, { size: 1, mime: 'image/jpeg', etag: 'a'.repeat(257) },
    { metadata: { size: 1, mimetype: 'image/jpeg' } },
  ];
  for (const value of invalid) await assert.rejects(() => queue(json(value)).store.info(KEY), safeError('CLOUD_STORAGE', 502));
});

test('remove 使用授权 DELETE，204和404均幂等成功', async () => {
  for (const status of [204, 404]) {
    const body = status === 204 ? new Response(null, { status }) : json({ message: 'upstream-secret' }, status);
    const fake = queue(body);
    assert.equal(await fake.store.remove(KEY), undefined);
    authorized(fake.calls[0], 'DELETE', `/v1/storages/object/${CLOUD_BLOB_BUCKET}/${KEY}`);
    assert.equal(fake.calls.length, 1);
  }
});

test('所有授权方法按状态安全映射错误，不把401/403当业务登录失败', async () => {
  for (const [status, code, outwardStatus] of [[401, 'CLOUD_PERMISSION', 503], [403, 'CLOUD_PERMISSION', 503], [429, 'CLOUD_QUOTA', 429], [404, 'NOT_FOUND', 404], [413, 'CLOUD_STORAGE', 502], [500, 'CLOUD_STORAGE', 502]] as const) {
    const operations: ((store: CloudBlobStore) => Promise<unknown>)[] = [
      store => store.write(KEY, Buffer.alloc(1), 'image/jpeg'), store => store.read(KEY),
      store => store.info(KEY), store => store.signUpload(KEY), store => store.signDownload(KEY),
    ];
    if (status !== 404) operations.push(store => store.remove(KEY));
    for (const operation of operations) {
      const body = streamed(1024, 10, { 'x-upstream-secret': API_KEY });
      const response = new Response(body.response.body, { status, headers: { 'x-upstream-secret': API_KEY } });
      const fake = queue(response);
      await assert.rejects(() => operation(fake.store), safeError(code, outwardStatus));
      assert.ok(body.state.cancelled);
      assert.equal(fake.calls.length, 1);
    }
  }
});

test('签名 GET 的404和权限错误也映射 AppError，依然无服务授权头', async () => {
  for (const [status, code, outwardStatus] of [[404, 'NOT_FOUND', 404], [401, 'CLOUD_PERMISSION', 503], [403, 'CLOUD_PERMISSION', 503], [429, 'CLOUD_QUOTA', 429], [500, 'CLOUD_STORAGE', 502]] as const) {
    const fake = queue(json({ fullSignedURL: DOWNLOAD }), json({ message: `${API_KEY} upstream-secret` }, status));
    await assert.rejects(() => fake.store.read(KEY), safeError(code, outwardStatus));
    assert.equal(fake.calls.length, 2);
    assert.equal(fake.calls[1].headers.get('Authorization'), null);
  }
});

test('重定向响应不跟随，无跨域请求且不打印上游 URL 或 headers', async () => {
  for (const status of [301, 302, 307, 308]) {
    const fake = queue(new Response(null, { status, headers: { Location: `https://evil.test/?token=${API_KEY}` } }));
    await assert.rejects(() => fake.store.signDownload(KEY), safeError('CLOUD_STORAGE', 502));
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].init.redirect, 'error');
  }
  const fake = queue(json({ fullSignedURL: DOWNLOAD }), new Response(null, { status: 302, headers: { Location: 'https://evil.test/' } }));
  await assert.rejects(() => fake.store.read(KEY), safeError('CLOUD_STORAGE', 502));
  assert.equal(fake.calls.length, 2);
  assert.equal(fake.calls[1].headers.get('Authorization'), null);
  const redirected = json({ fullSignedURL: DOWNLOAD });
  Object.defineProperty(redirected, 'redirected', { value: true });
  await assert.rejects(() => queue(redirected).store.signDownload(KEY), safeError('CLOUD_STORAGE', 502));
});

test('fetch 和流错误均脱敏，不附原始 cause，也不写 console', async context => {
  const output: unknown[][] = [];
  for (const method of ['log', 'error', 'warn', 'info', 'debug'] as const) context.mock.method(console, method, (...args: unknown[]) => { output.push(args); });
  const fetcher: typeof globalThis.fetch = async () => { throw new Error(`${API_KEY} ${DOWNLOAD} upstream-secret`); };
  await assert.rejects(() => new CloudBlobStore(ENV, API_KEY, fetcher).info(KEY), safeError('CLOUD_STORAGE', 502));
  for (const error of [new Error(API_KEY + ' upstream-secret'), new AppError('UNSAFE_UPSTREAM', API_KEY + ' upstream-secret', 500)]) {
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(error); } });
    await assert.rejects(() => queue(json({ fullSignedURL: DOWNLOAD }), new Response(body)).store.read(KEY), safeError('CLOUD_STORAGE', 502));
  }
  assert.equal(output.length, 0);
});

test('45秒超时中止实际请求，错误不泄漏上游异常', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let captured: AbortSignal | undefined;
  const fetcher: typeof globalThis.fetch = async (_, init) => new Promise<Response>((_, reject) => {
    captured = init?.signal ?? undefined;
    captured?.addEventListener('abort', () => reject(new Error(`${API_KEY} upstream-secret`)), { once: true });
  });
  const pending = new CloudBlobStore(ENV, API_KEY, fetcher).info(KEY);
  const rejection = assert.rejects(() => pending, safeError('CLOUD_STORAGE', 502));
  context.mock.timers.tick(44_999);
  assert.equal(captured?.aborted, false);
  context.mock.timers.tick(1);
  await rejection;
  assert.equal(captured?.aborted, true);
});

test('45秒覆盖签名加整个下载流，超时不会返回已读的半个文件', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const state = { cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array([1, 2])); },
    cancel() { state.cancelled = true; },
  });
  const fake = queue(json({ fullSignedURL: DOWNLOAD }), new Response(body));
  const fetcher: typeof globalThis.fetch = async (input, init) => {
    const response = await fake.fetcher(input, init);
    if (fake.calls.length === 1) await new Promise<void>(resolve => setTimeout(resolve, 30_000));
    return response;
  };
  const pending = new CloudBlobStore(ENV, API_KEY, fetcher).read(KEY);
  const rejection = assert.rejects(() => pending, safeError('CLOUD_STORAGE', 502));
  // 签名先耗30秒，下载流只能再使用剩余15秒。
  await Promise.resolve();
  context.mock.timers.tick(30_000);
  for (let index = 0; index < 30; index++) await Promise.resolve();
  assert.equal(fake.calls.length, 2);
  assert.equal(fake.calls[0].init.signal, fake.calls[1].init.signal);
  context.mock.timers.tick(14_999);
  assert.equal(fake.calls[1].init.signal?.aborted, false);
  context.mock.timers.tick(1);
  await rejection;
  assert.equal(fake.calls[1].init.signal?.aborted, true);
  assert.ok(state.cancelled);
});
