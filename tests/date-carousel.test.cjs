const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const dates = require('../miniprogram/utils/date-rail');
const domain = require('../miniprogram/utils/domain');
const componentFile = require.resolve('../miniprogram/components/date-rail/index.js');
let definition;
const originalComponent = global.Component;
global.Component = value => { definition = value; };
try { delete require.cache[componentFile]; require(componentFile); }
finally { if (originalComponent === undefined) delete global.Component; else global.Component = originalComponent; }

// Exercise the component's actual handlers, with deterministic time and parent
// property echoes. No WeChat runtime or changes to other test files are needed.
function harness(options = {}) {
  const originalNow = Date.now, originalSetTimeout = global.setTimeout, originalClearTimeout = global.clearTimeout;
  let now = Date.parse(options.now || '2026-10-18T04:00:00Z');
  let timerId = 0;
  const timers = new Map();
  Date.now = () => now;
  global.setTimeout = (callback, delay) => { const id = ++timerId; timers.set(id, { callback, at: now + delay }); return id; };
  global.clearTimeout = id => timers.delete(id);
  const changes = [];
  const component = {
    ...definition.methods,
    properties: { selectedDate: '', counts: {}, allowAll: false, maxDate: '', ...options.properties },
    data: structuredClone(definition.data),
    setData(patch) { Object.assign(this.data, patch); },
    triggerEvent(name, detail) {
      assert.equal(name, 'change');
      changes.push(detail.date);
      assert.ok(changes.length < 100, 'property observers must not feed events back indefinitely');
      if (options.echo !== false) {
        this.properties.selectedDate = detail.date;
        definition.observers['selectedDate, counts, maxDate, allowAll'].call(this);
      }
    },
    createSelectorQuery() {
      return { select(selector) { assert.equal(selector, '.rail-viewport'); return this; }, boundingClientRect(callback) { callback({ width: 350 }); return this; }, exec() {} };
    },
  };
  definition.lifetimes.attached.call(component);
  definition.lifetimes.ready.call(component);
  return {
    component, changes, timers,
    tick(milliseconds = 200) {
      now += milliseconds;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) { timers.delete(id); timer.callback(); }
      }
    },
    swipe(dx, dy = 0) {
      component.touchStart({ touches: [{ clientX: 175, clientY: 70 }] });
      component.touchMove({ touches: [{ clientX: 175 + dx, clientY: 70 + dy }] });
      component.touchEnd({ changedTouches: [{ clientX: 175 + dx, clientY: 70 + dy }] });
    },
    restore() {
      definition.lifetimes.detached.call(component);
      Date.now = originalNow; global.setTimeout = originalSetTimeout; global.clearTimeout = originalClearTimeout;
    },
  };
}
function run(options, callback) {
  const h = harness(options);
  try { callback(h); } finally { h.restore(); }
}
function centered(component, date) {
  assert.equal(component.data.anchor, date);
  assert.equal(component.data.days.length, 21);
  assert.equal(component.data.days[10].date, date);
  assert.equal(component.data.days[10].distance, 0);
  assert.equal(component.data.dragOffset, 0);
}

test('legacy dateItems keeps its 21-day truncated contract', () => {
  const items = dates.dateItems('2026-10-16', { '2026-10-15': 2 }, '2026-10-16', '2026-10-16');
  assert.equal(items.length, 21);
  assert.equal(items.at(-1).date, '2026-10-16');
  assert.equal(items.at(-1).week, '今');
  assert.equal(items.find(item => item.date === '2026-10-15').hasRecords, true);
  assert.deepEqual(Object.keys(items[0]).sort(), ['date', 'day', 'hasRecords', 'id', 'week']);
});

test('carousel centers its anchor and keeps both sides visible with date-based disablement', () => {
  const days = dates.carouselItems('2026-10-16', { '2026-10-17': 3 }, '', '2026-10-18');
  assert.equal(days.length, 21);
  assert.equal(days[10].date, '2026-10-16');
  assert.equal(days[11].disabled, false, 'a date right of an older selection is selectable');
  assert.equal(days[11].hasRecords, true);
  assert.equal(days[12].week, '今');
  assert.equal(days[12].disabled, false);
  assert.equal(days[13].disabled, true);
  assert.deepEqual(days.slice(10, 13).map(item => item.distance), [0, 1, 2]);
  assert.equal(dates.carouselItems('2026-10-16', {}, '2026-10-17', '2026-10-18')[12].disabled, true);
  assert.equal(dates.carouselItems('2026-10-18', {}, '2026-10-30', '2026-10-18')[11].disabled, true);
});

