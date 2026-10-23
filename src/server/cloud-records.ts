import { randomUUID } from 'node:crypto';
import { AppError } from '../lib/errors';
import { emptyFields, emptyProfile, type Product, type Photo, type Project, type ProjectSummary, type UserProfileFields } from '../lib/types';
import type { MarketRepository, ProductFilter, SaveProductCommand } from '../lib/db';
import { recordDateRangeBounds, type RecordDateRange } from '../lib/db';
export type AsyncMarketRepository = { [K in keyof MarketRepository]: (...args: Parameters<MarketRepository[K]>) => Promise<ReturnType<MarketRepository[K]>> };
import { createProjectSchema } from './contracts';
import { CloudDatabase, commandDigest, assertCloudOwner, type CloudCommands, type CloudOperation, type CloudBlobStore, type CloudContext, type CloudMedia, type CloudPage } from './cloud-db';

function summary(value: ProjectSummary): ProjectSummary {
  return { total: Number(value.total), confirmed: Number(value.confirmed), pending: Number(value.pending), missingPrice: Number(value.missingPrice), suppliers: Number(value.suppliers), photos: Number(value.photos) };
}
function project(value: Project): Project {
  return { ...value, demo: Boolean(value.demo), date: value.date.slice(0, 10), createdAt: new Date(value.createdAt).toISOString(), ...(value.summary ? { summary: summary(value.summary) } : {}) };
}
function hydrate(product: Product): Product {
  const value = { ...emptyFields, ...product, demo: Boolean(product.demo), confirmed: Boolean(product.confirmed), favorite: Boolean(product.favorite), version: Number(product.version), createdAt: new Date(product.createdAt).toISOString(), updatedAt: new Date(product.updatedAt).toISOString(), photos: (product.photos || []).map(photo => ({ id: photo.id, name: photo.name, url: `/api/photos/${photo.id}` })) };
  for (const key of ['weightG', 'unitPrice', 'moq', 'cartonQty', 'cartonCbm', 'leadTimeDays', 'rating','cartons','quantity'] as const) value[key] = value[key] == null ? null : Number(value[key]);
  return value;
}
function photo(media: CloudMedia): Photo { return { id: media.id, name: media.name, url: `/api/photos/${media.id}` }; }
/** 每请求创建一个实例，tokenHash必须来自BFF认证；方法的owner也只能由BFF传入。 */
export class CloudRecords implements AsyncMarketRepository {
  private readonly auth: CloudContext;
  constructor(private readonly db: CloudDatabase, private readonly blobs: CloudBlobStore, auth: CloudContext) { this.auth = { ...auth }; }
  private call<O extends CloudOperation>(operation: O, owner: string, payload: CloudCommands[O]['payload']) {
    assertCloudOwner(this.auth, owner);
    return this.db.call(operation, owner, this.auth.tokenHash, payload);
  }
  async capabilities(owner: string): Promise<{ dateRangeExport: boolean }> {
    try { return { dateRangeExport: (await this.call('capabilities', owner, {}))?.dateRangeExport === true }; }
    catch (error) { if (error instanceof AppError && error.code === 'UNKNOWN_OPERATION') return { dateRangeExport: false }; throw error; }
  }
  private async checkRange(owner: string, date: string | undefined, range: RecordDateRange) {
    recordDateRangeBounds(date, range);
    if ((range.dateFrom !== undefined || range.dateTo !== undefined) && !(await this.capabilities(owner)).dateRangeExport) throw new AppError('DATE_RANGE_UNSUPPORTED', '当前服务暂不支持跨日期导出，请更新服务后重试', 409);
  }
  forOwner(owner: string) {
    assertCloudOwner(this.auth, owner);
    return {
      listProjects: () => this.listProjects(owner), getProject: (id: string) => this.getProject(owner, id),
      createProject: (value: Pick<Project, 'name' | 'market' | 'date' | 'supplier' | 'supplierContact'>, requestKey: string) => this.createProject(owner, value, requestKey),
      listProducts: (id: string) => this.listProducts(owner, id),
      listMerchantVisits:(date:string)=>this.listMerchantVisits(owner,date),
      listMerchants: (id?: string,date?: string,favorite?: boolean,range?:RecordDateRange)=>this.listMerchants(owner,id,date,favorite,range),
      recordsForExport: (id?: string, date?: string, favorite?: boolean, supplier?:string,range?:RecordDateRange) => this.recordsForExport(owner, id, date, favorite, supplier,range),
      pageProducts: (id: string | undefined, cursor: string | undefined, limit: number, filter?: ProductFilter) => this.pageProducts(owner, id, cursor, limit, filter),
      projectSummary: (id: string,filter?:ProductFilter) => this.projectSummary(owner, id,filter), getProduct: (id: string) => this.getProduct(owner, id),
      saveProduct: (command: SaveProductCommand) => this.saveProduct(owner, command),
      deleteProduct: (id: string, version: number) => this.deleteProduct(owner, id, version),
      trashProduct:(id:string,version:number,restore=false)=>this.trashProduct(owner,id,version,restore),
      pageTrash:(cursor:string|undefined,limit:number,q='')=>this.pageTrash(owner,cursor,limit,q),
      setFavorite: (id: string, favorite: boolean, version: number) => this.setFavorite(owner, id, favorite, version),
      recordDays: () => this.recordDays(owner), getProfile: () => this.getProfile(owner),
      saveProfile: (fields: UserProfileFields, version: number) => this.saveProfile(owner, fields, version),
      stagePhoto: (upload: { name: string; bytes: Buffer }) => this.stagePhoto(owner, upload), readPhoto: (id: string) => this.readPhoto(owner, id),
    };
  }
  async listProjects(owner: string): Promise<Project[]> { return (await this.call('projects/list', owner, {})).map(project); }
  async getProject(owner: string, id: string): Promise<Project> { return project(await this.call('projects/get', owner, { id })); }
  async createProject(owner: string, value: Pick<Project, 'name' | 'market' | 'date' | 'supplier' | 'supplierContact'>, requestKey: string): Promise<Project> {
    assertCloudOwner(this.auth, owner);
    const { requestKey: key, ...fields } = createProjectSchema.parse({ ...value, requestKey });
    return project(await this.call('projects/create', owner, { ...fields, requestKey: key, digest: commandDigest({ operation: 'createProject', ...fields }) }));
  }
  async getProduct(owner: string, id: string): Promise<Product> { return hydrate(await this.call('product/get', owner, { id })); }
  async pageProducts(owner: string, projectId: string | undefined, cursor: string | undefined, limit: number, filter: ProductFilter = {}): Promise<CloudPage> {
    await this.checkRange(owner, filter.date, filter);
    const page = await this.call('product/page', owner, { ...filter, projectId, cursor, limit });
    return { ...page, items: page.items.map(hydrate), summary: summary(page.summary), matchedCount: Number(page.matchedCount) };
  }
  async projectSummary(owner: string, projectId: string,filter:ProductFilter={}) { return (await this.pageProducts(owner, projectId, undefined, 1,filter)).summary; }
  async listMerchantVisits(owner:string,date:string){return (await this.call('merchant/visits',owner,{date})).map(v=>({...v,date:v.date.slice(0,10),total:Number(v.total),confirmed:Number(v.confirmed),pending:Number(v.pending),missingPrice:Number(v.missingPrice)}));}
  async listMerchants(owner:string,projectId:string|undefined,date?:string,favorite=false,range:RecordDateRange={}) {
    await this.checkRange(owner,date,range);
    return (await this.call('merchant/list',owner,{projectId,date,favorite,...range})).map(m=>({...m,total:Number(m.total),confirmed:Number(m.confirmed),pending:Number(m.pending),missingPrice:Number(m.missingPrice)}));
  }
  async recordsForExport(owner: string, projectId: string | undefined, date?: string, favorite = false, supplier?: string,range:RecordDateRange={}): Promise<Product[]> {
    await this.checkRange(owner,date,range);
    return (await this.call('product/listExport', owner, { projectId, date, favorite, supplier,...range })).map(hydrate);
  }
  listProducts(owner: string, projectId: string) { return this.recordsForExport(owner, projectId); }
  async saveProduct(owner: string, command: SaveProductCommand): Promise<Product> {
    assertCloudOwner(this.auth, owner);
    const parsed = structuredClone(command), payload = { ...parsed, digest: commandDigest({ operation: 'saveProduct', ...parsed }) };
    if (!Array.isArray(parsed.photoIds) || parsed.photoIds.length > 6 || new Set(parsed.photoIds).size !== parsed.photoIds.length) throw new AppError('INVALID_PHOTO', '每件商品最多6张不重复的照片');
    // 回执先查再读照片，避免成功回执因后来删图/过期而失去重放能力；最终RPC重新检查CAS及归属。
    const replay = await this.call('product/save', owner, { ...payload, checkOnly: true });
    if (replay) return hydrate(replay);
    await Promise.all(parsed.photoIds.map(async id => {
      const media = await this.call('media/get', owner, { id });
      const info = await this.blobs.info(media.objectKey);
      if (!info.size || info.mime !== 'image/jpeg') throw new AppError('INVALID_PHOTO', '照片文件已丢失，请重新选择');
    }));
    const saved = await this.call('product/save', owner, payload);
    if (!saved) throw new AppError('DB_RESPONSE_INVALID', '商品保存响应无效', 502);
    return hydrate(saved);
  }
  deleteProduct(owner: string, id: string, version: number) { return this.call('product/delete', owner, { id, version }); }
  async trashProduct(owner:string,id:string,version:number,restore=false){return hydrate(await this.call(restore?'product/restore':'product/trash',owner,{id,version}));}
  async pageTrash(owner:string,cursor:string|undefined,limit:number,q=''){const result=await this.call('product/trashPage',owner,{cursor,limit,q});return{...result,items:result.items.map(hydrate),matchedCount:Number(result.matchedCount)};}
  async setFavorite(owner: string, id: string, favorite: boolean, version: number) { return hydrate(await this.call('product/favorite', owner, { id, favorite, version })); }
  async recordDays(owner: string) { return (await this.call('recordDays', owner, {})).map(value => ({ date: value.date, count: Number(value.count) })); }
  async getProfile(owner: string) { const value = await this.call('getProfile', owner, {}); return { ...emptyProfile, ...value, version: Number(value.version) }; }
  async saveProfile(owner: string, fields: UserProfileFields, version: number) { const value = await this.call('saveProfile', owner, { fields, version }); return { ...emptyProfile, ...value, version: Number(value.version) }; }
  async stagePhoto(owner: string, upload: { name: string; bytes: Buffer }): Promise<Photo> {
    assertCloudOwner(this.auth, owner);
    await this.call('getProfile', owner, {});
    // bytes由主控经Sharp规范化。RPC失败的孤儿留给TTL清理，不能误删已提交引用。
    const id = randomUUID(), objectKey = `${owner}/photos/${id}.jpg`;
    await this.blobs.write(objectKey, upload.bytes, 'image/jpeg');
    return photo(await this.call('media/stage', owner, { id, objectKey, name: upload.name }));
  }
  async readPhoto(owner: string, id: string): Promise<Buffer> {
    const media = await this.call('media/get', owner, { id });
    const bytes = await this.blobs.read(media.objectKey);
    await this.call('media/get', owner, { id });
    if (!bytes.length) throw new AppError('NOT_FOUND', '图片不存在', 404);
    return bytes;
  }
  listExpiredMedia(owner: string, limit = 100) { return this.call('media/listExpired', owner, { limit }); }
}
export function createCloudRecords(db: CloudDatabase, blobs: CloudBlobStore, context: CloudContext) { return new CloudRecords(db, blobs, context).forOwner(context.owner); }
