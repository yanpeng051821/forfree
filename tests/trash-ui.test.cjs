const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { SaxesParser } = require('saxes');
const domain = require('../miniprogram/utils/domain');
const root = path.resolve(__dirname, '../miniprogram');
const plain = value => JSON.parse(JSON.stringify(value));
const event = id => ({ currentTarget: { dataset: { id } }, detail: {} });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function product(id, patch = {}) {
  return { ...domain.emptyFields, id, name: '商品 ' + id, projectId: 'project', version: 3, photos: [], createdAt: '2026-10-16T05:00:00.000Z', updatedAt: '2026-10-16T05:00:00.000Z', ...patch };
}
function environment(mode) {
  let binding = { owner: 'alice', epoch: 1 }, loggedIn = true;
  const calls = [], toasts = [], comparisons = [], timers = new Map(); let timerId = 0;
  const api = { request: async (url, options) => { calls.push({ url, options }); return {}; }, download: async url => '/temp/' + url.split('/').at(-2) + '.jpg' };
  const session = {
    info: () => loggedIn ? { user: { id: binding.owner } } : null,
    capture: () => { if (!loggedIn) throw new Error('请先登录'); return binding; },
    valid: captured => loggedIn && captured === binding,
    assert: captured => { if (!loggedIn || captured !== binding) throw new Error('登录状态已变化'); }
  };
  const kit = {
    protectedPage: definition => ({ ...definition, data: { ...definition.data, authenticated: true } }),
    requireLogin: p => { p.setData({ authenticated: loggedIn }); return loggedIn; },
    start: p => { p._alive = true; return p._seq = (p._seq || 0) + 1; },
    stop: p => { p._alive = false; p._seq += 1; },
    current: (p, captured, seq) => p._alive && p._seq === seq && session.valid(captured),
    failure: (p, captured, seq, e) => { if (kit.current(p, captured, seq)) p.setData({ error: e.message }); else if (!loggedIn && p._alive) p.setData({ authenticated: false, items: [], products: [] }); },
    message: (p, e) => p.setData({ error: e.message }), toast: message => toasts.push(message),
    confirm: async (title, content) => { calls.push({ title, content }); return true; }
  };
  const store = {
    activeProject: () => 'project', consumeProductView: () => null, compareSelection: () => [],
    setCompareSelection: (captured, scope, ids) => { session.assert(captured); comparisons.push({ scope, ids: ids.slice() }); },
    drafts: { list: () => [] }
  };
  const wx = {
    getStorageSync: () => '', setStorageSync() {}, removeStorageSync() {}, stopPullDownRefresh() {},
    navigateTo: options => calls.push(options), showActionSheet: options => options.success({ tapIndex: 0 })
  };
  const background = { refresh: async (_, products) => products };
  const modules = { api, session, store, domain, 'page-kit': kit, 'background-organize': background };
  const context = { module: { exports: {} }, require: id => modules[id.split('/').at(-1)], wx,
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; }, clearTimeout: id => timers.delete(id) };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'utils/product-page.js'), 'utf8'), context, { filename: 'product-page.js' });
  const definition = context.module.exports(mode);
  const p = { ...definition, data: plain(definition.data), _alive: true, _seq: 1, _binding: binding, _scope: mode || 'project', _coverCache: new Map() };
  p.setData = patch => Object.assign(p.data, patch);
  if (!mode) p.setData({ project: { id: 'project' } });
  const seed = products => { p.setData({ products, matchedCount: products.length, summary: mode === 'trash' ? null : { total: products.length, confirmed: products.filter(p => p.confirmed).length, pending: products.filter(p => !p.confirmed).length, missingPrice: products.filter(p => p.unitPrice === null).length } }); p.filter(); };
  return { p, api, session, kit, store, background, wx, calls, toasts, comparisons, timers, seed,
    switchAccount: () => { binding = { owner: 'bob', epoch: 2 }; }, logout: () => { loggedIn = false; }, context };
}

