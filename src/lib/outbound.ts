import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request } from "node:https";
import { AppError } from "./errors";

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b] = address.split(".").map(Number);
    return !([0, 9, 10, 11, 21, 30, 127].includes(a) || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0, 168].includes(b)) ||
      (a === 198 && [18, 19, 51].includes(b)) || (a === 203 && b === 0));
  }
  if (family === 6) {
    const lower = address.toLowerCase();
    const [first, second = "0"] = lower.split(":").map(part => part || "0");
    const prefix = parseInt(first, 16), subnet = parseInt(second, 16);
    return prefix >= 0x2000 && prefix <= 0x3fff && prefix !== 0x2002 &&
      !(prefix === 0x2001 && (subnet <= 0x1ff || subnet === 0xdb8)) &&
      !(prefix === 0x3fff && subnet <= 0xfff);
  }
  return false;
}
export function validateServiceURL(url: URL) {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol !== "https:" || (url.port && url.port !== "443") || url.username || url.password || url.hash ||
    host === "localhost" || /\.(local|internal|localhost)$/i.test(host) || (isIP(host) && !isPublicAddress(host))) {
    throw new AppError("INVALID_SERVICE", "外部服务必须使用公网 HTTPS 地址");
  }
}
export async function secureFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  validateServiceURL(url);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  let timer: NodeJS.Timeout | undefined;
  const addresses = await Promise.race([
    lookup(hostname, { all: true }),
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new AppError("UPSTREAM_TIMEOUT", "外部服务解析超时", 504)), 5000); })
  ]).finally(() => clearTimeout(timer));
  if (!addresses.length || addresses.some(x => !isPublicAddress(x.address))) throw new AppError("INVALID_SERVICE", "外部服务不允许访问内网或保留地址");
  if (init.signal?.aborted) throw new AppError("UPSTREAM_TIMEOUT", "外部服务请求已超时", 504);
  const selected = addresses[0];
  return new Promise((resolve, reject) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const body = typeof init.body === "string" ? init.body : undefined;
    const req = request({
      hostname: selected.address, family: selected.family, servername: hostname,
      port: 443, method: init.method || "GET", path: `${url.pathname}${url.search}`,
      headers: { ...headers, host: url.host, ...(body ? { "content-length": Buffer.byteLength(body) } : {}) },
      signal: init.signal || AbortSignal.timeout(30000),
    }, res => {
      const chunks: Buffer[] = []; let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 512 * 1024) { req.destroy(new AppError("UPSTREAM_INVALID", "外部服务响应过大", 502)); return; }
        chunks.push(chunk);
      });
      res.on("error", reject);
      res.on("end", () => {
        const status = res.statusCode || 502;
        if (status >= 300 && status < 400) { reject(new AppError("UPSTREAM_INVALID", "外部服务重定向已拒绝", 502)); return; }
        try {
          resolve(new Response([204, 205, 304].includes(status) ? null : new Uint8Array(Buffer.concat(chunks)), { status, headers: { "content-type": String(res.headers["content-type"] || "application/json") } }));
        } catch { reject(new AppError("UPSTREAM_INVALID", "外部服务响应无效", 502)); }
      });
    });
    req.on("error", error => reject(init.signal?.aborted || (error as NodeJS.ErrnoException).code === "ABORT_ERR" ? new AppError("UPSTREAM_TIMEOUT", "外部服务超时，请重试或手动填写", 504) : new AppError("UPSTREAM_FAILED", "外部服务连接失败，请稍后重试", 502)));
    if (body) req.write(body);
    req.end();
  });
}
