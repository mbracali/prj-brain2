"""Account connectors: provider configuration, connected accounts, OAuth sign-in flows.

Non-secret data lives in SQLite (``accounts`` table, ``connectors.<provider>`` settings);
tokens, passwords and API keys live in the OS keychain (see ``secrets.py``).
"""

from __future__ import annotations

import json
import secrets as pysecrets
import socket
import threading
import time
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable
from urllib.parse import parse_qs, urlparse

import httpx

from ..db import Database
from ..gitcli import which
from . import providers as P
from .secrets import SecretStore

SCHEMA = """
CREATE TABLE IF NOT EXISTS accounts (
  id          TEXT PRIMARY KEY,
  provider    TEXT NOT NULL,
  kind        TEXT NOT NULL,
  nickname    TEXT NOT NULL,
  email       TEXT,
  status      TEXT NOT NULL DEFAULT 'ok',
  error       TEXT,
  config      TEXT NOT NULL DEFAULT '{}',   -- non-secret per-account data (e.g. CalDAV home URL)
  created_at  TEXT NOT NULL
);
"""

FLOW_TTL = 600
DONE_PAGE = """<!doctype html><meta charset="utf-8"><title>BRAIN2</title>
<body style="font-family:-apple-system,system-ui,sans-serif;background:#161616;color:#ddd;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h2>{title}</h2><p>{text}</p><p style="color:#888">You can close this tab and return to BRAIN2.</p></div>"""


