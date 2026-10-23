const dates = require('../../utils/date-rail');
const domain = require('../../utils/domain');
const SNAP_DURATION = 180;

function touchPoint(event, ended) {
  const points = ended ? event.changedTouches : event.touches;
  const point = points && points[0];
  return point && Number.isFinite(point.clientX) && Number.isFinite(point.clientY) ? point : null;
}

Component({
  properties: {
    selectedDate: { type: String, value: '' },
    counts: { type: Object, value: {} },
    allowAll: { type: Boolean, value: false },
    showToday: { type: Boolean, value: true },
    maxDate: { type: String, value: '' },
  },
  data: {
    days: [], monthLabel: '', anchor: '', activeDate: '', calendarDate: '',
    todayDate: '', limitDate: '', atMax: false, atMin: false,
    dragOffset: 0, snapDuration: 0,
  },
  observers: {
    'selectedDate, counts, maxDate, allowAll': function () { this.updateRail(); },
  },
  lifetimes: {
    attached() { this._detached = false; this.updateRail(); },
    ready() { this.measureRail(); },
    detached() { this._detached = true; this.cancelMotion(); },
  },
  pageLifetimes: {
    show() { this.updateRail(); this.measureRail(); },
    resize() { this.cancelMotion(); this.setData({ dragOffset: 0, snapDuration: 0 }); this.measureRail(); },
  },
  methods: {
    dateLimit(today) {
      const max = this.properties.maxDate;
      return dates.validDate(max) && max < today ? max : today;
    },
    cancelMotion() {
      clearTimeout(this._snapTimer);
      this._snapTimer = null;
      this._gesture = null;
      this._snapTarget = null;
    },
    renderRail(anchor, activeDate) {
      const today = domain.chinaLocalDate();
      const limitDate = this.dateLimit(today);
      this.setData({
        days: dates.carouselItems(anchor, this.properties.counts, limitDate, today),
        anchor, activeDate, calendarDate: anchor, todayDate: today, limitDate,
        monthLabel: anchor.slice(0, 4) + ' 年 ' + Number(anchor.slice(5, 7)) + ' 月',
        atMax: anchor >= limitDate, atMin: anchor === '0000-01-01',
        dragOffset: 0, snapDuration: 0,
      });
    },
    updateRail() {
      if (this._detached) return;
      const today = domain.chinaLocalDate();
      const limit = this.dateLimit(today);
      const selected = this.properties.selectedDate;
      const all = this.properties.allowAll && !selected;
      const remembered = all && !this.data.activeDate && dates.validDate(this.data.anchor) ? this.data.anchor : limit;
      const anchor = dates.validDate(selected) ? (selected > limit ? limit : selected) : (remembered > limit ? limit : remembered);
      const activeDate = all ? '' : anchor;
      // Property echoes and count refreshes must never emit another change.
      // Keep a pending gesture/snap intact when the selected date is unchanged.
      if (anchor === this.data.anchor && activeDate === this.data.activeDate && limit === this.data.limitDate && today === this.data.todayDate) {
        this.setData({ days: dates.carouselItems(anchor, this.properties.counts, limit, today) });
        return;
      }
      this.cancelMotion();
      this.renderRail(anchor, activeDate);
    },
    measureRail() {
      if (this._detached || typeof this.createSelectorQuery !== 'function') return;
      this.createSelectorQuery().select('.rail-viewport').boundingClientRect(rect => {
        if (!this._detached && rect && rect.width > 0) this._slotWidth = rect.width / 5;
      }).exec();
    },
    refreshToday() {
      if (this.data.todayDate !== domain.chinaLocalDate()) this.updateRail();
    },
    choose(e) {
      this.refreshToday();
      if (this._gesture || this._snapTarget || Date.now() < (this._ignoreTapUntil || 0)) return;
      const date = e.currentTarget.dataset.date;
      const day = this.data.days.find(item => item.date === date);
      if (day && !day.disabled) this.snapTo(date);
    },
    toggleAll() { this.refreshToday(); this.change(this.data.activeDate ? '' : this.data.anchor); },
    calendar(e) { this.change(e.detail.value); },
    change(date) {
      const today = domain.chinaLocalDate();
      if (date === '' && this.properties.allowAll) {
        const changed = this.data.activeDate !== '';
        this.cancelMotion();
        this.renderRail(this.data.anchor || this.dateLimit(today), '');
        if (changed) this.triggerEvent('change', { date: '' });
        return;
      }
      if (!dates.validDate(date) || date > this.dateLimit(today)) return;
      const changed = date !== this.data.activeDate;
      this.cancelMotion();
      this.renderRail(date, date);
      if (changed) this.triggerEvent('change', { date });
    },
    previous() { this.refreshToday(); if (!this.data.atMin) this.change(dates.shiftDate(this.data.anchor, -1)); },
    next() { this.refreshToday(); if (!this.data.atMax) this.change(dates.shiftDate(this.data.anchor, 1)); },
    today() { this.change(domain.chinaLocalDate()); },
    snapTo(date) {
      if (this._snapTarget) return;
      const index = this.data.days.findIndex(item => item.date === date && !item.disabled);
      const target = index < 0 ? this.data.anchor : date;
      const offset = index < 0 ? 0 : -(index - 10) * (this._slotWidth || 0);
      if (!this._slotWidth || (offset === 0 && this.data.dragOffset === 0)) { this.change(target); return; }
      this._snapTarget = target;
      this.setData({ dragOffset: offset, snapDuration: SNAP_DURATION });
      this._snapTimer = setTimeout(() => {
        const selected = this._snapTarget;
        this._snapTarget = null;
        this._snapTimer = null;
        if (!this._detached && selected) this.change(selected);
      }, SNAP_DURATION);
    },
    touchStart(e) {
      this.refreshToday();
      this._ignoreTapUntil = 0;
      if (this._snapTarget || !e.touches || e.touches.length !== 1) { this._ignoreTapUntil = Date.now() + 350; return; }
      const point = touchPoint(e);
      if (!point) return;
      this.measureRail();
      this._gesture = { x: point.clientX, y: point.clientY, delta: 0, axis: '' };
      this.setData({ snapDuration: 0 });
    },
    touchMove(e) {
      const gesture = this._gesture;
      if (!gesture) return;
      if (!e.touches || e.touches.length !== 1) { this.touchCancel(); return; }
      const point = touchPoint(e);
      if (!point) return;
      const dx = point.clientX - gesture.x, dy = point.clientY - gesture.y;
      if (!gesture.axis && Math.max(Math.abs(dx), Math.abs(dy)) >= 8) gesture.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (gesture.axis !== 'x') return;
      gesture.delta = dx;
      this._ignoreTapUntil = Date.now() + 350;
      // Eight safe steps each way keep all five visible slots filled.
      const width = this._slotWidth || 0;
      const past = this.data.days.slice(2, 10).filter(item => !item.disabled).length;
      const newer = this.data.days.slice(11, 19).filter(item => !item.disabled).length;
      const offset = Math.max(-newer * width, Math.min(past * width, dx)) || 0;
      this.setData({ dragOffset: offset });
    },
    touchEnd(e) {
      const gesture = this._gesture;
      if (!gesture) return;
      const point = touchPoint(e, true);
      this._gesture = null;
      if (gesture.axis !== 'x') {
        if (gesture.axis === 'y') this._ignoreTapUntil = Date.now() + 350;
        return;
      }
      this._ignoreTapUntil = Date.now() + 350;
      const delta = point ? point.clientX - gesture.x : gesture.delta;
      const width = this._slotWidth;
      if (!width) { this.setData({ dragOffset: 0 }); return; }
      const steps = Math.abs(delta) >= Math.max(18, width * 0.3) ? Math.max(1, Math.round(Math.abs(delta) / width)) : 0;
      const direction = delta < 0 ? 1 : -1;
      let index = 10;
      for (let step = 0; step < Math.min(8, steps); step += 1) {
        const next = this.data.days[index + direction];
        if (!next || next.disabled) break;
        index += direction;
      }
      // An unsuccessful drag in all-date mode must not select today's date.
      if (index === 10) {
        if (this.data.dragOffset) this.snapBack();
        return;
      }
      this.snapTo(this.data.days[index].date);
    },
    snapBack() {
      this._snapTarget = this.data.anchor;
      this.setData({ dragOffset: 0, snapDuration: SNAP_DURATION });
      this._snapTimer = setTimeout(() => {
        this._snapTimer = null;
        this._snapTarget = null;
        if (!this._detached) this.setData({ snapDuration: 0 });
      }, SNAP_DURATION);
    },
    touchCancel() {
      this._gesture = null;
      this._ignoreTapUntil = Date.now() + 350;
      if (this.data.dragOffset) this.snapBack();
    },
  },
});
