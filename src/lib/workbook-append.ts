import JSZip from 'jszip';
import { SaxesParser } from 'saxes';
import { posix } from 'node:path';

type Element = { name: string; attrs: Record<string, string>; children: (Element | string)[] };
const local = (name: string) => name.split(':').pop()!;
const elements = (node: Element, name?: string) => node.children.filter((child): child is Element => typeof child !== 'string' && (!name || local(child.name) === name));
function parse(xml: string): Element {
  let root: Element | undefined;
  const stack: Element[] = [], parser = new SaxesParser({ xmlns: false });
  parser.on('doctype', () => { throw new Error('Workbook DTD is unsupported'); });
  parser.on('opentag', tag => {
    const node: Element = { name: tag.name, attrs: tag.attributes, children: [] };
    if (stack.length) stack.at(-1)!.children.push(node); else root = node;
    stack.push(node);
  });
  parser.on('text', text => { if (stack.length) stack.at(-1)!.children.push(text); });
  parser.on('cdata', text => { if (stack.length) stack.at(-1)!.children.push(text); });
  parser.on('closetag', () => { stack.pop(); });
  parser.write(xml).close();
  if (!root) throw new Error('Missing workbook XML');
  return root;
}
const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function serialize(node: Element): string {
  const attrs = Object.entries(node.attrs).map(([key, value]) => ` ${key}="${escape(value)}"`).join('');
  return `<${node.name}${attrs}>${node.children.map(child => typeof child === 'string' ? escape(child) : serialize(child)).join('')}</${node.name}>`;
}
function walk(node: Element, fn: (node: Element) => void) { fn(node); elements(node).forEach(child => walk(child, fn)); }
const child = (node: Element, name: string) => elements(node, name)[0];
const attribute = (node: Element, name: string) => Object.entries(node.attrs).find(([key]) => local(key) === name)?.[1];
function normalizePrefix(node: Element, prefix: string) {
  walk(node, n => { n.name = prefix + local(n.name); });
  return node;
}
const prefixOf = (node: Element) => node.name.includes(':') ? node.name.split(':')[0] + ':' : '';

/** Append generated views while leaving every original worksheet/drawing/image part untouched.
 * Rewriting the source through a workbook object would discard unsupported Excel features.
 * Only package indexes, shared strings and style collections are extended here. */
