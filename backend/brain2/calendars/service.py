"""Calendars: BRAIN2 calendars aggregate remote calendars from any number of accounts, plus local events.

Remote events are cached in SQLite (window: 90 days back, 1 year ahead) and refreshed by a background
sync every 15 minutes or on demand. Local events (source_id NULL) are editable.
"""

from __future__ import annotations

import threading
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable

import httpx

from ..accounts import providers as P
from ..accounts.service import AccountService
from ..db import Database

SCHEMA = """
CREATE TABLE IF NOT EXISTS calendars (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  color       TEXT NOT NULL,
  icon        TEXT,
  visible     INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS calendar_sources (
  id          TEXT PRIMARY KEY,
  calendar_id TEXT NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  remote_id   TEXT NOT NULL,
  remote_name TEXT NOT NULL,
  color       TEXT,
  enabled     INTEGER NOT NULL DEFAULT 1,
  last_sync   TEXT,
  error       TEXT,
  UNIQUE (calendar_id, account_id, remote_id)
);
CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,
  calendar_id TEXT NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
  source_id   TEXT REFERENCES calendar_sources(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  start       TEXT NOT NULL,     -- ISO UTC "…Z", or YYYY-MM-DD for all-day
  end         TEXT NOT NULL,     -- exclusive
  start_key   TEXT NOT NULL,     -- sortable UTC instant used for range queries
  end_key     TEXT NOT NULL,
  all_day     INTEGER NOT NULL DEFAULT 0,
  location    TEXT,
  description TEXT,
  url         TEXT,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_range ON events(calendar_id, start_key, end_key);
"""

PALETTE = ["#4f8ff7", "#30a46c", "#e5484d", "#f5a524", "#8e4ec6", "#00a2c7", "#d6409f", "#978365"]
SYNC_BACK = timedelta(days=90)
SYNC_AHEAD = timedelta(days=365)
SYNC_EVERY = 15 * 60


class CalendarError(Exception):
    status = 400


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def instant_key(value: str, all_day: bool) -> str:
    """Comparable UTC key. All-day dates are treated as local midnight."""
    if all_day:
        d = date.fromisoformat(value[:10])
        local = datetime(d.year, d.month, d.day).astimezone()
        return P.iso_utc(local)
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.astimezone()
    return P.iso_utc(dt)


