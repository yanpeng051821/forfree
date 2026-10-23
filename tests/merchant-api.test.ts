import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import sharp from 'sharp';
import { createApp } from '../src/server/app';
import { issueSession } from '../src/server/auth';
import { parseRuntimeConfig } from '../src/server/config';
import { MarketService } from '../src/server/service';
import { closeDB, createProject, db, repository, saveProduct, stagePhoto, trashProduct } from '../src/lib/db';
import { emptyFields, type Product, type ProductFields } from '../src/lib/types';
import { defaultProcurementTemplate, ProcurementTemplateStore } from '../src/lib/procurement-template';
import { quotationExportMetadata } from '../src/lib/quotation-export';

const day = '2026-10-18', shop = '同名商家', similarShop = '同名商家分店';
const ids = (products: { id: string }[]) => products.map(product => product.id).sort();
type Preview = ReturnType<typeof quotationExportMetadata>;
type Query = Record<string, string | number | undefined>;

async function exportedRows(bytes: Buffer, preview: Preview) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as ExcelJS.Buffer);
  const header = preview.headerRows.filter(row => row.enabled).length + 1;
  const rows: { sheet: ExcelJS.Worksheet; row: ExcelJS.Row; cell: (key: string) => ExcelJS.Cell }[] = [];
  for (const sheet of workbook.worksheets.filter(sheet => sheet.name !== '说明')) {
    assert.deepEqual((sheet.getRow(header).values as string[]).slice(1), preview.columns.map(column => column.label));
    const skuColumn = preview.columns.findIndex(column => column.key === 'sku') + 1;
    assert.ok(skuColumn > 0);
    for (let index = header + 1; index <= sheet.rowCount && sheet.getCell(index, skuColumn).text; index++) {
      const row = sheet.getRow(index);
      rows.push({ sheet, row, cell: key => {
        const column = preview.columns.findIndex(column => column.key === key) + 1;
        assert.ok(column > 0, key);
        return row.getCell(column);
      } });
    }
  }
  return rows;
}

