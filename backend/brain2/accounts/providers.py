"""Calendar providers: Google (OAuth + Calendar API), Microsoft (OAuth + Graph), Apple iCloud (CalDAV).

Every provider exposes the same two calls:

    list_calendars(creds)                      -> [RemoteCalendar dict]
    fetch_events(creds, remote_id, start, end) -> [event dict]

Event dicts: uid, title, start, end (ISO; dates for all-day), all_day, location, description, url.
"""

from __future__ import annotations

import base64
import hashlib
import secrets as pysecrets
import time
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlencode, urljoin

import httpx

TIMEOUT = httpx.Timeout(30.0, connect=10.0)


class ProviderError(Exception):
    status = 400


# --------------------------------------------------------------------------- registry
PROVIDERS: list[dict[str, Any]] = [
    {
        "id": "google", "kind": "account", "name": "Google", "icon": "mail", "connect": "oauth", "needs_setup": True,
        "usable": True, "config_fields": ["client_id", "client_secret"],
        "help": (
            "BRAIN2 is free and has no company servers, so you use your own (free) Google OAuth app: "
            "Google Cloud Console → APIs & Services → enable “Google Calendar API” → Credentials → Create credentials → "
            "OAuth client ID → Application type “Desktop app”. Paste its Client ID and Client secret here. "
            "On the OAuth consent screen add yourself as a test user."
        ),
    },
    {
        "id": "microsoft", "kind": "account", "name": "Microsoft", "icon": "window", "connect": "oauth",
        "needs_setup": True, "usable": True, "config_fields": ["client_id", "tenant"],
        "help": (
            "Use your own (free) app registration: Azure portal → Microsoft Entra ID → App registrations → New "
            "registration → “Accounts in any organizational directory and personal Microsoft accounts” → Redirect URI: "
            "platform “Public client/native (mobile & desktop)”, value http://localhost. Paste the Application (client) "
            "ID here. Tenant can stay “common”."
        ),
    },
    {
        "id": "apple", "kind": "account", "name": "Apple iCloud", "icon": "cloud", "connect": "password",
        "needs_setup": False, "usable": True, "config_fields": [],
        "help": (
            "Apple has no calendar API for apps; BRAIN2 uses CalDAV. Create an app-specific password at "
            "account.apple.com → Sign-In and Security → App-Specific Passwords, then connect with your Apple ID "
            "email and that password. Your real Apple ID password is never needed."
        ),
    },
    {"id": "openai", "kind": "llm", "name": "ChatGPT (OpenAI)", "icon": "smart_toy", "connect": "apikey",
     "needs_setup": False, "usable": False, "config_fields": [], "help": "API key from platform.openai.com."},
    {"id": "anthropic", "kind": "llm", "name": "Claude (Anthropic)", "icon": "smart_toy", "connect": "apikey",
     "needs_setup": False, "usable": False, "config_fields": [], "help": "API key from console.anthropic.com."},
    {"id": "deepseek", "kind": "llm", "name": "DeepSeek", "icon": "smart_toy", "connect": "apikey",
     "needs_setup": False, "usable": False, "config_fields": [], "help": "API key from platform.deepseek.com."},
    {"id": "claude-code", "kind": "llm", "name": "Claude Code (CLI)", "icon": "terminal", "connect": "cli",
     "needs_setup": False, "usable": False, "config_fields": [], "cli": "claude",
     "help": "Uses the `claude` command already installed and signed in on this machine."},
    {"id": "codex", "kind": "llm", "name": "Codex (CLI)", "icon": "terminal", "connect": "cli",
     "needs_setup": False, "usable": False, "config_fields": [], "cli": "codex",
     "help": "Uses the `codex` command already installed and signed in on this machine."},
    {"id": "slack", "kind": "chat", "name": "Slack", "icon": "forum", "connect": "token",
     "needs_setup": False, "usable": False, "config_fields": [],
     "help": "A Slack user or bot token (xoxp-… / xoxb-…) from your own Slack app."},
]
BY_ID = {p["id"]: p for p in PROVIDERS}


# --------------------------------------------------------------------------- OAuth
OAUTH = {
    "google": {
        "auth": "https://accounts.google.com/o/oauth2/v2/auth",
        "token": "https://oauth2.googleapis.com/token",
        "scope": "openid email https://www.googleapis.com/auth/calendar.readonly",
        "redirect_host": "127.0.0.1",
    },
    "microsoft": {
        "auth": "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize",
        "token": "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token",
        "scope": "offline_access openid email User.Read Calendars.Read",
        "redirect_host": "localhost",
    },
}


