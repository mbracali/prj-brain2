// Calendars module: calendar list + mini month on the left, month/week/day/agenda views on the right.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon, UserIcon } from "../components/Icon";
import { Modal } from "../components/Modal";
import { pickIcon } from "../components/IconPicker";
import { Spinner } from "../components/Spinner";
import { calendarApi } from "../lib/api";
import type { CalEvent, Calendar } from "../lib/calTypes";
import { type MenuItem, confirmDialog, lastMenuPos, promptDialog, reportError, useApp } from "../store";
import { addDays, addMonths, fmt, isoLocal, sameDay, span, startOfDay, startOfMonth, startOfWeek } from "./dates";
import { ConnectSourcesDialog, EventDialog, type EventDraft, EventPopover, draftFromEvent, newDraftAt } from "./dialogs";
import { CALENDAR_COLORS, type CalView, useCalendars } from "./store";
import { AGENDA_DAYS, AgendaView, MonthView, TimeGridView } from "./views";

function visibleDays(view: CalView, cursor: Date): Date[] {
  if (view === "day") return [startOfDay(cursor)];
  if (view === "week") {
    const s = startOfWeek(cursor);
    return Array.from({ length: 7 }, (_, i) => addDays(s, i));
  }
  if (view === "agenda") {
    const s = startOfDay(cursor);
    return Array.from({ length: AGENDA_DAYS }, (_, i) => addDays(s, i));
  }
  const s = startOfWeek(startOfMonth(cursor));
  return Array.from({ length: 42 }, (_, i) => addDays(s, i));
}

function title(view: CalView, cursor: Date, days: Date[]): string {
  if (view === "month") return fmt.monthYear(cursor);
  if (view === "day") return fmt.dayLong(cursor);
  const a = days[0];
  const b = days[days.length - 1];
  if (a.getMonth() === b.getMonth()) return fmt.monthYear(a);
  return `${a.toLocaleDateString(undefined, { month: "short" })} – ${b.toLocaleDateString(undefined, { month: "short", year: "numeric" })}`;
}

function step(view: CalView, cursor: Date, dir: number): Date {
  if (view === "month") return addMonths(cursor, dir);
  if (view === "week") return addDays(cursor, 7 * dir);
  if (view === "agenda") return addDays(cursor, 30 * dir);
  return addDays(cursor, dir);
}

// ---------------------------------------------------------------------------- calendar actions
async function createCalendar(open = false) {
  const name = await promptDialog("New calendar", { label: "Name", okLabel: "Create" });
  if (!name?.trim()) return;
  try {
    const used = new Set(useCalendars.getState().calendars.map((c) => c.color));
    const color = CALENDAR_COLORS.find((c) => !used.has(c)) ?? CALENDAR_COLORS[0];
    const created = await calendarApi.create({ name: name.trim(), color });
    await useCalendars.getState().load();
    if (open) useApp.getState().navigate({ module: "calendar", calendarId: created.id });
  } catch (e) {
    reportError(e);
  }
}

async function patchCalendar(c: Calendar, body: Parameters<typeof calendarApi.update>[1]) {
  try {
    await calendarApi.update(c.id, body);
    await useCalendars.getState().load();
    useCalendars.getState().bump();
  } catch (e) {
    reportError(e);
  }
}

async function syncCalendars(id?: string) {
  try {
    const r = await calendarApi.sync(id);
    if (r.errors.length) useApp.getState().toast(r.errors.join("\n"), "error");
    else useApp.getState().toast(r.synced ? `Synced ${r.synced} calendar${r.synced === 1 ? "" : "s"}` : "Nothing to sync — connect an account to a calendar first");
  } catch (e) {
    reportError(e);
  } finally {
    await useCalendars.getState().load().catch(() => undefined);
    useCalendars.getState().bump();
  }
}

