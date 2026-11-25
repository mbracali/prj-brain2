// Calendar views: month grid, week/day time grid, agenda list.
import { useEffect, useMemo, useRef, useState } from "react";
import type { CalEvent } from "../lib/calTypes";
import { DAY_MS, type Span, fmt, isLong, layoutDay, overlapsDay, sameDay, startOfDay } from "./dates";
import { type EventDraft, newDraftAt } from "./dialogs";

export interface ViewProps {
  days: Date[];
  spans: Span[];
  cursor: Date;
  onOpen: (ev: CalEvent, at: { x: number; y: number }) => void;
  onCreate: (draft: EventDraft) => void;
  onPickDay: (day: Date) => void;
}

const sortSpans = (a: Span, b: Span) =>
  Number(isLong(b)) - Number(isLong(a)) || a.start.getTime() - b.start.getTime() || b.end.getTime() - a.end.getTime();

function Chip({ s, day, onOpen }: { s: Span; day: Date; onOpen: ViewProps["onOpen"] }) {
  const long = isLong(s);
  const startsHere = sameDay(s.start, day);
  const endsHere = s.end.getTime() <= startOfDay(day).getTime() + DAY_MS;
  return (
    <button
      className={`cal-chip${long ? " long" : ""}${long && !startsHere ? " cont-left" : ""}${long && !endsHere ? " cont-right" : ""}`}
      style={{ "--ev": s.ev.color } as React.CSSProperties}
      title={s.ev.title}
      onClick={(e) => {
        e.stopPropagation();
        onOpen(s.ev, { x: e.clientX + 8, y: e.clientY + 8 });
      }}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {!long && <span className="cal-chip-dot" />}
      {!long && <span className="cal-chip-time">{fmt.time(s.start)}</span>}
      <span className="cal-chip-title">{long && !startsHere ? "↳ " : ""}{s.ev.title || "(no title)"}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------- month
export function MonthView({ days, spans, cursor, onOpen, onCreate, onPickDay }: ViewProps) {
  const today = new Date();
  const grid = useRef<HTMLDivElement>(null);
  const [MAX, setMax] = useState(4);
  // As many chips as fit in a cell (the day number takes ~24px, a chip ~19px).
  useEffect(() => {
    const el = grid.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setMax(Math.max(1, Math.floor((el.clientHeight / 6 - 26) / 19))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div className="cal-month">
      <div className="cal-month-head">
        {days.slice(0, 7).map((d) => <div key={d.getDay()}>{fmt.weekday(d)}</div>)}
      </div>
      <div className="cal-month-grid" ref={grid}>
        {days.map((day) => {
          const items = spans.filter((s) => overlapsDay(s, day)).sort(sortSpans);
          const extra = items.length - MAX;
          return (
            <div
              key={day.getTime()}
              className={`cal-month-cell${day.getMonth() !== cursor.getMonth() ? " other" : ""}${sameDay(day, today) ? " today" : ""}`}
              onDoubleClick={() => onCreate(newDraftAt(day))}
            >
              <button className="cal-daynum" onClick={() => onPickDay(day)}>{day.getDate() === 1 ? day.toLocaleDateString(undefined, { day: "numeric", month: "short" }) : day.getDate()}</button>
              <div className="cal-month-items">
                {items.slice(0, extra > 0 ? MAX - 1 : MAX).map((s) => <Chip key={s.ev.id} s={s} day={day} onOpen={onOpen} />)}
                {extra > 0 && <button className="cal-more" onClick={() => onPickDay(day)}>+{extra + 1} more</button>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------- week / day
const HOUR = 48;

export function TimeGridView({ days, spans, onOpen, onCreate, onPickDay }: ViewProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 7 * HOUR - 8;
  }, []);
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(t);
  }, []);

  const long = useMemo(() => spans.filter(isLong).sort(sortSpans), [spans]);
  const timed = useMemo(() => spans.filter((s) => !isLong(s)), [spans]);
  const cols = `56px repeat(${days.length}, minmax(0, 1fr))`;

  return (
    <div className="cal-timegrid">
      <div className="cal-tg-head" style={{ gridTemplateColumns: cols }}>
        <div />
        {days.map((d) => (
          <button key={d.getTime()} className={`cal-tg-day${sameDay(d, now) ? " today" : ""}`} onClick={() => onPickDay(d)}>
            <span className="wd">{fmt.weekday(d)}</span>
            <span className="dn">{d.getDate()}</span>
          </button>
        ))}
      </div>
      <div className="cal-tg-allday" style={{ gridTemplateColumns: cols }}>
        <div className="cal-tg-label">all-day</div>
        {days.map((d) => (
          <div key={d.getTime()} className="cal-tg-allday-cell" onDoubleClick={() => onCreate(newDraftAt(d))}>
            {long.filter((s) => overlapsDay(s, d)).map((s) => <Chip key={s.ev.id} s={s} day={d} onOpen={onOpen} />)}
          </div>
        ))}
      </div>
      <div className="cal-tg-scroll" ref={scroller}>
        <div className="cal-tg-body" style={{ gridTemplateColumns: cols, height: 24 * HOUR }}>
          <div className="cal-tg-hours">
            {Array.from({ length: 24 }, (_, h) => (
              <div key={h} className="cal-tg-hour" style={{ top: h * HOUR }}>{h ? fmt.hour(h) : ""}</div>
            ))}
          </div>
          {days.map((d) => {
            const mine = timed.filter((s) => overlapsDay(s, d));
            const layout = layoutDay(mine);
            const d0 = startOfDay(d).getTime();
            return (
              <div
                key={d.getTime()}
                className="cal-tg-col"
                onDoubleClick={(e) => {
                  const y = e.clientY - e.currentTarget.getBoundingClientRect().top;
                  onCreate(newDraftAt(d, Math.max(0, Math.min(23.5, Math.floor((y / HOUR) * 2) / 2))));
                }}
              >
                {mine.map((s) => {
                  const { col, cols: n } = layout.get(s)!;
                  const top = ((Math.max(s.start.getTime(), d0) - d0) / 3600000) * HOUR;
                  const bottom = ((Math.min(s.end.getTime(), d0 + DAY_MS) - d0) / 3600000) * HOUR;
                  const h = Math.max(18, bottom - top - 2);
                  return (
                    <button
                      key={s.ev.id}
                      className={`cal-tg-event${h < 36 ? " short" : ""}`}
                      style={{ top, height: h, left: `calc(${(col / n) * 100}% + 2px)`, width: `calc(${100 / n}% - 4px)`, "--ev": s.ev.color } as React.CSSProperties}
                      title={s.ev.title}
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpen(s.ev, { x: e.clientX + 8, y: e.clientY + 8 });
                      }}
                      onDoubleClick={(e) => e.stopPropagation()}
                    >
                      <span className="cal-tg-title">{s.ev.title || "(no title)"}</span>
                      <span className="cal-tg-time">{fmt.time(s.start)} – {fmt.time(s.end)}</span>
                      {s.ev.location && h >= 60 && <span className="cal-tg-loc">{s.ev.location}</span>}
                    </button>
                  );
                })}
                {sameDay(d, now) && (
                  <div className="cal-now" style={{ top: ((now.getTime() - d0) / 3600000) * HOUR }}><span /></div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------- agenda
export function AgendaView({ days, spans, onOpen, onPickDay }: ViewProps) {
  const today = new Date();
  const groups = days
    .map((d) => ({ day: d, items: spans.filter((s) => overlapsDay(s, d)).sort(sortSpans) }))
    .filter((g) => g.items.length);
  if (!groups.length) return <div className="empty cal-agenda-empty">Nothing scheduled in the next {days.length} days.</div>;
  return (
    <div className="cal-agenda">
      {groups.map(({ day, items }) => (
        <section key={day.getTime()} className={`cal-agenda-day${sameDay(day, today) ? " today" : ""}`}>
          <button className="cal-agenda-date" onClick={() => onPickDay(day)}>
            <span className="dn">{day.getDate()}</span>
            <span className="md">{day.toLocaleDateString(undefined, { month: "short", weekday: "short" })}</span>
          </button>
          <div className="cal-agenda-items">
            {items.map((s) => (
              <button key={s.ev.id} className="cal-agenda-item" onClick={(e) => onOpen(s.ev, { x: e.clientX + 8, y: e.clientY + 8 })}>
                <span className="event-dot" style={{ background: s.ev.color }} />
                <span className="cal-agenda-time">
                  {isLong(s) ? "All day" : `${fmt.time(s.start)} – ${fmt.time(s.end)}`}
                </span>
                <span className="cal-agenda-title">{s.ev.title || "(no title)"}</span>
                {s.ev.location && <span className="muted small cal-agenda-loc">{s.ev.location}</span>}
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export const AGENDA_DAYS = 60;
