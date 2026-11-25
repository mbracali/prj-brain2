// Calendar dialogs: event editor, event popover, connected accounts of a calendar.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { Modal } from "../components/Modal";
import { Spinner } from "../components/Spinner";
import { accountsApi, calendarApi } from "../lib/api";
import { bridge } from "../lib/bridge";
import type { Account, CalEvent, Calendar, RemoteCalendar } from "../lib/calTypes";
import { confirmDialog, reportError, useApp } from "../store";
import { addDays, eventTimeLabel, hm, isoLocal, parseWhen, span, ymd } from "./dates";
import { useCalendars } from "./store";

export const PROVIDER_ICON: Record<string, string> = { google: "mail", microsoft: "window", apple: "phone_iphone" };
export const PROVIDER_NAME: Record<string, string> = { google: "Google", microsoft: "Microsoft", apple: "Apple" };

// ---------------------------------------------------------------------------- event editor
export interface EventDraft {
  event?: CalEvent; // editing an existing event
  start: Date;
  end: Date;
  allDay: boolean;
  calendarId?: string;
}

export function EventDialog({ draft, onClose }: { draft: EventDraft; onClose: () => void }) {
  const calendars = useCalendars((s) => s.calendars);
  const ev = draft.event;
  const [title, setTitle] = useState(ev?.title ?? "");
  const [calendarId, setCalendarId] = useState(draft.calendarId ?? ev?.calendar_id ?? calendars.find((c) => c.visible)?.id ?? calendars[0]?.id ?? "");
  const [allDay, setAllDay] = useState(draft.allDay);
  const [startDate, setStartDate] = useState(ymd(draft.start));
  const [startTime, setStartTime] = useState(hm(draft.start));
  // All-day ends are exclusive in the API; the form shows the last day.
  const [endDate, setEndDate] = useState(ymd(draft.allDay ? addDays(draft.end, -1) : draft.end));
  const [endTime, setEndTime] = useState(hm(draft.end));
  const [location, setLocation] = useState(ev?.location ?? "");
  const [description, setDescription] = useState(ev?.description ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setError(null);
    if (!title.trim()) return setError("Give the event a title.");
    if (!calendarId) return setError("Create a calendar first.");
    const [sy, sm, sd] = startDate.split("-").map(Number);
    const [ey, em, ed] = endDate.split("-").map(Number);
    let start: string, end: string;
    if (allDay) {
      start = startDate;
      end = ymd(addDays(new Date(ey, em - 1, ed), 1));
      if (end <= start) return setError("The end date must be on or after the start date.");
    } else {
      const [sh, smin] = startTime.split(":").map(Number);
      const [eh, emin] = endTime.split(":").map(Number);
      const s = new Date(sy, sm - 1, sd, sh, smin);
      const e = new Date(ey, em - 1, ed, eh, emin);
      if (!(e > s)) return setError("The end must be after the start.");
      start = isoLocal(s);
      end = isoLocal(e);
    }
    const body = { title: title.trim(), start, end, all_day: allDay, location: location.trim() || null, description: description.trim() || null };
    setBusy(true);
    try {
      if (ev) await calendarApi.updateEvent(ev.id, body);
      else await calendarApi.createEvent(calendarId, body);
      useCalendars.getState().bump();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={<><Icon name={ev ? "edit_calendar" : "event"} size={20} /> {ev ? "Edit event" : "New event"}</>}
      onClose={onClose}
      className="modal-medium event-dialog"
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy} onClick={save}>{ev ? "Save" : "Create event"}</button>
        </>
      }
    >
      <input className="input event-title-input" autoFocus placeholder="Event title" value={title}
        onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()} />
      <label className="field-label">Calendar</label>
      <select className="select" value={calendarId} disabled={!!ev} onChange={(e) => setCalendarId(e.target.value)}>
        {calendars.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      <label className="check event-allday"><input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} /> All day</label>
      <div className="event-when">
        <div>
          <label className="field-label">Starts</label>
          <div className="row">
            <input className="input" type="date" value={startDate} onChange={(e) => {
              setStartDate(e.target.value);
              if (e.target.value > endDate) setEndDate(e.target.value);
            }} />
            {!allDay && <input className="input" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />}
          </div>
        </div>
        <div>
          <label className="field-label">Ends</label>
          <div className="row">
            <input className="input" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            {!allDay && <input className="input" type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />}
          </div>
        </div>
      </div>
      <label className="field-label">Location</label>
      <input className="input" value={location} placeholder="Optional" onChange={(e) => setLocation(e.target.value)} />
      <label className="field-label">Description</label>
      <textarea className="input event-desc" rows={4} value={description} placeholder="Optional" onChange={(e) => setDescription(e.target.value)} />
      {error && <div className="form-warning"><Icon name="warning" size={18} /><div>{error}</div></div>}
    </Modal>
  );
}

