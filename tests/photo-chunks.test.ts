import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { createApp } from "../src/server/app";
import { MarketService } from "../src/server/service";
import { issueSession } from "../src/server/auth";
import { closeDB } from "../src/lib/db";

// 分片暂存是进程内内存，测试必须使用独立数据目录并显式关闭连接。
const root = mkdtempSync(join(tmpdir(), "huoji-photo-chunks-"));
process.env.APP_DATA_DIR = root;
after(() => { closeDB(); rmSync(root, { recursive: true, force: true }); });
const service = new MarketService(undefined, { enabled: () => false, extract: async () => { throw new Error("unused"); } });
const makeApp = () => createApp({ identity: { exchange: async code => `mock:${code}` }, service });
const CHUNK = 48 * 1024;
const headers = (token: string) => ({ authorization: "Bearer " + token });

async function jpegBytes(): Promise<Buffer> {
  // 随机噪点保证压缩后明显大于48KiB，从而覆盖多分片路径。
  const pixels = randomBytes(600 * 600 * 3);
  const bytes = await sharp(pixels, { raw: { width: 600, height: 600, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
  assert.ok(bytes.length > CHUNK * 2, "测试照片应跨多个分片");
  return bytes;
}
function chunksOf(bytes: Buffer, total: number) {
  return Array.from({ length: total }, (_, index) => bytes.subarray(index * CHUNK, (index + 1) * CHUNK));
}
function split(bytes: Buffer) {
  const total = Math.ceil(bytes.length / CHUNK);
  return { total, parts: chunksOf(bytes, total) };
}
async function send(app: Awaited<ReturnType<typeof createApp>>, token: string, body: object) {
  return app.inject({ method: "POST", url: "/api/photos/chunks", headers: headers(token), payload: body });
}
function chunk(uploadId: string, index: number, total: number, data: Buffer, name = "cup.jpg") {
  return { uploadId, index, total, name, data: data.toString("base64") };
}
function multipart(bytes: Buffer, name: string) {
  const boundary = "photo-chunks-boundary";
  return {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="${name}"\r\nContent-Type: image/jpeg\r\n\r\n`), bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]),
  };
}

test("分片收齐后按序拼接，响应体与 multipart 上传一致", async () => {
  const app = await makeApp();
  try {
    const owner = issueSession("chunk-owner"), other = issueSession("chunk-other");
    const bytes = await jpegBytes(), total = Math.ceil(bytes.length / CHUNK), parts = chunksOf(bytes, total);
    const uploadId = randomUUID();
    for (let index = 0; index < total; index++) {
      const response = await send(app, owner.token, chunk(uploadId, index, total, parts[index]));
      if (index < total - 1) {
        assert.equal(response.statusCode, 202, response.body);
        assert.deepEqual(response.json(), { received: index + 1, total, complete: false });
      } else {
        assert.equal(response.statusCode, 201, response.body);
        const photo = response.json() as { id: string; name: string; url: string };
        assert.deepEqual(Object.keys(photo).sort(), ["id", "name", "url"]);
        assert.equal(photo.name, "cup.jpg");
        assert.equal(photo.url, "/api/photos/" + photo.id);
        const read = await app.inject({ method: "GET", url: photo.url, headers: headers(owner.token) });
        assert.equal(read.statusCode, 200, read.body);
        assert.match(String(read.headers["content-type"]), /image\/jpeg/);
        // 跨账号不可读取该照片。
        assert.equal((await app.inject({ method: "GET", url: photo.url, headers: headers(other.token) })).statusCode, 404);
      }
    }
    // 与 multipart 入口返回同一套字段，证明复用了同一保存逻辑。
    const legacy = await app.inject({ method: "POST", url: "/api/photos", headers: { ...headers(owner.token), ...multipart(bytes, "cup.jpg").headers }, payload: multipart(bytes, "cup.jpg").payload });
    assert.equal(legacy.statusCode, 201, legacy.body);
    assert.deepEqual(Object.keys(legacy.json()).sort(), ["id", "name", "url"]);
  } finally { await app.close(); }
});

test("缺片时只返回进行中状态，收齐后才返回照片", async () => {
  const app = await makeApp();
  try {
    const owner = issueSession("chunk-missing"), bytes = await jpegBytes(), { total, parts } = split(bytes), uploadId = randomUUID();
    assert.ok(total >= 3);
    const first = await send(app, owner.token, chunk(uploadId, 0, total, parts[0]));
    assert.equal(first.statusCode, 202, first.body);
    assert.equal(first.json().complete, false);
    assert.ok(!("id" in first.json()));
    // 乱序到达的最后一片不算收齐。
    const last = await send(app, owner.token, chunk(uploadId, total - 1, total, parts[total - 1]));
    assert.equal(last.statusCode, 202, last.body);
    assert.equal(last.json().received, 2);
    // 补齐剩余中间片才完成。
    let completed: Awaited<ReturnType<typeof send>> | undefined;
    for (let index = 1; index < total - 1; index++) completed = await send(app, owner.token, chunk(uploadId, index, total, parts[index]));
    assert.ok(completed);
    assert.equal(completed.statusCode, 201, completed.body);
    assert.ok(completed.json().id);
  } finally { await app.close(); }
});

test("累计超过8MB立即拒绝并清理暂存", async () => {
  const app = await makeApp();
  try {
    const owner = issueSession("chunk-overflow"), uploadId = randomUUID(), part = Buffer.alloc(64 * 1024, 7), total = 200;
    let rejected: Awaited<ReturnType<typeof send>> | undefined;
    for (let index = 0; index < 129; index++) {
      const response = await send(app, owner.token, chunk(uploadId, index, total, part));
      if (response.statusCode !== 202) { rejected = response; break; }
    }
    assert.ok(rejected, "超过8MB必须被拒绝");
    assert.equal(rejected.statusCode, 413, rejected.body);
    assert.equal(rejected.json().error.message, "照片不能超过 8MB");
    // 暂存已清理：重新从0开始只回到进行中，不会带着旧分片直接完成。
    const restarted = await send(app, owner.token, chunk(uploadId, 0, total, part));
    assert.equal(restarted.statusCode, 202, restarted.body);
    assert.equal(restarted.json().received, 1);
  } finally { await app.close(); }
});

test("跨账号不能共用同一 uploadId", async () => {
  const app = await makeApp();
  try {
    const alice = issueSession("chunk-alice"), bob = issueSession("chunk-bob");
    const bytes = await jpegBytes(), { total, parts } = split(bytes), uploadId = randomUUID();
    assert.equal((await send(app, alice.token, chunk(uploadId, 0, total, parts[0]))).statusCode, 202);
    const cross = await send(app, bob.token, chunk(uploadId, 1, total, parts[1]));
    assert.equal(cross.statusCode, 404, cross.body);
    assert.equal(cross.json().error.code, "UPLOAD_NOT_FOUND");
    // alice 的暂存未被 bob 影响或篡改。
    let completed: Awaited<ReturnType<typeof send>> | undefined;
    for (let index = 1; index < total; index++) completed = await send(app, alice.token, chunk(uploadId, index, total, parts[index]));
    assert.ok(completed);
    assert.equal(completed.statusCode, 201, completed.body);
  } finally { await app.close(); }
});

test("同一 uploadId 的 total 或 name 不一致要拒绝", async () => {
  const app = await makeApp();
  try {
    const owner = issueSession("chunk-conflict"), bytes = await jpegBytes(), { total, parts } = split(bytes), uploadId = randomUUID();
    assert.equal((await send(app, owner.token, chunk(uploadId, 0, total, parts[0], "a.jpg"))).statusCode, 202);
    const wrongTotal = await send(app, owner.token, chunk(uploadId, 1, total + 1, parts[1], "a.jpg"));
    assert.equal(wrongTotal.statusCode, 409, wrongTotal.body);
    assert.equal(wrongTotal.json().error.code, "CHUNK_CONFLICT");
    const wrongName = await send(app, owner.token, chunk(uploadId, 1, total, parts[1], "b.jpg"));
    assert.equal(wrongName.statusCode, 409, wrongName.body);
    let completed: Awaited<ReturnType<typeof send>> | undefined;
    for (let index = 1; index < total; index++) completed = await send(app, owner.token, chunk(uploadId, index, total, parts[index], "a.jpg"));
    assert.ok(completed);
    assert.equal(completed.statusCode, 201, completed.body);
  } finally { await app.close(); }
});

test("拼接后魔数不是 JPEG/PNG 时拒绝", async () => {
  const app = await makeApp();
  try {
    const owner = issueSession("chunk-magic"), uploadId = randomUUID();
    const response = await send(app, owner.token, chunk(uploadId, 0, 1, Buffer.from("this is not an image")));
    assert.equal(response.statusCode, 415, response.body);
    assert.equal(response.json().error.code, "INVALID_PHOTO");
    // 拒绝后暂存已释放：同一 uploadId 重新按合法分片上传可成功。
    const bytes = await jpegBytes(), { total, parts } = split(bytes);
    let completed: Awaited<ReturnType<typeof send>> | undefined;
    for (let index = 0; index < total; index++) completed = await send(app, owner.token, chunk(uploadId, index, total, parts[index]));
    assert.ok(completed);
    assert.equal(completed.statusCode, 201, completed.body);
  } finally { await app.close(); }
});