def pkce_pair() -> tuple[str, str]:
    verifier = pysecrets.token_urlsafe(64)[:96]
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    return verifier, challenge


def auth_url(provider: str, config: dict[str, str], redirect_uri: str, state: str, challenge: str) -> str:
    o = OAUTH[provider]
    tenant = config.get("tenant") or "common"
    params = {
        "client_id": config["client_id"],
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": o["scope"],
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }
    if provider == "google":
        params.update({"access_type": "offline", "prompt": "consent select_account", "include_granted_scopes": "true"})
    else:
        params["prompt"] = "select_account"
    return o["auth"].format(tenant=tenant) + "?" + urlencode(params)


def _token_request(provider: str, config: dict[str, str], data: dict[str, str], client: httpx.Client | None = None) -> dict:
    o = OAUTH[provider]
    data = {"client_id": config["client_id"], **data}
    if provider == "google" and config.get("client_secret"):
        data["client_secret"] = config["client_secret"]
    if provider == "microsoft":
        data["scope"] = o["scope"]
    c = client or httpx.Client(timeout=TIMEOUT)
    r = c.post(o["token"].format(tenant=config.get("tenant") or "common"), data=data)
    body = _json(r)
    if r.status_code >= 400:
        raise ProviderError(body.get("error_description") or body.get("error") or f"Token request failed ({r.status_code})")
    tokens = {
        "access_token": body["access_token"],
        "refresh_token": body.get("refresh_token") or data.get("refresh_token"),
        "expires_at": time.time() + int(body.get("expires_in", 3600)) - 60,
    }
    return tokens


def exchange_code(provider: str, config: dict[str, str], code: str, verifier: str, redirect_uri: str,
                  client: httpx.Client | None = None) -> dict:
    return _token_request(provider, config, {"grant_type": "authorization_code", "code": code,
                                             "code_verifier": verifier, "redirect_uri": redirect_uri}, client)


def refresh(provider: str, config: dict[str, str], tokens: dict, client: httpx.Client | None = None) -> dict:
    if not tokens.get("refresh_token"):
        raise ProviderError("The sign-in expired — reconnect this account")
    return _token_request(provider, config, {"grant_type": "refresh_token", "refresh_token": tokens["refresh_token"]}, client)


def _json(r: httpx.Response) -> dict:
    try:
        return r.json()
    except ValueError:
        return {}


def profile_email(provider: str, access_token: str, client: httpx.Client | None = None) -> str | None:
    c = client or httpx.Client(timeout=TIMEOUT)
    h = {"Authorization": f"Bearer {access_token}"}
    if provider == "google":
        r = c.get("https://openidconnect.googleapis.com/v1/userinfo", headers=h)
        return _json(r).get("email")
    r = c.get("https://graph.microsoft.com/v1.0/me", headers=h)
    b = _json(r)
    return b.get("mail") or b.get("userPrincipalName")