test('My, Products, Favorites and Trash expose recycle controls and valid bound handlers without redundant visible entries', () => {
  const env = environment(), manifest = JSON.parse(fs.readFileSync(path.join(root, 'app.json')));
  assert.ok(manifest.pages.includes('pages/trash/index'));
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'pages/me/index.wxml'), 'utf8'), /按日回顾|下单整理|bindtap="procurement"|bindtap="review"/);
  assert.match(fs.readFileSync(path.join(root, 'pages/me/index.wxml'), 'utf8'), /bindtap="trash"/);
  assert.match(fs.readFileSync(path.join(root, 'pages/favorites/index.wxml'), 'utf8'), /include.*products\/index.wxml/);
  for (const name of ['products', 'trash']) {
    const markup = fs.readFileSync(path.join(root, 'pages', name, 'index.wxml'), 'utf8');
    const parser = new SaxesParser({ xmlns: false }), errors = [];
    parser.on('error', e => errors.push(e.message));
    parser.write(markup.replace(/\s(scroll-x|enhanced|wx:else)(?=\s|\/?>)/g, ' $1="true"').replace(/&/g, '&amp;')).close();
    assert.deepEqual(errors, [], name);
    for (const match of markup.matchAll(/(?:bind|catch)[\w:]*="([a-zA-Z][\w]*)"/g)) assert.equal(typeof env.p[match[1]], 'function', name + ': ' + match[1]);
    assert.match(markup, /bindtap="toggleManageMode"/);
    assert.doesNotMatch(markup, /清空回收站|清空全部|生成采购单|下单整理/);
  }
  const markup = fs.readFileSync(path.join(root, 'pages/trash/index.wxml'), 'utf8');
  assert.match(markup, /catchtap="restoreProduct"/); assert.match(markup, /catchtap="deleteProduct"/);
  assert.match(markup, /aria-label="恢复商品"/); assert.match(markup, /aria-label="永久删除商品"/);
  assert.match(markup, /assets\/icons\/restore\.png/); assert.match(markup, /assets\/icons\/trash\.png/);
});

test('visible product menu offers export and recycle; My opens authenticated Trash', async () => {
  const env = environment(); let choices;
  env.wx.showActionSheet = options => { choices = plain(options.itemList); options.success({ tapIndex: 1 }); };
  await env.p.organizeMenu();
  assert.deepEqual(choices, ['导出Excel', '回收站']); assert.equal(env.calls.at(-1).url, '/pages/trash/index');
  let definition;
  vm.runInNewContext(fs.readFileSync(path.join(root, 'pages/me/index.js'), 'utf8'), { Page: value => { definition = value; }, require: id => ({ api: env.api, session: env.session, draft: {}, store: env.store, 'page-kit': env.kit, profile: { normalize: () => ({}), currencies: [] } })[id.split('/').at(-1)], wx: env.wx });
  definition.trash(); assert.equal(env.calls.at(-1).url, '/pages/trash/index');
  const count = env.calls.length; env.logout(); definition.trash(); env.p.openTrash(); assert.equal(env.calls.length, count);
});

test('manage selection caps at 50, crosses loaded pages, and starts a fresh two-item comparison after completion', () => {
  const env = environment(); env.seed(Array.from({ length: 55 }, (_, index) => product(String(index))));
  env.p.setData({ selectedIds: ['0', '1'], compareMode: true }); env.p.toggleManageMode();
  assert.equal(env.p.data.compareMode, false); assert.deepEqual(plain(env.p.data.selectedIds), []);
  for (let index = 0; index < 51; index += 1) env.p.toggleSelection(event(String(index)));
  assert.equal(env.p.data.manageIds.length, 50); assert.match(env.toasts.at(-1), /50/);
  env.p.toggleSelection(event('0')); env.p.toggleSelection(event('50')); assert.equal(env.p.data.manageIds.length, 50);
  env.p.toggleManageMode(); env.p.toggleCompareMode(); assert.equal(env.p.data.manageMode, false);
  assert.deepEqual(plain(env.p.data.selectedIds), []); env.p.toggleCompare(event('0')); env.p.toggleCompare(event('1')); env.p.compare(); assert.match(env.calls.at(-1).url, /pages\/compare\/index/);
  env.p.toggleCompare(event('2')); assert.deepEqual(plain(env.p.data.selectedIds), ['0', '1']);
});

