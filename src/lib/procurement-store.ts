import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { AppError, conflict, notFound } from './errors';
import { procurementView, type Procurement } from './procurement';

export const PROCUREMENT_FILE_LIMIT = 40 * 1024 * 1024;
// Check actual inflated ZIP members before the workbook reader allocates objects.
export function validateProcurementZip(bytes: Buffer) {
  if (bytes.length > PROCUREMENT_FILE_LIMIT) throw new AppError('WORKBOOK_LIMIT', 'Excel不能超过40MB', 413);
  let end = -1;
  for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 65557); p--) if (bytes.readUInt32LE(p) === 0x06054b50 && p + 22 + bytes.readUInt16LE(p + 20) === bytes.length) { end = p; break; }
  if (end < 0) throw new AppError('INVALID_WORKBOOK', '请选择未加密的 .xlsx 文件');
  const count = bytes.readUInt16LE(end + 10), offset = bytes.readUInt32LE(end + 16), directorySize = bytes.readUInt32LE(end + 12);
  if (count > 2500 || offset + directorySize > end || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 8) !== count) throw new AppError('WORKBOOK_LIMIT', 'Excel结构过大或不支持，请拆分文件');
  let cursor = offset, size = 0;
  const names = new Set<string>();
  try {
    for (let index = 0; index < count; index++) {
      if (bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error('directory');
      const compressed = bytes.readUInt32LE(cursor + 20), expanded = bytes.readUInt32LE(cursor + 24);
      const n = bytes.readUInt16LE(cursor + 28), extra = bytes.readUInt16LE(cursor + 30), comment = bytes.readUInt16LE(cursor + 32);
      const name = bytes.subarray(cursor + 46, cursor + 46 + n).toString('utf8');
      const method = bytes.readUInt16LE(cursor + 10), flags = bytes.readUInt16LE(cursor + 8), local = bytes.readUInt32LE(cursor + 42);
      size += expanded;
      if (size > 80 * 1024 * 1024 || expanded > 16 * 1024 * 1024 || (/\.xml$/i.test(name) && expanded > 4 * 1024 * 1024)) throw new AppError('WORKBOOK_LIMIT', 'Excel解压后过大，请压缩图片或拆分文件');
      if (names.has(name) || /(^\/|\\|(^|\/)\.\.(\/|$))/.test(name) || flags & 1 || ![0, 8].includes(method) || bytes.readUInt32LE(local) !== 0x04034b50) throw new Error('member');
      names.add(name);
      if (/externalLinks|vbaProject|embeddings\//i.test(name)) throw new AppError('UNSUPPORTED_WORKBOOK', '请去掉外部链接、宏和嵌入对象后再整理');
      const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
      if (start + compressed > offset) throw new Error('bounds');
      const packed = bytes.subarray(start, start + compressed);
      const unpacked = method === 0 ? packed : inflateRawSync(packed, { maxOutputLength: Math.max(1, expanded) });
      if (unpacked.length !== expanded) throw new Error('size');
      if (/xl\/worksheets\/sheet\d+\.xml$/.test(name)) {
        const xml = unpacked.toString('utf8');
        if ((xml.match(/<c[ >]/g) || []).length > 100000 || [...xml.matchAll(/<row\b[^>]*\br="(\d+)"/g)].some(m => Number(m[1]) > 10000)) throw new AppError('WORKBOOK_LIMIT', '工作表数据区域过大，请拆分文件');
      }
      cursor += 46 + n + extra + comment;
    }
    if (cursor !== offset + directorySize || !names.has('xl/workbook.xml')) throw new Error('xlsx');
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('INVALID_WORKBOOK', 'Excel文件结构无效，请重新另存为 .xlsx');
  }
}

export class ProcurementStore {
  constructor(private root: string) {}
  private directory(owner: string) {
    const path = join(this.root, 'procurement', createHash('sha256').update(owner).digest('hex'));
    mkdirSync(path, { recursive: true, mode: 0o700 });
    return path;
  }
  private path(owner: string, id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) notFound();
    return join(this.directory(owner), id + '.json');
  }
  private write(path: string, value: Procurement) {
    const temporary = path + '.' + randomUUID() + '.tmp';
    try { writeFileSync(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); renameSync(temporary, path); }
    finally { rmSync(temporary, { force: true }); }
  }
  list(owner: string) {
    return readdirSync(this.directory(owner)).filter(name => name.endsWith('.json')).map(name => {
      const doc = this.read(owner, name.slice(0, -5));
      return { id: doc.id, version: doc.version, name: doc.name, updatedAt: doc.updatedAt, summary: procurementView(doc).summary };
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  create(owner: string, doc: Procurement, original?: Buffer) {
    if (doc.sourceHash) {
      for (const file of readdirSync(this.directory(owner)).filter(name => name.endsWith('.json'))) {
        const previous = this.read(owner, file.slice(0, -5));
        if (previous.sourceHash === doc.sourceHash) return previous;
      }
    }
    const path = this.path(owner, doc.id);
    if (existsSync(path)) conflict();
    if (this.list(owner).length >= 30) throw new AppError('PROCUREMENT_LIMIT', '最多保留30份整理记录，请先删除不用的记录');
    if (original) writeFileSync(path.replace(/\.json$/, '.xlsx'), original, { flag: 'wx', mode: 0o600 });
    try { this.write(path, doc); }
    catch (error) { rmSync(path.replace(/\.json$/, '.xlsx'), { force: true }); throw error; }
    return doc;
  }
  read(owner: string, id: string): Procurement {
    const path = this.path(owner, id);
    if (!existsSync(path)) notFound();
    return JSON.parse(readFileSync(path, 'utf8'));
  }
  update(owner: string, id: string, version: number, change: (doc: Procurement) => void) {
    const doc = this.read(owner, id);
    if (doc.version !== version) conflict('整理记录已更新，请重新打开后修改');
    change(doc); doc.version += 1; doc.updatedAt = new Date().toISOString();
    this.write(this.path(owner, id), doc); return doc;
  }
  original(owner: string, id: string) {
    this.read(owner, id);
    const path = this.path(owner, id).replace(/\.json$/, '.xlsx');
    if (!existsSync(path)) notFound();
    return readFileSync(path);
  }
  delete(owner: string, id: string, version: number) {
    if (this.read(owner, id).version !== version) conflict();
    const path = this.path(owner, id); rmSync(path); rmSync(path.replace(/\.json$/, '.xlsx'), { force: true });
  }
}
