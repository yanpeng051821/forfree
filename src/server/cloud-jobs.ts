import { randomUUID } from 'node:crypto';
import { AppError } from '../lib/errors';
import type { Extraction } from '../lib/types';
import { readProcurement } from '../lib/procurement';
import { validateProcurementZip } from '../lib/procurement-store';
import { exportProcurement } from '../lib/procurement-export';
import { CloudProcurementStore, CloudTemplateStore } from './cloud-procurement';
import { assertCloudOwner, type CloudContext, type CloudDatabase } from './cloud-db';
import type { BlobStore } from './cloud-blobs';
import type { CloudUploadBroker } from './workbook-upload';
import {
  assertOwnedObjectKey, assertSignedUrl, parseJobRecord, exportObjectKey, extractionResultSchema, isUuid, jobErrorOf,
  requireUuid, sanitizeFilename, productExportInputSchema, JOB_TTL_MS, WORKBOOK_MIME, type ProductExportInput, type JobError, type JobInput,
  type JobKind, type JobRecord, type JobState,
} from './cloud-tasks';

export const EXTRACTION_JOB_KIND = 'extraction';
export type AnyJobKind = JobKind;
export type AnyJobRecord = JobRecord;
export interface ExtractionInput { description: string; photoIds: string[] }
export type ExtractionRunner = (checkpoint: () => Promise<void>) => Promise<Extraction>;
/** Synchronous app-owned cleanup, called once even if a runner never starts. */
export type JobFinalizer = () => void;
interface JobLifecycle {
  deadline: number;
  finalize(): void;
  assertActive(): void;
}
export interface JobView {
  jobId: string; kind: JobKind; state: JobState; procurementId: string | null;
  result: Extraction | null; error: JobError | null; createdAt: string; updatedAt: string;
}
export interface DownloadGrant { url: string; expiresAt: string }
function view(record: JobRecord, owner: string): JobView {
  let result: Extraction | null = null;
  if (record.state === 'succeeded') {
    try {
      if (record.kind === 'extraction') result = extractionResultSchema.parse(JSON.parse(record.resultReference ?? 'null'));
      else if (record.kind === 'workbook-import') requireUuid(record.resultReference);
      else {
        const key = assertOwnedObjectKey(owner, record.resultReference, '.xlsx');
        if (!key.startsWith(`${owner}/exports/`)) throw new Error('Invalid export folder');
      }
    } catch {
      throw new AppError('DB_RESPONSE_INVALID', '任务结果无效，请重试', 502);
    }
  }
  return {
    jobId: record.jobId, kind: record.kind, state: record.state,
    procurementId: record.kind === 'workbook-import' && record.state === 'succeeded' ? record.resultReference : null,
    result, error: record.error, createdAt: record.createdAt, updatedAt: record.updatedAt,
  };
}

