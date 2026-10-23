import { randomUUID } from 'node:crypto';
import { emptyFields, type Product, type ProductFields, type Extraction } from '../lib/types';
import { fieldsSchema } from '../lib/schema';
import { AppError } from '../lib/errors';
import type { MarketService } from './service';
import type { ModelContext } from './cloud-session';

export function productFields(value: Product): ProductFields {
  return fieldsSchema.parse(Object.fromEntries(Object.keys(emptyFields).map(key => [key, value[key as keyof ProductFields]])));
}
export function mergeOrganizedProduct(product: Product, result: Extraction): ProductFields {
  const current = productFields(product), next = { ...current };
  const allowed: (keyof ProductFields)[] = ['name','sku','supplier','supplierContact','colors','material','dimensions','weightG','unitPrice','currency','moq','cartons','quantity','barcode','cartonQty','cartonDimensions','cartonCbm','leadTimeDays','tradeTerms','notes','exportRemarks'];
  const ignored = new Set(result.estimates || []);
  for (const key of allowed) {
    if (ignored.has(key)) continue;
    const incoming = result.fields[key];
    const empty = next[key] === '' || next[key] === null || (key === 'name' && next.name === '未命名商品');
    // Default currency can only follow an explicitly extracted price for an unpriced record.
    if (key === 'currency' ? current.unitPrice !== null || ignored.has('unitPrice') || !result.fields.currency || result.fields.unitPrice == null : !empty) continue;
    if (incoming !== undefined && incoming !== null) Object.assign(next, { [key]: incoming });
  }
  return fieldsSchema.parse({ ...next, confirmed: false });
}
/** A bounded per-owner queue. The job is durable; execution currently lives in one container. */
export class ProductOrganizeQueue {
  private counts = new Map<string, number>();
  private tails = new Map<string, Promise<unknown>>();
  private total = 0;
  reserve(owner: string) {
    if ((this.counts.get(owner) || 0) >= 4 || this.total >= 12) throw new AppError('BUSY','后台整理队列已满，商品已保存，可稍后重试',429);
    this.counts.set(owner,(this.counts.get(owner)||0)+1); this.total++;
    let released = false;
    return () => { if(released)return;released=true;this.total--;const n=(this.counts.get(owner)||1)-1;if(n)this.counts.set(owner,n);else this.counts.delete(owner); };
  }
  async run<T>(owner: string, work: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(owner) || Promise.resolve();
    const next = prior.catch(()=>{}).then(work);this.tails.set(owner,next);
    try { return await next; } finally { if(this.tails.get(owner)===next)this.tails.delete(owner); }
  }
}
export async function applyProductOrganization(service: MarketService, owner: string, snapshot: Product, context: ModelContext, checkpoint: () => Promise<void>) {
  const current = await service.records.getProduct(owner,snapshot.id);
  if(current.deletedAt || current.version!==snapshot.version || current.organizeJobId!==snapshot.organizeJobId) throw new AppError('CONFLICT','商品已修改，本次整理未覆盖你的输入',409);
  const result = await service.extract(owner,snapshot.description,snapshot.photos.map(p=>p.id),context);
  await checkpoint();
  const latest = await service.records.getProduct(owner,snapshot.id);
  if(latest.version!==snapshot.version || latest.organizeJobId!==snapshot.organizeJobId) throw new AppError('CONFLICT','商品已修改，本次整理未覆盖你的输入',409);
  const fields = Object.assign(mergeOrganizedProduct(latest,result),{organizeState:'done',organizeJobId:snapshot.organizeJobId});
  await service.records.saveProduct(owner,{requestKey:randomUUID(),projectId:snapshot.projectId,id:snapshot.id,version:snapshot.version,fields,photoIds:snapshot.photos.map(p=>p.id)});
  return result;
}