class AccountError(Exception):
    status = 400


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class AccountService:
    def __init__(self, db: Database, secrets: SecretStore, publish: Callable[[dict], None] | None = None,
                 http: Callable[[], httpx.Client] | None = None):
        self.db = db
        self.secrets = secrets
        self.publish = publish or (lambda ev: None)
        self.http = http or (lambda: httpx.Client(timeout=P.TIMEOUT, follow_redirects=True))
        self._flows: dict[str, dict[str, Any]] = {}
        self._lock = threading.Lock()
        with db._lock:  # noqa: SLF001
            db._conn.executescript(SCHEMA)  # noqa: SLF001

    # ---------------------------------------------------------------- providers
    def provider_config(self, provider: str) -> dict[str, str]:
        cfg = dict(self.db.get_settings().get(f"connectors.{provider}") or {})
        secret = self.secrets.get(f"provider:{provider}:client_secret")
        if secret:
            cfg["client_secret"] = secret
        return cfg

    def configure(self, provider: str, values: dict[str, str]) -> dict[str, Any]:
        info = P.BY_ID.get(provider)
        if not info:
            raise AccountError("Unknown provider")
        public = dict(self.db.get_settings().get(f"connectors.{provider}") or {})
        for field in info["config_fields"]:
            if field not in values:
                continue
            v = (values.get(field) or "").strip()
            if field == "client_secret":
                if v:
                    self.secrets.set(f"provider:{provider}:client_secret", v)
                else:
                    self.secrets.delete(f"provider:{provider}:client_secret")
            elif v:
                public[field] = v
            else:
                public.pop(field, None)
        self.db.update_settings({f"connectors.{provider}": public or None})
        self.publish({"type": "accounts.changed"})
        return self.connectors()

    def _configured(self, info: dict) -> bool:
        if not info["needs_setup"]:
            return True
        cfg = self.provider_config(info["id"])
        if info["id"] == "google":
            return bool(cfg.get("client_id") and cfg.get("client_secret"))
        return bool(cfg.get("client_id"))

    def connectors(self) -> dict[str, Any]:
        providers = []
        for info in P.PROVIDERS:
            cfg = dict(self.db.get_settings().get(f"connectors.{info['id']}") or {})
            if self.secrets.get(f"provider:{info['id']}:client_secret"):
                cfg["client_secret"] = "••••••••"  # never sent back
            providers.append({
                "id": info["id"], "kind": info["kind"], "name": info["name"], "icon": info["icon"],
                "connect": info["connect"], "needs_setup": info["needs_setup"], "configured": self._configured(info),
                "config": cfg, "usable": info["usable"], "help": info["help"],
                "detected": which(info["cli"]) if info.get("cli") else None,
            })
        return {"providers": providers, "accounts": self.list_accounts(), "keychain": self.secrets.label}

    # ---------------------------------------------------------------- accounts
    def _row(self, account_id: str) -> dict[str, Any]:
        row = self.db.one("SELECT * FROM accounts WHERE id = ?", (account_id,))
        if not row:
            err = AccountError("Account not found")
            err.status = 404
            raise err
        return dict(row)

    @staticmethod
    def _public(row: dict) -> dict[str, Any]:
        return {k: row[k] for k in ("id", "provider", "kind", "nickname", "email", "status", "error", "created_at")}

    def list_accounts(self) -> list[dict[str, Any]]:
        return [self._public(dict(r)) for r in self.db.query("SELECT * FROM accounts ORDER BY kind, provider, nickname")]

    def get(self, account_id: str) -> dict[str, Any]:
        return self._public(self._row(account_id))

    def _insert(self, provider: str, nickname: str | None, email: str | None, secret: dict | str,
                config: dict | None = None) -> dict[str, Any]:
        info = P.BY_ID[provider]
        # Reconnecting the same login replaces the old credentials instead of duplicating the account.
        existing = self.db.one("SELECT id FROM accounts WHERE provider = ? AND email = ?", (provider, email)) if email else None
        aid = existing["id"] if existing else uuid.uuid4().hex[:12]
        label = (nickname or "").strip() or email or info["name"]
        if isinstance(secret, dict):
            self.secrets.set_json(f"account:{aid}", secret)
        else:
            self.secrets.set(f"account:{aid}", secret)
        if existing:
            self.db.execute("UPDATE accounts SET status='ok', error=NULL, config=?, nickname=? WHERE id=?",
                            (json.dumps(config or {}), label, aid))
        else:
            self.db.execute(
                "INSERT INTO accounts(id, provider, kind, nickname, email, status, config, created_at) VALUES (?,?,?,?,?,?,?,?)",
                (aid, provider, info["kind"], label, email, "ok", json.dumps(config or {}), now_iso()),
            )
        self.publish({"type": "accounts.changed"})
        return self.get(aid)

    def rename(self, account_id: str, nickname: str) -> dict[str, Any]:
        self._row(account_id)
        if nickname.strip():
            self.db.execute("UPDATE accounts SET nickname = ? WHERE id = ?", (nickname.strip(), account_id))
            self.publish({"type": "accounts.changed"})
        return self.get(account_id)

    def remove(self, account_id: str) -> None:
        self._row(account_id)
        self.db.execute("DELETE FROM accounts WHERE id = ?", (account_id,))
        self.secrets.delete(f"account:{account_id}")
        self.publish({"type": "accounts.changed"})

    def set_status(self, account_id: str, error: str | None) -> None:
        self.db.execute("UPDATE accounts SET status = ?, error = ? WHERE id = ?",
                        ("error" if error else "ok", error, account_id))

    def connect_secret(self, provider: str, secret: str, nickname: str | None) -> dict[str, Any]:
        info = P.BY_ID.get(provider)
        if not info or info["connect"] not in ("apikey", "token", "cli"):
            raise AccountError("This provider does not connect with a key")
        if info["connect"] != "cli" and not secret.strip():
            raise AccountError("Paste the key / token")
        return self._insert(provider, nickname, None, secret.strip() or "cli")

    # ---------------------------------------------------------------- Apple / CalDAV
    def connect_apple(self, apple_id: str, app_password: str, nickname: str | None, server: str | None = None) -> dict[str, Any]:
        apple_id, app_password = apple_id.strip(), app_password.strip().replace(" ", "")
        if not apple_id or not app_password:
            raise AccountError("Enter your Apple ID and an app-specific password")
        base = (server or P.ICLOUD).strip()
        with self.http() as client:
            try:
                home = P.caldav_home(client, base, (apple_id, app_password))
            except (P.ProviderError, httpx.HTTPError) as e:
                raise AccountError(str(e) or "Could not reach iCloud") from e
        return self._insert("apple", nickname, apple_id, {"username": apple_id, "password": app_password},
                            {"home": home, "server": base})

    # ---------------------------------------------------------------- OAuth
    def start_oauth(self, provider: str, nickname: str | None = None) -> dict[str, str]:
        if provider not in P.OAUTH:
            raise AccountError("This provider does not use browser sign-in")
        info = P.BY_ID[provider]
        if not self._configured(info):
            raise AccountError(f"Set up your {info['name']} app credentials first")
        cfg = self.provider_config(provider)
        verifier, challenge = P.pkce_pair()
        state = pysecrets.token_urlsafe(24)
        flow_id = uuid.uuid4().hex[:12]
        server = _CallbackServer(self, flow_id)
        host = P.OAUTH[provider]["redirect_host"]
        redirect_uri = f"http://{host}:{server.port}" + ("/" if provider == "google" else "")
        flow = {"provider": provider, "config": cfg, "verifier": verifier, "state": state, "redirect_uri": redirect_uri,
                "nickname": nickname, "status": "pending", "created": time.time(), "server": server}
        with self._lock:
            self._gc_flows()
            self._flows[flow_id] = flow
        server.start()
        return {"flow_id": flow_id, "auth_url": P.auth_url(provider, cfg, redirect_uri, state, challenge)}

    def _gc_flows(self) -> None:
        for fid, f in list(self._flows.items()):
            if time.time() - f["created"] > FLOW_TTL:
                f["server"].stop()
                if f["status"] == "pending":
                    f.update(status="error", error="Sign-in timed out")
                if time.time() - f["created"] > FLOW_TTL * 2:
                    self._flows.pop(fid, None)

    def flow_status(self, flow_id: str) -> dict[str, Any]:
        with self._lock:
            self._gc_flows()
            f = self._flows.get(flow_id)
        if not f:
            return {"state": "error", "error": "Unknown or expired sign-in"}
        out: dict[str, Any] = {"state": f["status"]}
        if f["status"] == "done":
            out["account"] = f["account"]
        if f["status"] == "error":
            out["error"] = f.get("error")
        return out

    def _complete(self, flow_id: str, params: dict[str, str]) -> tuple[bool, str]:
        f = self._flows.get(flow_id)
        if not f or f["status"] != "pending":
            return False, "This sign-in is no longer active."
        if params.get("state") != f["state"]:
            f.update(status="error", error="Sign-in state mismatch")
            return False, "Security check failed (state mismatch)."
        if params.get("error"):
            msg = params.get("error_description") or params["error"]
            f.update(status="error", error=msg)
            return False, msg
        try:
            with self.http() as client:
                tokens = P.exchange_code(f["provider"], f["config"], params.get("code", ""), f["verifier"],
                                         f["redirect_uri"], client)
                email = P.profile_email(f["provider"], tokens["access_token"], client)
            account = self._insert(f["provider"], f["nickname"], email, tokens)
            f.update(status="done", account=account)
            return True, f"Connected {email or account['nickname']}."
        except Exception as e:  # noqa: BLE001 - surfaced to the user
            f.update(status="error", error=str(e))
            return False, str(e)

    # ---------------------------------------------------------------- credentials for providers
    def access_token(self, account_id: str, client: httpx.Client) -> str:
        row = self._row(account_id)
        tokens = self.secrets.get_json(f"account:{account_id}") or {}
        if not tokens.get("access_token"):
            raise P.ProviderError("Missing credentials — reconnect this account")
        if tokens.get("expires_at", 0) <= time.time():
            fresh = P.refresh(row["provider"], self.provider_config(row["provider"]), tokens, client)
            self.secrets.set_json(f"account:{account_id}", fresh)
            tokens = fresh
        return tokens["access_token"]

    def caldav_auth(self, account_id: str) -> tuple[tuple[str, str], dict]:
        row = self._row(account_id)
        cred = self.secrets.get_json(f"account:{account_id}") or {}
        if not cred.get("password"):
            raise P.ProviderError("Missing credentials — reconnect this account")
        return (cred["username"], cred["password"]), json.loads(row["config"] or "{}")

    def remote_calendars(self, account_id: str) -> list[dict[str, Any]]:
        row = self._row(account_id)
        try:
            with self.http() as client:
                if row["provider"] == "google":
                    cals = P.google_calendars(self.access_token(account_id, client), client)
                elif row["provider"] == "microsoft":
                    cals = P.ms_calendars(self.access_token(account_id, client), client)
                elif row["provider"] == "apple":
                    auth, cfg = self.caldav_auth(account_id)
                    home = cfg.get("home") or P.caldav_home(client, cfg.get("server") or P.ICLOUD, auth)
                    cals = P.caldav_calendars(client, home, auth)
                else:
                    raise AccountError("This account has no calendars")
            self.set_status(account_id, None)
            return cals
        except (P.ProviderError, httpx.HTTPError) as e:
            self.set_status(account_id, str(e))
            self.publish({"type": "accounts.changed"})
            raise AccountError(str(e)) from e


class _CallbackServer:
    """One-shot loopback HTTP server receiving the OAuth redirect."""

    def __init__(self, svc: AccountService, flow_id: str):
        self.svc, self.flow_id = svc, flow_id
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                q = {k: v[0] for k, v in parse_qs(urlparse(self.path).query).items()}
                if not q:  # favicon etc.
                    self.send_response(404)
                    self.end_headers()
                    return
                ok, text = outer.svc._complete(outer.flow_id, q)  # noqa: SLF001
                page = DONE_PAGE.format(title="Account connected ✓" if ok else "Sign-in failed", text=_esc(text))
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.end_headers()
                self.wfile.write(page.encode())
                threading.Thread(target=outer.stop, daemon=True).start()
                outer.svc.publish({"type": "accounts.changed"})

            def log_message(self, *args):
                pass

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.httpd.server_address[1]

    def start(self) -> None:
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def stop(self) -> None:
        try:
            self.httpd.shutdown()
            self.httpd.server_close()
        except Exception:
            pass


def _esc(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def free_port() -> int:  # pragma: no cover - kept for tooling
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]