/** 所有回执从持久记录读取，工作执行权由版本和一次性 runToken 确认。 */
export class CloudJobs {
  private readonly auth: CloudContext;
  constructor(private readonly db: CloudDatabase, private readonly blobs: BlobStore, private readonly uploads: CloudUploadBroker, auth: CloudContext) {
    this.auth = { ...auth };
  }
  async #record(owner: string, jobId: string): Promise<JobRecord> {
    const record = parseJobRecord(await this.db.call('job/get', owner, this.auth.tokenHash, { jobId }));
    if (record.jobId !== jobId) throw new AppError('DB_RESPONSE_INVALID', '任务回执无效', 502);
    return record;
  }
  async get(owner: string, jobId: string): Promise<JobView> {
    assertCloudOwner(this.auth, owner);
    return view(await this.#record(owner, requireUuid(jobId, 'NOT_FOUND', '任务不存在')), owner);
  }
  async download(owner: string, jobId: string): Promise<DownloadGrant> {
    assertCloudOwner(this.auth, owner);
    const record = await this.#record(owner, requireUuid(jobId, 'NOT_FOUND', '任务不存在'));
    view(record, owner);
    if (!['workbook-export', 'product-export'].includes(record.kind) || record.state !== 'succeeded' || !record.resultReference) {
      throw new AppError('NOT_FOUND', '下载不存在或尚未生成', 404);
    }
    const signed = await this.blobs.signDownload(record.resultReference);
    return { url: assertSignedUrl(signed.url), expiresAt: signed.expiresAt };
  }
  /** 下载前后均查持久任务，覆盖对象读取期间的会话撤销或任务变化。 */
  async downloadFile(owner: string, jobId: string): Promise<Buffer> {
    assertCloudOwner(this.auth, owner);
    const id = requireUuid(jobId, 'NOT_FOUND', '任务不存在');
    const record = await this.#record(owner, id);
    view(record, owner);
    if (!['workbook-export', 'product-export'].includes(record.kind) || record.state !== 'succeeded' || !record.resultReference) {
      throw new AppError('NOT_FOUND', '下载不存在或尚未生成', 404);
    }
    const bytes = await this.blobs.read(record.resultReference);
    const checked = await this.#record(owner, id);
    view(checked, owner);
    if (checked.state !== 'succeeded' || checked.kind !== record.kind || checked.version !== record.version || checked.resultReference !== record.resultReference) {
      throw new AppError('CONFLICT', '下载任务已变化，请重新读取', 409);
    }
    return bytes;
  }
  async startProductExport(owner: string, input: ProductExportInput, run: () => Promise<Buffer>, onFinally?: JobFinalizer): Promise<JobView> {
    return this.#withFinalizer(onFinally, async lifecycle => {
      assertCloudOwner(this.auth, owner);
      const parsed = productExportInputSchema.safeParse(input);
      if (!parsed.success) throw new AppError('VALIDATION', '导出范围或选项无效', 400);
      return this.#start(owner, 'product-export', parsed.data, async checkpoint => {
        const bytes = await run();
        if (!Buffer.isBuffer(bytes) || !bytes.length) throw new AppError('EXPORT_INVALID', '导出结果无效', 502);
        await checkpoint();
        const objectKey = exportObjectKey(owner);
        await this.blobs.write(objectKey, bytes, WORKBOOK_MIME);
        return objectKey;
      }, lifecycle);
    });
  }
  async startWorkbookImport(owner: string, objectKey: string, filename: string): Promise<JobView> {
    assertCloudOwner(this.auth, owner);
    await this.uploads.committed(owner, objectKey);
    const safeName = sanitizeFilename(filename, '采购表.xlsx');
    return this.#start(owner, 'workbook-import', { objectKey, filename: safeName }, checkpoint => this.#runImport(owner, objectKey, safeName, checkpoint));
  }
  async startWorkbookExport(owner: string, procurementId: string): Promise<JobView> {
    assertCloudOwner(this.auth, owner);
    const recordId = requireUuid(procurementId, 'VALIDATION', '采购记录无效');
    return this.#start(owner, 'workbook-export', { procurementId: recordId }, checkpoint => this.#runExport(owner, recordId, checkpoint));
  }
  async startExtraction(owner: string, input: ExtractionInput, run: ExtractionRunner, onFinally?: JobFinalizer, jobId?: string): Promise<JobView> {
    return this.#withFinalizer(onFinally, async lifecycle => {
      assertCloudOwner(this.auth, owner);
      if (!Array.isArray(input?.photoIds) || input.photoIds.length > 6 || new Set(input.photoIds).size !== input.photoIds.length || input.photoIds.some(id => !isUuid(id))) {
        throw new AppError('INVALID_PHOTO', '照片无效，请重新选择', 400);
      }
      if (typeof input?.description !== 'string' || input.description.length > 10000) throw new AppError('VALIDATION', '整理内容无效或过长', 400);
      return this.#start(owner, 'extraction', {}, async checkpoint => {
        const parsed = extractionResultSchema.safeParse(await run(checkpoint));
        if (!parsed.success) throw new AppError('UPSTREAM_INVALID', '智能整理结果格式不正确，请重试或手动填写。', 502);
        return JSON.stringify(parsed.data);
      }, lifecycle, jobId);
    });
  }
  async #withFinalizer(onFinally: JobFinalizer | undefined, submit: (lifecycle: JobLifecycle) => Promise<JobView>): Promise<JobView> {
    let finalized = false;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const deadline = Date.now() + JOB_TTL_MS;
    const lifecycle: JobLifecycle = {
      deadline,
      finalize: () => {
        if (finalized) return;
        finalized = true;
        if (watchdog) clearTimeout(watchdog);
        // Cleanup failure must not change the durable task outcome.
        try { onFinally?.(); } catch { /* App cleanup is synchronous and best effort. */ }
      },
      assertActive: () => {
        if (finalized || Date.now() >= deadline) {
          lifecycle.finalize();
          throw new AppError('JOB_EXPIRED', '任务已超时或结束，请重新提交', 408);
        }
      },
    };
    // Also releases app slots if create/start/finish RPC never settles.
    watchdog = setTimeout(lifecycle.finalize, JOB_TTL_MS);
    watchdog.unref();
    try { return await submit(lifecycle); }
    catch (error) { lifecycle.finalize(); throw error; }
  }
  async #start(owner: string, kind: JobKind, input: JobInput, work: (checkpoint: () => Promise<void>) => Promise<string>, lifecycle?: JobLifecycle, requestedId?: string): Promise<JobView> {
    const jobId = requestedId ? requireUuid(requestedId) : randomUUID();
    const job = parseJobRecord(await this.db.call('job/create', owner, this.auth.tokenHash, { jobId, kind, state: 'pending', input }));
    lifecycle?.assertActive();
    if (job.jobId !== jobId || job.kind !== kind || job.state !== 'pending') throw new AppError('DB_RESPONSE_INVALID', '任务创建响应无效', 502);
    process.nextTick(() => { void this.#execute(owner, job, work, lifecycle).catch(() => {
      // RPC 失败保持持久真值；下次读取由 SQL deadline 终结失去执行者的任务。
    }).finally(() => lifecycle?.finalize()); });
    return view(job, owner);
  }
  async #execute(owner: string, job: JobRecord, work: (checkpoint: () => Promise<void>) => Promise<string>, lifecycle?: JobLifecycle): Promise<void> {
    lifecycle?.assertActive();
    const runToken = randomUUID();
    const running = parseJobRecord(await this.db.call('job/start', owner, this.auth.tokenHash, { jobId: job.jobId, expectedVersion: job.version, runToken }));
    lifecycle?.assertActive();
    if (running.jobId !== job.jobId || running.kind !== job.kind || running.state !== 'running' || running.version !== job.version + 1) {
      throw new AppError('DB_RESPONSE_INVALID', '任务执行回执无效', 502);
    }
    let resultReference: string | null = null, error: JobError | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      resultReference = await Promise.race([
        work(async () => {
          lifecycle?.assertActive();
          const checked = await this.#record(owner, job.jobId);
          lifecycle?.assertActive();
          if (checked.state !== 'running' || checked.version !== running.version) throw new AppError('JOB_EXPIRED', '任务已超时或结束，请重新提交', 408);
        }), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new AppError('JOB_EXPIRED', '任务已超时，请重新提交', 408)), Math.max(1, Math.min(Date.parse(running.expiresAt), lifecycle?.deadline ?? Infinity) - Date.now()));
          timer.unref();
        }),
      ]);
    } catch (failure) { error = jobErrorOf(failure); }
    finally {
      if (timer) clearTimeout(timer);
      lifecycle?.finalize();
    }
    const finished = parseJobRecord(await this.db.call('job/finish', owner, this.auth.tokenHash, {
      jobId: job.jobId, expectedVersion: running.version, runToken,
      state: error ? 'failed' : 'succeeded', resultReference, error,
    }));
    if (finished.jobId !== job.jobId || finished.kind !== job.kind) throw new AppError('DB_RESPONSE_INVALID', '任务回执无效', 502);
    view(finished, owner);
  }
  async #runImport(owner: string, objectKey: string, filename: string, checkpoint: () => Promise<void>): Promise<string> {
    await this.uploads.committed(owner, objectKey);
    const bytes = await this.blobs.read(objectKey);
    validateProcurementZip(bytes);
    const doc = await readProcurement(bytes, filename);
    const templates = new CloudTemplateStore(this.db, this.auth);
    const savedTemplate = await templates.read(owner);
    doc.template = savedTemplate.version > 0 ? savedTemplate : doc.template || savedTemplate;
    doc.lines.forEach(line => { line.custom = {}; });
    const store = new CloudProcurementStore(this.db, this.blobs, this.auth);
    await checkpoint();
    const saved = await store.create(owner, doc, bytes);
    return saved.id;
  }

  async #runExport(owner: string, procurementId: string, checkpoint: () => Promise<void>): Promise<string> {
    const store = new CloudProcurementStore(this.db, this.blobs, this.auth);
    const doc = await store.read(owner, procurementId, true);
    const original = doc.sourceHash ? await store.original(owner, procurementId) : undefined;
    const bytes = await exportProcurement(doc, original);
    await checkpoint();
    const objectKey = exportObjectKey(owner);
    await this.blobs.write(objectKey, bytes, WORKBOOK_MIME);
    return objectKey;
  }
}