// ---------------------------------------------------------------------------- popover
function Linkified({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s<>"')]+)/g);
  return (
    <>
      {parts.map((p, i) =>
        /^https?:\/\//.test(p) ? (
          <a key={i} href={p} onClick={(e) => (e.preventDefault(), bridge.openExternal(p))}>{p}</a>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

export function EventPopover({ ev, at, onClose, onEdit }: {
  ev: CalEvent;
  at: { x: number; y: number };
  onClose: () => void;
  onEdit: (ev: CalEvent) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(at);
  const calendar = useCalendars((s) => s.calendars.find((c) => c.id === ev.calendar_id));
  const s = span(ev);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ x: Math.max(8, Math.min(at.x, innerWidth - r.width - 8)), y: Math.max(8, Math.min(at.y, innerHeight - r.height - 8)) });
  }, [at]);
  useEffect(() => {
    const down = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    setTimeout(() => window.addEventListener("mousedown", down), 0);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", down);
      window.removeEventListener("keydown", key);
    };
  }, [onClose]);

  const remove = async () => {
    if (!(await confirmDialog("Delete event", `Delete “${ev.title}”?`, { okLabel: "Delete", danger: true }))) return;
    try {
      await calendarApi.deleteEvent(ev.id);
      useCalendars.getState().bump();
      onClose();
    } catch (e) {
      reportError(e);
    }
  };

  return (
    <div className="event-popover" ref={ref} style={{ left: pos.x, top: pos.y }} role="dialog">
      <div className="event-popover-head">
        <span className="event-dot" style={{ background: ev.color }} />
        <strong className="event-popover-title">{ev.title || "(no title)"}</strong>
        {ev.editable && (
          <>
            <button className="icon-button" title="Edit" onClick={() => onEdit(ev)}><Icon name="edit" size={18} /></button>
            <button className="icon-button" title="Delete" onClick={remove}><Icon name="delete" size={18} /></button>
          </>
        )}
        <button className="icon-button" title="Close" onClick={onClose}><Icon name="close" size={18} /></button>
      </div>
      <div className="event-popover-row"><Icon name="schedule" size={17} /> {eventTimeLabel(s)}</div>
      {calendar && <div className="event-popover-row"><Icon name="calendar_month" size={17} /> {calendar.name}</div>}
      {ev.provider && (
        <div className="event-popover-row">
          <Icon name={PROVIDER_ICON[ev.provider] ?? "cloud"} size={17} />
          <span className="kind-badge">{PROVIDER_NAME[ev.provider] ?? ev.provider}</span>
          {!ev.editable && <span className="muted tiny">read-only</span>}
        </div>
      )}
      {ev.location && <div className="event-popover-row"><Icon name="location_on" size={17} /> <span><Linkified text={ev.location} /></span></div>}
      {ev.url && (
        <div className="event-popover-row"><Icon name="link" size={17} /> <a href={ev.url} onClick={(e) => (e.preventDefault(), bridge.openExternal(ev.url!))}>Open in {PROVIDER_NAME[ev.provider ?? ""] ?? "browser"}</a></div>
      )}
      {ev.description && <div className="event-popover-desc"><Linkified text={ev.description} /></div>}
    </div>
  );
}

// ---------------------------------------------------------------------------- connected accounts
function AccountCalendars({ account, calendar }: { account: Account; calendar: Calendar }) {
  const [remote, setRemote] = useState<RemoteCalendar[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    accountsApi.remoteCalendars(account.id).then(setRemote).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [account.id]);
  const linked = (rid: string) => calendar.sources.find((s) => s.account_id === account.id && s.remote_id === rid);

  const toggle = async (rc: RemoteCalendar) => {
    setBusy(rc.id);
    try {
      const src = linked(rc.id);
      if (src) await calendarApi.removeSource(calendar.id, src.id);
      else await calendarApi.addSource(calendar.id, { account_id: account.id, remote_id: rc.id, remote_name: rc.name, color: rc.color });
      await useCalendars.getState().load();
      useCalendars.getState().bump();
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="account-block">
      <div className="account-block-head">
        <Icon name={PROVIDER_ICON[account.provider] ?? "account_circle"} size={18} />
        <strong>{account.nickname}</strong>
        {account.email && <span className="muted small">{account.email}</span>}
        <span className="kind-badge">{PROVIDER_NAME[account.provider] ?? account.provider}</span>
      </div>
      {error && <div className="muted small danger-text">{error}</div>}
      {!remote && !error && <Spinner delay={150} />}
      {remote && !remote.length && <div className="muted small">No calendars in this account.</div>}
      {remote?.map((rc) => (
        <label key={rc.id} className="remote-cal">
          <input type="checkbox" checked={!!linked(rc.id)} disabled={busy === rc.id} onChange={() => toggle(rc)} />
          <span className="event-dot" style={{ background: rc.color ?? "var(--text-faint)" }} />
          <span className="remote-cal-name">{rc.name}</span>
          {rc.primary && <span className="kind-badge">primary</span>}
          {rc.read_only && <span className="muted tiny">read-only</span>}
        </label>
      ))}
    </div>
  );
}

export function ConnectSourcesDialog({ calendarId, onClose }: { calendarId: string; onClose: () => void }) {
  const calendar = useCalendars((s) => s.calendars.find((c) => c.id === calendarId));
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  useEffect(() => {
    accountsApi
      .connectors()
      .then((c) => setAccounts(c.accounts.filter((a) => a.kind === "account")))
      .catch((e) => {
        reportError(e);
        setAccounts([]);
      });
  }, []);
  if (!calendar) return null;

  const update = async (sourceId: string, body: { enabled?: boolean }) => {
    try {
      await calendarApi.updateSource(calendar.id, sourceId, body);
      await useCalendars.getState().load();
      useCalendars.getState().bump();
    } catch (e) {
      reportError(e);
    }
  };
  const remove = async (sourceId: string) => {
    try {
      await calendarApi.removeSource(calendar.id, sourceId);
      await useCalendars.getState().load();
      useCalendars.getState().bump();
    } catch (e) {
      reportError(e);
    }
  };

  return (
    <Modal
      title={<><Icon name="manage_accounts" size={20} /> Accounts of “{calendar.name}”</>}
      onClose={onClose}
      className="modal-medium sources-dialog"
      footer={<button className="btn btn-primary" onClick={onClose}>Done</button>}
    >
      <p className="muted small">
        A BRAIN2 calendar shows its own events plus the remote calendars you pick below, from as many accounts as you like.
      </p>
      <div className="panel-section-title">Connected calendars <span className="count">{calendar.sources.length}</span></div>
      {!calendar.sources.length && <div className="muted small source-empty">Only local events so far.</div>}
      {calendar.sources.map((s) => (
        <div key={s.id} className="source-row">
          <Icon name={PROVIDER_ICON[s.provider] ?? "cloud"} size={18} />
          <span className="event-dot" style={{ background: s.color ?? calendar.color }} />
          <div className="source-text">
            <span>{s.remote_name}</span>
            <span className="muted tiny">
              {s.account_label}
              {s.error ? <span className="danger-text"> · {s.error}</span> : s.last_sync ? ` · synced ${new Date(s.last_sync).toLocaleString()}` : ""}
            </span>
          </div>
          <label className="check" title="Show events from this calendar">
            <input type="checkbox" checked={s.enabled} onChange={(e) => update(s.id, { enabled: e.target.checked })} /> Enabled
          </label>
          <button className="icon-button" title="Disconnect" onClick={() => remove(s.id)}><Icon name="link_off" size={18} /></button>
        </div>
      ))}
      <div className="panel-section-title">Add from your accounts</div>
      {!accounts && <Spinner delay={150} />}
      {accounts && !accounts.length && (
        <div className="empty small">
          No calendar accounts connected yet.
          <button className="btn" onClick={() => (onClose(), useApp.getState().openSettings("connectors"))}>
            <Icon name="add_link" size={18} /> Connect an account…
          </button>
        </div>
      )}
      {accounts?.map((a) => <AccountCalendars key={a.id} account={a} calendar={calendar} />)}
      {accounts && accounts.length > 0 && (
        <button className="link-button small" onClick={() => (onClose(), useApp.getState().openSettings("connectors"))}>
          <Icon name="add_link" size={16} /> Connect another account…
        </button>
      )}
    </Modal>
  );
}

export function newDraftAt(day: Date, hour?: number): EventDraft {
  if (hour === undefined) {
    const s = new Date(day.getFullYear(), day.getMonth(), day.getDate());
    return { start: s, end: addDays(s, 1), allDay: true };
  }
  const s = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(hour), (hour % 1) * 60);
  return { start: s, end: new Date(s.getTime() + 3600000), allDay: false };
}

export function draftFromEvent(ev: CalEvent): EventDraft {
  return { event: ev, start: parseWhen(ev.start), end: parseWhen(ev.end), allDay: ev.all_day, calendarId: ev.calendar_id };
}
