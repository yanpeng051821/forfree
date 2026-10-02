import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import type { Photo, Product, ProductFields, Project } from "./types";

// Runtime storage is external state, never a build/deployment input.
export const dataDir = () => resolve(/* turbopackIgnore: true */ process.env.APP_DATA_DIR || join(process.cwd(), ".data"));
type Cached = typeof globalThis & { huojiDBs?: Map<string, DatabaseSync> };
export function db(): DatabaseSync {
  const root = dataDir();
  const cache = (globalThis as Cached).huojiDBs ||= new Map();
  let connection = cache.get(root);
  if (!connection) {
    mkdirSync(join(root, "photos"), { recursive: true });
    connection = new DatabaseSync(join(root,"market.sqlite"));
    connection.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, market TEXT NOT NULL, date TEXT NOT NULL, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), fields TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS photos (id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE, name TEXT NOT NULL, position INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS products_project ON products(project_id);
      CREATE INDEX IF NOT EXISTS photos_product ON photos(product_id);`);
    cache.set(root,connection);
  }
  return connection;
}
const photoPath = (id: string) => join(dataDir(), "photos", `${id}.jpg`);
export function readPhoto(id: string): Buffer | null {
  if (!/^[a-f0-9-]{36}$/.test(id) || !db().prepare("SELECT id FROM photos WHERE id=?").get(id)) return null;
  const path = photoPath(id);
  return existsSync(path) ? readFileSync(path) : null;
}
export function listProjects(): Project[] {
  return (db().prepare("SELECT id,name,market,date,demo,created_at AS createdAt FROM projects ORDER BY created_at DESC").all() as unknown as Project[]).map(p=>({...p,demo:Boolean(p.demo)}));
}
export function getProject(id: string) { return listProjects().find(p=>p.id===id); }
export function createProject(value: Pick<Project,"name"|"market"|"date">, demo=false): Project {
  const project: Project = {...value, id:randomUUID(),demo,createdAt:new Date().toISOString()};
  db().prepare("INSERT INTO projects VALUES (?,?,?,?,?,?)").run(project.id, project.name, project.market, project.date, Number(demo), project.createdAt);
  return project;
}
type ProductRow = {id:string;project_id:string;fields:string;created_at:string;updated_at:string};
function hydrate(row: ProductRow): Product {
  const photos = (db().prepare("SELECT id,name FROM photos WHERE product_id=? ORDER BY position").all(row.id) as unknown as Photo[]).map(photo=>({...photo,url:`/api/photos/${photo.id}`}));
  return {...JSON.parse(row.fields),id:row.id,projectId:row.project_id,photos,createdAt:row.created_at,updatedAt:row.updated_at};
}
export function listProducts(projectId: string): Product[] {
  return (db().prepare("SELECT * FROM products WHERE project_id=? ORDER BY created_at DESC").all(projectId) as unknown as ProductRow[]).map(hydrate);
}
export function getProduct(id: string): Product | undefined {
  const row = db().prepare("SELECT * FROM products WHERE id=?").get(id) as ProductRow | undefined;
  return row ? hydrate(row) : undefined;
}
export async function prepareImage(file: File): Promise<{ name:string;bytes:Buffer }> {
  if (file.size > 8*1024*1024 || file.size===0) throw new Error("每张照片须大于0且不超过8MB");
  if (!["image/jpeg","image/png","image/webp","image/heic","image/heif"].includes(file.type)) throw new Error("请选择 JPG、PNG 或 WebP 图片；手机可尝试使用兼容格式拍照。");
  try {
    const image=sharp(Buffer.from(await file.arrayBuffer()),{limitInputPixels:40000000});
    const metadata=await image.metadata();
    if(!["jpeg","png","webp","heif"].includes(metadata.format || "")) throw new Error("不支持的图片格式");
    const bytes=await image.rotate().resize(1600,1600,{fit:"inside",withoutEnlargement:true}).jpeg({quality:85}).toBuffer();
    return {name:file.name.slice(0,200),bytes};
  } catch { throw new Error("这张照片无法读取，请改用 JPG、PNG 或 WebP 格式。"); }
}
export async function saveProduct(projectId:string, fields:ProductFields, uploads:{name:string;bytes:Buffer}[], id?:string, keepPhotoIds:string[]=[]): Promise<Product> {
  if (!getProject(projectId)) throw new Error("看货任务不存在");
  const existing=id ? getProduct(id) : undefined;
  if (id && (!existing || existing.projectId!==projectId)) throw new Error("商品不存在");
  const keep=(existing?.photos || []).filter(photo=>keepPhotoIds.includes(photo.id));
  if (keepPhotoIds.length!==keep.length || new Set(keepPhotoIds).size!==keepPhotoIds.length) throw new Error("照片归属无效");
  if (uploads.length+keep.length>6) throw new Error("每件商品最多6张照片");
  const productId=id || randomUUID(), now=new Date().toISOString();
  const added=uploads.map(photo=>({...photo,id:randomUUID()}));
  const connection=db();
  connection.exec("BEGIN IMMEDIATE");
  try {
    if (existing) connection.prepare("UPDATE products SET fields=?,updated_at=? WHERE id=?").run(JSON.stringify(fields),now,productId);
    else connection.prepare("INSERT INTO products VALUES (?,?,?,?,?)").run(productId,projectId,JSON.stringify(fields),now,now);
    connection.prepare("DELETE FROM photos WHERE product_id=?").run(productId);
    for (const [position,photo] of [...keep,...added].entries()) {
      if ("bytes" in photo) writeFileSync(photoPath(photo.id),photo.bytes);
      connection.prepare("INSERT INTO photos VALUES (?,?,?,?)").run(photo.id,productId,photo.name,position);
    }
    connection.exec("COMMIT");
  } catch(error) {
    connection.exec("ROLLBACK");
    for (const photo of added) {try {unlinkSync(photoPath(photo.id));} catch { /* missing partial write */ }}
    throw error;
  }
  for (const photo of existing?.photos || []) if (!keepPhotoIds.includes(photo.id)) {try {unlinkSync(photoPath(photo.id));} catch { /* record already removed */ }}
  return getProduct(productId)!;
}
export function deleteProduct(id:string) {
  const product=getProduct(id); if (!product) return false;
  db().prepare("DELETE FROM products WHERE id=?").run(id);
  for(const photo of product.photos) {try {unlinkSync(photoPath(photo.id));} catch { /* stale file */ }}
  return true;
}