# --------------------------------------------------------------------------- helpers
def iso_utc(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _raise_for(r: httpx.Response, what: str) -> None:
    if r.status_code == 401:
        raise ProviderError(f"{what}: not authorized — reconnect the account")
    if r.status_code >= 400:
        b = _json(r)
        msg = (b.get("error") or {}).get("message") if isinstance(b.get("error"), dict) else b.get("error")
        raise ProviderError(f"{what} failed ({r.status_code}){': ' + msg if msg else ''}")


# --------------------------------------------------------------------------- Google
def google_calendars(token: str, client: httpx.Client) -> list[dict]:
    out, page = [], None
    while True:
        r = client.get("https://www.googleapis.com/calendar/v3/users/me/calendarList",
                       headers={"Authorization": f"Bearer {token}"},
                       params={"maxResults": 250, **({"pageToken": page} if page else {})})
        _raise_for(r, "Google calendar list")
        b = r.json()
        for c in b.get("items", []):
            out.append({"id": c["id"], "name": c.get("summaryOverride") or c.get("summary") or c["id"],
                        "color": c.get("backgroundColor"), "primary": bool(c.get("primary")),
                        "read_only": c.get("accessRole") not in ("owner", "writer")})
        page = b.get("nextPageToken")
        if not page:
            return out


def google_events(token: str, cal_id: str, start: datetime, end: datetime, client: httpx.Client) -> list[dict]:
    out, page = [], None
    while True:
        params = {"timeMin": iso_utc(start), "timeMax": iso_utc(end), "singleEvents": "true", "orderBy": "startTime",
                  "maxResults": 2500, "showDeleted": "false"}
        if page:
            params["pageToken"] = page
        r = client.get(f"https://www.googleapis.com/calendar/v3/calendars/{_q(cal_id)}/events",
                       headers={"Authorization": f"Bearer {token}"}, params=params)
        _raise_for(r, "Google events")
        b = r.json()
        for e in b.get("items", []):
            if e.get("status") == "cancelled":
                continue
            s, en = e.get("start", {}), e.get("end", {})
            all_day = "date" in s
            out.append({
                "uid": e["id"], "title": e.get("summary") or "(no title)",
                "start": s.get("date") if all_day else iso_utc(datetime.fromisoformat(s["dateTime"])),
                "end": en.get("date") if all_day else iso_utc(datetime.fromisoformat(en["dateTime"])),
                "all_day": all_day, "location": e.get("location"), "description": e.get("description"),
                "url": e.get("htmlLink"),
            })
        page = b.get("nextPageToken")
        if not page:
            return out


def _q(s: str) -> str:
    from urllib.parse import quote

    return quote(s, safe="")


# --------------------------------------------------------------------------- Microsoft
def ms_calendars(token: str, client: httpx.Client) -> list[dict]:
    out, url = [], "https://graph.microsoft.com/v1.0/me/calendars?$top=100"
    while url:
        r = client.get(url, headers={"Authorization": f"Bearer {token}"})
        _raise_for(r, "Microsoft calendar list")
        b = r.json()
        for c in b.get("value", []):
            color = c.get("hexColor") or None
            out.append({"id": c["id"], "name": c.get("name") or "Calendar", "color": color,
                        "primary": bool(c.get("isDefaultCalendar")), "read_only": not c.get("canEdit", False)})
        url = b.get("@odata.nextLink")
    return out


def _ms_time(v: dict) -> datetime:
    raw = v["dateTime"]
    raw = raw.split(".")[0]  # Graph returns 7 fractional digits
    return datetime.fromisoformat(raw).replace(tzinfo=timezone.utc)


def ms_events(token: str, cal_id: str, start: datetime, end: datetime, client: httpx.Client) -> list[dict]:
    out = []
    url = (f"https://graph.microsoft.com/v1.0/me/calendars/{_q(cal_id)}/calendarView?"
           + urlencode({"startDateTime": iso_utc(start), "endDateTime": iso_utc(end), "$top": 500,
                        "$select": "id,subject,start,end,isAllDay,location,bodyPreview,webLink,isCancelled"}))
    headers = {"Authorization": f"Bearer {token}", "Prefer": 'outlook.timezone="UTC"'}
    while url:
        r = client.get(url, headers=headers)
        _raise_for(r, "Microsoft events")
        b = r.json()
        for e in b.get("value", []):
            if e.get("isCancelled"):
                continue
            s, en = _ms_time(e["start"]), _ms_time(e["end"])
            all_day = bool(e.get("isAllDay"))
            out.append({
                "uid": e["id"], "title": e.get("subject") or "(no title)",
                "start": s.date().isoformat() if all_day else iso_utc(s),
                "end": en.date().isoformat() if all_day else iso_utc(en),
                "all_day": all_day, "location": (e.get("location") or {}).get("displayName") or None,
                "description": e.get("bodyPreview") or None, "url": e.get("webLink"),
            })
        url = b.get("@odata.nextLink")
    return out


# --------------------------------------------------------------------------- CalDAV (Apple iCloud)
DAV = "DAV:"
CAL = "urn:ietf:params:xml:ns:caldav"
ICAL = "http://apple.com/ns/ical/"
NS = {"d": DAV, "c": CAL, "i": ICAL}
ICLOUD = "https://caldav.icloud.com/"


def _propfind(client: httpx.Client, url: str, body: str, depth: str, auth) -> ET.Element:
    r = client.request("PROPFIND", url, content=body, auth=auth,
                       headers={"Depth": depth, "Content-Type": "application/xml; charset=utf-8"})
    if r.status_code == 401:
        raise ProviderError("Apple rejected the Apple ID or app-specific password")
    if r.status_code >= 400:
        raise ProviderError(f"CalDAV request failed ({r.status_code})")
    return ET.fromstring(r.content)


def _href(root: ET.Element, prop: str) -> str | None:
    el = root.find(f".//{prop}/d:href", NS)
    return el.text.strip() if el is not None and el.text else None


def caldav_home(client: httpx.Client, base: str, auth) -> str:
    root = _propfind(client, base, '<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>', "0", auth)
    principal = _href(root, "d:current-user-principal")
    if not principal:
        raise ProviderError("CalDAV server did not return a user principal")
    principal = urljoin(base, principal)
    root = _propfind(client, principal, '<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop>'
                     '<c:calendar-home-set/></d:prop></d:propfind>', "0", auth)
    home = _href(root, "c:calendar-home-set")
    if not home:
        raise ProviderError("CalDAV server did not return a calendar home")
    return urljoin(principal, home)


def caldav_calendars(client: httpx.Client, home: str, auth) -> list[dict]:
    body = ('<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:i="http://apple.com/ns/ical/">'
            '<d:prop><d:displayname/><d:resourcetype/><i:calendar-color/><c:supported-calendar-component-set/>'
            '<d:current-user-privilege-set/></d:prop></d:propfind>')
    root = _propfind(client, home, body, "1", auth)
    out = []
    for resp in root.findall("d:response", NS):
        href = resp.findtext("d:href", namespaces=NS)
        prop = resp.find(".//d:propstat/d:prop", NS)
        if not href or prop is None or prop.find("d:resourcetype/c:calendar", NS) is None:
            continue
        comps = [c.get("name") for c in prop.findall("c:supported-calendar-component-set/c:comp", NS)]
        if comps and "VEVENT" not in comps:
            continue
        color = (prop.findtext("i:calendar-color", namespaces=NS) or "").strip() or None
        if color and len(color) == 9:  # #RRGGBBAA
            color = color[:7]
        writable = prop.find(".//d:privilege/d:write", NS) is not None or prop.find(".//d:privilege/d:all", NS) is not None
        out.append({"id": urljoin(home, href), "name": prop.findtext("d:displayname", namespaces=NS) or href.rstrip("/").split("/")[-1],
                    "color": color, "primary": False, "read_only": not writable})
    return out


def caldav_events(client: httpx.Client, cal_url: str, start: datetime, end: datetime, auth) -> list[dict]:
    fmt = "%Y%m%dT%H%M%SZ"
    body = ('<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-data/></d:prop>'
            '<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">'
            f'<c:time-range start="{start.astimezone(timezone.utc).strftime(fmt)}" end="{end.astimezone(timezone.utc).strftime(fmt)}"/>'
            '</c:comp-filter></c:comp-filter></c:filter></c:calendar-query>')
    r = client.request("REPORT", cal_url, content=body, auth=auth,
                       headers={"Depth": "1", "Content-Type": "application/xml; charset=utf-8"})
    if r.status_code >= 400:
        raise ProviderError(f"CalDAV events request failed ({r.status_code})")
    root = ET.fromstring(r.content)
    out: list[dict] = []
    for data in root.iter(f"{{{CAL}}}calendar-data"):
        if data.text:
            out.extend(ics_events(data.text, start, end))
    return out


def ics_events(text: str, start: datetime, end: datetime) -> list[dict]:
    """Expand an iCalendar document (incl. recurrences) into event dicts within [start, end)."""
    import icalendar
    import recurring_ical_events

    cal = icalendar.Calendar.from_ical(text)
    out = []
    for ev in recurring_ical_events.of(cal).between(start, end):
        if ev.name != "VEVENT":
            continue
        s = ev.get("DTSTART").dt
        e_prop = ev.get("DTEND")
        if e_prop is not None:
            e = e_prop.dt
        elif ev.get("DURATION") is not None:
            e = s + ev.get("DURATION").dt
        else:
            e = s + (timedelta(days=1) if not isinstance(s, datetime) else timedelta(0))
        all_day = not isinstance(s, datetime)
        uid = str(ev.get("UID", "")) or pysecrets.token_hex(6)
        rid = ev.get("RECURRENCE-ID")
        inst = rid.dt.isoformat() if rid is not None else s.isoformat()
        url = ev.get("URL")
        out.append({
            "uid": f"{uid}@{inst}",
            "title": str(ev.get("SUMMARY", "")) or "(no title)",
            "start": s.isoformat() if all_day else iso_utc(_aware(s)),
            "end": (e.isoformat() if isinstance(e, date) and not isinstance(e, datetime) else iso_utc(_aware(e))),
            "all_day": all_day,
            "location": str(ev.get("LOCATION")) if ev.get("LOCATION") else None,
            "description": str(ev.get("DESCRIPTION")) if ev.get("DESCRIPTION") else None,
            "url": str(url) if url else None,
        })
    return out


def _aware(dt: datetime) -> datetime:
    if dt.tzinfo is None:  # floating time: interpret as local time
        return dt.astimezone()
    return dt