test('merchant API scopes real SQLite pages, aggregates, previews and XLSX bytes to active owned records', async t => {
  const previousDir = process.env.APP_DATA_DIR;
  const root = mkdtempSync(join(tmpdir(), 'huoji-merchant-api-'));
  process.env.APP_DATA_DIR = root;
  const service = new MarketService(repository, { enabled: () => false, extract: async () => { throw new Error('unused model'); } });
  const config = parseRuntimeConfig({ APP_DATA_DIR: root }, { identityInjected: true, serviceInjected: true });
  const app = await createApp({ config, identity: { exchange: async code => code }, service });
  try {
    const a = issueSession('synthetic-merchant-alice'), b = issueSession('synthetic-merchant-bob');
    const task = createProject(a.user.id, { name: '合成任务一', market: '', date: '2026-10-01' }, randomUUID());
    const otherTask = createProject(a.user.id, { name: '合成任务二', market: '', date: '2026-10-02' }, randomUUID());
    const foreignTask = createProject(b.user.id, { name: '合成他人任务', market: '', date: day }, randomUUID());
    const photo = stagePhoto(a.user.id, { name: 'synthetic.jpg', bytes: await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ffffff' } }).jpeg().toBuffer() });
    function add(projectId: string, sku: string, supplier: string, patch: Partial<ProductFields> = {}, at = '2026-10-18T04:00:00.000Z', owner = a.user.id, photoIds: string[] = []) {
      const product = saveProduct(owner, { requestKey: randomUUID(), projectId, fields: { ...emptyFields, name: sku, sku, supplier, supplierContact: supplier ? '合成联系人' : '', unitPrice: 1.2345, cartons: 3, cartonQty: 12, cartonCbm: .012345, ...patch }, photoIds });
      db().prepare('UPDATE products SET created_at=? WHERE id=?').run(at, product.id);
      return { ...product, createdAt: at };
    }
    const primary = Array.from({ length: 36 }, (_, index) => add(task.id, 'A-' + index, shop,
      { confirmed: index % 2 === 0, favorite: index % 4 === 0, unitPrice: index % 3 === 0 ? null : 1.2345, ...(index === 1 ? { quantity: 7 } : {}) },
      index === 0 ? '2026-10-17T16:00:00.000Z' : index === 35 ? '2026-10-18T15:59:59.999Z' : undefined,
      a.user.id, index === 1 ? [photo.id] : []));
    const crossTask = [add(otherTask.id, 'A-cross-1', shop, { confirmed: true, favorite: true }), add(otherTask.id, 'A-cross-2', shop, { unitPrice: null })];
    const similar = [add(task.id, 'similar-1', similarShop, { name: shop + ' 搜索命中', currency: 'USD', confirmed: true }), add(otherTask.id, 'similar-2', similarShop, { currency: 'USD' })];
    const unnamed = [add(task.id, 'unnamed-1', '', { currency: 'EUR', confirmed: true }), add(otherTask.id, 'unnamed-2', '', { currency: 'EUR', unitPrice: null })];
    const discarded = add(task.id, 'discarded', shop, { currency: 'USD', confirmed: true });
    trashProduct(a.user.id, discarded.id, discarded.version);
    add(task.id, 'previous-day', shop, { currency: 'USD' }, '2026-10-17T15:59:59.999Z');
    add(task.id, 'next-day', shop, { currency: 'EUR' }, '2026-10-18T16:00:00.000Z');
    const foreign = add(foreignTask.id, 'foreign', shop, { currency: 'USD' }, undefined, b.user.id);
    const exact = [...primary, ...crossTask], activeDay = [...exact, ...similar, ...unnamed];
    const expectedSummary = { total: 38, confirmed: 19, pending: 19, missingPrice: 13, suppliers: 1, photos: 1 };
    const url = (route: string, query: Query) => route + '?' + new URLSearchParams(Object.entries(query).flatMap(([key, value]) => value === undefined ? [] : [[key, String(value)]]));
    const request = (route: string, query: Query, token = a.token) => app.inject({ method: 'GET', url: url(route, query), headers: { authorization: 'Bearer ' + token } });
    const get = async (route: string, query: Query, token = a.token) => {
      const response = await request(route, query, token);
      assert.equal(response.statusCode, 200, response.body);
      return response.json();
    };

    await t.test('exact shop pages exceed 30, retain complete counts and reject foreign scope cursors', async () => {
      const first = await get('/api/products', { date: day, supplier: shop, limit: 30 });
      assert.equal(first.items.length, 30); assert.equal(first.matchedCount, 38);
      assert.deepEqual(first.summary, expectedSummary); assert.ok(first.nextCursor);
      const second = await get('/api/products', { date: day, supplier: shop, limit: 30, cursor: first.nextCursor });
      assert.equal(second.items.length, 8); assert.equal(second.nextCursor, null);
      assert.equal(second.matchedCount, 38); assert.deepEqual(second.summary, expectedSummary);
      assert.deepEqual(ids([...first.items, ...second.items]), ids(exact));
      assert.equal(new Set([...first.items, ...second.items].map((p: Product) => p.id)).size, 38);
      for (const query of [{ date: day, supplier: similarShop }, { date: day, supplier: '' }, { date: day }, { projectId: task.id, date: day, supplier: shop }, { date: '2026-10-17', supplier: shop }]) {
        const response = await request('/api/products', { ...query, cursor: first.nextCursor });
        assert.equal(response.statusCode, 400, response.body); assert.equal(response.json().error.code, 'INVALID_CURSOR');
      }
      const foreignCursor = await request('/api/products', { date: day, supplier: shop, cursor: first.nextCursor }, b.token);
      assert.equal(foreignCursor.statusCode, 400); assert.equal(foreignCursor.json().error.code, 'INVALID_CURSOR');
      const taskPage = await get('/api/products', { projectId: task.id, date: day, supplier: shop, limit: 100 });
      assert.deepEqual(ids(taskPage.items), ids(primary));
      assert.deepEqual(taskPage.summary, { total: 36, confirmed: 18, pending: 18, missingPrice: 12, suppliers: 1, photos: 1 });
      const foreignScope = await request('/api/products', { projectId: task.id, supplier: shop }, b.token);
      assert.equal(foreignScope.statusCode, 404);
      assert.deepEqual(ids((await get('/api/products', { date: day, supplier: shop }, b.token)).items), [foreign.id]);
    });

    await t.test('empty supplier is distinct from no supplier, and search/status/favorites stay inside the exact shop', async () => {
      const empty = await get('/api/products', { date: day, supplier: '', limit: 100 });
      assert.deepEqual(ids(empty.items), ids(unnamed));
      assert.deepEqual(empty.summary, { total: 2, confirmed: 1, pending: 1, missingPrice: 1, suppliers: 0, photos: 0 });
      assert.deepEqual(ids((await get('/api/products', { date: day, limit: 100 })).items), ids(activeDay));
      assert.deepEqual(ids((await get('/api/products', { date: day, supplier: shop, q: 'A-cross', limit: 100 })).items), ids(crossTask));
      const confirmed = await get('/api/products', { date: day, supplier: shop, status: 'confirmed', limit: 100 });
      assert.equal(confirmed.matchedCount, 19); assert.deepEqual(confirmed.summary, expectedSummary);
      assert.deepEqual(ids(confirmed.items), ids(exact.filter(p => p.confirmed)));
      assert.deepEqual(ids((await get('/api/products', { date: day, supplier: shop, status: 'missingPrice', limit: 100 })).items), ids(exact.filter(p => p.unitPrice === null)));
      const favorites = await get('/api/products', { date: day, supplier: shop, favorite: 'yes', limit: 100 });
      assert.deepEqual(ids(favorites.items), ids(exact.filter(p => p.favorite))); assert.equal(favorites.summary.total, 10);
    });

    await t.test('SQL merchant aggregates include all active pages and remain isolated by task, day and account', async () => {
      const groups = await get('/api/merchants', { date: day });
      const group = (supplier: string) => groups.find((value: { supplier: string }) => value.supplier === supplier);
      assert.equal(groups.length, 3);
      assert.deepEqual(group(shop), { supplier: shop, supplierContact: '合成联系人', total: 38, confirmed: 19, pending: 19, missingPrice: 13 });
      assert.deepEqual(group(similarShop), { supplier: similarShop, supplierContact: '合成联系人', total: 2, confirmed: 1, pending: 1, missingPrice: 0 });
      assert.deepEqual(group(''), { supplier: '', supplierContact: '', total: 2, confirmed: 1, pending: 1, missingPrice: 1 });
      assert.equal(groups.reduce((sum: number, value: { total: number }) => sum + value.total, 0), 42);
      assert.equal((await get('/api/merchants', { projectId: task.id, date: day })).find((m: { supplier: string }) => m.supplier === shop).total, 36);
      assert.deepEqual(await get('/api/merchants', { date: day }, b.token), [{ supplier: shop, supplierContact: '合成联系人', total: 1, confirmed: 0, pending: 1, missingPrice: 0 }]);
      assert.equal((await request('/api/merchants', { projectId: task.id }, b.token)).statusCode, 404);
      assert.equal((await get('/api/merchants', { date: day, favorite: 'yes' }))[0].total, 10);
    });

    await t.test('single-shop and daily XLSX exports contain exact rows and previews preserve currency and decimal precision', async () => {
      const settings = defaultProcurementTemplate();
      settings.layout.moneyDecimals = 4; settings.layout.volumeDecimals = 6;
      settings.columns.filter(column => ['supplier', 'currency'].includes(column.key)).forEach(column => { column.enabled = true; });
      const { version: _version, ...fields } = settings;
      new ProcurementTemplateStore(root).save(a.user.id, 0, fields);
      const queries = [
        { date: day, supplier: shop },
        { date: day },
        { date: day, supplier: '' },
        { date: day, supplier: shop, scope: 'confirmed' },
      ];
      const expectations = [exact, activeDay, unnamed, exact.filter(p => p.confirmed)];
      for (let index = 0; index < queries.length; index++) {
        const query = { ...queries[index], images: 'no' };
        const preview: Preview = await get('/api/export-preview', query);
        assert.equal(preview.layout.moneyDecimals, 4); assert.equal(preview.layout.volumeDecimals, 6);
        const priceLabel = preview.columns.find(column => column.key === 'unitPrice')!.label;
        assert.equal(priceLabel.includes('原币种'), index === 1 || index === 2);
        assert.equal(priceLabel.includes('RMB'), index === 0 || index === 3);
        const response = await request('/api/export', query);
        assert.equal(response.statusCode, 200, response.body);
        assert.match(String(response.headers['content-type']), /spreadsheetml/);
        const rows = await exportedRows(response.rawPayload, preview);
        assert.deepEqual(rows.map(row => row.cell('sku').text).sort(), expectations[index].map(p => p.sku).sort());
        assert.ok(!rows.some(row => row.cell('sku').text === 'discarded'));
        if (index === 0) {
          assert.deepEqual([...new Set(rows.map(row => row.sheet.name))], [shop]);
          const precise = rows.find(row => row.cell('sku').text === 'A-1')!;
          assert.equal(precise.cell('unitPrice').value, 1.2345); assert.equal(precise.cell('unitPrice').numFmt, '#,##0.0000');
          assert.equal(precise.cell('quantity').value, 7); assert.ok(Math.abs(Number(precise.cell('amount').value) - 8.6415) < 1e-10);
          assert.equal(precise.cell('cartonCbm').value, .012345); assert.equal(precise.cell('cartonCbm').numFmt, '0.000000');
          assert.ok(Math.abs(Number(precise.cell('cbm').value) - .037035) < 1e-10);
          assert.equal(rows.find(row => row.cell('sku').text === 'A-0')!.cell('unitPrice').value, null);
        }
      }
    });

    await t.test('trash/restore updates exact-shop pages and aggregates without changing record day', async () => {
      const target = primary[0], moved = trashProduct(a.user.id, target.id, target.version);
      assert.equal((await get('/api/products', { date: day, supplier: shop })).matchedCount, 37);
      assert.equal((await get('/api/merchants', { date: day })).find((m: { supplier: string }) => m.supplier === shop).total, 37);
      assert.equal(repository.recordsForExport(a.user.id, undefined, day, false, shop).some(p => p.id === target.id), false);
      const restored = trashProduct(a.user.id, target.id, moved.version, true);
      assert.equal(restored.createdAt, '2026-10-17T16:00:00.000Z');
      assert.equal((await get('/api/products', { date: day, supplier: shop })).matchedCount, 38);
    });

    await t.test('merchant contact comes from the latest nonempty active record rather than text maximum', async () => {
      const supplier = '联系人时序商家';
      add(task.id, 'contact-old', supplier, { supplierContact: 'z-old-contact' }, '2026-10-18T05:00:00.000Z');
      add(otherTask.id, 'contact-new', supplier, { supplierContact: 'a-new-contact' }, '2026-10-18T06:00:00.000Z');
      add(otherTask.id, 'contact-empty', supplier, { supplierContact: '' }, '2026-10-18T07:00:00.000Z');
      const removed = add(otherTask.id, 'contact-trash', supplier, { supplierContact: 'trashed-contact' }, '2026-10-18T08:00:00.000Z');
      trashProduct(a.user.id, removed.id, removed.version);
      const daily = (await get('/api/merchants', { date: day })).find((m: { supplier: string }) => m.supplier === supplier);
      assert.deepEqual(daily, { supplier, supplierContact: 'a-new-contact', total: 3, confirmed: 0, pending: 3, missingPrice: 0 });
      assert.equal((await get('/api/merchants', { projectId: task.id, date: day })).find((m: { supplier: string }) => m.supplier === supplier).supplierContact, 'z-old-contact');
    });
  } finally {
    await app.close(); closeDB(); rmSync(root, { recursive: true, force: true });
    if (previousDir === undefined) delete process.env.APP_DATA_DIR; else process.env.APP_DATA_DIR = previousDir;
  }
});

test('merchant visits read legacy shop groups, keep new empty stores and preserve merchant data after local migration',async()=>{
 const root=mkdtempSync(join(tmpdir(),'huoji-visits-api-'));process.env.APP_DATA_DIR=root;closeDB();
 const a=issueSession('visits-fixture-a'),b=issueSession('visits-fixture-b'),app=await createApp({identity:{exchange:async()=>''}}),headers={authorization:'Bearer '+a.token};
 try{
  const create=await app.inject({method:'POST',url:'/api/projects',headers,payload:{name:'店铺甲',market:'合成市场',date:day,supplier:'店铺甲',supplierContact:'微信甲',requestKey:randomUUID()}});assert.equal(create.statusCode,201,create.body);const merchant=create.json();assert.equal(merchant.supplierContact,'微信甲');
  const legacy=createProject(a.user.id,{name:'旧任务',market:'合成',date:'2026-10-01'},randomUUID());
  const first=saveProduct(a.user.id,{requestKey:randomUUID(),projectId:legacy.id,fields:{...emptyFields,name:'演示一',supplier:'店铺甲'},photoIds:[]});db().prepare('UPDATE products SET created_at=? WHERE id=?').run(day+'T01:00:00Z',first.id);
  const second=saveProduct(a.user.id,{requestKey:randomUUID(),projectId:legacy.id,fields:{...emptyFields,name:'演示二',supplier:'店铺乙'},photoIds:[]});db().prepare('UPDATE products SET created_at=? WHERE id=?').run(day+'T01:01:00Z',second.id);
  const visits=(await app.inject({url:'/api/merchant-visits?date='+day,headers})).json();assert.equal(visits.find((v:{projectId:string})=>v.projectId===merchant.id).total,0);assert.equal(visits.filter((v:{projectId:string})=>v.projectId===legacy.id).length,2);
  trashProduct(a.user.id,second.id,second.version);const active=(await app.inject({url:'/api/merchant-visits?date='+day,headers})).json();assert.ok(!active.some((v:{supplier:string})=>v.supplier==='店铺乙'));
  assert.deepEqual((await app.inject({url:'/api/merchant-visits?date='+day,headers:{authorization:'Bearer '+b.token}})).json(),[]);
  const file=await app.inject({url:'/api/export?date='+day+'&supplier='+encodeURIComponent('店铺甲')+'&images=no',headers});assert.equal(file.statusCode,200,file.body);assert.match(decodeURIComponent(file.headers['content-disposition'] as string),/店铺甲-2026-10-18\.xlsx/);
 }finally{await app.close();closeDB();rmSync(root,{recursive:true,force:true});}
});
