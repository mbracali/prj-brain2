#!/usr/bin/env python3
"""Install BRAIN2's built-in Google sign-in client for this checkout (or a CI build).

    python scripts/set-oauth-client.py ~/Downloads/client_secret_XXXX.apps.googleusercontent.com.json
    python scripts/set-oauth-client.py --from-env      # CI: BRAIN2_GOOGLE_CLIENT_ID / _SECRET

Writes backend/brain2/accounts/oauth_clients.json, which is git-ignored and bundled into release
builds. Nothing is printed except the client ID's last characters.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "backend" / "brain2" / "accounts" / "oauth_clients.json"


def from_google_json(path: Path) -> dict[str, str]:
    data = json.loads(path.read_text(encoding="utf-8"))
    entry = data.get("installed") or data.get("web")
    if not entry or not entry.get("client_id"):
        sys.exit(f"{path} is not a Google OAuth client file (expected an 'installed' Desktop client)")
    if "installed" not in data:
        print("warning: this is a 'Web application' client; BRAIN2 needs a 'Desktop app' client", file=sys.stderr)
    return {"client_id": entry["client_id"], "client_secret": entry.get("client_secret", "")}


def main() -> None:
    args = sys.argv[1:]
    if args == ["--from-env"]:
        cid = os.environ.get("BRAIN2_GOOGLE_CLIENT_ID", "").strip()
        if not cid:
            print("BRAIN2_GOOGLE_CLIENT_ID is not set: building without built-in Google sign-in")
            return
        google = {"client_id": cid, "client_secret": os.environ.get("BRAIN2_GOOGLE_CLIENT_SECRET", "").strip()}
    elif len(args) == 1:
        google = from_google_json(Path(args[0]).expanduser())
    else:
        sys.exit(__doc__)
    current = {}
    if OUT.exists():
        try:
            current = json.loads(OUT.read_text(encoding="utf-8"))
        except ValueError:
            current = {}
    current["google"] = google
    OUT.write_text(json.dumps(current, indent=2) + "\n", encoding="utf-8")
    try:
        OUT.chmod(0o600)
    except OSError:
        pass
    print(f"Built-in Google client installed (…{google['client_id'].split('.')[0][-6:]}) → {OUT}")


if __name__ == "__main__":
    main()