class CalendarService:
    def __init__(self, db: Database, accounts: AccountService, publish: Callable[[dict], None] | None = None):
        self.db = db
        self.accounts = accounts
        self.publish = publish or (lambda ev: None)
        self._sync_lock = threading.Lock()
        self._stop = threading.Event()
        with db._lock:  # noqa: SLF001
            db._conn.executescript(SCHEMA)  # noqa: SLF001

    # ---------------------------------------------------------------- calendars
    def _cal(self, cid: str) -> dict[str, Any]:
        row = self.db.one("SELECT * FROM calendars WHERE id = ?", (cid,))
        if not row:
            err = CalendarError("Calendar not found")
            err.status = 404
            raise err
        return dict(row)

    def _sources(self, cid: str | None = None) -> list[dict[str, Any]]:
        sql = ("SELECT s.*, a.provider, a.nickname AS account_label FROM calendar_sources s "
               "JOIN accounts a ON a.id = s.account_id")
        rows = self.db.query(sql + (" WHERE s.calendar_id = ?" if cid else "") + " ORDER BY s.remote_name",
                             (cid,) if cid else ())
        out = []
        for r in rows:
            d = dict(r)
            d["enabled"] = bool(d["enabled"])
            out.append(d)
        return out

    def _cal_dict(self, row: dict) -> dict[str, Any]:
        d = dict(row)
        d["visible"] = bool(d["visible"])
        d["sources"] = self._sources(d["id"])
        syncs = [s["last_sync"] for s in d["sources"] if s["last_sync"]]
        d["last_sync"] = max(syncs) if syncs else None
        d.pop("created_at", None)
        return d

    def list(self) -> list[dict[str, Any]]:
        return [self._cal_dict(dict(r)) for r in self.db.query("SELECT * FROM calendars ORDER BY sort_order, name COLLATE NOCASE")]

    def get(self, cid: str) -> dict[str, Any]:
        return self._cal_dict(self._cal(cid))

    def create(self, name: str, color: str | None = None, icon: str | None = None) -> dict[str, Any]:
        name = (name or "").strip()
        if not name:
            raise CalendarError("Give the calendar a name")
        count = (self.db.one("SELECT COUNT(*) AS n FROM calendars") or {"n": 0})["n"]
        cid = uuid.uuid4().hex[:12]
        self.db.execute("INSERT INTO calendars(id, name, color, icon, sort_order, created_at) VALUES (?,?,?,?,?,?)",
                        (cid, name, color or PALETTE[count % len(PALETTE)], icon, count, now_iso()))
        self.publish({"type": "calendars.changed"})
        return self.get(cid)

    def update(self, cid: str, **fields: Any) -> dict[str, Any]:
        self._cal(cid)
        sets, params = [], []
        for key in ("name", "color", "icon", "visible", "sort_order"):
            if fields.get(key) is None:
                continue
            v = fields[key]
            if key == "name" and not str(v).strip():
                continue
            sets.append(f"{key} = ?")
            params.append(int(v) if key == "visible" else (v.strip() if isinstance(v, str) else v))
        if sets:
            self.db.execute(f"UPDATE calendars SET {', '.join(sets)} WHERE id = ?", (*params, cid))
            self.publish({"type": "calendars.changed"})
            if "color" in fields or "visible" in fields:
                self.publish({"type": "events.changed"})
        return self.get(cid)

    def delete(self, cid: str) -> None:
        self._cal(cid)
        self.db.execute("DELETE FROM calendars WHERE id = ?", (cid,))
        self.publish({"type": "calendars.changed"})
        self.publish({"type": "events.changed"})

    # ---------------------------------------------------------------- sources
    def add_source(self, cid: str, account_id: str, remote_id: str, remote_name: str, color: str | None = None) -> dict[str, Any]:
        self._cal(cid)
        acc = self.accounts.get(account_id)
        if acc["kind"] != "account":
            raise CalendarError("Only calendar accounts can be added to a calendar")
        existing = self.db.one("SELECT id FROM calendar_sources WHERE calendar_id=? AND account_id=? AND remote_id=?",
                               (cid, account_id, remote_id))
        sid = existing["id"] if existing else uuid.uuid4().hex[:12]
        if not existing:
            self.db.execute("INSERT INTO calendar_sources(id, calendar_id, account_id, remote_id, remote_name, color) VALUES (?,?,?,?,?,?)",
                            (sid, cid, account_id, remote_id, remote_name.strip() or remote_id, color))
        self.publish({"type": "calendars.changed"})
        threading.Thread(target=self._sync_sources, args=([sid],), daemon=True).start()
        return self._source(sid)

    def _source(self, sid: str) -> dict[str, Any]:
        for s in self._sources():
            if s["id"] == sid:
                return s
        err = CalendarError("Source not found")
        err.status = 404
        raise err

    def update_source(self, cid: str, sid: str, enabled: bool | None = None, color: str | None = None) -> dict[str, Any]:
        src = self._source(sid)
        if src["calendar_id"] != cid:
            raise CalendarError("Source not in this calendar")
        if enabled is not None:
            self.db.execute("UPDATE calendar_sources SET enabled = ? WHERE id = ?", (int(enabled), sid))
        if color is not None:
            self.db.execute("UPDATE calendar_sources SET color = ? WHERE id = ?", (color or None, sid))
        self.publish({"type": "calendars.changed"})
        self.publish({"type": "events.changed"})
        return self._source(sid)

    def remove_source(self, cid: str, sid: str) -> None:
        src = self._source(sid)
        if src["calendar_id"] != cid:
            raise CalendarError("Source not in this calendar")
        self.db.execute("DELETE FROM calendar_sources WHERE id = ?", (sid,))
        self.publish({"type": "calendars.changed"})
        self.publish({"type": "events.changed"})

    # ---------------------------------------------------------------- sync
    def sync(self, cid: str | None = None) -> dict[str, Any]:
        sources = [s["id"] for s in self._sources(cid) if s["enabled"]]
        return self._sync_sources(sources)

    def _sync_sources(self, ids: list[str]) -> dict[str, Any]:
        errors: list[str] = []
        synced = 0
        with self._sync_lock:
            start = datetime.now(timezone.utc) - SYNC_BACK
            end = datetime.now(timezone.utc) + SYNC_AHEAD
            with self.accounts.http() as client:
                for sid in ids:
                    try:
                        src = self._source(sid)
                    except CalendarError:
                        continue
                    try:
                        events = self.fetch(src, start, end, client)
                        self._store(src, events)
                        self.db.execute("UPDATE calendar_sources SET last_sync = ?, error = NULL WHERE id = ?", (now_iso(), sid))
                        self.accounts.set_status(src["account_id"], None)
                        synced += 1
                    except (P.ProviderError, httpx.HTTPError, ValueError) as e:
                        msg = str(e) or type(e).__name__
                        errors.append(f"{src['remote_name']}: {msg}")
                        self.db.execute("UPDATE calendar_sources SET error = ? WHERE id = ?", (msg, sid))
                        self.accounts.set_status(src["account_id"], msg)
        if ids:
            self.publish({"type": "calendars.changed"})
            self.publish({"type": "events.changed"})
            self.publish({"type": "accounts.changed"})
        return {"synced": synced, "errors": errors}

    def fetch(self, src: dict, start: datetime, end: datetime, client: httpx.Client) -> list[dict]:
        provider = src["provider"]
        if provider == "google":
            return P.google_events(self.accounts.access_token(src["account_id"], client), src["remote_id"], start, end, client)
        if provider == "microsoft":
            return P.ms_events(self.accounts.access_token(src["account_id"], client), src["remote_id"], start, end, client)
        if provider == "apple":
            auth, _cfg = self.accounts.caldav_auth(src["account_id"])
            return P.caldav_events(client, src["remote_id"], start, end, auth)
        raise P.ProviderError(f"Unsupported provider: {provider}")

    def _store(self, src: dict, events: list[dict]) -> None:
        ts = now_iso()
        with self.db.tx() as c:
            c.execute("DELETE FROM events WHERE source_id = ?", (src["id"],))
            seen: set[str] = set()
            for e in events:
                eid = f"{src['id']}:{e['uid']}"
                if eid in seen:
                    continue
                seen.add(eid)
                c.execute(
                    "INSERT INTO events(id, calendar_id, source_id, title, start, end, start_key, end_key, all_day, location,"
                    " description, url, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (eid, src["calendar_id"], src["id"], e["title"], e["start"], e["end"],
                     instant_key(e["start"], e["all_day"]), instant_key(e["end"], e["all_day"]), int(e["all_day"]),
                     e.get("location"), e.get("description"), e.get("url"), ts),
                )

    def start_background_sync(self) -> None:
        def loop() -> None:
            if self._stop.wait(5):
                return
            while not self._stop.is_set():
                try:
                    self.sync()
                except Exception:  # noqa: BLE001 - keep the loop alive
                    pass
                if self._stop.wait(SYNC_EVERY):
                    return

        threading.Thread(target=loop, name="calendar-sync", daemon=True).start()

    def stop(self) -> None:
        self._stop.set()

    # ---------------------------------------------------------------- events
    def events(self, start: str, end: str, calendars: list[str] | None = None) -> list[dict[str, Any]]:
        s_key, e_key = instant_key(start, len(start) == 10), instant_key(end, len(end) == 10)
        cals = {c["id"]: c for c in self.list()}
        srcs = {s["id"]: s for c in cals.values() for s in c["sources"]}
        ids = [c for c in (calendars or list(cals)) if c in cals]
        if not ids:
            return []
        marks = ",".join("?" * len(ids))
        rows = self.db.query(
            f"SELECT * FROM events WHERE calendar_id IN ({marks}) AND start_key < ? AND end_key > ? ORDER BY start_key",
            (*ids, e_key, s_key),
        )
        out = []
        for r in rows:
            src = srcs.get(r["source_id"]) if r["source_id"] else None
            if src and not src["enabled"]:
                continue
            out.append(self._event(dict(r), cals[r["calendar_id"]], src))
        return out

    @staticmethod
    def _event(r: dict, cal: dict, src: dict | None) -> dict[str, Any]:
        return {
            "id": r["id"], "calendar_id": r["calendar_id"], "source_id": r["source_id"], "title": r["title"],
            "start": r["start"], "end": r["end"], "all_day": bool(r["all_day"]), "location": r["location"],
            "description": r["description"], "url": r["url"],
            "color": (src or {}).get("color") or cal["color"], "editable": src is None,
            "provider": (src or {}).get("provider"),
        }

    def _normalize(self, data: dict[str, Any]) -> dict[str, Any]:
        title = (data.get("title") or "").strip() or "(no title)"
        all_day = bool(data.get("all_day"))
        start, end = str(data.get("start") or ""), str(data.get("end") or "")
        try:
            if all_day:
                s, e = date.fromisoformat(start[:10]), date.fromisoformat((end or start)[:10])
                if e <= s:
                    e = s + timedelta(days=1)
                start, end = s.isoformat(), e.isoformat()
            else:
                s_dt = datetime.fromisoformat(start.replace("Z", "+00:00"))
                e_dt = datetime.fromisoformat((end or start).replace("Z", "+00:00"))
                s_dt = s_dt if s_dt.tzinfo else s_dt.astimezone()
                e_dt = e_dt if e_dt.tzinfo else e_dt.astimezone()
                if e_dt <= s_dt:
                    e_dt = s_dt + timedelta(hours=1)
                start, end = P.iso_utc(s_dt), P.iso_utc(e_dt)
        except ValueError as exc:
            raise CalendarError("Invalid date or time") from exc
        return {"title": title, "all_day": all_day, "start": start, "end": end,
                "location": (data.get("location") or None), "description": (data.get("description") or None)}

    def create_event(self, cid: str, data: dict[str, Any]) -> dict[str, Any]:
        cal = self._cal(cid)
        e = self._normalize(data)
        eid = "local:" + uuid.uuid4().hex[:16]
        self.db.execute(
            "INSERT INTO events(id, calendar_id, source_id, title, start, end, start_key, end_key, all_day, location, description, url, updated_at)"
            " VALUES (?,?,NULL,?,?,?,?,?,?,?,?,NULL,?)",
            (eid, cid, e["title"], e["start"], e["end"], instant_key(e["start"], e["all_day"]),
             instant_key(e["end"], e["all_day"]), int(e["all_day"]), e["location"], e["description"], now_iso()),
        )
        self.publish({"type": "events.changed"})
        return self._event(dict(self.db.one("SELECT * FROM events WHERE id = ?", (eid,))), self._cal_dict(cal), None)

    def _local(self, eid: str) -> dict[str, Any]:
        row = self.db.one("SELECT * FROM events WHERE id = ?", (eid,))
        if not row:
            err = CalendarError("Event not found")
            err.status = 404
            raise err
        if row["source_id"]:
            raise CalendarError("Events from connected accounts are read-only in BRAIN2 for now — edit them in the provider")
        return dict(row)

    def update_event(self, eid: str, data: dict[str, Any]) -> dict[str, Any]:
        row = self._local(eid)
        merged = {**{k: row[k] for k in ("title", "start", "end", "location", "description")}, "all_day": bool(row["all_day"]),
                  **{k: v for k, v in data.items() if v is not None}}
        target = data.get("calendar_id") or row["calendar_id"]
        cal = self._cal(target)
        e = self._normalize(merged)
        self.db.execute(
            "UPDATE events SET calendar_id=?, title=?, start=?, end=?, start_key=?, end_key=?, all_day=?, location=?, description=?, updated_at=? WHERE id=?",
            (target, e["title"], e["start"], e["end"], instant_key(e["start"], e["all_day"]), instant_key(e["end"], e["all_day"]),
             int(e["all_day"]), e["location"], e["description"], now_iso(), eid),
        )
        self.publish({"type": "events.changed"})
        return self._event(dict(self.db.one("SELECT * FROM events WHERE id = ?", (eid,))), self._cal_dict(cal), None)

    def delete_event(self, eid: str) -> None:
        self._local(eid)
        self.db.execute("DELETE FROM events WHERE id = ?", (eid,))
        self.publish({"type": "events.changed"})
