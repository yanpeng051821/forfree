import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { readProcurement, procurementView } from '../src/lib/procurement';
import { validateProcurementZip } from '../src/lib/procurement-store';

async function main() {
  const source = process.argv[2], output = process.argv[3];
  if (!source || !output) throw new Error('用法：npm run inspect:procurement -- source.xlsx output-directory');
  const bytes = readFileSync(source); validateProcurementZip(bytes);
  const doc = await readProcurement(bytes, basename(source));
  const destination = resolve(output); mkdirSync(destination, { recursive: true, mode: 0o700 });
  writeFileSync(resolve(destination, 'procurement.json'), JSON.stringify(doc), { mode: 0o600 });
  const view = procurementView(doc);
  console.log(JSON.stringify({ summary: view.summary, sourceCartons: doc.suppliers.reduce((n, s) => n + (s.sourceCartons || 0), 0), sourceCbm: doc.suppliers.reduce((n, s) => n + (s.sourceCbm || 0), 0), mainLines: doc.lines.filter(l => l.sourceIncluded).length, appendedLines: doc.lines.filter(l => !l.sourceIncluded).length, cancelMarked: doc.lines.filter(l => /取消/.test(l.sourceMark)).length, images: doc.lines.reduce((n, l) => n + l.images.length, 0), skippedSheets: doc.skippedSheets, issues: doc.issues.filter(i => !/未单列运费|同一行有多张图|商户状态/.test(i.message)) }, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