test('batch move is sequential, shows immediate progress and retains failed and unacknowledged cards and selections', async () => {
  const env = environment(), products = ['a', 'b', 'c', 'd'].map(id => product(id)); env.seed(products);
  env.p.setData({ manageMode: true, manageIds: products.map(p => p.id), selectedIds: ['a', 'b'] });
  const first = deferred(); let active = 0, maxActive = 0;
  env.api.request = async (url, options) => {
    env.calls.push({ url, options: plain(options) }); active += 1; maxActive = Math.max(maxActive, active);
    try {
      if (url.includes('/a/')) return await first.promise;
      if (url.includes('/b/')) throw new Error('版本冲突');
      if (url.includes('/c/')) return { id: 'c', version: 4 }; // Missing acknowledgement of deleted state.
      return { ...products[3], version: 4, deletedAt: '2026-10-18T05:00:00Z' };
    } finally { active -= 1; }
  };
  const work = env.p.moveSelected();
  assert.equal(env.calls.length, 1); assert.equal(env.p.data.mutationBusy, true); assert.equal(env.p.data.items[0].actionBusy, true);
  assert.equal(env.p.data.items.length, 4); assert.equal(env.p.data.mutationTotal, 4);
  await env.p.moveSelected(); assert.equal(env.calls.length, 1);
  first.resolve({ ...products[0], version: 8, deletedAt: '2026-10-18T05:00:00Z' }); await work;
  assert.equal(maxActive, 1); assert.deepEqual(plain(env.p.data.products.map(p => p.id)), ['b', 'c']);
  assert.deepEqual(plain(env.p.data.manageIds), ['b', 'c']); assert.deepEqual(plain(env.p.data.selectedIds), ['b']);
  assert.deepEqual(env.comparisons, [{ scope: 'project', ids: ['b'] }]); assert.equal(env.p.data.summary.total, 2);
  assert.equal(env.p.data.undoCount, 2); assert.equal(env.p.data.mutationBusy, false); assert.match(env.p.data.error, /2 件未确认/);
  assert.deepEqual(plain(env.p._undo.records.map(p => ({ id: p.id, version: p.version }))), [{ id: 'a', version: 8 }, { id: 'd', version: 4 }]);
});

test('undo restores exactly acknowledged ids with returned versions and original project, fields, and date', async () => {
  const env = environment(), original = product('a', { createdAt: '2026-10-15T16:05:00Z', favorite: true, unitPrice: 0, rating: 5, notes: '真实记录' }); env.seed([original]);
  env.api.request = async (url, options) => {
    env.calls.push({ url, options: plain(options) });
    return { ...original, version: url.endsWith('/trash') ? 17 : 18, deletedAt: url.endsWith('/trash') ? '2026-10-18T05:00:00Z' : null };
  };
  await env.p.mutateProducts([original], 'trash'); assert.equal(env.p.data.items.length, 0);
  await env.p.undoMove();
  assert.deepEqual(env.calls.map(call => ({ url: call.url, data: call.options.data })), [{ url: '/api/products/a/trash', data: { version: 3 } }, { url: '/api/products/a/restore', data: { version: 17 } }]);
  const restored = env.p.data.products[0]; assert.equal(restored.id, original.id); assert.equal(restored.projectId, original.projectId);
  assert.equal(restored.createdAt, original.createdAt); assert.equal(restored.notes, original.notes); assert.equal(restored.unitPrice, 0); assert.equal(restored.rating, 5);
  assert.equal(env.p.data.summary.total, 1); assert.equal(env.p.data.undoCount, 0);
});

