import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(root, '../..');
const read = file => fs.readFileSync(file,'utf8');
const design = JSON.parse(read(root+'/report/design.json'));
const checks = [];
function check(name,work) { work(); checks.push(name); }
const fieldsSource = read(repo+'/src/lib/types.ts').match(/export type ProductFields = \{([\s\S]*?)\n\};/)[1];
const fields = new Set([...fieldsSource.matchAll(/^\s*(\w+):/gm)].map(match=>match[1]));
const productExtras = ['id','projectId','version','photos','createdAt','updatedAt','deletedAt','organizeState','organizeJobId','organizeError','taskName','taskMarket','taskDate','demo'];
const allFields = new Set([...fields,...productExtras]);
const req = createRequire(repo+'/package.json');
const domain = req(repo+'/miniprogram/utils/domain.js');
const capture = req(repo+'/miniprogram/utils/capture-template.js');

check('formal authority and no new business routes',()=>{
  assert.equal(design.meta.version,'1.3');
  assert.equal(design.meta.authority,'SOLUTION.md');
  assert.equal(design.tabs.map(tab=>tab.name).join('/'),'商户/商品');
  assert.equal(design.auxiliaryPages[0].implementation,'pages/me/index');
  assert.equal(design.auxiliaryPages[0].tab,false);
  const app = JSON.parse(read(repo+'/miniprogram/app.json'));
  assert.deepEqual(app.tabBar.list.map(tab=>tab.text),['商户','商品']);
  assert.deepEqual(app.tabBar.list.map(tab=>tab.pagePath),design.tabs.map(tab=>tab.implementation));
  assert.deepEqual(design.reliability.newDatabaseFields,[]);
  assert.equal(design.reliability.noPublicFallback,true);
  const routes = JSON.parse(read(repo+'/miniprogram/app.json')).pages;
  for(const screen of design.screens) assert.ok(routes.some(route=>screen.implementation.includes(route)),screen.id);
});
check('product schema uses real field keys and complete data',()=>{
  assert.equal(fields.size,27);
  for(const field of design.entities[0].fields) assert.ok(allFields.has(field),'unknown field '+field);
  for(const field of fields) assert.ok(design.entities[0].fields.includes(field),'missing product field '+field);
  for(const field of [...design.confirmation.invalidate,...design.confirmation.preserve]) assert.ok(fields.has(field),field);
  assert.deepEqual([...design.confirmation.invalidate,...design.confirmation.preserve,'confirmed'].sort(),[...fields].sort());
});
check('reference eleven columns and real mappings',()=>{
  const template = read(repo+'/src/lib/procurement-template.ts');
  const order = JSON.parse(template.match(/referenceColumnOrder = (\[[^\]]+\])/)[1].replaceAll("'",'"'));
  assert.deepEqual(design.excel.columns.map(column=>column.key),order.slice(0,11));
  for(const column of design.excel.columns) {
    if(column.field) assert.ok(allFields.has(column.field),column.field);
    for(const field of column.derivedFrom||[]) assert.ok(fields.has(field),field);
    for(const field of column.composedFrom||[]) assert.ok(fields.has(field),field);
  }
  assert.equal(design.excel.columns.find(column=>column.key==='pcsPerCarton').field,'cartonQty');
  assert.equal(design.excel.defaultScope,'all');
  assert.equal(design.excel.defaultAudience,'selection');
  assert.equal(design.excel.defaultImages,true);
});
check('numeric rules distinguish unknown and explicit zero',()=>{
  const base = {...domain.emptyFields,name:'合成商品'};
  const unknown = domain.validateFields({...base,unitPrice:'',quantity:''});
  assert.equal(unknown.unitPrice,null); assert.equal(unknown.quantity,null);
  const explicit = domain.validateFields({...base,unitPrice:0,cartons:2,cartonQty:48,quantity:0,cartonCbm:0});
  assert.equal(capture.totals(explicit).amount,'0.00');
  assert.equal(capture.totals(explicit).quantityMismatch,true);
  assert.equal(capture.totals({...base,cartons:2,cartonQty:48,unitPrice:6.8}).amount,'652.80');
  assert.equal(capture.totals({...base,cartons:2,cartonQty:null,unitPrice:6.8}).amount,'');
  assert.throws(()=>domain.validateFields({...base,cartonQty:0}));
  assert.equal(domain.validateFields({...base,barcode:'00001234'}).barcode,'00001234');
  assert.equal(domain.chinaLocalDate('2026-10-23T16:00:00Z'),'2026-10-24');
  assert.equal(domain.chinaLocalDate('2026-10-23T15:59:59Z'),'2026-10-23');
});
check('current exporter formulas and transport implementation are explicit',()=>{
  const exporter = read(repo+'/src/lib/quotation-export.ts');
  assert.match(exporter,/quantity = product.quantity \?\?/);
  assert.match(exporter,/amount: quantity !== null/);
  assert.equal((exporter.match(/\bformula:/g)||[]).length,2,'detail formula writer plus TOTAL formula writer');
  assert.match(exporter,/sourceRows\.length/);
  assert.match(exporter,/product\.photos/);
  const store=read(repo+'/miniprogram/utils/store.js');
  assert.match(store,/exportFileV2/);assert.match(store,/supported\?655360:4\*1024\*1024/);
  assert.match(store,/hash\.fileHash/);assert.match(store,/FILE_CORRUPT/);
});
check('one chosen transport and cache budget',()=>{
  assert.equal(design.reliability.transfer.chunkBytes,640*1024);
  assert.equal(design.reliability.transfer.responseBudgetBytes,900*1024);
  assert.ok(design.reliability.transfer.chunkBytes*4/3+2048<design.reliability.transfer.responseBudgetBytes);
  assert.equal(design.reliability.cache.reclaimableBudgetBytes,60*1024*1024);
  assert.equal(design.reliability.cache.exportRetentionDays,7);
});
check('no active queue or fabricated AI suggestions in mockups',()=>{
  const html = read(root+'/report/mockups/06-review-queue.html');
  assert.ok(!/保存并下一件|采用此值|来源：标签|第 2 \/ 5 件/.test(html));
  assert.match(html,/保存修改/); assert.match(html,/复用现有编辑页/);
  assert.match(read(root+'/report/mockups/08-export-picker.html'),/十一列/);
  assert.ok(!/AI待确认/.test(read(root+'/report/mockups/05-library-list.html')));
});
check('current report/handoffs and mirrors are reproducible',()=>{
  for(const [source,active,mirror] of [
    ['final-v13/REPORT.md','report/REPORT.md','revise-r4/REPORT-current.md'],
    ['final-v13/HANDOFF-REVIEW.md','HANDOFF-REVIEW.md','revise-r4/handoff-review-current.md'],
    ['final-v13/HANDOFF-TODO.md','HANDOFF-TODO.md','revise-r4/handoff-todo-current.md']
  ]) {
    assert.equal(read(root+'/'+source),read(root+'/'+active));
    assert.equal(read(root+'/'+source),read(root+'/'+mirror));
    assert.match(read(root+'/'+active),/SOLUTION\.md/);
    assert.match(read(root+'/'+active),/v1\.3/);
  }
  assert.match(read(root+'/revise-r4/revise.mjs'),/历史v1\.2重建入口已停用/);
});
check('implementation and backup diff from historical base stays within authorized files',()=>{
  execFileSync('git',['merge-base','--is-ancestor','9d07bc2','HEAD'],{cwd:repo});
  const changed = execFileSync('git',['diff','9d07bc2','--name-only'],{cwd:repo,encoding:'utf8'}).trim().split('\n').filter(Boolean);
  const backend=new Set(['src/lib/quotation-export.ts','src/server/app.ts','src/server/product-organize.ts']);
  const backup=new Set(['.gitignore','scripts/sample-product-export.ts']);
  assert.ok(changed.every(file=>file.startsWith('miniprogram/') || file.startsWith('tests/') || file.startsWith('docs/') || backend.has(file) || backup.has(file)),'unexpected backend/schema/deployment-file change');
});
const businessWorktreeClean = !execFileSync('git',['status','--porcelain'],{cwd:repo,encoding:'utf8'}).trim();
const result = {date:'2026-10-24',version:'1.3',pass:true,scope:'正式方案/字段/既有数值语义/两tab与文档一致性，业务测试另记录；非真机验收',checks,productFields:fields.size,referenceColumns:design.excel.columns.length,businessCodeChanged:!businessWorktreeClean,businessWorktreeClean};
console.log(JSON.stringify(result,null,2));
