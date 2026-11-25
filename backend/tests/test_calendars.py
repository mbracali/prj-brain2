"""Accounts, providers (mocked HTTP) and calendars."""

import json
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlparse

import httpx
import pytest
from fastapi.testclient import TestClient

from brain2.accounts import providers as P
from brain2.accounts.secrets import MemorySecrets
from brain2.api.app import create_app
from brain2.config import load_config

NOW = datetime.now(timezone.utc).replace(microsecond=0)
SOON = (NOW + timedelta(days=2)).replace(hour=15, minute=0, second=0)

ICS = f"""BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:weekly-1
DTSTART:{(NOW - timedelta(days=1)).strftime('%Y%m%dT100000Z')}
DTEND:{(NOW - timedelta(days=1)).strftime('%Y%m%dT110000Z')}
RRULE:FREQ=WEEKLY;COUNT=3
SUMMARY:Weekly sync
LOCATION:Room 1
END:VEVENT
BEGIN:VEVENT
UID:allday-1
DTSTART;VALUE=DATE:{SOON.strftime('%Y%m%d')}
DTEND;VALUE=DATE:{(SOON + timedelta(days=1)).strftime('%Y%m%d')}
SUMMARY:Holiday
END:VEVENT
END:VCALENDAR
"""

MULTISTATUS = """<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:i="http://apple.com/ns/ical/">{}</d:multistatus>"""


def handler(request: httpx.Request) -> httpx.Response:
    url = str(request.url)
    # ---- Google
    if url.startswith("https://oauth2.googleapis.com/token"):
        form = parse_qs(request.content.decode())
        assert form["client_secret"] == ["gsecret"]
        if form["grant_type"] == ["authorization_code"]:
            assert form["code"] == ["the-code"] and form["code_verifier"]
        return httpx.Response(200, json={"access_token": "g-access", "refresh_token": "g-refresh", "expires_in": 3600})
    if url.startswith("https://openidconnect.googleapis.com/v1/userinfo"):
        return httpx.Response(200, json={"email": "me@gmail.com"})
    if "googleapis.com/calendar/v3/users/me/calendarList" in url:
        assert request.headers["authorization"] == "Bearer g-access"
        return httpx.Response(200, json={"items": [{"id": "primary@gmail.com", "summary": "Me", "backgroundColor": "#123456",
                                                    "primary": True, "accessRole": "owner"}]})
    if "googleapis.com/calendar/v3/calendars/" in url:
        return httpx.Response(200, json={"items": [
            {"id": "g1", "summary": "Dentist", "start": {"dateTime": SOON.isoformat()}, "end": {"dateTime": (SOON + timedelta(hours=1)).isoformat()},
             "htmlLink": "https://calendar.google.com/x"},
            {"id": "g2", "status": "cancelled", "start": {"date": "2020-01-01"}, "end": {"date": "2020-01-02"}},
        ]})
    # ---- Microsoft
    if url.startswith("https://graph.microsoft.com/v1.0/me/calendars?"):
        return httpx.Response(200, json={"value": [{"id": "ms-cal", "name": "Calendar", "hexColor": "#ff0000", "isDefaultCalendar": True, "canEdit": True}]})
    if "graph.microsoft.com/v1.0/me/calendars/ms-cal/calendarView" in url:
        assert request.headers["prefer"] == 'outlook.timezone="UTC"'
        st = SOON.strftime("%Y-%m-%dT09:00:00.0000000")
        return httpx.Response(200, json={"value": [{"id": "m1", "subject": "Standup", "isAllDay": False,
                                                    "start": {"dateTime": st, "timeZone": "UTC"}, "end": {"dateTime": st.replace("09:00", "09:15"), "timeZone": "UTC"},
                                                    "location": {"displayName": "Teams"}, "bodyPreview": "daily"}]})
    # ---- iCloud CalDAV
    if request.method == "PROPFIND" and url == "https://caldav.icloud.com/":
        if request.headers.get("authorization", "") != "Basic " + __import__("base64").b64encode(b"me@icloud.com:abcdabcdabcdabcd").decode():
            return httpx.Response(401)
        return httpx.Response(207, content=MULTISTATUS.format("<d:response><d:href>/</d:href><d:propstat><d:prop><d:current-user-principal><d:href>/123/principal/</d:href></d:current-user-principal></d:prop></d:propstat></d:response>"))
    if request.method == "PROPFIND" and url.endswith("/123/principal/"):
        return httpx.Response(207, content=MULTISTATUS.format("<d:response><d:href>/123/principal/</d:href><d:propstat><d:prop><c:calendar-home-set><d:href>https://p01-caldav.icloud.com/123/calendars/</d:href></c:calendar-home-set></d:prop></d:propstat></d:response>"))
    if request.method == "PROPFIND" and url == "https://p01-caldav.icloud.com/123/calendars/":
        return httpx.Response(207, content=MULTISTATUS.format(
            "<d:response><d:href>/123/calendars/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>"
            "<d:response><d:href>/123/calendars/home/</d:href><d:propstat><d:prop><d:displayname>Home</d:displayname>"
            "<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><i:calendar-color>#34C759FF</i:calendar-color>"
            "<c:supported-calendar-component-set><c:comp name=\"VEVENT\"/></c:supported-calendar-component-set></d:prop></d:propstat></d:response>"
            "<d:response><d:href>/123/calendars/tasks/</d:href><d:propstat><d:prop><d:displayname>Reminders</d:displayname>"
            "<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>"
            "<c:supported-calendar-component-set><c:comp name=\"VTODO\"/></c:supported-calendar-component-set></d:prop></d:propstat></d:response>"))
    if request.method == "REPORT" and url == "https://p01-caldav.icloud.com/123/calendars/home/":
        return httpx.Response(207, content=MULTISTATUS.format(
            f"<d:response><d:href>/123/calendars/home/a.ics</d:href><d:propstat><d:prop><c:calendar-data>{ICS}</c:calendar-data></d:prop></d:propstat></d:response>"))
    return httpx.Response(404, json={"error": f"unmocked {request.method} {url}"})