export async function appendWorkbook(source: Buffer, addition: Buffer): Promise<Buffer> {
  const [base, extra] = await Promise.all([JSZip.loadAsync(source), JSZip.loadAsync(addition)]);
  async function xml(zip: JSZip, path: string) { const file = zip.file(path); if (!file) throw new Error(`Missing workbook part: ${path}`); return parse(await file.async('string')); }
  const [book, addedBook, rels, addedRels, styles, addedStyles, types, addedTypes] = await Promise.all([
    xml(base, 'xl/workbook.xml'), xml(extra, 'xl/workbook.xml'), xml(base, 'xl/_rels/workbook.xml.rels'), xml(extra, 'xl/_rels/workbook.xml.rels'),
    xml(base, 'xl/styles.xml'), xml(extra, 'xl/styles.xml'), xml(base, '[Content_Types].xml'), xml(extra, '[Content_Types].xml'),
  ]);
  const stylePrefix = prefixOf(styles);
  const offsets: Record<string, number> = {};
  const numFmtMap = new Map<number, number>();
  const styleOrder = ['numFmts', 'fonts', 'fills', 'borders', 'cellStyleXfs', 'cellXfs', 'cellStyles', 'dxfs', 'tableStyles', 'colors', 'extLst'];
  function collection(name: string) {
    let target = child(styles, name);
    if (!target) {
      target = { name: stylePrefix + name, attrs: { count: '0' }, children: [] };
      const at = styles.children.findIndex(n => typeof n !== 'string' && styleOrder.indexOf(local(n.name)) > styleOrder.indexOf(name));
      if (at < 0) styles.children.push(target); else styles.children.splice(at, 0, target);
    }
    return target;
  }
  const oldNumFmts = child(styles, 'numFmts');
  let nextNumFmt = Math.max(163, ...elements(oldNumFmts || { name: '', attrs: {}, children: [] }).map(n => Number(n.attrs.numFmtId))) + 1;
  for (const fmt of elements(child(addedStyles, 'numFmts') || { name: '', attrs: {}, children: [] })) {
    numFmtMap.set(Number(fmt.attrs.numFmtId), nextNumFmt); fmt.attrs.numFmtId = String(nextNumFmt++);
    collection('numFmts').children.push(normalizePrefix(fmt, stylePrefix));
  }
  if (child(styles, 'numFmts')) collection('numFmts').attrs.count = String(elements(collection('numFmts')).length);
  for (const name of ['fonts', 'fills', 'borders', 'cellStyleXfs', 'cellXfs', 'dxfs']) {
    const from = child(addedStyles, name); if (!from) { offsets[name] = 0; continue; }
    const target = collection(name); offsets[name] = elements(target).length;
    for (const item of elements(from)) {
      if (name === 'cellStyleXfs' || name === 'cellXfs') {
        for (const [attr, list] of [['fontId', 'fonts'], ['fillId', 'fills'], ['borderId', 'borders'], ['xfId', 'cellStyleXfs']]) {
          if (item.attrs[attr] !== undefined) item.attrs[attr] = String(Number(item.attrs[attr]) + offsets[list]);
        }
        if (item.attrs.numFmtId && numFmtMap.has(Number(item.attrs.numFmtId))) item.attrs.numFmtId = String(numFmtMap.get(Number(item.attrs.numFmtId)));
      }
      if (name === 'dxfs') walk(item, n => { if (local(n.name) === 'numFmt' && numFmtMap.has(Number(n.attrs.numFmtId))) n.attrs.numFmtId = String(numFmtMap.get(Number(n.attrs.numFmtId))); });
      target.children.push(normalizePrefix(item, stylePrefix));
    }
    target.attrs.count = String(elements(target).length);
  }
  let stringOffset = 0;
  if (extra.file('xl/sharedStrings.xml')) {
    const strings = base.file('xl/sharedStrings.xml') ? await xml(base, 'xl/sharedStrings.xml') : parse('<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="0" uniqueCount="0"/>');
    const addedStrings = await xml(extra, 'xl/sharedStrings.xml'); stringOffset = elements(strings, 'si').length;
    elements(addedStrings, 'si').forEach(si => strings.children.push(normalizePrefix(si, prefixOf(strings))));
    strings.attrs.count = String(Number(strings.attrs.count || stringOffset) + Number(addedStrings.attrs.count || 0));
    strings.attrs.uniqueCount = String(elements(strings, 'si').length);
    base.file('xl/sharedStrings.xml', serialize(strings));
    if (!elements(rels).some(n => n.attrs.Type.endsWith('/sharedStrings'))) rels.children.push({ name: prefixOf(rels) + 'Relationship', attrs: { Id: 'procurementStrings', Type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings', Target: 'sharedStrings.xml' }, children: [] });
    if (!elements(types).some(n => n.attrs.PartName === '/xl/sharedStrings.xml')) types.children.push({ name: prefixOf(types) + 'Override', attrs: { PartName: '/xl/sharedStrings.xml', ContentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml' }, children: [] });
  }
  const mapping = new Map<string, string>();
  let worksheetNumber = Math.max(0, ...Object.keys(base.files).map(path => Number(path.match(/^xl\/worksheets\/sheet(\d+)\.xml$/)?.[1] || 0))) + 1;
  let suffix = 1;
  while (Object.keys(base.files).some(path => path.includes(`/procurement${suffix}`))) suffix++;
  for (const [path, file] of Object.entries(extra.files)) {
    if (file.dir || !path.startsWith('xl/') || ['xl/workbook.xml', 'xl/styles.xml', 'xl/sharedStrings.xml', 'xl/_rels/workbook.xml.rels', 'xl/theme/theme1.xml'].includes(path)) continue;
    if (path.includes('/_rels/')) continue;
    mapping.set(path, path.startsWith('xl/worksheets/') ? `xl/worksheets/sheet${worksheetNumber++}.xml` : posix.join(posix.dirname(path), `procurement${suffix}` + posix.basename(path)));
  }
  for (const [path, file] of Object.entries(extra.files)) {
    if (file.dir || !path.includes('/_rels/') || path === 'xl/_rels/workbook.xml.rels') continue;
    const owner = posix.join(posix.dirname(posix.dirname(path)), posix.basename(path).replace(/\.rels$/, ''));
    const mapped = mapping.get(owner);
    if (!mapped) throw new Error('Unsupported generated relationship owner');
    mapping.set(path, posix.join(posix.dirname(mapped), '_rels', posix.basename(mapped) + '.rels'));
  }
  const sheets = child(book, 'sheets')!, addedSheets = child(addedBook, 'sheets')!;
  const usedNames = new Set(elements(sheets).map(n => n.attrs.name));
  const renamed = new Map<string, string>();
  for (const sheet of elements(addedSheets)) {
    let name = sheet.attrs.name, n = 2;
    while (usedNames.has(name)) name = sheet.attrs.name.slice(0, 27) + `(${n++})`;
    usedNames.add(name); renamed.set(sheet.attrs.name, name); sheet.attrs.name = name;
  }
  let sheetId = Math.max(...elements(sheets).map(n => Number(n.attrs.sheetId))) + 1;
  const usedRelIds = new Set(elements(rels).map(n => n.attrs.Id));
  const relAttr = Object.keys(elements(sheets)[0]?.attrs || {}).find(key => key.endsWith(':id')) || 'r:id';
  book.attrs['xmlns:' + relAttr.split(':')[0]] ||= 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  for (const sheet of elements(addedSheets)) {
    const relationship = elements(addedRels).find(n => n.attrs.Id === attribute(sheet, 'id'))!;
    const originalPath = posix.resolve('/xl', relationship.attrs.Target).slice(1);
    const mapped = mapping.get(originalPath); if (!mapped) throw new Error('Missing generated worksheet');
    let relId = `procurementSheet${sheetId}`; while (usedRelIds.has(relId)) relId += '_'; usedRelIds.add(relId);
    sheets.children.push({ name: prefixOf(sheets) + 'sheet', attrs: { name: sheet.attrs.name, sheetId: String(sheetId++), [relAttr]: relId }, children: [] });
    rels.children.push({ name: prefixOf(rels) + 'Relationship', attrs: { Id: relId, Type: relationship.attrs.Type, Target: posix.relative('xl', mapped) }, children: [] });
  }
  for (const [path, mapped] of mapping) {
    if (path.endsWith('.rels')) {
      const document = await xml(extra, path);
      const oldOwner = posix.join(posix.dirname(posix.dirname(path)), posix.basename(path).replace(/\.rels$/, ''));
      const newOwner = mapping.get(oldOwner)!;
      for (const rel of elements(document)) {
        if (rel.attrs.TargetMode === 'External') throw new Error('Generated external links are unsupported');
        const oldTarget = posix.resolve('/' + posix.dirname(oldOwner), rel.attrs.Target).slice(1);
        const target = mapping.get(oldTarget); if (!target) throw new Error(`Missing generated dependency: ${oldTarget}`);
        rel.attrs.Target = posix.relative(posix.dirname(newOwner), target);
      }
      base.file(mapped, serialize(document));
    } else if (path.startsWith('xl/worksheets/') && path.endsWith('.xml')) {
      const document = await xml(extra, path);
      walk(document, n => {
        if (local(n.name) === 'c' && n.attrs.s !== undefined) n.attrs.s = String(Number(n.attrs.s) + offsets.cellXfs);
        if (local(n.name) === 'row' && n.attrs.s !== undefined) n.attrs.s = String(Number(n.attrs.s) + offsets.cellXfs);
        if (local(n.name) === 'col' && n.attrs.style !== undefined) n.attrs.style = String(Number(n.attrs.style) + offsets.cellXfs);
        if (n.attrs.dxfId !== undefined) n.attrs.dxfId = String(Number(n.attrs.dxfId) + offsets.dxfs);
        if (local(n.name) === 'c' && n.attrs.t === 's') { const v = child(n, 'v'); if (v) v.children = [String(Number(v.children.join('')) + stringOffset)]; }
        if (local(n.name) === 'f') n.children = n.children.map(value => {
          if (typeof value !== 'string') return value;
          for (const [old, name] of renamed) if (old !== name) value = value.replaceAll(`'${old.replaceAll("'", "''")}'!`, `'${name.replaceAll("'", "''")}'!`).replaceAll(old + '!', `'${name}'!`);
          return value;
        });
      });
      base.file(mapped, serialize(document));
    } else base.file(mapped, await extra.file(path)!.async('nodebuffer'));
  }
  for (const entry of elements(addedTypes)) {
    if (local(entry.name) === 'Default') {
      const existing = elements(types).find(n => n.attrs.Extension === entry.attrs.Extension);
      if (existing && existing.attrs.ContentType !== entry.attrs.ContentType) {
        for (const [path, mapped] of mapping) if (path.endsWith('.' + entry.attrs.Extension) && !elements(addedTypes).some(n => n.attrs.PartName === '/' + path)) types.children.push({ name: prefixOf(types) + 'Override', attrs: { PartName: '/' + mapped, ContentType: entry.attrs.ContentType }, children: [] });
      }
      if (!existing) types.children.push(normalizePrefix(entry, prefixOf(types)));
    } else {
      const mapped = mapping.get(entry.attrs.PartName.slice(1));
      if (mapped) { entry.attrs.PartName = '/' + mapped; types.children.push(normalizePrefix(entry, prefixOf(types))); }
    }
  }
  let calc = child(book, 'calcPr'); if (!calc) { calc = { name: prefixOf(book) + 'calcPr', attrs: {}, children: [] }; book.children.push(calc); }
  Object.assign(calc.attrs, { calcMode: 'auto', fullCalcOnLoad: '1', forceFullCalc: '1' });
  base.file('xl/workbook.xml', serialize(book)); base.file('xl/_rels/workbook.xml.rels', serialize(rels));
  base.file('xl/styles.xml', serialize(styles)); base.file('[Content_Types].xml', serialize(types));
  if (base.file('docProps/app.xml')) {
    const app = await xml(base, 'docProps/app.xml'), heading = child(app, 'HeadingPairs'), titles = child(app, 'TitlesOfParts');
    const vector = titles && child(titles, 'vector');
    if (vector) {
      const text = elements(vector)[0];
      for (const sheet of elements(addedSheets)) vector.children.push({ name: text?.name || 'vt:lpstr', attrs: {}, children: [sheet.attrs.name] });
      vector.attrs.size = String(elements(vector).length);
    }
    // HeadingPairs can contain several named groups; update only the worksheet group.
    const pairs = heading && child(heading, 'vector');
    if (pairs) {
      const entries = elements(pairs);
      for (let i = 0; i + 1 < entries.length; i += 2) {
        if (elements(entries[i]).some(n => n.children.join('') === 'Worksheets')) {
          const count = elements(entries[i + 1])[0]; if (count) count.children = [String(Number(count.children.join('')) + elements(addedSheets).length)];
        }
      }
    }
    base.file('docProps/app.xml', serialize(app));
  }
  return base.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}
