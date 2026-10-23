// Yiwu records use China time; timestamps remain UTC in storage.
export function chinaDate(value: string): string { return new Date(Date.parse(value) + 8 * 60 * 60 * 1000).toISOString().slice(0, 10); }
export function chinaDayBounds(date: string): [string, string] {
  const start = Date.parse(date + 'T00:00:00+08:00');
  return [new Date(start).toISOString(), new Date(start + 86400000).toISOString()];
}