test('day and weekday math crosses leap days, months, years and China midnight', () => {
  const leap = dates.carouselItems('2024-03-01', {}, '', '2024-03-01');
  assert.equal(leap[9].date, '2024-02-29'); assert.equal(leap[9].week, '四');
  const regular = dates.carouselItems('2026-03-01', {}, '', '2026-03-01');
  assert.equal(regular[9].date, '2026-02-28'); assert.equal(regular[9].week, '六');
  assert.equal(dates.carouselItems('2026-01-01', {}, '', '2026-01-01')[9].date, '2025-12-31');
  assert.equal(domain.chinaLocalDate('2026-10-17T15:59:59.999Z'), '2026-10-17');
  assert.equal(domain.chinaLocalDate('2026-10-17T16:00:00.000Z'), '2026-10-18');
  for (const invalid of ['2026-02-29', '2026-02-30', '2026-13-01', '2026-2-01', 'oops']) assert.equal(dates.validDate(invalid), false);
  assert.throws(() => dates.carouselItems('2026-02-30'));
});

test('four-digit year boundaries keep the center and never expose invalid dates', () => {
  for (const anchor of ['0000-01-01', '9999-12-31']) {
    const days = dates.carouselItems(anchor, {}, '', '9999-12-31');
    assert.equal(days.length, 21); assert.equal(days[10].date, anchor);
    assert.equal(new Set(days.map(item => item.id)).size, 21);
    assert.ok(days.every(item => item.date ? dates.validDate(item.date) : item.disabled));
  }
  run({ properties: { selectedDate: '0000-01-01' } }, ({ component: c, changes }) => {
    c.previous(); centered(c, '0000-01-01'); assert.deepEqual(changes, []);
  });
});

test('today initially centers without an observer event, future taps and next are blocked', () => {
  run({}, ({ component: c, changes, swipe, tick }) => {
    centered(c, '2026-10-18'); assert.equal(c.data.activeDate, '2026-10-18');
    assert.equal(c.data.days[10].week, '今'); assert.equal(c.data.atMax, true);
    c.choose({ currentTarget: { dataset: { date: '2026-10-19' } } });
    c.next(); c.calendar({ detail: { value: '2026-10-19' } }); c.change('2026-02-30');
    swipe(-140); tick(); assert.deepEqual(changes, []); centered(c, '2026-10-18');
  });
});

test('older right-side dates remain tappable, snap and emit once through parent echoes', () => {
  run({ properties: { selectedDate: '2026-10-15' } }, ({ component: c, changes, tick }) => {
    c.choose({ currentTarget: { dataset: { date: '2026-10-17' } } });
    assert.equal(c.data.dragOffset, -140); assert.equal(c.data.snapDuration, 180);
    assert.deepEqual(changes, []);
    tick(); centered(c, '2026-10-17'); assert.deepEqual(changes, ['2026-10-17']);
    c.updateRail(); c.updateRail(); c.change('2026-10-17');
    assert.deepEqual(changes, ['2026-10-17']);
  });
});

test('horizontal swipe moves both directions, clamps to today, and suppresses post-swipe taps', () => {
  run({ properties: { selectedDate: '2026-10-16' } }, ({ component: c, changes, swipe, tick }) => {
    swipe(70); assert.equal(c.data.dragOffset, 70); tick(); centered(c, '2026-10-15');
    c.choose({ currentTarget: { dataset: { date: '2026-10-14' } } });
    assert.deepEqual(changes, ['2026-10-15']);
    swipe(-500); tick(); centered(c, '2026-10-18');
    assert.deepEqual(changes, ['2026-10-15', '2026-10-18']);
    assert.equal(c.data.activeDate, '2026-10-18');
  });
});

