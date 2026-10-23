import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { emptyFields, emptyProfile, type UserProfile, type UserProfileFields, type Photo, type Product, type ProductFields, type Project, type ProjectSummary } from "./types";
import { dataDir, photoStorage } from "./storage";
import { migrate } from "./migrations";
import { AppError, conflict, notFound } from "./errors";
import { chinaDayBounds } from './dates';

const connections = new Map<string, DatabaseSync>();
export function db(): DatabaseSync {
  const root = dataDir();
  let connection = connections.get(root);
  if (!connection) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    connection = new DatabaseSync(join(root, "market.sqlite"));
    try {
      connection.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
      migrate(connection);
    } catch (error) { connection.close(); throw error; }
    connections.set(root, connection);
  }
  return connection;
}
export function closeDB() {
  const root = dataDir();
  connections.get(root)?.close(); connections.delete(root);
}
export function getProfile(owner: string): UserProfile {
  const row = db().prepare("SELECT fields,version FROM user_profiles WHERE owner_id=?").get(owner) as { fields: string; version: number } | undefined;
  return row ? { ...emptyProfile, ...JSON.parse(row.fields), version: row.version } : { ...emptyProfile, version: 0 };
}
export function saveProfile(owner: string, fields: UserProfileFields, version: number): UserProfile {
  return transaction(() => {
    const current = getProfile(owner), { version: priorVersion, ...prior } = current;
    if (stableJson(prior) === stableJson(fields)) return current;
    if (priorVersion !== version) conflict("个人资料已在其他设备更新，请重新打开后修改");
    db().prepare("INSERT INTO user_profiles (owner_id,fields,version) VALUES (?,?,?) ON CONFLICT(owner_id) DO UPDATE SET fields=excluded.fields,version=excluded.version").run(owner, JSON.stringify(fields), version + 1);
    return { ...fields, version: version + 1 };
  });
}
export function transaction<T>(work: () => T): T {
  const connection = db();
  connection.exec("BEGIN IMMEDIATE");
  try { const result = work(); connection.exec("COMMIT"); return result; }
  catch (error) { connection.exec("ROLLBACK"); throw error; }
}
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
function replay<T>(owner: string, requestKey: string, payload: unknown, work: () => T): T {
  const digest = createHash("sha256").update(stableJson(payload)).digest("hex");
  return transaction(() => {
    const prior = db().prepare("SELECT digest,result FROM receipts WHERE owner_id=? AND request_key=?").get(owner, requestKey) as { digest: string; result: string } | undefined;
    if (prior) {
      if (prior.digest !== digest) conflict("同一请求编号对应的内容已变化，请重新提交");
      return JSON.parse(prior.result) as T;
    }
    const result = work();
    db().prepare("INSERT INTO receipts VALUES (?,?,?,?,?)").run(owner, requestKey, digest, JSON.stringify(result), Date.now());
    return result;
  });
}
export function listProjects(owner: string): Project[] {
  const projects = db().prepare("SELECT id,name,market,date,demo,created_at AS createdAt,supplier,supplier_contact AS supplierContact FROM projects WHERE owner_id=? ORDER BY created_at DESC,id DESC").all(owner) as unknown as Project[];
  const summaries = db().prepare(`SELECT p.id, ${summaryColumns} FROM projects p LEFT JOIN products pr ON pr.project_id=p.id AND pr.deleted_at IS NULL WHERE p.owner_id=? GROUP BY p.id`).all(owner) as unknown as (ProjectSummary & { id: string })[];
  const byId = new Map(summaries.map(summary => { const { id, ...values } = summary; return [id, values]; }));
  return projects.map(p => ({ ...p, demo: Boolean(p.demo), summary: byId.get(p.id) }));
}
const summaryColumns = `COUNT(pr.id) AS total,
  COALESCE(SUM(CASE WHEN json_extract(pr.fields,'$.confirmed')=1 THEN 1 ELSE 0 END),0) AS confirmed,
  COALESCE(SUM(CASE WHEN pr.id IS NOT NULL AND COALESCE(json_extract(pr.fields,'$.confirmed'),0)=0 THEN 1 ELSE 0 END),0) AS pending,
  COALESCE(SUM(CASE WHEN pr.id IS NOT NULL AND json_extract(pr.fields,'$.unitPrice') IS NULL THEN 1 ELSE 0 END),0) AS missingPrice,
  COUNT(DISTINCT NULLIF(TRIM(json_extract(pr.fields,'$.supplier')),'')) AS suppliers,
  COALESCE(SUM((SELECT COUNT(*) FROM media m WHERE m.product_id=pr.id)),0) AS photos`;
