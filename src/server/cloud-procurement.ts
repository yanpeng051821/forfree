import { randomUUID } from 'node:crypto';
import { AppError, conflict, notFound } from '../lib/errors';
import { procurementView, type Procurement } from '../lib/procurement';
import { normalizeProcurementTemplate, templateSaveSchema, type ProcurementTemplateFields } from '../lib/procurement-template';
import { assertCloudOwner, CloudDatabase, type CloudBlobStore, type CloudContext, type CloudProcurement } from './cloud-db';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
function pictureKey(owner: string, reference: string): string {
  const key = reference.startsWith('cloud:') ? reference.slice(6) : '';
  if (!new RegExp(`^${UUID}/pictures/${UUID}\\.jpg$`).test(key) || !key.startsWith(owner + '/pictures/')) throw new AppError('INVALID_PHOTO', '采购图片归属无效');
  return key;
}
async function mapPictures(values: string[], work: (value: string) => Promise<string>): Promise<Map<string, string>> {
  const unique = [...new Set(values)], result = new Map<string, string>();
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(6, unique.length) }, async () => {
    while (index < unique.length) { const value = unique[index++]; result.set(value, await work(value)); }
  }));
  return result;
}
function hydrate(row: CloudProcurement): Procurement {
  const doc = structuredClone(row.document);
  doc.version = Number(doc.version);
  doc.createdAt = new Date(doc.createdAt).toISOString(); doc.updatedAt = new Date(doc.updatedAt).toISOString();
  if (doc.template) doc.template = normalizeProcurementTemplate(doc.template);
  return doc;
}