test('partially failed undo keeps only failed ids with their acknowledged move versions for retry', async () => {
  const env = environment(), products = ['a', 'b'].map(id => product(id, { version: 9, deletedAt: '2026-10-18T05:00:00Z' })); env.seed([]);
  env.p.offerUndo(env.session.capture(), products);
  env.api.request = async (url, options) => {
    env.calls.push({ url, options }); if (url.includes('/b/')) throw new Error('网络中断');
    return { ...products[0], version: 10, deletedAt: null };
  };
  await env.p.undoMove(); assert.equal(env.p.data.products.length, 1); assert.equal(env.p.data.undoCount, 1);
  assert.deepEqual(plain(env.p._undo.records.map(p => ({ id: p.id, version: p.version }))), [{ id: 'b', version: 9 }]);
});

test('undo cannot run under another account, after expiry, or after page hide', async () => {
  for (const invalidation of ['account', 'expiry', 'hide']) {
    const env = environment(); env.p.offerUndo(env.session.capture(), [product('a', { deletedAt: '2026-10-18T05:00:00Z' })]);
    if (invalidation === 'account') env.switchAccount();
    if (invalidation === 'expiry') env.p._undo.expiresAt = Date.now() - 1;
    if (invalidation === 'hide') env.p.onHide();
    await env.p.undoMove(); assert.equal(env.calls.length, 0); assert.equal(env.p.data.undoCount, 0);
  }
});

test('long press offers soft move and permanent delete and cancellation leaves the card unchanged', async () => {
  const env = environment(), original = product('a'); env.seed([original]); let sheet;
  env.wx.showActionSheet = options => { sheet = options; };
  const work = env.p.productActions(event('a')); assert.equal(env.p.data.items[0].actionBusy, true);
  assert.deepEqual(plain(sheet.itemList), ['移入回收站', '永久删除']);
  sheet.fail({ errMsg: 'showActionSheet:fail cancel' }); await work;
  assert.equal(env.p.data.items[0].actionBusy, false); assert.equal(env.p.data.products.length, 1); assert.equal(env.calls.length, 0);
  env.wx.showActionSheet = options => options.success({ tapIndex: 0 });
  env.api.request = async () => ({ ...original, version: 4, deletedAt: '2026-10-18T05:00:00Z' });
  await env.p.productActions(event('a')); assert.equal(env.p.data.products.length, 0); assert.equal(env.p.data.undoCount, 1);
});

test('every permanent delete awaits explicit confirmation and removes only server-acknowledged cards', async () => {
  const env = environment(); env.seed([product('a'), product('b')]); const confirmation = deferred();
  env.kit.confirm = (title, content) => { env.calls.push({ title, content }); return confirmation.promise; };
  const work = env.p.deleteProduct(event('a')); assert.match(env.calls[0].content, /永久删除.*无法恢复/);
  assert.equal(env.p.data.mutationBusy, true); assert.equal(env.calls.length, 1);
  confirmation.resolve(false); await work; assert.equal(env.calls.length, 1); assert.equal(env.p.data.products.length, 2); assert.equal(env.p.data.mutationBusy, false);
  env.kit.confirm = async () => true;
  env.api.request = async (url, options) => { env.calls.push({ url, options: plain(options) }); return url.endsWith('/a') ? { deleted: true } : {}; };
  env.p.setData({ manageMode: true, manageIds: ['a', 'b'] }); await env.p.deleteSelected();
  assert.equal(env.calls[1].options.method, 'DELETE'); assert.deepEqual(env.calls[1].options.data, { version: 3 });
  assert.deepEqual(plain(env.p.data.products.map(p => p.id)), ['b']); assert.deepEqual(plain(env.p.data.manageIds), ['b']);
});