export function projectSummary(owner: string, projectId: string, filter: ProductFilter = {}): ProjectSummary {
  if (filter.dateFrom !== undefined || filter.dateTo !== undefined || filter.date || filter.favorite || filter.supplier !== undefined) return pageProducts(owner, projectId, undefined, 1, filter).summary;
  getProject(owner, projectId);
  return db().prepare(`SELECT ${summaryColumns} FROM products pr WHERE pr.project_id=? AND pr.deleted_at IS NULL`).get(projectId) as unknown as ProjectSummary;
}
export function getProject(owner: string, id: string): Project {
  const row = db().prepare("SELECT id,name,market,date,demo,created_at AS createdAt,supplier,supplier_contact AS supplierContact FROM projects WHERE owner_id=? AND id=?").get(owner, id) as Project | undefined;
  if (!row) notFound();
  return { ...row, demo: Boolean(row.demo) };
}
export function createProject(owner: string, value: Pick<Project, "name" | "market" | "date" | "supplier" | "supplierContact">, requestKey: string): Project {
  return replay(owner, requestKey, { operation: "createProject", ...value }, () => {
    const project: Project = { ...value, id: randomUUID(), demo: false, createdAt: new Date().toISOString() };
    db().prepare("INSERT INTO projects (id,name,market,date,demo,created_at,owner_id,supplier,supplier_contact) VALUES (?,?,?,?,?,?,?,?,?)").run(project.id, project.name, project.market, project.date, 0, project.createdAt, owner,project.supplier ?? null,project.supplierContact ?? null);
    return project;
  });
}
type ProductRow = { deleted_at?:string|null; id: string; project_id: string; fields: string; version: number; created_at: string; updated_at: string; taskName?: string; taskMarket?: string; taskDate?: string; demo?: number };
type MediaRow = { id: string; owner_id: string; product_id: string | null; name: string; expires_at: number | null };
function hydrate(row: ProductRow): Product {
  const photos = (db().prepare("SELECT id,name FROM media WHERE product_id=? ORDER BY position").all(row.id) as unknown as Photo[]).map(photo => ({ ...photo, url: `/api/photos/${photo.id}` }));
  return { ...emptyFields, ...JSON.parse(row.fields), id: row.id, projectId: row.project_id, version: row.version, photos, createdAt: row.created_at, updatedAt: row.updated_at, deletedAt:row.deleted_at, taskName: row.taskName, taskMarket: row.taskMarket, taskDate: row.taskDate, demo: Boolean(row.demo) };
}
function encodeProductCursor(projectId: string, id: string): string {
  return createHash("sha256").update(projectId).update("\0").update(id).digest("base64url");
}
function resolveProductCursor(owner: string, scope: string, cursor: string, from: string, values: (string | number)[]): { id: string; created_at: string } {
  if (!/^[A-Za-z0-9_-]{43}$/.test(cursor)) throw new AppError("INVALID_CURSOR", "分页游标无效");
  const bytes = Buffer.from(cursor, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== cursor) throw new AppError("INVALID_CURSOR", "分页游标无效");
  const boundaries = db().prepare("SELECT pr.id,pr.created_at " + from).all(...values) as { id: string; created_at: string }[];
  const boundary = boundaries.find(row => encodeProductCursor(scope, row.id) === cursor);
  if (!boundary) throw new AppError("INVALID_CURSOR", "分页游标无效");
  return boundary;
}
export type RecordDateRange = { dateFrom?: string; dateTo?: string };
export type ProductFilter = RecordDateRange & { supplier?: string; q?: string; date?: string; favorite?: boolean; status?: "all" | "pending" | "confirmed" | "missingPrice" };
export function recordDateRangeBounds(date: string | undefined, range: RecordDateRange = {}): [string, string] | undefined {
  const { dateFrom, dateTo } = range;
  if (dateFrom !== undefined || dateTo !== undefined) {
    const valid = (value: string | undefined) => Boolean(value && !value.startsWith('0000') && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value);
    if (!valid(dateFrom) || !valid(dateTo) || date || dateFrom! > dateTo!) throw new AppError('VALIDATION', '日期范围无效');
    return [chinaDayBounds(dateFrom!)[0], chinaDayBounds(dateTo!)[1]];
  }
  return date ? chinaDayBounds(date) : undefined;
}
function recordScope(owner: string, projectId: string | undefined, date?: string, favorite = false, range: RecordDateRange = {}) {
  const bounds = recordDateRangeBounds(date, range);
  if (projectId) getProject(owner, projectId);
  if (!projectId && !bounds && !favorite) throw new AppError('INVALID_SCOPE', '请选择任务、日期或收藏');
  const clauses = ['p.owner_id=?','pr.deleted_at IS NULL'], values: (string | number)[] = [owner];
  if (projectId) { clauses.push('p.id=?'); values.push(projectId); }
  if (bounds) { clauses.push('pr.created_at>=? AND pr.created_at<?'); values.push(...bounds); }
  if (favorite) clauses.push("json_extract(pr.fields,'$.favorite')=1");
  return { clauses, values };
}
export function pageProducts(owner: string, projectId: string | undefined, cursor: string | undefined, limit: number, filter: ProductFilter = {}): { items: Product[]; nextCursor: string | null; summary: ProjectSummary; matchedCount: number } {
  const { clauses, values } = recordScope(owner, projectId, filter.date, filter.favorite, filter);
  if (filter.supplier !== undefined) { clauses.push("COALESCE(json_extract(pr.fields,'$.supplier'),'')=?"); values.push(filter.supplier); }
  const baseFrom = 'FROM products pr JOIN projects p ON pr.project_id=p.id WHERE ' + clauses.join(' AND ');
  const summary = db().prepare('SELECT ' + summaryColumns + ' ' + baseFrom).get(...values) as unknown as ProjectSummary;
  const scope = (projectId || 'all') + (filter.date ? ':' + filter.date : '') + (filter.favorite ? ':favorites' : '') + (filter.supplier !== undefined ? ':supplier:' + filter.supplier : '') + (filter.dateFrom ? ':range:' + filter.dateFrom + ':' + filter.dateTo : '');
  // Resolve the boundary against the owned date/task scope, independent of a status edit.
  const boundary = cursor ? resolveProductCursor(owner, scope, cursor, baseFrom, values) : null;
  if (filter.status === "confirmed") clauses.push("json_extract(pr.fields,'$.confirmed')=1");
  if (filter.status === "pending") clauses.push("COALESCE(json_extract(pr.fields,'$.confirmed'),0)=0");
  if (filter.status === "missingPrice") clauses.push("json_extract(pr.fields,'$.unitPrice') IS NULL");
  if (filter.q) {
    const keys = ["name", "sku", "supplier", "supplierContact", "description", "notes", "evaluation"];
    clauses.push("(" + keys.map(key => `LOWER(COALESCE(json_extract(pr.fields,'$.${key}'),'')) LIKE ? ESCAPE '\\'`).join(" OR ") + ")");
    const pattern = "%" + filter.q.toLowerCase().replace(/[\\%_]/g, char => "\\" + char) + "%";
    values.push(...keys.map(() => pattern));
  }
  const from = "FROM products pr JOIN projects p ON pr.project_id=p.id WHERE " + clauses.join(" AND ");
  const matchedCount = (db().prepare("SELECT COUNT(*) AS n " + from).get(...values) as { n: number }).n;
  if (boundary) { clauses.push("(pr.created_at<? OR (pr.created_at=? AND pr.id<?))"); values.push(boundary.created_at, boundary.created_at, boundary.id); }
  const rows = db().prepare("SELECT pr.*,p.name AS taskName,p.market AS taskMarket,p.date AS taskDate,p.demo FROM products pr JOIN projects p ON pr.project_id=p.id WHERE " + clauses.join(" AND ") + " ORDER BY pr.created_at DESC,pr.id DESC LIMIT ?").all(...values, limit + 1) as unknown as ProductRow[];
  const hasMore = rows.length > limit, page = rows.slice(0, limit);
  return { items: page.map(hydrate), nextCursor: hasMore && page.length ? encodeProductCursor(scope, page[page.length - 1].id) : null, summary, matchedCount };
}
export type MerchantSummary = { supplier: string; supplierContact: string; total: number; confirmed: number; pending: number; missingPrice: number };
export type MerchantVisit = MerchantSummary & { projectId: string; date: string; market: string; demo: boolean };
export function listMerchantVisits(owner: string,date:string): MerchantVisit[] {
  const [from,to]=chinaDayBounds(date);
  const rows=db().prepare("SELECT p.id projectId,? date,p.market,p.demo,COALESCE(json_extract(pr.fields,'$.supplier'),p.supplier,'') supplier,COALESCE(json_extract(json_group_array(json_extract(pr.fields,'$.supplierContact') ORDER BY pr.created_at DESC,pr.id DESC) FILTER(WHERE COALESCE(json_extract(pr.fields,'$.supplierContact'),'')<>''),'$[0]'),p.supplier_contact,'') supplierContact,COUNT(pr.id) total,COUNT(*) FILTER(WHERE json_extract(pr.fields,'$.confirmed')=1) confirmed,COUNT(*) FILTER(WHERE pr.id IS NOT NULL AND COALESCE(json_extract(pr.fields,'$.confirmed'),0)=0) pending,COUNT(*) FILTER(WHERE pr.id IS NOT NULL AND json_extract(pr.fields,'$.unitPrice') IS NULL) missingPrice FROM projects p LEFT JOIN products pr ON pr.project_id=p.id AND pr.deleted_at IS NULL AND pr.created_at>=? AND pr.created_at<? WHERE p.owner_id=? AND (pr.id IS NOT NULL OR (p.date=? AND p.supplier IS NOT NULL)) GROUP BY p.id,COALESCE(json_extract(pr.fields,'$.supplier'),p.supplier,'') ORDER BY MAX(COALESCE(pr.created_at,p.created_at)) DESC,p.id DESC").all(date,from,to,owner,date) as Omit<MerchantVisit,'demo'>[];
  return rows.map(v=>({...v,demo:Boolean((v as unknown as {demo:number}).demo)}));
}
export function listMerchants(owner: string, projectId: string | undefined, date?: string, favorite = false, range: RecordDateRange = {}): MerchantSummary[] {
  const { clauses, values } = recordScope(owner, projectId, date, favorite, range);
  return db().prepare("SELECT COALESCE(json_extract(pr.fields,'$.supplier'),'') supplier, COALESCE(json_extract(json_group_array(json_extract(pr.fields,'$.supplierContact') ORDER BY pr.created_at DESC,pr.id DESC) FILTER(WHERE COALESCE(json_extract(pr.fields,'$.supplierContact'),'')<>''),'$[0]'),'') supplierContact, COUNT(*) total, COUNT(*) FILTER(WHERE json_extract(pr.fields,'$.confirmed')=1) confirmed, COUNT(*) FILTER(WHERE COALESCE(json_extract(pr.fields,'$.confirmed'),0)=0) pending, COUNT(*) FILTER(WHERE json_extract(pr.fields,'$.unitPrice') IS NULL) missingPrice FROM products pr JOIN projects p ON pr.project_id=p.id WHERE " + clauses.join(' AND ') + " GROUP BY COALESCE(json_extract(pr.fields,'$.supplier'),'') ORDER BY MAX(pr.created_at) DESC,supplier").all(...values) as MerchantSummary[];
}
export function recordsForExport(owner: string, projectId: string | undefined, date?: string, favorite = false, supplier?: string, range: RecordDateRange = {}): Product[] {
  const { clauses, values } = recordScope(owner, projectId, date, favorite, range);
  if(supplier !== undefined){clauses.push("COALESCE(json_extract(pr.fields,'$.supplier'),'')=?");values.push(supplier);}
  return (db().prepare('SELECT pr.*,p.name AS taskName,p.market AS taskMarket,p.date AS taskDate,p.demo FROM products pr JOIN projects p ON pr.project_id=p.id WHERE ' + clauses.join(' AND ') + ' ORDER BY pr.created_at DESC,pr.id DESC').all(...values) as unknown as ProductRow[]).map(hydrate);
}
export function recordDays(owner: string): { date: string; count: number }[] {
  return db().prepare("SELECT date(pr.created_at,'+8 hours') AS date,COUNT(*) AS count FROM products pr JOIN projects p ON pr.project_id=p.id WHERE p.owner_id=? AND pr.deleted_at IS NULL GROUP BY date(pr.created_at,'+8 hours') ORDER BY date DESC").all(owner) as { date: string; count: number }[];
}
export function listProducts(owner: string, projectId: string): Product[] {
  getProject(owner, projectId);
  return (db().prepare("SELECT pr.*,p.demo FROM products pr JOIN projects p ON pr.project_id=p.id WHERE p.owner_id=? AND p.id=? AND pr.deleted_at IS NULL ORDER BY pr.created_at DESC,pr.id DESC").all(owner, projectId) as unknown as ProductRow[]).map(hydrate);
}
export function getProduct(owner: string, id: string): Product {
  const row = db().prepare("SELECT pr.*,p.name AS taskName,p.demo FROM products pr JOIN projects p ON pr.project_id=p.id WHERE p.owner_id=? AND pr.id=?").get(owner, id) as ProductRow | undefined;
  if (!row) notFound();
  return hydrate(row);
}
function ownedMedia(owner: string, id: string): MediaRow {
  const row = db().prepare("SELECT * FROM media WHERE owner_id=? AND id=?").get(owner, id) as MediaRow | undefined;
  if (!row || (row.expires_at !== null && row.expires_at <= Date.now())) notFound();
  return row;
}
export function readPhoto(owner: string, id: string): Buffer {
  ownedMedia(owner, id);
  const bytes = photoStorage.read(id);
  if (!bytes) notFound();
  return bytes;
}
export function stagePhoto(owner: string, upload: { name: string; bytes: Buffer }): Photo {
  const count = db().prepare("SELECT count(*) AS n FROM media WHERE owner_id=? AND product_id IS NULL").get(owner) as { n: number };
  if (count.n >= 100) throw new AppError("MEDIA_QUOTA", "待保存照片过多，请保存商品或等待过期照片清理", 429);
  const id = randomUUID();
  photoStorage.write(id, upload.bytes);
  try {
    db().prepare("INSERT INTO media (id,owner_id,name,expires_at) VALUES (?,?,?,?)").run(id, owner, upload.name, Date.now() + 24 * 60 * 60 * 1000);
  } catch (error) { photoStorage.remove(id); throw error; }
  return { id, name: upload.name, url: `/api/photos/${id}` };
}
export type SaveProductCommand = { requestKey: string; projectId: string; id?: string; version?: number; fields: ProductFields; photoIds: string[] };
export function saveProduct(owner: string, command: SaveProductCommand): Product {
  const { projectId, fields, id, version, photoIds, requestKey } = command;
  return replay(owner, requestKey, { operation: "saveProduct", ...command }, () => {
    getProject(owner, projectId);
    const existing = id ? getProduct(owner, id) : undefined;
    if(existing?.deletedAt)throw new AppError('PRODUCT_TRASHED','商品在回收站，请先恢复',409);
    if (existing && existing.projectId !== projectId) notFound();
    if (existing && existing.version !== version) conflict();
    if (photoIds.length > 6 || new Set(photoIds).size !== photoIds.length) throw new AppError("INVALID_PHOTO", "每件商品最多6张不重复的照片");
    for (const photoId of photoIds) {
      const photo = ownedMedia(owner, photoId);
      if (photo.product_id !== null && photo.product_id !== id) throw new AppError("INVALID_PHOTO", "照片归属无效");
      if (!photoStorage.read(photoId)) throw new AppError("INVALID_PHOTO", "照片文件已丢失，请重新选择");
    }
    const productId = id || randomUUID(), now = new Date().toISOString();
    if (existing) db().prepare("UPDATE products SET fields=?,version=version+1,updated_at=? WHERE id=? AND version=?").run(JSON.stringify(fields), now, productId, version!);
    else db().prepare("INSERT INTO products (id,project_id,fields,created_at,updated_at,version) VALUES (?,?,?,?,?,1)").run(productId, projectId, JSON.stringify(fields), now, now);
    db().prepare("UPDATE media SET product_id=NULL,expires_at=? WHERE product_id=?").run(Date.now() + 24 * 60 * 60 * 1000, productId);
    for (const [position, photoId] of photoIds.entries()) db().prepare("UPDATE media SET product_id=?,position=?,expires_at=NULL WHERE id=? AND owner_id=?").run(productId, position, photoId, owner);
    return getProduct(owner, productId);
  });
}
export function deleteProduct(owner: string, id: string, version: number) {
  return transaction(() => {
    const product = getProduct(owner, id);
    if (product.version !== version) conflict();
    db().prepare("UPDATE media SET product_id=NULL,expires_at=? WHERE product_id=?").run(Date.now(), id);
    db().prepare("DELETE FROM products WHERE id=? AND version=?").run(id, version);
    return { deleted: true };
  });
}
export function trashProduct(owner:string,id:string,version:number,restore=false):Product{
  return transaction(()=>{
    const current=getProduct(owner,id);
    if(restore?!current.deletedAt:!!current.deletedAt)return current;
    if(current.version!==version)conflict('商品已更新，请刷新后重试');
    const now=new Date().toISOString();
    db().prepare('UPDATE products SET deleted_at=?,version=version+1,updated_at=? WHERE id=? AND version=?').run(restore?null:now,now,id,version);
    return getProduct(owner,id);
  });
}
export function pageTrash(owner:string,cursor:string|undefined,limit:number,q=''){
  const clauses=['p.owner_id=?','pr.deleted_at IS NOT NULL'],values:(string|number)[]=[owner];
  if(q){const pattern='%'+q.toLowerCase().replace(/[\\%_]/g,c=>'\\'+c)+'%';clauses.push("(LOWER(json_extract(pr.fields,'$.name')) LIKE ? ESCAPE '\\' OR LOWER(json_extract(pr.fields,'$.supplier')) LIKE ? ESCAPE '\\')");values.push(pattern,pattern);}
  const from='FROM products pr JOIN projects p ON p.id=pr.project_id WHERE '+clauses.join(' AND ');
  const total=(db().prepare('SELECT COUNT(*) n '+from).get(...values) as {n:number}).n;
  const boundary=cursor?resolveProductCursor(owner,'trash',cursor,from,values):null;
  if(boundary){clauses.push('(pr.created_at<? OR (pr.created_at=? AND pr.id<?))');values.push(boundary.created_at,boundary.created_at,boundary.id);}
  const rows=db().prepare('SELECT pr.*,p.name taskName,p.date taskDate,p.market taskMarket,p.demo FROM products pr JOIN projects p ON p.id=pr.project_id WHERE '+clauses.join(' AND ')+' ORDER BY pr.created_at DESC,pr.id DESC LIMIT ?').all(...values,limit+1) as unknown as ProductRow[];
  const items=rows.slice(0,limit).map(hydrate);return{items,matchedCount:total,nextCursor:rows.length>limit?encodeProductCursor('trash',items[items.length-1].id):null};
}
export function setFavorite(owner: string, id: string, favorite: boolean, version: number): Product {
  return transaction(() => {
    const current = getProduct(owner, id);
    if(current.deletedAt)throw new AppError('PRODUCT_TRASHED','商品在回收站，请先恢复',409);
    if (current.favorite === favorite) return current;
    if (current.version !== version) conflict('商品已更新，请刷新后重新收藏');
    db().prepare("UPDATE products SET fields=json_set(fields,'$.favorite',json(?)),version=version+1,updated_at=? WHERE id=? AND version=?").run(JSON.stringify(favorite), new Date().toISOString(), id, version);
    return getProduct(owner, id);
  });
}
export function collectGarbage() {
  const now = Date.now();
  transaction(() => {
    db().prepare("DELETE FROM media WHERE product_id IS NULL AND expires_at<=?").run(now);
    db().prepare("DELETE FROM sessions WHERE expires_at<=?").run(now);
  });
  const referenced = new Set((db().prepare("SELECT id FROM media").all() as { id: string }[]).map(x => x.id));
  return { filesRemoved: photoStorage.sweep(referenced, now - 60 * 60 * 1000) };
}
export interface MarketRepository {
  listProjects: typeof listProjects;
  getProject: typeof getProject;
  createProject: typeof createProject;
  listProducts: typeof listProducts;
  listMerchantVisits: typeof listMerchantVisits;
  listMerchants: typeof listMerchants;
  recordsForExport: typeof recordsForExport;
  pageProducts: typeof pageProducts;
  projectSummary: typeof projectSummary;
  getProduct: typeof getProduct;
  saveProduct: typeof saveProduct;
  deleteProduct: typeof deleteProduct;
  trashProduct: typeof trashProduct;
  pageTrash: typeof pageTrash;
  stagePhoto: typeof stagePhoto;
  readPhoto: typeof readPhoto;
}
export const repository: MarketRepository = { listProjects, getProject, createProject, listProducts, listMerchantVisits, listMerchants, recordsForExport, pageProducts, projectSummary, getProduct, saveProduct, deleteProduct, trashProduct, pageTrash, stagePhoto, readPhoto };