@pytest.fixture
def client(tmp_path):
    secrets = MemorySecrets()
    app = create_app(load_config(tmp_path / "home"), token=None, watch=False, secret_store=secrets,
                     http=lambda: httpx.Client(transport=httpx.MockTransport(handler)))
    with TestClient(app) as c:
        c.secrets = secrets
        c.app_ = app
        yield c


def test_ics_expansion():
    events = P.ics_events(ICS, NOW - timedelta(days=30), NOW + timedelta(days=30))
    weekly = [e for e in events if e["title"] == "Weekly sync"]
    assert len(weekly) == 3 and weekly[0]["location"] == "Room 1" and weekly[0]["start"].endswith("Z")
    holiday = next(e for e in events if e["title"] == "Holiday")
    assert holiday["all_day"] and len(holiday["start"]) == 10
    assert len({e["uid"] for e in weekly}) == 3


def test_connectors_listing_and_config(client):
    c = client.get("/api/connectors").json()
    kinds = {p["kind"] for p in c["providers"]}
    assert kinds == {"account", "llm", "chat"}
    google = next(p for p in c["providers"] if p["id"] == "google")
    assert google["needs_setup"] and not google["configured"]
    assert client.post("/api/accounts/oauth/start", json={"provider": "google"}).status_code == 400
    c = client.put("/api/connectors/google/config", json={"client_id": "gid", "client_secret": "gsecret"}).json()
    google = next(p for p in c["providers"] if p["id"] == "google")
    assert google["configured"] and google["config"]["client_secret"] != "gsecret"  # masked
    assert client.secrets.get("provider:google:client_secret") == "gsecret"


def test_google_oauth_flow_and_calendar_sync(client):
    client.put("/api/connectors/google/config", json={"client_id": "gid", "client_secret": "gsecret"})
    flow = client.post("/api/accounts/oauth/start", json={"provider": "google", "nickname": "Personal"}).json()
    q = parse_qs(urlparse(flow["auth_url"]).query)
    assert q["client_id"] == ["gid"] and q["code_challenge_method"] == ["S256"] and "calendar.readonly" in q["scope"][0]
    redirect = q["redirect_uri"][0]
    assert redirect.startswith("http://127.0.0.1:")
    # The browser comes back to the loopback server.
    r = httpx.get(redirect, params={"code": "the-code", "state": q["state"][0]})
    assert "connected" in r.text.lower()
    st = client.get(f"/api/accounts/oauth/{flow['flow_id']}").json()
    assert st["state"] == "done" and st["account"]["email"] == "me@gmail.com" and st["account"]["nickname"] == "Personal"
    acc = st["account"]["id"]
    assert json.loads(client.secrets.get(f"account:{acc}"))["refresh_token"] == "g-refresh"

    cals = client.get(f"/api/accounts/{acc}/calendars").json()
    assert cals[0]["primary"] and cals[0]["color"] == "#123456"
    cal = client.post("/api/calendars", json={"name": "Life"}).json()
    client.post(f"/api/calendars/{cal['id']}/sources", json={"account_id": acc, "remote_id": cals[0]["id"], "remote_name": "Me"})
    res = client.post(f"/api/calendars/{cal['id']}/sync").json()
    assert res == {"synced": 1, "errors": []}
    ev = client.get("/api/events", params={"start": NOW.date().isoformat(), "end": (NOW + timedelta(days=7)).date().isoformat()}).json()
    assert [e["title"] for e in ev] == ["Dentist"] and not ev[0]["editable"] and ev[0]["provider"] == "google"
    assert client.patch(f"/api/events/{ev[0]['id']}", json={"title": "x"}).status_code == 400