test('account and page guards stop batches after the current request and discard late acknowledgements', async () => {
  for (const invalidation of ['account', 'hide', 'reload', 'logout']) {
    const env = environment(); env.seed([product('a'), product('b')]); env.p.setData({ manageMode: true, manageIds: ['a', 'b'] });
    const pending = deferred(); env.api.request = async (url, options) => { env.calls.push({ url, options }); return pending.promise; };
    const work = env.p.moveSelected();
    if (invalidation === 'account') env.switchAccount();
    if (invalidation === 'hide') env.p.onHide();
    if (invalidation === 'reload') env.p._seq += 1;
    if (invalidation === 'logout') env.logout();
    pending.resolve({ ...product('a'), version: 4, deletedAt: '2026-10-18T05:00:00Z' }); await work;
    assert.equal(env.calls.length, 1); assert.equal(env.p.data.products.length, 2); assert.equal(env.p.data.undoCount, 0);
  }
});

test('changing accounts or hiding while a permanent modal is open sends no delete request', async () => {
  for (const hide of [false, true]) {
    const env = environment(); env.seed([product('a')]); const pending = deferred(); env.kit.confirm = () => pending.promise;
    const work = env.p.deleteProduct(event('a')); if (hide) env.p.onHide(); else env.switchAccount();
    pending.resolve(true); await work; assert.equal(env.calls.length, 0); assert.equal(env.p.data.products.length, 1);
  }
});

test('trash fetch uses owner-bound query and cursor, renders cards before thumbnails, and skips AI polling', async () => {
  const env = environment('trash'), pending = deferred(); let downloads = 0, refreshes = 0;
  const trashed = product('a', { deletedAt: '2026-10-18T05:00:00Z', photos: [{ id: 'photo/one' }] });
  env.p.setData({ query: '杯 & 盘' });
  env.api.request = async (url, options) => { env.calls.push({ url, options }); return { items: [trashed], nextCursor: 'next/+cursor', matchedCount: 8 }; };
  env.api.download = (url, binding) => { downloads += 1; assert.equal(url, '/api/photos/photo%2Fone/thumbnail'); assert.equal(binding, env.session.capture()); return pending.promise; };
  env.background.refresh = async () => { refreshes += 1; return []; };
  await env.p.fetchPage('', false, env.session.capture(), 1);
  assert.equal(env.p.data.items[0].name, trashed.name); assert.equal(env.p.data.items[0].cover, ''); assert.equal(env.p.data.matchedCount, 8);
  assert.equal(env.calls[0].url, '/api/trash?limit=30&q=' + encodeURIComponent('杯 & 盘')); assert.equal(env.calls[0].options.identity, env.session.capture());
  assert.equal(downloads, 1); assert.equal(refreshes, 0);
  pending.resolve('/temp/thumb.jpg'); await tick(); assert.equal(env.p.data.items[0].cover, '/temp/thumb.jpg');
  await env.p.loadMore(); assert.match(env.calls[1].url, /cursor=next%2F%2Bcursor/); assert.equal(env.p.data.items.length, 1);
});

test('trash thumbnail concurrency remains at four even when pages hydrate simultaneously', async () => {
  const env = environment('trash'), downloads = [], resolvers = []; let active = 0, peak = 0;
  env.api.download = url => {
    downloads.push(url); active += 1; peak = Math.max(peak, active);
    const task = deferred(); resolvers.push(task);
    return task.promise.finally(() => { active -= 1; });
  };
  const items = Array.from({ length: 12 }, (_, index) => product(String(index), { deletedAt: '2026-10-18T05:00:00Z', photos: [{ id: 'photo-' + index }] }));
  env.api.request = async url => ({ items: url.includes('cursor=') ? items.slice(6) : items.slice(0, 6), nextCursor: url.includes('cursor=') ? null : 'next', matchedCount: 12 });
  await env.p.fetchPage('', false, env.session.capture(), 1); await env.p.fetchPage('next', true, env.session.capture(), 1); await tick();
  assert.equal(env.p.data.items.length, 12); assert.equal(downloads.length, 4);
  for (let index = 0; index < 12; index += 1) { resolvers[index].resolve('/temp/' + index); await tick(); }
  assert.equal(peak, 4); assert.equal(downloads.length, 12); assert.equal(env.p.data.items.filter(p => p.cover).length, 12);
});

