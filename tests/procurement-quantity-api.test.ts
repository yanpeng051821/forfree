import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import ExcelJS from 'exceljs';
import { createApp } from '../src/server/app';
import { parseRuntimeConfig } from '../src/server/config';
import { MarketService } from '../src/server/service';
import { issueSession } from '../src/server/auth';
import { closeDB } from '../src/lib/db';
import { procurementFromProducts } from '../src/lib/procurement';
import { ProcurementStore } from '../src/lib/procurement-store';
import { emptyFields } from '../src/lib/types';

test('采购数量HTTP显式值、旧请求省略、清空、0与Excel一致且不改变商户和模板', async () => {
  const root = mkdtempSync(join(tmpdir(), 'huoji-quantity-api-')), previous = process.env.APP_DATA_DIR;
  process.env.APP_DATA_DIR = root; closeDB();
  const config = parseRuntimeConfig({ APP_DATA_DIR: root }, { identityInjected: true, serviceInjected: true });
  const app = await createApp({ config, identity: { exchange: async code => code }, service: new MarketService(undefined, { enabled: () => false, extract: async () => { throw new Error('unused'); } }) });
  try {
    const account = issueSession('synthetic-quantity-review'), headers = { authorization: 'Bearer ' + account.token };
    const doc = await procurementFromProducts({ id: 'p', name: '合成测试', market: '', date: '2026-10-21', createdAt: '', demo: true }, [{ ...emptyFields, id: 'l', projectId: 'p', version: 1, name: '合成杯子', supplier: '合成商家', photos: [], createdAt: '', updatedAt: '', cartons: 2, cartonQty: 24, quantity: 50, unitPrice: 2.5 }], () => Buffer.alloc(0));
    const store = new ProcurementStore(root); store.create(account.user.id, doc);
    const templateBefore = (await app.inject({ method: 'GET', url: '/api/procurement-template', headers })).body;
    const route = `/api/procurement/${doc.id}/lines/${doc.lines[0].id}`;
    const initial = await app.inject({ method: 'GET', url: `/api/procurement/${doc.id}`, headers });
    assert.equal(initial.json().lines[0].recordedQuantity, 50);
    let version = 1;
    const base = { decision: 'include', cartons: 2, pcsPerCarton: 24, unitPrice: 2.5, cartonCbm: null, note: '' };
    async function save(patch: Record<string, unknown>, expectedQuantity: number, expectedRecorded: number | null) {
      const response = await app.inject({ method: 'POST', url: route, headers, payload: { version, fields: { ...base, ...patch } } });
      assert.equal(response.statusCode, 200, response.body); const view = response.json(); version = view.version;
      assert.equal(view.lines[0].quantity, expectedQuantity); assert.equal(view.lines[0].recordedQuantity, expectedRecorded);
      assert.equal(view.lines[0].amount, expectedQuantity * 2.5); assert.equal(view.suppliers.length, 1);
      const exported = await app.inject({ method: 'GET', url: `/api/procurement/${doc.id}/export`, headers });
      assert.equal(exported.statusCode, 200, exported.body);
      const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(exported.rawPayload as unknown as ExcelJS.Buffer);
      const detail = workbook.getWorksheet('商品明细')!;
      let header = 0; detail.eachRow(row => { if (row.values && (row.values as ExcelJS.CellValue[]).some(value => value === 'REF.')) header = row.number; });
      const headerValues = detail.getRow(header).values as ExcelJS.CellValue[];
      const quantityCol = headerValues.findIndex(value => String(value).startsWith('QUANTITY'));
      const amountCol = headerValues.findIndex(value => String(value).startsWith('AMOUNT'));
      const quantity = detail.getCell(header + 1, quantityCol as number), amount = detail.getCell(header + 1, amountCol);
      assert.equal(quantity.formula ? quantity.result : quantity.value, expectedQuantity); assert.equal(amount.result, expectedQuantity * 2.5);
    }
    await save({ cartons: 3 }, 50, 50); // Older clients omit quantity: preserve the explicit value.
    await save({ quantity: null, cartons: 3 }, 72, null);
    await save({ quantity: 0, cartons: null, pcsPerCarton: null }, 0, 0);
    await save({ quantity: 17, cartons: null, pcsPerCarton: null }, 17, 17);
    for (const quantity of [-1, 1.5, '20', 100_000_001]) {
      const invalid = await app.inject({ method: 'POST', url: route, headers, payload: { version, fields: { ...base, quantity } } });
      assert.equal(invalid.statusCode, 400, invalid.body); assert.equal(store.read(account.user.id, doc.id).version, version);
    }
    const invalidClear = await app.inject({ method: 'POST', url: route, headers, payload: { version, fields: { ...base, quantity: null, cartons: null } } });
    assert.equal(invalidClear.statusCode, 400); assert.equal(store.read(account.user.id, doc.id).lines[0].quantity, 17);
    assert.equal((await app.inject({ method: 'GET', url: '/api/procurement-template', headers })).body, templateBefore);
    const legacy = structuredClone(doc); legacy.id = crypto.randomUUID(); legacy.lines[0].id = crypto.randomUUID(); delete legacy.lines[0].quantity;
    store.create(account.user.id, legacy);
    const old = await app.inject({ method: 'GET', url: `/api/procurement/${legacy.id}`, headers });
    assert.equal(old.json().lines[0].quantity, 48); assert.equal(old.json().lines[0].recordedQuantity, null);
  } finally {
    await app.close(); closeDB(); rmSync(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.APP_DATA_DIR; else process.env.APP_DATA_DIR = previous;
  }
});