test('small, vertical, cancelled and multitouch gestures do not select dates', () => {
  run({}, ({ component: c, changes, swipe, tick }) => {
    swipe(12); tick(); centered(c, '2026-10-18');
    swipe(20, 100); tick(); centered(c, '2026-10-18');
    c.touchStart({ touches: [{ clientX: 175, clientY: 70 }] });
    c.touchMove({ touches: [{ clientX: 245, clientY: 70 }] }); c.touchCancel(); tick();
    centered(c, '2026-10-18');
    c.touchStart({ touches: [{ clientX: 175, clientY: 70 }] });
    c.touchMove({ touches: [{ clientX: 245, clientY: 70 }, { clientX: 250, clientY: 70 }] });
    c.touchEnd({ changedTouches: [{ clientX: 245, clientY: 70 }] }); tick();
    assert.deepEqual(changes, []); centered(c, '2026-10-18');
  });
});

test('long repeated swipes retain a bounded window and can leave the original range', () => {
  run({}, ({ component: c, changes, swipe, tick }) => {
    swipe(5000); tick(); centered(c, '2026-10-10');
    swipe(5000); tick(); centered(c, '2026-10-02');
    swipe(5000); tick(); centered(c, '2026-09-24');
    assert.deepEqual(changes, ['2026-10-10', '2026-10-02', '2026-09-24']);
    assert.equal(c.data.days.length, 21);
  });
});

test('calendar jumps recenter, counts refresh keeps selection, and external props cancel pending snaps', () => {
  run({}, ({ component: c, changes, swipe, tick }) => {
    c.calendar({ detail: { value: '2024-02-29' } }); centered(c, '2024-02-29');
    assert.equal(c.data.monthLabel, '2024 年 2 月');
    c.properties.counts = { '2024-02-29': 5 }; c.updateRail();
    assert.equal(c.data.days[10].hasRecords, true); assert.deepEqual(changes, ['2024-02-29']);
    swipe(70); c.properties.counts['2024-02-28'] = 2; c.updateRail();
    assert.equal(c.data.dragOffset, 70, 'count-only refresh must preserve the snap');
    c.properties.selectedDate = '2026-10-17'; c.updateRail(); tick();
    centered(c, '2026-10-17'); assert.deepEqual(changes, ['2024-02-29']);
    c.today(); centered(c, '2026-10-18');
  });
});

test('allowAll is a separate toggle and failed drags keep all-date mode', () => {
  run({ properties: { allowAll: true } }, ({ component: c, changes, swipe, tick }) => {
    centered(c, '2026-10-18'); assert.equal(c.data.activeDate, '');
    swipe(-70); tick(); swipe(12); tick(); assert.deepEqual(changes, []); assert.equal(c.data.activeDate, '');
    c.toggleAll(); assert.equal(c.data.activeDate, '2026-10-18');
    c.calendar({ detail: { value: '2026-10-16' } }); c.toggleAll();
    centered(c, '2026-10-16'); assert.equal(c.data.activeDate, '');
    c.updateRail(); centered(c, '2026-10-16');
    c.toggleAll(); assert.equal(c.data.activeDate, '2026-10-16');
    assert.deepEqual(changes, ['2026-10-18', '2026-10-16', '', '2026-10-16']);
  });
  run({}, ({ component: c, changes }) => { c.change(''); assert.deepEqual(changes, []); });
});

test('selection recenters locally even before the parent echoes the change', () => {
  run({ echo: false }, ({ component: c, changes, swipe, tick }) => {
    swipe(70); tick(); centered(c, '2026-10-17');
    c.next(); centered(c, '2026-10-18'); assert.deepEqual(changes, ['2026-10-17', '2026-10-18']);
  });
});

test('midnight page-show refreshes today and removes the old today marker', () => {
  run({ now: '2026-10-17T15:59:59.990Z', properties: { selectedDate: '2026-10-17' } }, ({ component: c, changes, tick }) => {
    assert.equal(c.data.days[10].week, '今'); assert.equal(c.data.days[11].disabled, true);
    tick(20); definition.pageLifetimes.show.call(c);
    centered(c, '2026-10-17'); assert.equal(c.data.days[10].week, '六');
    assert.equal(c.data.days[11].week, '今'); assert.equal(c.data.days[11].disabled, false);
    c.next(); centered(c, '2026-10-18'); assert.deepEqual(changes, ['2026-10-18']);
  });
});