test('late trash thumbnails never overwrite the next account or continue their stale queue', async () => {
  const env = environment('trash'), pending = deferred(); let downloads = 0;
  const items = Array.from({ length: 8 }, (_, index) => product(String(index), { deletedAt: '2026-10-18T05:00:00Z', photos: [{ id: 'photo-' + index }] })); env.seed(items);
  env.api.download = () => { downloads += 1; return pending.promise; };
  const work = env.p.fillCovers(items, env.session.capture(), 1); await tick(); assert.equal(downloads, 4);
  env.switchAccount(); env.seed([product('bob', { deletedAt: '2026-10-18T05:00:00Z' })]); pending.resolve('/temp/alice.jpg'); await work; await tick();
  assert.equal(downloads, 4); assert.equal(env.p.data.products[0].id, 'bob'); assert.equal(env.p.data.products[0].cover, undefined);
});

test('trash supports batch restore with partial failure, preserving failed cards and their selection', async () => {
  const env = environment('trash'), products = ['a', 'b'].map(id => product(id, { deletedAt: '2026-10-18T05:00:00Z' })); env.seed(products);
  env.p.setData({ manageMode: true, manageIds: ['a', 'b'] });
  env.api.request = async (url, options) => {
    env.calls.push({ url, options: plain(options) }); if (url.includes('/b/')) throw new Error('恢复失败');
    return { ...products[0], version: 4, deletedAt: null };
  };
  await env.p.restoreSelected(); assert.deepEqual(env.calls.map(c => c.url), ['/api/products/a/restore', '/api/products/b/restore']);
  assert.deepEqual(plain(env.p.data.items.map(p => p.id)), ['b']); assert.deepEqual(plain(env.p.data.manageIds), ['b']); assert.equal(env.p.data.undoCount, 0);
});

test('load resets private manage and undo state for the next owner without changing fixed trash mode', async () => {
  const env = environment('trash'); env.seed([product('alice', { deletedAt: '2026-10-18T05:00:00Z' })]);
  env.p.setData({ query: 'alice', manageIds: ['alice'], manageMode: true, menuId: 'alice' }); env.p.offerUndo(env.session.capture(), [product('old')]); env.switchAccount();
  env.api.request = async url => { assert.equal(url, '/api/trash?limit=30&q='); return { items: [product('bob', { deletedAt: '2026-10-18T05:00:00Z' })], nextCursor: null, matchedCount: 1 }; };
  await env.p.load(); assert.equal(env.p.data.viewMode, 'trash'); assert.equal(env.p.data.items[0].id, 'bob');
  assert.equal(env.p.data.query, ''); assert.deepEqual(plain(env.p.data.manageIds), []); assert.equal(env.p.data.undoCount, 0); assert.equal(env.p.data.menuId, '');
});

test('server search and pagination discard stale results and retain current trash records', async () => {
  const env = environment('trash'), calls = [];
  env.api.request = (url, options) => { const task = deferred(); calls.push({ url, options, ...task }); return task.promise; };
  const old = env.p.reloadResults(); env.p.search({ detail: { value: '新词' } });
  const searchTimer = Array.from(env.timers.values()).find(t => t.ms === 300); searchTimer.fn();
  calls[1].resolve({ items: [product('new', { deletedAt: '2026-10-18T05:00:00Z' })], nextCursor: 'page2', matchedCount: 3 }); await tick();
  calls[0].resolve({ items: [product('old', { deletedAt: '2026-10-18T05:00:00Z' })], nextCursor: null, matchedCount: 99 }); await old;
  assert.equal(env.p.data.items[0].id, 'new'); assert.match(calls[1].url, /q=%E6%96%B0%E8%AF%8D/); assert.equal(env.p.data.hasMore, true);
  const more = env.p.loadMore(); env.p.clearSearch();
  calls[3].resolve({ items: [product('fresh', { deletedAt: '2026-10-18T05:00:00Z' })], nextCursor: null, matchedCount: 1 }); await tick();
  calls[2].resolve({ items: [product('stale-page', { deletedAt: '2026-10-18T05:00:00Z' })], nextCursor: null, matchedCount: 3 }); await more;
  assert.equal(env.p.data.items[0].id, 'fresh'); assert.equal(env.p.data.loadingMore, false);
});