/** 仅存采购元数据；对象写入先于RPC，失败或删除产生的孤儿由主控延迟清理。 */
export class CloudProcurementStore {
  private readonly auth: CloudContext;
  constructor(private readonly db: CloudDatabase, private readonly blobs: CloudBlobStore, auth: CloudContext) { this.auth = { ...auth }; }
  private async row(owner: string, id: string): Promise<CloudProcurement> {
    assertCloudOwner(this.auth, owner);
    return this.db.call('procurement/get', owner, this.auth.tokenHash, { id });
  }
  private async externalize(owner: string, value: Procurement): Promise<Procurement> {
    const doc = structuredClone(value);
    if (doc.template) doc.template = normalizeProcurementTemplate(doc.template);
    const mapping = await mapPictures(doc.lines.flatMap(line => line.images), async image => {
      if (image.startsWith('cloud:')) {
        const key = pictureKey(owner, image), info = await this.blobs.info(key);
        if (!info.size || info.mime !== 'image/jpeg') throw new AppError('INVALID_PHOTO', '采购图片不存在');
        return image;
      }
      const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/.exec(image);
      if (!match) throw new AppError('INVALID_PHOTO', '采购图片必须是规范化JPEG');
      const bytes = Buffer.from(match[1], 'base64');
      if (!bytes.length || bytes.toString('base64') !== match[1] || bytes.length > 8 * 1024 * 1024) throw new AppError('INVALID_PHOTO', '采购图片格式或大小无效');
      const key = `${owner}/pictures/${randomUUID()}.jpg`;
      await this.blobs.write(key, bytes, 'image/jpeg'); return 'cloud:' + key;
    });
    for (const line of doc.lines) line.images = line.images.map(value => mapping.get(value)!);
    return doc;
  }
  async list(owner: string) {
    assertCloudOwner(this.auth, owner);
    const docs = await this.db.call('procurement/list', owner, this.auth.tokenHash, {});
    return docs.map(doc => ({ id: doc.id, version: Number(doc.version), name: doc.name, updatedAt: new Date(doc.updatedAt).toISOString(), summary: procurementView(doc).summary }));
  }
  async create(owner: string, value: Procurement, original?: Buffer): Promise<Procurement> {
    assertCloudOwner(this.auth, owner);
    await this.db.call('getProfile', owner, this.auth.tokenHash, {});
    const doc = await this.externalize(owner, value);
    let originalKey: string | null = null;
    if (original) {
      if (original.length > 40 * 1024 * 1024) throw new AppError('WORKBOOK_LIMIT', 'Excel不能超过40MB', 413);
      originalKey = `${owner}/procurement/${randomUUID()}.xlsx`;
      await this.blobs.write(originalKey, original, XLSX);
    }
    return hydrate(await this.db.call('procurement/create', owner, this.auth.tokenHash, { document: doc, originalKey }));
  }
  async read(owner: string, id: string, expandImages = false): Promise<Procurement> {
    const doc = hydrate(await this.row(owner, id));
    if (!expandImages) return doc;
    const mapping = await mapPictures(doc.lines.flatMap(line => line.images), async image => {
      const bytes = await this.blobs.read(pictureKey(owner, image));
      if (!bytes.length) notFound();
      return `data:image/jpeg;base64,${bytes.toString('base64')}`;
    });
    for (const line of doc.lines) line.images = line.images.map(value => mapping.get(value)!);
    await this.row(owner, id);
    return doc;
  }
  async update(owner: string, id: string, version: number, change: (doc: Procurement) => void): Promise<Procurement> {
    const current = hydrate(await this.row(owner, id));
    if (current.version !== version && current.version !== version + 1) conflict('整理记录已更新，请重新打开后修改');
    const candidate = structuredClone(current);
    if (change.constructor.name === 'AsyncFunction') throw new AppError('INVALID_CHANGE', '采购修改回调必须同步且不返回值');
    const changed: unknown = change(candidate);
    if (changed !== undefined) throw new AppError('INVALID_CHANGE', '采购修改回调必须同步且不返回值');
    if (candidate.id !== current.id || candidate.sourceHash !== current.sourceHash || candidate.createdAt !== current.createdAt) throw new AppError('VALIDATION', '采购来源和标识不能修改');
    const doc = await this.externalize(owner, candidate);
    return hydrate(await this.db.call('procurement/update', owner, this.auth.tokenHash, { id, version, document: doc }));
  }
  async original(owner: string, id: string): Promise<Buffer> {
    const row = await this.row(owner, id);
    if (!row.originalKey) notFound();
    const bytes = await this.blobs.read(row.originalKey);
    await this.row(owner, id);
    if (!bytes.length) notFound();
    return bytes;
  }
  async resolveImage(owner: string, id: string, lineId: string, index: number): Promise<Buffer> {
    const row = await this.row(owner, id);
    const image = Number.isInteger(index) && index >= 0 ? row.document.lines.find(line => line.id === lineId)?.images[index] : undefined;
    if (!image) notFound();
    const bytes = await this.blobs.read(pictureKey(owner, image));
    const latest = await this.row(owner, id);
    if (latest.document.lines.find(line => line.id === lineId)?.images[index] !== image || !bytes.length) notFound();
    return bytes;
  }
  async delete(owner: string, id: string, version: number): Promise<void> {
    assertCloudOwner(this.auth, owner);
    await this.db.call('procurement/delete', owner, this.auth.tokenHash, { id, version });
  }
}
export class CloudTemplateStore {
  private readonly auth: CloudContext;
  constructor(private readonly db: CloudDatabase, auth: CloudContext) { this.auth = { ...auth }; }
  async read(owner: string) {
    assertCloudOwner(this.auth, owner);
    return normalizeProcurementTemplate(await this.db.call('template/get', owner, this.auth.tokenHash, {}) || undefined);
  }
  async save(owner: string, version: number, fields: ProcurementTemplateFields) {
    assertCloudOwner(this.auth, owner);
    const parsed = templateSaveSchema.parse({ version, fields });
    const { version: ignored, ...normalized } = normalizeProcurementTemplate({ ...parsed.fields, version });
    return normalizeProcurementTemplate(await this.db.call('template/save', owner, this.auth.tokenHash, { version, fields: normalized }));
  }
}