function ColorPalette({ value, onPick }: { value: string; onPick: (c: string) => void }) {
  return (
    <div className="cal-palette">
      {CALENDAR_COLORS.map((c) => (
        <button key={c} className={`cal-swatch${c === value ? " active" : ""}`} style={{ background: c }} title={c} onClick={() => onPick(c)} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------- mini month
function MiniMonth({ cursor, onPick }: { cursor: Date; onPick: (d: Date) => void }) {
  const [month, setMonth] = useState(startOfMonth(cursor));
  useEffect(() => setMonth(startOfMonth(cursor)), [cursor]);
  const days = visibleDays("month", month);
  const today = new Date();
  return (
    <div className="mini-month">
      <div className="mini-month-head">
        <span>{fmt.monthYear(month)}</span>
        <button className="icon-button" onClick={() => setMonth(addMonths(month, -1))}><Icon name="chevron_left" size={18} /></button>
        <button className="icon-button" onClick={() => setMonth(addMonths(month, 1))}><Icon name="chevron_right" size={18} /></button>
      </div>
      <div className="mini-month-grid">
        {days.slice(0, 7).map((d) => <span key={`h${d.getDay()}`} className="mini-wd">{fmt.weekdayNarrow(d)}</span>)}
        {days.map((d) => (
          <button
            key={d.getTime()}
            className={`mini-day${d.getMonth() !== month.getMonth() ? " other" : ""}${sameDay(d, today) ? " today" : ""}${sameDay(d, cursor) ? " selected" : ""}`}
            onClick={() => onPick(d)}
          >
            {d.getDate()}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------- home (list of calendars)
function sourcesLabel(c: Calendar): string {
  const accounts = new Set(c.sources.map((s) => s.account_id)).size;
  if (!c.sources.length) return "Local events only";
  return `${c.sources.length} connected calendar${c.sources.length === 1 ? "" : "s"} · ${accounts} account${accounts === 1 ? "" : "s"}`;
}

export function CalendarsHome() {
  const { calendars, loaded } = useCalendars();
  const navigate = useApp((s) => s.navigate);
  const showMenu = useApp((s) => s.showMenu);
  const [sourcesFor, setSourcesFor] = useState<string | null>(null);
  useEffect(() => {
    useCalendars.getState().load().catch(reportError);
  }, []);
  if (!loaded) return <div className="page center"><Spinner /></div>;
  if (!calendars.length) return <FirstCalendar />;
  const menu = (c: Calendar): MenuItem[] => [
    { label: "Open", icon: "open_in_browser", action: () => navigate({ module: "calendar", calendarId: c.id }) },
    { label: "Connected accounts…", icon: "manage_accounts", action: () => setSourcesFor(c.id) },
    { label: "Sync now", icon: "sync", disabled: !c.sources.length, action: () => syncCalendars(c.id) },
    { label: "Rename…", icon: "edit", action: async () => {
      const name = await promptDialog("Rename calendar", { value: c.name, okLabel: "Rename" });
      if (name?.trim()) patchCalendar(c, { name: name.trim() });
    } },
    { label: "Change icon…", icon: "mood", action: async () => {
      const icon = await pickIcon(lastMenuPos, c.icon ?? "");
      if (icon !== null) patchCalendar(c, { icon });
    } },
    { separator: true },
    { label: "Delete calendar", icon: "delete", danger: true, action: () => deleteCalendar(c) },
  ];
  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-head">
          <h1 className="page-title">Calendars</h1>
          <div className="row">
            <button className="btn" onClick={() => navigate({ module: "calendar", calendarId: ALL })}>
              <Icon name="stacks" size={18} /> All calendars together
            </button>
            <button className="btn btn-primary" onClick={() => createCalendar(true)}>
              <Icon name="add" size={18} /> New calendar
            </button>
          </div>
        </div>
        <div className="card-grid">
          {calendars.map((c) => (
            <button
              key={c.id}
              className="card cal-card"
              style={{ "--cal": c.color } as React.CSSProperties}
              onClick={() => navigate({ module: "calendar", calendarId: c.id })}
              onContextMenu={(e) => (e.preventDefault(), showMenu(e, menu(c)))}
            >
              <UserIcon value={c.icon ?? ""} fallback="calendar_month" size={26} />
              <strong>{c.name}</strong>
              <span className="muted small">{sourcesLabel(c)}</span>
              {c.sources.some((s) => s.error) && <span className="danger-text tiny">A connected account needs attention</span>}
              <span
                role="button"
                className="icon-button card-sync"
                title="Calendar options"
                onClick={(e) => (e.stopPropagation(), showMenu(e, menu(c)))}
              >
                <Icon name="more_horiz" size={18} />
              </span>
            </button>
          ))}
        </div>
        <button className="link-button small cal-accounts-link" onClick={() => useApp.getState().openSettings("connectors")}>
          <Icon name="add_link" size={16} /> Account connectors…
        </button>
      </div>
      {sourcesFor && <ConnectSourcesDialog calendarId={sourcesFor} onClose={() => setSourcesFor(null)} />}
    </div>
  );
}

function FirstCalendar() {
  return (
    <div className="page center">
      <div className="hero">
        <Icon name="calendar_month" size={56} />
        <h2>Create your first calendar</h2>
        <p className="muted">
          A calendar can hold its own events and show events from your Google, Microsoft and Apple accounts — as many accounts as
          you like, side by side.
        </p>
        <button className="btn btn-primary btn-large" onClick={() => createCalendar(true)}>
          <Icon name="add" size={20} /> New calendar
        </button>
      </div>
    </div>
  );
}

async function deleteCalendar(c: Calendar) {
  const ok = await confirmDialog("Delete calendar", `Delete “${c.name}” and its local events? Connected accounts are not affected.`, { okLabel: "Delete", danger: true });
  if (!ok) return;
  try {
    await calendarApi.remove(c.id);
    await useCalendars.getState().load();
    useCalendars.getState().bump();
    const route = useApp.getState().route;
    if (route.module === "calendar" && route.calendarId === c.id) useApp.getState().navigate({ module: "calendars" });
  } catch (e) {
    reportError(e);
  }
}

// ---------------------------------------------------------------------------- one calendar (or all together)
export const ALL = "all";

export function CalendarPage({ calendarId }: { calendarId: string }) {
  const { calendars, loaded, view, cursor, version } = useCalendars();
  const showMenu = useApp((s) => s.showMenu);
  const navigate = useApp((s) => s.navigate);
  const all = calendarId === ALL;
  const current = calendars.find((c) => c.id === calendarId) ?? null;
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [popover, setPopover] = useState<{ ev: CalEvent; at: { x: number; y: number } } | null>(null);
  const [draft, setDraft] = useState<EventDraft | null>(null);
  const [sourcesFor, setSourcesFor] = useState<string | null>(null);
  const [colorFor, setColorFor] = useState<Calendar | null>(null);

  useEffect(() => {
    useCalendars.getState().load().catch(reportError);
  }, []);

  const days = useMemo(() => visibleDays(view, cursor), [view, cursor]);
  const visibleIds = useMemo(
    () => (all ? calendars.filter((c) => c.visible).map((c) => c.id) : calendars.some((c) => c.id === calendarId) ? [calendarId] : []),
    [calendars, all, calendarId],
  );
  const rangeKey = `${days[0].getTime()}-${days.length}-${visibleIds.join(",")}-${version}`;

  useEffect(() => {
    if (!loaded) return;
    if (!visibleIds.length) {
      setEvents([]);
      return;
    }
    let alive = true;
    setLoading(true);
    calendarApi
      .events(isoLocal(days[0]), isoLocal(addDays(days[days.length - 1], 1)), visibleIds)
      .then((evs) => alive && setEvents(evs))
      .catch((e) => alive && reportError(e))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeKey, loaded]);

  const spans = useMemo(() => events.map(span), [events]);
  const setCursor = useCalendars.getState().setCursor;
  const setView = useCalendars.getState().setView;
  const pickDay = useCallback((d: Date) => {
    setCursor(d);
    setView("day");
  }, [setCursor, setView]);
  const open = useCallback((ev: CalEvent, at: { x: number; y: number }) => setPopover({ ev, at }), []);
  const create = useCallback((d: EventDraft) => {
    if (!useCalendars.getState().calendars.length) return;
    setDraft(all ? d : { ...d, calendarId });
  }, [all, calendarId]);

  const calendarMenu = (c: Calendar): MenuItem[] => [
    { label: "Rename…", icon: "edit", action: async () => {
      const name = await promptDialog("Rename calendar", { value: c.name, okLabel: "Rename" });
      if (name?.trim()) patchCalendar(c, { name: name.trim() });
    } },
    { label: "Change color…", icon: "palette", action: () => setColorFor(c) },
    { label: "Change icon…", icon: "mood", action: async () => {
      const icon = await pickIcon(lastMenuPos, c.icon ?? "");
      if (icon !== null) patchCalendar(c, { icon });
    } },
    { label: "Connected accounts…", icon: "manage_accounts", action: () => setSourcesFor(c.id) },
    { label: "Sync now", icon: "sync", disabled: !c.sources.length, action: () => syncCalendars(c.id) },
    { label: "Show only this calendar", icon: "visibility", action: async () => {
      for (const o of calendars) if (o.visible !== (o.id === c.id)) await calendarApi.update(o.id, { visible: o.id === c.id }).catch(reportError);
      await useCalendars.getState().load();
    } },
    { separator: true },
    { label: "Delete calendar", icon: "delete", danger: true, action: () => deleteCalendar(c) },
  ];

  if (!loaded) return <div className="page center"><Spinner /></div>;
  if (!calendars.length) return <FirstCalendar />;
  if (!all && !current) {
    return (
      <div className="page center">
        <div className="hero">
          <Icon name="event_busy" size={56} />
          <h2>Calendar not found</h2>
          <button className="btn" onClick={() => navigate({ module: "calendars" })}>
            <Icon name="arrow_back" size={18} /> All calendars
          </button>
        </div>
      </div>
    );
  }

  const today = new Date();
  const props = { days, spans, cursor, onOpen: open, onCreate: create, onPickDay: pickDay };

  return (
    <div className="page cal-page">
      <aside className="cal-side">
        <button className="cal-back" onClick={() => navigate({ module: "calendars" })} title="Back to the list of calendars">
          <Icon name="arrow_back" size={18} /> Calendars
        </button>
        <div className="cal-side-title">
          {all ? <Icon name="stacks" size={20} /> : <UserIcon value={current!.icon ?? ""} fallback="calendar_month" size={20} />}
          <strong>{all ? "All calendars" : current!.name}</strong>
          {!all && (
            <button className="icon-button" title="Calendar options" onClick={(e) => showMenu(e, calendarMenu(current!))}>
              <Icon name="more_horiz" size={17} />
            </button>
          )}
        </div>
        <button className="btn btn-primary cal-new" onClick={() => create(newDraftAt(cursor, sameDay(cursor, today) ? Math.min(23, today.getHours() + 1) : 9))}>
          <Icon name="add" size={18} /> New event
        </button>
        <MiniMonth cursor={cursor} onPick={(d) => setCursor(d)} />
        {all ? (
          <>
        <div className="cal-list-head">
          <span>Calendars</span>
          <button className="icon-button" title="New calendar" onClick={() => createCalendar()}><Icon name="add" size={18} /></button>
        </div>
        <div className="cal-list">
          {calendars.map((c) => (
            <div
              key={c.id}
              className="cal-list-item"
              onContextMenu={(e) => (e.preventDefault(), showMenu(e, calendarMenu(c)))}
            >
              <label className="cal-check" style={{ "--cal": c.color } as React.CSSProperties}>
                <input type="checkbox" checked={c.visible} onChange={(e) => patchCalendar(c, { visible: e.target.checked })} />
                <span className="cal-check-box" />
              </label>
              {c.icon ? <UserIcon value={c.icon} fallback="calendar_month" size={16} /> : null}
              <button className="cal-list-name" title={`Open ${c.name}`} onClick={() => navigate({ module: "calendar", calendarId: c.id })}>{c.name}</button>
              {c.sources.length > 0 && (
                <span className="cal-list-sources" title={c.sources.map((s) => `${s.remote_name} (${s.account_label})`).join("\n")}>
                  <Icon name={c.sources.some((s) => s.error) ? "cloud_off" : "cloud_sync"} size={15} />
                </span>
              )}
              <button className="icon-button cal-list-more" title="Calendar options" onClick={(e) => showMenu(e, calendarMenu(c))}>
                <Icon name="more_horiz" size={17} />
              </button>
            </div>
          ))}
        </div>
          </>
        ) : (
          current && <CalendarSourcesList calendar={current} onManage={() => setSourcesFor(current.id)} />
        )}
        <button className="link-button small cal-accounts-link" onClick={() => useApp.getState().openSettings("connectors")}>
          <Icon name="add_link" size={16} /> Account connectors…
        </button>
      </aside>

      <section className="cal-main">
        <header className="cal-toolbar">
          <button className="btn btn-small" onClick={() => setCursor(new Date())}>Today</button>
          <button className="icon-button" title="Previous" onClick={() => setCursor(step(view, cursor, -1))}><Icon name="chevron_left" size={20} /></button>
          <button className="icon-button" title="Next" onClick={() => setCursor(step(view, cursor, 1))}><Icon name="chevron_right" size={20} /></button>
          <h1 className="cal-title">{title(view, cursor, days)}</h1>
          {loading && <span className="cal-loading"><Icon name="progress_activity" size={16} className="spin" /></span>}
          <span className="spacer" />
          <div className="segmented small cal-views">
            {(["month", "week", "day", "agenda"] as const).map((v) => (
              <button key={v} className={view === v ? "active" : ""} onClick={() => setView(v)}>{v[0].toUpperCase() + v.slice(1)}</button>
            ))}
          </div>
          <button
            className="btn btn-small"
            disabled={syncing}
            title="Fetch events from the connected accounts"
            onClick={async () => {
              setSyncing(true);
              await syncCalendars(all ? undefined : calendarId);
              setSyncing(false);
            }}
          >
            <Icon name="sync" size={16} className={syncing ? "spin" : ""} /> Sync
          </button>
        </header>
        <div className="cal-body">
          {view === "month" && <MonthView {...props} />}
          {(view === "week" || view === "day") && <TimeGridView key={view} {...props} />}
          {view === "agenda" && <AgendaView {...props} />}
        </div>
      </section>

      {popover && (
        <EventPopover
          ev={popover.ev}
          at={popover.at}
          onClose={() => setPopover(null)}
          onEdit={(ev) => {
            setPopover(null);
            setDraft(draftFromEvent(ev));
          }}
        />
      )}
      {draft && <EventDialog draft={draft} onClose={() => setDraft(null)} />}
      {sourcesFor && <ConnectSourcesDialog calendarId={sourcesFor} onClose={() => setSourcesFor(null)} />}
      {colorFor && (
        <Modal title={<><Icon name="palette" size={20} /> Color of “{colorFor.name}”</>} onClose={() => setColorFor(null)} className="cal-color-modal">
          <ColorPalette
            value={colorFor.color}
            onPick={(color) => {
              patchCalendar(colorFor, { color });
              setColorFor(null);
            }}
          />
        </Modal>
      )}
    </div>
  );
}

/** Left column of a single calendar: its local events plus every connected remote calendar, each can be toggled. */
function CalendarSourcesList({ calendar, onManage }: { calendar: Calendar; onManage: () => void }) {
  const toggle = async (sourceId: string, enabled: boolean) => {
    try {
      await calendarApi.updateSource(calendar.id, sourceId, { enabled });
      await useCalendars.getState().load();
      useCalendars.getState().bump();
    } catch (e) {
      reportError(e);
    }
  };
  return (
    <>
      <div className="cal-list-head">
        <span>Accounts</span>
        <button className="icon-button" title="Connect accounts to this calendar" onClick={onManage}><Icon name="add" size={18} /></button>
      </div>
      <div className="cal-list">
        <div className="cal-list-item">
          <span className="cal-dot" style={{ background: calendar.color }} />
          <span className="cal-list-name">Local events</span>
        </div>
        {calendar.sources.map((s) => (
          <div key={s.id} className="cal-list-item" title={s.error ?? `${s.remote_name} — ${s.account_label}`}>
            <label className="cal-check" style={{ "--cal": s.color ?? calendar.color } as React.CSSProperties}>
              <input type="checkbox" checked={s.enabled} onChange={(e) => toggle(s.id, e.target.checked)} />
              <span className="cal-check-box" />
            </label>
            <span className="cal-list-name">
              {s.remote_name}
              <span className="muted tiny cal-list-sub">{s.account_label}</span>
            </span>
            {s.error && <Icon name="cloud_off" size={15} className="danger-text" />}
          </div>
        ))}
        {!calendar.sources.length && (
          <button className="link-button small" onClick={onManage}>
            <Icon name="add_link" size={16} /> Connect a Google, Microsoft or iCloud calendar
          </button>
        )}
      </div>
    </>
  );
}