test('moving a cursor boundary restarts pagination, skips duplicates and keeps unacknowledged selections', async () => {
  const env = environment(); env.seed([product('a'), product('b')]); env.p.setData({ nextCursor: 'boundary-b', hasMore: true, manageMode: true, manageIds: ['a', 'b'] });
  env.api.request = async url => {
    env.calls.push({ url });
    if (url.endsWith('/b/trash')) return { ...product('b'), deletedAt: '2026-10-18T05:00:00Z', version: 4 };
    if (url.includes('cursor=')) return { items: [product('c')], nextCursor: null, matchedCount: 2 };
    return { items: [product('a')], nextCursor: 'boundary-a', matchedCount: 2 };
  };
  await env.p.mutateProducts([product('b')], 'trash'); await env.p.loadMore();
  assert.equal(env.calls.length, 3); assert.doesNotMatch(env.calls[1].url, /cursor=/); assert.match(env.calls[2].url, /cursor=boundary-a/);
  assert.deepEqual(plain(env.p.data.items.map(p => p.id)), ['a', 'c']); assert.deepEqual(plain(env.p.data.manageIds), ['a']);
});

test('soft-deleted records never appear in active lists and active records never appear in Trash', async () => {
  for (const mode of [undefined, 'favorites', 'trash']) {
    const env = environment(mode); env.api.request = async () => ({ items: [product('active'), product('deleted', { deletedAt: '2026-10-18T05:00:00Z' })], nextCursor: null });
    await env.p.fetchPage('', false, env.session.capture(), 1);
    assert.deepEqual(plain(env.p.data.items.map(p => p.id)), [mode === 'trash' ? 'deleted' : 'active']);
  }
});

test('an in-flight favorite blocks moving that item without losing its card; other selected moves proceed', async () => {
  const env = environment(); env.seed([product('a'), product('b')]); env.p.setData({ favoriteBusy: { a: true }, manageIds: ['a', 'b'], manageMode: true });
  env.api.request = async (url, options) => { env.calls.push({ url, options }); return { ...product('b'), version: 4, deletedAt: '2026-10-18T05:00:00Z' }; };
  await env.p.moveSelected(); assert.equal(env.calls.length, 1); assert.match(env.calls[0].url, /\/b\/trash$/);
  assert.deepEqual(plain(env.p.data.manageIds), ['a']); assert.equal(env.p.data.products[0].id, 'a');
});

test('account change during a batch permits loading the new account and prevents the old completion from touching it', async () => {
  const env = environment('trash'), original = product('alice', { deletedAt: '2026-10-18T05:00:00Z' }); env.seed([original]);
  const pending = deferred();
  env.api.request = async url => url.endsWith('/restore') ? pending.promise : { items: [product('bob', { deletedAt: '2026-10-18T05:00:00Z' })], nextCursor: null, matchedCount: 1 };
  const work = env.p.restoreProduct(event('alice')); assert.equal(env.p.data.mutationBusy, true);
  env.switchAccount(); await env.p.load(); assert.equal(env.p.data.items[0].id, 'bob'); assert.equal(env.p.data.mutationBusy, false);
  pending.resolve({ ...original, version: 4, deletedAt: null }); await work;
  assert.equal(env.p.data.items[0].id, 'bob'); assert.equal(env.p.data.mutationBusy, false);
});

