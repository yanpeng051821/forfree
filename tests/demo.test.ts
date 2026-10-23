import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { seedDemo } from '../scripts/seed-demo';
import { closeDB, createProject, listProjects, listProducts, readPhoto, recordDays, saveProduct } from '../src/lib/db';
import { issueSession } from '../src/server/auth';

test('演示播种保留已有任务、不重复写入，覆盖跨日、照片、待询价、收藏与评价', () => {
  const prior = process.env.APP_DATA_DIR, root = mkdtempSync(join(tmpdir(), 'forfree-demo-')); process.env.APP_DATA_DIR = root;
  try {
    const owner = issueSession('seed-test').user.id;
    const original = createProject(owner, { name: '用户已有任务', market: '自有市场', date: '2026-10-16' }, randomUUID());
    const first = seedDemo(owner), second = seedDemo(owner);
    assert.deepEqual(second.productIds, first.productIds); assert.equal(first.projects.length, 4); assert.equal(first.productIds.length, 12);
    const projects = listProjects(owner); assert.equal(projects.length, 5); assert.ok(projects.some(p => p.id === original.id && !p.demo));
    assert.equal(recordDays(owner).length, 3);
    const items = first.projects.flatMap(p => listProducts(owner, p.id));
    assert.ok(items.some(p => p.unitPrice === null)); assert.ok(items.some(p => p.favorite && p.rating === 5)); assert.ok(items.some(p => p.photos.length === 3));
    assert.ok(items.every(p => p.demo && p.notes.includes('演示'))); assert.ok(readPhoto(owner, items[0].photos[0].id).length > 1000);
    assert.equal(first.draft.demo, true); assert.equal(second.draft.photos[0].id, first.draft.photos[0].id);
    assert.ok(!items.some(item => item.photos.some(photo => photo.id === first.draft.photos[0].id)), 'demo draft must have its own upload, so saving it never reuses another product photo');
    assert.ok(saveProduct(owner, { requestKey: randomUUID(), projectId: first.draft.projectId, fields: first.draft.fields, photoIds: first.draft.photos.map(photo => photo.id) }).id);
    assert.equal(listProjects(issueSession('other-seed-owner').user.id).length, 0);
  } finally { closeDB(); rmSync(root, { recursive: true, force: true }); if (prior === undefined) delete process.env.APP_DATA_DIR; else process.env.APP_DATA_DIR = prior; }
});
