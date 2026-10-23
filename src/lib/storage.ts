import { mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { AppError } from "./errors";

export const dataDir = () => resolve(process.env.APP_DATA_DIR || join(process.cwd(), ".data"));
export interface PhotoStorage {
  write(id: string, bytes: Buffer): void;
  read(id: string): Buffer | null;
  remove(id: string): void;
  sweep(referenced: Set<string>, cutoff: number): number;
}
export class LocalPhotoStorage implements PhotoStorage {
  private path(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new AppError("INVALID_PHOTO", "照片标识无效");
    return join(dataDir(), "photos", `${id}.jpg`);
  }
  write(id: string, bytes: Buffer) {
    mkdirSync(join(dataDir(), "photos"), { recursive: true });
    writeFileSync(this.path(id), bytes, { flag: "wx", mode: 0o600 });
  }
  read(id: string) { return existsSync(this.path(id)) ? readFileSync(this.path(id)) : null; }
  remove(id: string) {
    try { unlinkSync(this.path(id)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  sweep(referenced: Set<string>, cutoff: number) {
    const root = join(dataDir(), "photos");
    if (!existsSync(root)) return 0;
    let removed = 0;
    for (const name of readdirSync(root)) {
      const id = name.replace(/\.jpg$/, "");
      if (/^[a-f0-9-]{36}\.jpg$/.test(name) && !referenced.has(id) && statSync(join(root, name)).mtimeMs < cutoff) {
        this.remove(id); removed++;
      }
    }
    return removed;
  }
}
export const photoStorage: PhotoStorage = new LocalPhotoStorage();
export async function prepareImage(file: File): Promise<{ name: string; bytes: Buffer }> {
  if (file.size > 8 * 1024 * 1024 || file.size === 0) throw new AppError("INVALID_PHOTO", "每张照片须大于0且不超过8MB");
  if (!["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "application/octet-stream"].includes(file.type)) throw new AppError("INVALID_PHOTO", "请选择 JPG、PNG 或 WebP 图片");
  try {
    const image = sharp(Buffer.from(await file.arrayBuffer()), { limitInputPixels: 40000000 });
    const metadata = await image.metadata();
    if (!["jpeg", "png", "webp", "heif"].includes(metadata.format || "")) throw new Error("format");
    const bytes = await image.rotate().resize(1600, 1600, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
    return { name: file.name.slice(0, 200), bytes };
  } catch { throw new AppError("INVALID_PHOTO", "这张照片无法读取，请改用 JPG、PNG 或 WebP 格式。"); }
}
