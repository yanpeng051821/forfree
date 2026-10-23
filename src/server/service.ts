import { repository, recordDateRangeBounds, type RecordDateRange, type MarketRepository } from "../lib/db";
import { exportWorkbook } from "../lib/export";
import { exportQuotation, quotationExportMetadata, type QuotationExportOptions } from "../lib/quotation-export";
import type { ProcurementTemplate } from "../lib/procurement-template";
import { extractText, extractWithModel, modelEnabled } from "../lib/extraction";
import { prepareImage } from "../lib/storage";
import type { Extraction } from "../lib/types";
import { AppError } from "../lib/errors";
import { WorkBuddyModelProvider, modelBackend, type SessionPersistence } from "./workbuddy";

export type AwaitableMarketRepository = { [K in keyof MarketRepository]: (...args: Parameters<MarketRepository[K]>) => ReturnType<MarketRepository[K]> | Promise<ReturnType<MarketRepository[K]>> };
import type { ModelContext } from "./cloud-session";
import type { RuntimeConfig } from "./config";

export interface ExtractionProvider { enabled(): boolean; extract(description: string, images: string[], context?: ModelContext): Promise<Extraction>; }
export const modelProvider: ExtractionProvider = { enabled: modelEnabled, extract: (description, images) => extractWithModel(description, images) };
export function selectedModelProvider(config?: RuntimeConfig, sessions?: SessionPersistence): ExtractionProvider {
  const backend = config?.modelProvider || modelBackend();
  return backend === "workbuddy" ? new WorkBuddyModelProvider(undefined, config, sessions) : modelProvider;
}
export class MarketService {
  constructor(public records: AwaitableMarketRepository = repository, public model: ExtractionProvider = selectedModelProvider()) {}
  async upload(owner: string, file: File) { return this.records.stagePhoto(owner, await prepareImage(file)); }
  async extract(owner: string, description: string, photoIds: string[], context?: ModelContext) {
    const bytes = await Promise.all(photoIds.map(id => this.records.readPhoto(owner, id)));
    if (!this.model.enabled()) return extractText(description);
    if (context && context.owner !== owner) throw new AppError("LOGIN_REQUIRED", "模型会话身份不一致", 401);
    return this.model.extract(description, bytes.map(image => `data:image/jpeg;base64,${image.toString("base64")}`), context);
  }
  async suppliers(owner: string, projectId: string) {
    return [...new Set((await this.records.listMerchants(owner, projectId)).map(merchant => merchant.supplier).filter(Boolean))].sort();
  }
  async export(owner: string, projectId: string | undefined, options: QuotationExportOptions & RecordDateRange & { supplier?: string; date?: string; favorite?: boolean; template?: ProcurementTemplate } = {}) {
    const bounds = recordDateRangeBounds(options.date, options);
    const label = options.dateFrom ? options.dateFrom + ' 至 ' + options.dateTo : options.date;
    const project = projectId ? await this.records.getProject(owner, projectId) : { id: '', name: options.favorite ? '收藏选品' : label + ' 看货记录', market: '', date: options.dateFrom || options.date || '', demo: false, createdAt: new Date().toISOString() };
    const products = (await this.records.recordsForExport(owner, projectId, options.date, options.favorite, options.supplier, { dateFrom: options.dateFrom, dateTo: options.dateTo })).filter(product => !product.deletedAt && (!bounds || (product.createdAt >= bounds[0] && product.createdAt < bounds[1])) && (options.supplier === undefined || product.supplier === options.supplier) && (options.scope !== "confirmed" || product.confirmed));
    if (!products.length) throw new AppError("EMPTY_EXPORT", "当前任务没有可导出的商品");
    const readPhoto = (id: string) => this.records.readPhoto(owner, id);
    const bytes = options.template
      ? await exportQuotation(project, products, readPhoto, options.template, options)
      : await exportWorkbook(project, products, readPhoto, options);
    return { project, bytes, ...(options.template ? { metadata: quotationExportMetadata(options.template, options, products.map(product => product.currency), products) } : {}) };
  }
}