def test_oauth_state_mismatch(client):
    client.put("/api/connectors/google/config", json={"client_id": "gid", "client_secret": "gsecret"})
    flow = client.post("/api/accounts/oauth/start", json={"provider": "google"}).json()
    redirect = parse_qs(urlparse(flow["auth_url"]).query)["redirect_uri"][0]
    httpx.get(redirect, params={"code": "the-code", "state": "forged"})
    assert client.get(f"/api/accounts/oauth/{flow['flow_id']}").json()["state"] == "error"


def test_one_calendar_many_accounts(client):
    # Microsoft account (inject tokens directly) + Apple account via CalDAV.
    svc = client.app_.state.accounts
    ms = svc._insert("microsoft", "Work", "me@work.com", {"access_token": "m", "refresh_token": "r", "expires_at": 9e12})
    assert client.post("/api/accounts/apple", json={"apple_id": "me@icloud.com", "app_password": "wrong"}).status_code == 400
    apple = client.post("/api/accounts/apple", json={"apple_id": "me@icloud.com", "app_password": "abcd-abcd-abcd-abcd".replace("-", " ")}).json()
    assert apple["provider"] == "apple"
    apple_cals = client.get(f"/api/accounts/{apple['id']}/calendars").json()
    assert [c["name"] for c in apple_cals] == ["Home"] and apple_cals[0]["color"] == "#34C759"

    cal = client.post("/api/calendars", json={"name": "Everything", "color": "#8e4ec6"}).json()
    client.post(f"/api/calendars/{cal['id']}/sources", json={"account_id": ms["id"], "remote_id": "ms-cal", "remote_name": "Work cal", "color": "#ff0000"})
    client.post(f"/api/calendars/{cal['id']}/sources", json={"account_id": apple["id"], "remote_id": apple_cals[0]["id"], "remote_name": "Home"})
    assert client.post("/api/calendars/sync").json()["errors"] == []
    local = client.post(f"/api/calendars/{cal['id']}/events", json={"title": "Write report", "start": SOON.isoformat(), "end": (SOON + timedelta(hours=2)).isoformat(), "all_day": False}).json()
    assert local["editable"] and local["color"] == "#8e4ec6"

    ev = client.get("/api/events", params={"start": (NOW - timedelta(days=10)).date().isoformat(), "end": (NOW + timedelta(days=30)).date().isoformat()}).json()
    titles = sorted(e["title"] for e in ev)
    assert titles.count("Weekly sync") >= 2 and "Holiday" in titles and "Standup" in titles and "Write report" in titles
    standup = next(e for e in ev if e["title"] == "Standup")
    assert standup["color"] == "#ff0000" and standup["location"] == "Teams"

    # edit / delete local event, hide a calendar source
    client.patch(f"/api/events/{local['id']}", json={"title": "Report v2", "all_day": True, "start": SOON.date().isoformat(), "end": SOON.date().isoformat()})
    got = client.get("/api/events", params={"start": SOON.date().isoformat(), "end": (SOON + timedelta(days=1)).date().isoformat()}).json()
    rep = next(e for e in got if e["title"] == "Report v2")
    assert rep["all_day"] and rep["end"] > rep["start"]
    src = client.get("/api/calendars").json()[0]["sources"]
    ms_src = next(s for s in src if s["provider"] == "microsoft")
    client.patch(f"/api/calendars/{cal['id']}/sources/{ms_src['id']}", json={"enabled": False})
    got = client.get("/api/events", params={"start": SOON.date().isoformat(), "end": (SOON + timedelta(days=1)).date().isoformat()}).json()
    assert "Standup" not in [e["title"] for e in got]
    assert client.delete(f"/api/events/{local['id']}").status_code == 200

    # removing an account removes its sources and cached events
    client.delete(f"/api/accounts/{apple['id']}")
    assert all(s["provider"] != "apple" for s in client.get("/api/calendars").json()[0]["sources"])
    assert client.delete(f"/api/calendars/{cal['id']}").json() == {"ok": True}


def test_llm_and_chat_connectors(client):
    acc = client.post("/api/accounts/secret", json={"provider": "anthropic", "secret": "sk-ant-x", "nickname": "Claude"}).json()
    assert acc["kind"] == "llm" and acc["email"] is None
    assert client.secrets.get(f"account:{acc['id']}") == "sk-ant-x"
    assert "sk-ant" not in json.dumps(client.get("/api/connectors").json())
    assert client.post("/api/accounts/secret", json={"provider": "google", "secret": "x"}).status_code == 400
