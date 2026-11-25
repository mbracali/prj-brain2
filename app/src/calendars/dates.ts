// Date helpers for the calendar views (local time, weeks start on Monday).
import type { CalEvent } from "../lib/calTypes";

export const DAY_MS = 86400000;

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
export function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes());
}
export function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}
export function startOfWeek(d: Date): Date {
  const s = startOfDay(d);
  return addDays(s, -((s.getDay() + 6) % 7));
}
export function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
export function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
/** YYYY-MM-DD in local time. */
export function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
export function hm(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
/** Parses an event boundary: date-only strings are local midnight. */
export function parseWhen(s: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(s);
}
/** ISO string with the local timezone offset. */
export function isoLocal(d: Date): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const a = Math.abs(off);
  return `${ymd(d)}T${hm(d)}:00${sign}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}

export interface Span {
  ev: CalEvent;
  start: Date;
  end: Date;
}
export function span(ev: CalEvent): Span {
  const start = parseWhen(ev.start);
  let end = parseWhen(ev.end);
  if (!(end > start)) end = new Date(start.getTime() + (ev.all_day ? DAY_MS : 30 * 60000));
  return { ev, start, end };
}
/** All-day or crossing midnight: shown in the all-day lane. */
export function isLong(s: Span): boolean {
  return s.ev.all_day || !sameDay(s.start, new Date(s.end.getTime() - 1));
}
export function overlapsDay(s: Span, day: Date): boolean {
  const d0 = startOfDay(day).getTime();
  return s.start.getTime() < d0 + DAY_MS && s.end.getTime() > d0;
}

const loc = undefined;
export const fmt = {
  monthYear: (d: Date) => d.toLocaleDateString(loc, { month: "long", year: "numeric" }),
  dayLong: (d: Date) => d.toLocaleDateString(loc, { weekday: "long", day: "numeric", month: "long", year: "numeric" }),
  dayShort: (d: Date) => d.toLocaleDateString(loc, { weekday: "short", day: "numeric", month: "short" }),
  weekday: (d: Date) => d.toLocaleDateString(loc, { weekday: "short" }),
  weekdayNarrow: (d: Date) => d.toLocaleDateString(loc, { weekday: "narrow" }),
  time: (d: Date) => d.toLocaleTimeString(loc, { hour: "numeric", minute: "2-digit" }),
  hour: (h: number) => new Date(2000, 0, 1, h).toLocaleTimeString(loc, { hour: "numeric" }),
};

export function eventTimeLabel(s: Span): string {
  if (s.ev.all_day) {
    const last = addDays(s.end, -1);
    return sameDay(s.start, last) ? `${fmt.dayShort(s.start)} · all day` : `${fmt.dayShort(s.start)} – ${fmt.dayShort(last)} · all day`;
  }
  if (sameDay(s.start, s.end)) return `${fmt.dayShort(s.start)} · ${fmt.time(s.start)} – ${fmt.time(s.end)}`;
  return `${fmt.dayShort(s.start)} ${fmt.time(s.start)} – ${fmt.dayShort(s.end)} ${fmt.time(s.end)}`;
}

/** Side-by-side layout for overlapping timed events of one day: column index and column count. */
export function layoutDay(items: Span[]): Map<Span, { col: number; cols: number }> {
  const sorted = [...items].sort((a, b) => a.start.getTime() - b.start.getTime() || b.end.getTime() - a.end.getTime());
  const out = new Map<Span, { col: number; cols: number }>();
  let cluster: Span[] = [];
  let clusterEnd = 0;
  let colsEnd: number[] = [];
  const flush = () => {
    const n = colsEnd.length;
    cluster.forEach((s) => (out.get(s)!.cols = n));
    cluster = [];
    colsEnd = [];
  };
  for (const s of sorted) {
    if (cluster.length && s.start.getTime() >= clusterEnd) flush();
    let col = colsEnd.findIndex((e) => e <= s.start.getTime());
    if (col === -1) {
      col = colsEnd.length;
      colsEnd.push(0);
    }
    colsEnd[col] = s.end.getTime();
    out.set(s, { col, cols: 1 });
    cluster.push(s);
    clusterEnd = Math.max(clusterEnd, s.end.getTime());
  }
  flush();
  return out;
}
