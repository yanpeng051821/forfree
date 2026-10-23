import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import https from "node:https";
import dns from "node:dns/promises";
import { secureFetch } from "../src/lib/outbound";

function transport(status: number, chunks: Buffer[] = []) {
  let captured: https.RequestOptions | undefined;
  mock.method(dns, "lookup", async () => [{ address: "8.8.8.8", family: 4 }]);
  mock.method(https, "request", (options: https.RequestOptions, callback: (response: EventEmitter) => void) => {
    captured = options;
    const req = new EventEmitter() as EventEmitter & { write: () => void; end: () => void; destroy: (error: Error) => void };
    req.write = () => {};
    req.destroy = error => { req.emit("error", error); };
    req.end = () => queueMicrotask(() => {
      const response = Object.assign(new EventEmitter(), { statusCode: status, headers: { "content-type": "application/json" } });
      callback(response);
      for (const chunk of chunks) response.emit("data", chunk);
      response.emit("end");
    });
    return req;
  });
  return () => captured!;
}

test("secure transport pins the resolved public IP while retaining TLS hostname", async () => {
  const options = transport(200, [Buffer.from('{"ok":true}')]);
  try {
    const result = await secureFetch("https://model.example/v1/test", { method: "POST", body: "{}" });
    assert.deepEqual(await result.json(), { ok: true });
    assert.equal(options().hostname, "8.8.8.8"); assert.equal(options().servername, "model.example");
    assert.equal((options().headers as Record<string, string>).host, "model.example");
  } finally { mock.restoreAll(); }
});

test("empty upstream 205 does not escape the promise as an uncaught exception", async () => {
  transport(205);
  try { const response = await secureFetch("https://model.example"); assert.equal(response.status, 205); assert.equal(await response.text(), ""); }
  finally { mock.restoreAll(); }
});

test("redirects, oversized responses and private DNS addresses are rejected", async () => {
  try {
    transport(302);
    await assert.rejects(() => secureFetch("https://model.example"), /重定向/);
    mock.restoreAll(); transport(200, [Buffer.alloc(512 * 1024 + 1)]);
    await assert.rejects(() => secureFetch("https://model.example"), /连接失败|响应过大/);
    mock.restoreAll(); transport(200);
    mock.method(dns, "lookup", async () => [{ address: "127.0.0.1", family: 4 }]);
    await assert.rejects(() => secureFetch("https://model.example"), /内网或保留/);
  } finally { mock.restoreAll(); }
});
