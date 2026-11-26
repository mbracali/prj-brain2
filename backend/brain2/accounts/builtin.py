"""Built-in OAuth clients shipped with official BRAIN2 builds, plus email → provider detection.

A desktop OAuth client ID/secret is not confidential (Google documents that installed apps can't
keep secrets), but we still keep it out of git: release builds write ``oauth_clients.json`` from
CI secrets, and developers create it locally with ``python scripts/set-oauth-client.py``. Forks and
dev checkouts without the file simply fall back to "use your own app credentials".

Lookup order: environment (``BRAIN2_GOOGLE_CLIENT_ID`` / ``BRAIN2_GOOGLE_CLIENT_SECRET``,
``BRAIN2_MICROSOFT_CLIENT_ID``) → ``oauth_clients.json`` next to this module.
"""

from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path
from typing import Callable

CLIENTS_FILE = Path(__file__).with_name("oauth_clients.json")

_ENV = {
    "google": {"client_id": "BRAIN2_GOOGLE_CLIENT_ID", "client_secret": "BRAIN2_GOOGLE_CLIENT_SECRET"},
    "microsoft": {"client_id": "BRAIN2_MICROSOFT_CLIENT_ID"},
}


@lru_cache(maxsize=1)
def _file_clients() -> dict[str, dict[str, str]]:
    try:
        data = json.loads(CLIENTS_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return {k: {f: str(v) for f, v in cfg.items() if v} for k, cfg in data.items() if isinstance(cfg, dict)}


def builtin_client(provider: str) -> dict[str, str]:
    """The built-in client for ``provider`` ({} when this build has none)."""
    env = {f: os.environ[var].strip() for f, var in _ENV.get(provider, {}).items() if os.environ.get(var, "").strip()}
    if env.get("client_id"):
        return env
    cfg = _file_clients().get(provider) or {}
    return cfg if cfg.get("client_id") else {}


# --------------------------------------------------------------------------- email → provider
KNOWN_DOMAINS = {
    "google": {"gmail.com", "googlemail.com"},
    "microsoft": {"outlook.com", "hotmail.com", "live.com", "msn.com", "outlook.com.br", "hotmail.com.br"},
    "apple": {"icloud.com", "me.com", "mac.com"},
}
MX_SUFFIXES = {
    "google": ("google.com", "googlemail.com"),
    "microsoft": ("mail.protection.outlook.com", "outlook.com"),
    "apple": ("mail.icloud.com",),
}


def _mx_hosts(domain: str) -> list[str]:
    try:
        import dns.resolver  # noqa: PLC0415 - optional at import time
    except ImportError:
        return []
    try:
        answer = dns.resolver.resolve(domain, "MX", lifetime=4)
    except Exception:  # noqa: BLE001 - NXDOMAIN, timeout, no network: just "unknown"
        return []
    return [r.exchange.to_text().rstrip(".").lower() for r in answer]


def detect_provider(email: str, mx_lookup: Callable[[str], list[str]] = _mx_hosts) -> dict[str, str | bool | None]:
    """Which account provider hosts this address: ``{"provider": "google"|"microsoft"|"apple"|None, "custom_domain": bool}``."""
    email = email.strip().lower()
    if "@" not in email or email.startswith("@") or email.endswith("@"):
        return {"provider": None, "custom_domain": False, "email": email}
    domain = email.rsplit("@", 1)[1]
    for provider, domains in KNOWN_DOMAINS.items():
        if domain in domains:
            return {"provider": provider, "custom_domain": False, "email": email}
    for host in mx_lookup(domain):
        for provider, suffixes in MX_SUFFIXES.items():
            if any(host == s or host.endswith("." + s) for s in suffixes):
                return {"provider": provider, "custom_domain": True, "email": email}
    return {"provider": None, "custom_domain": True, "email": email}
