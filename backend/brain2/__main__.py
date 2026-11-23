"""BRAIN2 command line.

    brain2 serve [--host 127.0.0.1] [--port 8765] [--token T | --no-auth] [--ui DIR]
    brain2 mcp                       # MCP server over stdio
    brain2 vaults                    # list vaults
    brain2 reindex <vault>           # rebuild a vault's index
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import sys
from pathlib import Path


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="brain2", description="BRAIN2 — Personal Assistant Harness")
    parser.add_argument("--home", help="BRAIN2 home directory (default: $BRAIN2_HOME or ~/Brain2)")
    sub = parser.add_subparsers(dest="cmd", required=True)

    serve = sub.add_parser("serve", help="Run the HTTP/WebSocket API (local or server mode)")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8765)
    serve.add_argument("--token", default=os.environ.get("BRAIN2_TOKEN"))
    serve.add_argument("--no-auth", action="store_true", help="Disable the API token (trusted networks only)")
    serve.add_argument("--ui", help="Serve the built web UI from this folder (server mode)")
    serve.add_argument("--exit-with-parent", action="store_true", help="Exit when the launching process dies (desktop app)")

    sub.add_parser("mcp", help="Run the MCP server over stdio")
    sub.add_parser("vaults", help="List vaults")
    reindex = sub.add_parser("reindex", help="Rebuild a vault index")
    reindex.add_argument("vault", help="Vault id or name")

    args = parser.parse_args(argv)
    if args.home:
        os.environ["BRAIN2_HOME"] = str(Path(args.home).expanduser())

    if args.cmd == "serve":
        import uvicorn

        from .api.app import create_app
        from .config import load_config

        token = None if args.no_auth else (args.token or secrets.token_urlsafe(24))
        ui = args.ui
        if ui is None:
            default_ui = Path(__file__).resolve().parents[2] / "app" / "dist"
            ui = str(default_ui) if default_ui.is_dir() else None
        config = load_config()
        if token and not args.token:
            print(f"BRAIN2 API token: {token}", file=sys.stderr)
            if ui:
                print(f"Open http://{args.host}:{args.port}/?token={token}", file=sys.stderr)
        print(f"BRAIN2 home: {config.home}", file=sys.stderr)
        if args.exit_with_parent:
            _exit_with_parent()
        uvicorn.run(create_app(config, token=token, static_dir=ui), host=args.host, port=args.port,
                    log_level="warning", timeout_graceful_shutdown=3)
    elif args.cmd == "mcp":
        from .mcp_server import run_stdio

        run_stdio()
    else:
        from .config import load_config
        from .db import Database
        from .vaults.service import VaultService

        config = load_config()
        svc = VaultService(Database(config.db_path), config)
        if args.cmd == "vaults":
            print(json.dumps(svc.list_vaults(), indent=2))
        elif args.cmd == "reindex":
            match = [v for v in svc.list_vaults() if args.vault in (v["id"], v["name"])]
            if not match:
                sys.exit(f"Unknown vault: {args.vault}")
            print(json.dumps(svc.index_vault(match[0]["id"], force=True), indent=2))


def _exit_with_parent() -> None:
    """Stop the backend if the desktop app that started it goes away (crash, kill -9)."""
    import threading
    import time

    parent = os.getppid()

    def watch() -> None:
        while True:
            time.sleep(2)
            if os.getppid() != parent:
                os._exit(0)

    threading.Thread(target=watch, daemon=True).start()


if __name__ == "__main__":
    main()