test('midnight next and day taps refresh a foreground rail without a page-show event', () => {
  run({ now: '2026-10-17T15:59:59.990Z', properties: { selectedDate: '2026-10-17' } }, ({ component: c, changes, tick }) => {
    tick(20); c.next(); centered(c, '2026-10-18'); assert.deepEqual(changes, ['2026-10-18']);
  });
  run({ now: '2026-10-17T15:59:59.990Z', properties: { selectedDate: '2026-10-17' } }, ({ component: c, changes, tick }) => {
    tick(20); c.choose({ currentTarget: { dataset: { date: '2026-10-18' } } }); tick();
    centered(c, '2026-10-18'); assert.deepEqual(changes, ['2026-10-18']);
  });
});

test('rapid touches during a snap cannot create duplicate changes or enter a future date', () => {
  run({}, ({ component: c, changes, swipe, tick }) => {
    swipe(70); swipe(-210); tick(); centered(c, '2026-10-17');
    assert.deepEqual(changes, ['2026-10-17']);
    c.properties.maxDate = '2026-10-16'; c.updateRail();
    centered(c, '2026-10-16'); assert.deepEqual(changes, ['2026-10-17']);
  });
});

test('midnight gesture refresh, resize and detachment clear pending motion safely', () => {
  run({ now: '2026-10-17T15:59:59.990Z' }, ({ component: c, changes, swipe, tick, timers }) => {
    tick(20); swipe(-70); tick(); centered(c, '2026-10-18'); assert.deepEqual(changes, []);
    swipe(70); definition.pageLifetimes.resize.call(c); tick(); centered(c, '2026-10-18');
    swipe(70); definition.lifetimes.detached.call(c); tick();
    assert.deepEqual(changes, []); assert.equal(timers.size, 0);
  });
});

test('maxDate clamps external dates and applies to taps, arrows, calendar and gestures', () => {
  run({ properties: { selectedDate: '2026-10-19', maxDate: '2026-10-16' } }, ({ component: c, changes, swipe, tick }) => {
    centered(c, '2026-10-16'); assert.equal(c.data.limitDate, '2026-10-16');
    c.next(); c.today(); c.calendar({ detail: { value: '2026-10-17' } }); swipe(-70); tick();
    assert.deepEqual(changes, []); centered(c, '2026-10-16');
    c.previous(); centered(c, '2026-10-15'); c.next(); centered(c, '2026-10-16');
    assert.deepEqual(changes, ['2026-10-15', '2026-10-16']);
  });
});

test('native markup has snapping touch handlers, calendar cap, separate all toggle and size hierarchy', () => {
  const base = path.dirname(componentFile);
  const wxml = fs.readFileSync(path.join(base, 'index.wxml'), 'utf8');
  const css = fs.readFileSync(path.join(base, 'index.wxss'), 'utf8');
  for (const handler of ['touchStart', 'touchMove', 'touchEnd', 'touchCancel']) assert.match(wxml, new RegExp('bindtouch\\w+="' + handler + '"'));
  assert.match(wxml, /<picker mode="date"[^>]*end="\{\{limitDate\}\}"[^>]*bindchange="calendar"/);
  assert.match(wxml, /wx:if="\{\{allowAll\}\}" class="all-toggle/);
  assert.match(wxml, /bindtap="toggleAll"/); assert.doesNotMatch(wxml, /<scroll-view/);
  assert.match(wxml, /translateX\(\{\{dragOffset\}\}px\)/);
  assert.match(css, /\.rail-day\.center\{transform:scale\(1\)/);
  assert.match(css, /\.rail-day\.near\{transform:scale\(\.84\)/);
  assert.match(css, /\.rail-day\.far\{transform:scale\(\.66\)/);
  assert.match(css, /\.rail-day\.selected\{background:#f5f5f6;color:#202226/);
  assert.match(css, /\.selected \.day-number\{color:#202226/);
  assert.doesNotMatch(css, /\.rail-day\.selected\{[^}]*background:#202226/);
  assert.match(css, /\.rail-day\.disabled\{opacity:\.38/);
});
