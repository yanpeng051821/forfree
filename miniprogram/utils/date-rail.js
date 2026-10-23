const { chinaLocalDate } = require('./domain');
const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
function validDate(value) { return /^\d{4}-\d{2}-\d{2}$/.test(value || '') && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value; }
function shiftDate(value, offset) {
  if (!validDate(value)) throw new Error('日期无效');
  return new Date(Date.parse(value + 'T00:00:00Z') + offset * 86400000).toISOString().slice(0, 10);
}
function dateItems(anchor, counts = {}, maxDate = '', today = chinaLocalDate()) {
  let end = shiftDate(anchor, 7);
  if (maxDate && end > maxDate) end = maxDate;
  return Array.from({ length: 21 }, (_, index) => {
    const date = shiftDate(end, index - 20), day = new Date(date + 'T00:00:00Z');
    return { date, id: 'day-' + date, day: day.getUTCDate(), week: date === today ? '今' : weekdays[day.getUTCDay()], hasRecords: (counts[date] || 0) > 0 };
  });
}
// Keep dateItems' historical, max-date-truncated window for existing callers.
// The carousel keeps its anchor in slot 10, including disabled future slots.
function carouselItems(anchor, counts = {}, maxDate = '', today = chinaLocalDate()) {
  if (!validDate(anchor) || !validDate(today)) throw new Error('日期无效');
  const limit = validDate(maxDate) && maxDate < today ? maxDate : today;
  const start = Date.parse(anchor + 'T00:00:00Z');
  const first = Date.parse('0000-01-01T00:00:00Z');
  const last = Date.parse('9999-12-31T00:00:00Z');
  return Array.from({ length: 21 }, (_, index) => {
    const offset = index - 10;
    const timestamp = start + offset * 86400000;
    if (timestamp < first || timestamp > last) {
      return { id: 'day-boundary-' + index, date: '', day: '', week: '', disabled: true, distance: Math.abs(offset), hasRecords: false };
    }
    const value = new Date(timestamp);
    const date = value.toISOString().slice(0, 10);
    return { date, id: 'day-' + date, day: value.getUTCDate(), week: date === today ? '今' : weekdays[value.getUTCDay()], hasRecords: ((counts || {})[date] || 0) > 0, disabled: date > limit, distance: Math.abs(offset) };
  });
}
module.exports = { validDate, shiftDate, dateItems, carouselItems };
