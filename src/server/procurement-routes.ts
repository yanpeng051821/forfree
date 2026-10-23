import { basename } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate } from './auth';
import type { MarketService } from './service';
import { AppError } from '../lib/errors';
import { readProcurement, procurementView, procurementFromProducts, lineCalculation, type Procurement } from '../lib/procurement';
import { ProcurementStore, validateProcurementZip } from '../lib/procurement-store';
import { exportProcurement } from '../lib/procurement-export';
import { ProcurementTemplateStore, templateSaveSchema, normalizeProcurementTemplate } from '../lib/procurement-template';

type AwaitableMethods<T> = { [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => R | Promise<R> : never };
type RouteStore = AwaitableMethods<Pick<ProcurementStore, 'list' | 'create' | 'update' | 'delete'>> & {
  original(owner: string, id: string): Buffer | Promise<Buffer>;
  read(owner: string, id: string, expandImages?: boolean): Procurement | Promise<Procurement>;
  resolveImage?(owner: string, id: string, lineId: string, index: number): Promise<Buffer>;
};
type RouteTemplates = AwaitableMethods<Pick<ProcurementTemplateStore, 'read' | 'save'>>;
/** 对象直传侧的门面：只暴露"凭证换对象键、确认已提交、读取字节"，路由不接触存储实现。 */
export type RouteUploads = {
  objectKeyOf(owner: string, uploadId: string): string | Promise<string>;
  requireCommitted(owner: string, objectKey: string): { objectKey: string } | Promise<{ objectKey: string }>;
  read(owner: string, objectKey: string): Promise<Buffer>;
};
/** 持久任务侧门面：导入与导出都只回任务号。 */
export type RouteJobs = {
  startWorkbookImport(owner: string, objectKey: string, filename: string): Promise<{ jobId: string; state: string }>;
  startWorkbookExport(owner: string, procurementId: string): Promise<{ jobId: string; state: string }>;
};
export type ProcurementRouteOptions = {
  session?: (req: FastifyRequest) => { owner: string };
  cloudFactory?: (req: FastifyRequest) => { store: RouteStore; templates: RouteTemplates };
  uploads?: (req: FastifyRequest) => RouteUploads;
  jobs?: (req: FastifyRequest) => RouteJobs;
};
/**
 * 网关入口是20MB/60秒，采购表上限是40MB：multipart 只是小文件兼容通道，
 * 超过20MB一律先走 /api/uploads/prepare|commit 对象直传，再用 {uploadId} 导入，
 * 不要提高网关上限，也不要在请求里缓冲大文件。
 */
const MULTIPART_IMPORT_LIMIT = 20 * 1024 * 1024;
/** 大导出阈值：商品数或图片累计字节超过后交给持久任务，不在请求内渲染。 */
const EXPORT_ASYNC_LINE_COUNT = 200;
const EXPORT_ASYNC_IMAGE_BYTES = 20 * 1024 * 1024;
const DATA_IMAGE = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/;
const id = z.uuid();
const versionSchema = z.strictObject({ version: z.number().int().positive() });
const nullableNumber = z.number().finite().nonnegative().max(1_000_000_000).nullable();
const fields = z.strictObject({
  decision: z.enum(['pending', 'include', 'cancel']),
  cartons: z.number().int().nonnegative().max(1_000_000).nullable(),
  pcsPerCarton: z.number().int().positive().max(1_000_000).nullable(),
  quantity: z.number().int().nonnegative().max(100_000_000).nullable().optional(),
  unitPrice: nullableNumber, cartonCbm: z.number().finite().nonnegative().max(100).nullable(),
  note: z.string().max(2000),
  custom: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), z.string().max(2000)).optional(),
});
const uploadRefSchema = z.strictObject({ uploadId: id });
/** 请求体是 {uploadId} 的 JSON 时走对象直传分支；multipart 走原来的小文件兼容分支。 */
function uploadReference(req: FastifyRequest): { uploadId: string } | null {
  if (typeof req.isMultipart === 'function' && req.isMultipart()) return null;
  return uploadRefSchema.parse(req.body ?? {});
}
function exportImageBytes(doc: Procurement): number {
  return doc.lines.reduce((total, line) => total + line.images.reduce((sum, image) => {
    const match = DATA_IMAGE.exec(image);
    return sum + (match ? Math.floor(match[1].length * 3 / 4) : 0);
  }, 0), 0);
}
function needsAsyncExport(doc: Procurement): boolean {
  return doc.lines.length > EXPORT_ASYNC_LINE_COUNT || exportImageBytes(doc) > EXPORT_ASYNC_IMAGE_BYTES;
}
function publicView(doc: Parameters<typeof procurementView>[0]) {
  const view = procurementView(doc);
  return { ...view, template: normalizeProcurementTemplate(doc.template), lines: view.lines.map(({ images, ...line }, index) => ({ ...line, recordedQuantity: doc.lines[index].quantity ?? null, imageCount: images.length, imageUrls: images.map((_, index) => `/api/procurement/${doc.id}/images/${line.id}/${index}`) })) };
}
export async function registerProcurementRoutes(app: FastifyInstance, root: string, service: MarketService | ((req: FastifyRequest) => MarketService), options: ProcurementRouteOptions = {}) {
  const local = options.cloudFactory ? undefined : { store: new ProcurementStore(root), templates: new ProcurementTemplateStore(root) };
  const scopes = new WeakMap<FastifyRequest, { store: RouteStore; templates: RouteTemplates }>();
  const scope = (req: FastifyRequest): { store: RouteStore; templates: RouteTemplates } => {
    if (local) return local;
    let value = scopes.get(req);
    if (!value) { value = options.cloudFactory!(req); scopes.set(req, value); }
    return value;
  };
  const active = new Set<string>();
  const owner = (req: FastifyRequest) => options.session ? options.session(req).owner : authenticate(req.headers.authorization).owner;
  const busy = async <T>(account: string, work: () => Promise<T>) => {
    if (active.size || active.has(account)) throw new AppError('BUSY', '表格正在处理，请稍后重试', 429);
    active.add(account); try { return await work(); } finally { active.delete(account); }
  };
  const uploadClient = (req: FastifyRequest) => {
    if (!options.uploads) throw new AppError('CLOUD_CONFIG', '云直传依赖未注入，大文件请改用对象直传', 503);
    return options.uploads(req);
  };
  const jobClient = (req: FastifyRequest) => {
    if (!options.jobs) throw new AppError('CLOUD_CONFIG', '持久任务依赖未注入，无法异步处理', 503);
    return options.jobs(req);
  };
  /** 直传分支统一入口：凭证换对象键、确认已提交、读字节并按同一上限做结构校验。 */
  async function committedWorkbook(req: FastifyRequest, account: string, uploadId: string): Promise<{ objectKey: string; bytes: Buffer }> {
    const uploads = uploadClient(req), objectKey = await uploads.objectKeyOf(account, uploadId);
    await uploads.requireCommitted(account, objectKey);
    const bytes = await uploads.read(account, objectKey);
    validateProcurementZip(bytes);
    return { objectKey, bytes };
  }
  app.get('/api/procurement', async req => await scope(req).store.list(owner(req)));
  app.get('/api/procurement-template', async req => await scope(req).templates.read(owner(req)));
  app.post('/api/procurement-template', async req => {
    const { version, fields } = templateSaveSchema.parse(req.body);
    return await scope(req).templates.save(owner(req), version, fields);
  });
  app.post('/api/procurement-template/import', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async req => {
    const account = owner(req);
    return busy(account, async () => {
      // 大采购表走对象直传：先 prepare/commit，再用 {uploadId} 提交，字节不经过网关。
      const reference = uploadReference(req);
      if (reference) {
        const { bytes } = await committedWorkbook(req, account, reference.uploadId);
        const doc = await readProcurement(bytes, '模板.xlsx');
        if (!doc.template) throw new AppError('UNSUPPORTED_TEMPLATE', '未识别出公司名、英文名、地址、联系方式和单据标题，请在设置中填写');
        return { ...normalizeProcurementTemplate(doc.template), version: (await scope(req).templates.read(account)).version };
      }
      const file = await req.file({ limits: { fileSize: MULTIPART_IMPORT_LIMIT, files: 1, fields: 0, parts: 1 } });
      if (!file || file.fieldname !== 'workbook' || !/\.xlsx$/i.test(file.filename)) throw new AppError('INVALID_WORKBOOK', '请选择 .xlsx 采购表');
      const bytes = await file.toBuffer();
      if (file.file.truncated) throw new AppError('WORKBOOK_LIMIT', '表单上传仅支持20MB以内，更大的采购表请先走对象直传', 413);
      validateProcurementZip(bytes); const doc = await readProcurement(bytes, '模板.xlsx');
      if (!doc.template) throw new AppError('UNSUPPORTED_TEMPLATE', '未识别出公司名、英文名、地址、联系方式和单据标题，请在设置中填写');
      return { ...normalizeProcurementTemplate(doc.template), version: (await scope(req).templates.read(account)).version };
    });
  });
  app.post('/api/procurement/import', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const account = owner(req), { store, templates } = scope(req);
    return busy(account, async () => {
      // 直传分支：对象已提交即返回任务号，解析与建记录在后台做，避免入口20MB/60秒限制。
      const reference = uploadReference(req);
      if (reference) {
        const { objectKey } = await committedWorkbook(req, account, reference.uploadId);
        const job = await jobClient(req).startWorkbookImport(account, objectKey, '采购表.xlsx');
        return reply.code(202).send({ jobId: job.jobId, state: job.state });
      }
      // 兼容分支：只保留小文件，20MB 以上必须走直传，不提高网关上限。
      const file = await req.file({ limits: { fileSize: MULTIPART_IMPORT_LIMIT, files: 1, fields: 0, parts: 1 } });
      if (!file || file.fieldname !== 'workbook' || !/\.xlsx$/i.test(file.filename)) throw new AppError('INVALID_WORKBOOK', '请选择 .xlsx 采购表');
      const bytes = await file.toBuffer();
      if (file.file.truncated) throw new AppError('WORKBOOK_LIMIT', '表单上传仅支持20MB以内，更大的采购表请先走对象直传', 413);
      validateProcurementZip(bytes);
      const filename = basename(file.filename).replace(/[\r\n]/g, '').slice(0, 160);
      const doc = await readProcurement(bytes, filename);
      const savedTemplate = await templates.read(account);
      doc.template = savedTemplate.version > 0 ? savedTemplate : doc.template || savedTemplate;
      doc.lines.forEach(line => { line.custom = {}; });
      return reply.code(201).send(publicView(await store.create(account, doc, bytes)));
    });
  });
  app.post('/api/procurement/from-project', async (req, reply) => {
    const account = owner(req), { projectId } = z.strictObject({ projectId: id }).parse(req.body), { store, templates } = scope(req);
    return busy(account, async () => {
      const currentService = typeof service === 'function' ? service(req) : service;
      const project = await currentService.records.getProject(account, projectId);
      const products = await currentService.records.listProducts(account, projectId);
      if (products.some(p => p.currency !== 'CNY')) throw new AppError('CURRENCY_UNSUPPORTED', '当前采购整理支持人民币，请先选择人民币商品任务');
      const doc = await procurementFromProducts(project, products, photo => currentService.records.readPhoto(account, photo));
      doc.template = await templates.read(account);
      const defaults = [doc.template.paymentTerms && '付款方式：' + doc.template.paymentTerms, doc.template.shippingMark && '唛头：' + doc.template.shippingMark, doc.template.packingRequirements && '包装要求：' + doc.template.packingRequirements].filter(Boolean).join('\n');
      doc.suppliers.forEach(s => { s.information += (s.information && defaults ? '\n' : '') + defaults; });
      doc.lines.forEach(line => { line.custom = {}; });
      return reply.code(201).send(publicView(await store.create(account, doc)));
    });
  });
  app.get('/api/procurement/:id', async req => publicView(await scope(req).store.read(owner(req), id.parse((req.params as { id: string }).id))));
  app.post('/api/procurement/:id/template', async req => {
    const account = owner(req), recordId = id.parse((req.params as { id: string }).id), { version } = versionSchema.parse(req.body), { store, templates } = scope(req);
    const next = await templates.read(account);
    return publicView(await store.update(account, recordId, version, doc => {
      // 已删除自定义列若仍有数据，保留在记录自己的模板内。
      const used = normalizeProcurementTemplate(doc.template).customFields.filter(field => !next.customFields.some(c => c.key === field.key) && doc.lines.some(line => line.custom?.[field.key]));
      if (next.customFields.length + used.length > 8) throw new AppError('TEMPLATE_LIMIT', '已有自定义列含数据，应用后超过8列；请先整理现有列');
      if (used.some(field => [...next.columns.filter(c => c.enabled), ...next.customFields].some(c => c.label === field.label))) throw new AppError('TEMPLATE_CONFLICT', '已有自定义列含数据且与新列同名，请先修改新列名称');
      next.customFields.push(...used); doc.template = next;
    }));
  });
  app.get('/api/procurement/:id/images/:lineId/:index', async (req, reply) => {
    const params = z.strictObject({ id, lineId: id, index: z.coerce.number().int().nonnegative().max(20) }).parse(req.params);
    const { store } = scope(req), account = owner(req);
    if (store.resolveImage) return reply.type('image/jpeg').send(await store.resolveImage(account, params.id, params.lineId, params.index));
    const doc = await store.read(account, params.id);
    const data = doc.lines.find(line => line.id === params.lineId)?.images[params.index];
    if (!data) throw new AppError('NOT_FOUND', '图片不存在', 404);
    return reply.type('image/jpeg').send(Buffer.from(data.split(',')[1], 'base64'));
  });
  app.post('/api/procurement/:id/lines/:lineId', async req => {
    const params = z.strictObject({ id, lineId: id }).parse(req.params);
    const body = z.strictObject({ version: z.number().int().positive(), fields }).parse(req.body);
    return publicView(await scope(req).store.update(owner(req), params.id, body.version, doc => {
      const line = doc.lines.find(line => line.id === params.lineId);
      if (!line) throw new AppError('NOT_FOUND', '商品不存在', 404);
      const candidate = { ...line, ...body.fields };
      if (Object.keys(body.fields.custom || {}).some(key => !doc.template?.customFields.some(field => field.key === key))) throw new AppError('VALIDATION', '自定义字段不在当前采购模板中');
      if (candidate.decision === 'include' && lineCalculation(candidate).amount === null) throw new AppError('INCOMPLETE_ORDER', '计入采购前请填写实际采购数量（或箱数与每箱数量）和采购单价');
      Object.assign(line, body.fields);
    }));
  });
  app.post('/api/procurement/:id/source-selection', async req => {
    const recordId = id.parse((req.params as { id: string }).id), { version } = versionSchema.parse(req.body);
    return publicView(await scope(req).store.update(owner(req), recordId, version, doc => {
      doc.lines.forEach(line => {
        // 有歧义的商户备注和异常体积保持待核对，不撤销人工决定。
        if (line.decision === 'pending' && line.sourceIncluded && !line.warnings.length && lineCalculation(line).amount !== null) line.decision = 'include';
      });
    }));
  });
  app.post('/api/procurement/:id/supplier', async req => {
    const recordId = id.parse((req.params as { id: string }).id);
    const body = z.strictObject({ version: z.number().int().positive(), name: z.string().max(200), freight: nullableNumber }).parse(req.body);
    return publicView(await scope(req).store.update(owner(req), recordId, body.version, doc => {
      const supplier = doc.suppliers.find(s => s.name === body.name);
      if (!supplier) throw new AppError('NOT_FOUND', '商户不存在', 404);
      supplier.freight = body.freight;
    }));
  });
  if (options.jobs) app.post('/api/procurement/:id/export-job', async (req, reply) => {
    const account = owner(req), recordId = id.parse((req.params as { id: string }).id);
    await scope(req).store.read(account, recordId);
    const job = await options.jobs!(req).startWorkbookExport(account, recordId);
    return reply.code(202).send({ jobId: job.jobId, state: job.state });
  });
  app.get('/api/procurement/:id/export', async (req, reply) => {
    const account = owner(req), recordId = id.parse((req.params as { id: string }).id), { store } = scope(req);
    return busy(account, async () => {
      const doc = options.cloudFactory ? await store.read(account, recordId, true) : await store.read(account, recordId);
      // 商品多或图片大的导出不在请求内渲染：交给持久任务，客户端凭任务号取短期下载。
      if (options.jobs && needsAsyncExport(doc)) {
        const job = await options.jobs(req).startWorkbookExport(account, recordId);
        return reply.code(202).send({ jobId: job.jobId, state: job.state });
      }
      const original = doc.sourceHash ? await store.original(account, recordId) : undefined;
      const bytes = await exportProcurement(doc, original);
      if (options.cloudFactory && bytes.length > 20 * 1024 * 1024) throw new AppError('DOWNLOAD_LIMIT', '云端缓冲下载最多20MB，大文件请使用后续下载任务', 413);
      return reply.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(doc.name.replace(/[\\/\r\n]/g, '_') + '整理.xlsx')}`).send(bytes);
    });
  });
  app.get('/api/procurement/:id/original', async (req, reply) => reply.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(await scope(req).store.original(owner(req), id.parse((req.params as { id: string }).id))));
  app.delete('/api/procurement/:id', async req => {
    await scope(req).store.delete(owner(req), id.parse((req.params as { id: string }).id), versionSchema.parse(req.body).version);
    return { deleted: true };
  });
}