test('a failed pagination restart retries from the beginning instead of using the removed boundary', async () => {
  const env = environment('trash'); env.seed([product('a', { deletedAt: '2026-10-18T05:00:00Z' })]); env.p.setData({ nextCursor: 'removed-boundary', hasMore: true }); env.p._paginationRestart = true;
  env.api.request = async url => { env.calls.push({ url }); throw new Error('暂时离线'); };
  await env.p.loadMore(); assert.equal(env.p._paginationRestart, true); assert.equal(env.p.data.loadingMore, false);
  env.api.request = async url => { env.calls.push({ url }); return { items: [product('b', { deletedAt: '2026-10-18T05:00:00Z' })], nextCursor: null, matchedCount: 2 }; };
  await env.p.loadMore(); assert.doesNotMatch(env.calls[0].url, /cursor=/); assert.doesNotMatch(env.calls[1].url, /cursor=/);
  assert.deepEqual(plain(env.p.data.items.map(p => p.id)), ['a', 'b']);
});

test('the old undo expires after an unrelated operation finishes and cannot leave a dead action visible', async () => {
  const env = environment(); env.seed([product('b')]); env.p.offerUndo(env.session.capture(), [product('a', { deletedAt: '2026-10-18T05:00:00Z' })]);
  const pending = deferred(); env.api.request = () => pending.promise;
  const work = env.p.deleteProduct(event('b')); await tick(); env.p._undo.expiresAt = Date.now() - 1;
  pending.resolve({ deleted: true }); await work; assert.equal(env.p.data.undoCount, 0); assert.equal(env.p._undo, null);
});

test('idempotent restore acknowledgements update the card once and never increment counts twice or roll back newer edits', () => {
  const env = environment(), restored = product('a', { version: 8 }); env.seed([]);
  env.p.restoreAcknowledged(restored); env.p.restoreAcknowledged(restored);
  assert.equal(env.p.data.matchedCount, 1); assert.equal(env.p.data.summary.total, 1); assert.equal(env.p.data.products.length, 1);
  env.p.setData({ products: [product('a', { version: 10, name: '刚刚修改' })] }); env.p.restoreAcknowledged(restored);
  assert.equal(env.p.data.products[0].name, '刚刚修改'); assert.equal(env.p.data.products[0].version, 10); assert.equal(env.p.data.summary.total, 1);
  env.p.setData({ query: '不会匹配' }); env.seed([]); env.p._restoredIds = new Set();
  env.p.restoreAcknowledged(restored); env.p.restoreAcknowledged(restored);
  assert.equal(env.p.data.products.length, 0); assert.equal(env.p.data.matchedCount, 0); assert.equal(env.p.data.summary.total, 1);
});

test('undo recovers a cover cached after moving and rehydrates uncached photos without delaying the restored card', async () => {
  for (const cached of [false, true]) {
    const env = environment(), original = product('a', { version: 8, photos: [{ id: 'original-photo' }], deletedAt: '2026-10-18T05:00:00Z' }); env.seed([]);
    env.p.offerUndo(env.session.capture(), [original]); const thumbnail = deferred(); let downloads = 0;
    if (cached) env.p._coverCache.set('original-photo', '/temp/cached-original.jpg');
    env.api.request = async () => ({ ...original, version: 9, deletedAt: null });
    env.api.download = async url => { downloads += 1; assert.equal(url, '/api/photos/original-photo/thumbnail'); return thumbnail.promise; };
    await env.p.undoMove(); assert.equal(env.p.data.items.length, 1); assert.equal(env.p.data.items[0].photos[0].id, 'original-photo');
    assert.equal(env.p.data.items[0].cover, cached ? '/temp/cached-original.jpg' : ''); assert.equal(downloads, cached ? 0 : 1);
    if (!cached) { thumbnail.resolve('/temp/restored-original.jpg'); await tick(); assert.equal(env.p.data.items[0].cover, '/temp/restored-original.jpg'); }
  }
});

test('trash record date uses China createdAt rather than project date', () => {
  const env = environment('trash'); env.seed([product('a', { createdAt: '2026-09-30T16:05:00Z', taskDate: '2026-09-28', deletedAt: '2026-10-18T05:00:00Z' })]);
  assert.equal(env.p.data.items[0].recordDateText, '2026-10-01');
  assert.match(fs.readFileSync(path.join(root, 'pages/trash/index.wxml'), 'utf8'), /item.recordDateText/);
});
