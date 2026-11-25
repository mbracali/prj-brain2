"""HTTP + WebSocket API. Every vault capability is exposed here (and via MCP)."""

from __future__ import annotations

import asyncio
import platform
import secrets
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .. import __version__
from ..config import Config, load_config
from ..db import Database
from ..accounts.providers import ProviderError
from ..accounts.secrets import default_secrets
from ..accounts.service import AccountError, AccountService
from ..calendars.service import CalendarError, CalendarService
from ..gitcli import GitError
from ..repos.service import RepoError, RepoService
from ..terminals import TerminalError, TerminalManager
from ..vaults.gitsync import VaultGitSync
from ..vaults.service import EventBus, VaultError, VaultService


# --------------------------------------------------------------------------- models
class VaultCreate(BaseModel):
    name: str
    path: str | None = None
    icon: str | None = None
    connections: dict[str, list[str]] | None = None


class VaultUpdate(BaseModel):
    name: str | None = None
    icon: str | None = None
    connections: dict[str, list[str]] | None = None
    sort_order: int | None = None


class FileWrite(BaseModel):
    path: str
    content: str
    create_only: bool = False


class FileCreate(BaseModel):
    folder: str = ""
    name: str | None = None
    ext: str = "md"
    content: str = ""


class FolderCreate(BaseModel):
    parent: str = ""
    name: str | None = None


class MoveRequest(BaseModel):
    src: str
    dst: str
    update_links: bool = True


class IconSet(BaseModel):
    path: str
    icon: str | None = None


class AttachmentUpload(BaseModel):
    folder: str = ""
    name: str
    data_base64: str


class TerminalCreate(BaseModel):
    cwd: str | None = None
    title: str | None = None
    key: str | None = None


class TerminalUpdate(BaseModel):
    title: str


class TerminalRun(BaseModel):
    command: str | list[str]
    cwd: str | None = None
    wait: bool = False


class RepoClone(BaseModel):
    url: str
    parent: str
    name: str | None = None
    icon: str | None = None
    terminal_id: str | None = None


class RepoCreateLocal(BaseModel):
    parent: str
    folder: str
    name: str | None = None
    icon: str | None = None
    terminal_id: str | None = None


class RepoLocate(BaseModel):
    path: str
    name: str | None = None
    icon: str | None = None
    terminal_id: str | None = None


class RepoUpdate(BaseModel):
    name: str | None = None
    icon: str | None = None
    sort_order: int | None = None


class RepoCommand(BaseModel):
    action: str
    args: dict[str, Any] = {}


class VaultGitAttach(BaseModel):
    url: str | None = None


class VaultResolve(BaseModel):
    choices: dict[str, str]


class OAuthStart(BaseModel):
    provider: str
    nickname: str | None = None


class AppleConnect(BaseModel):
    apple_id: str
    app_password: str
    nickname: str | None = None
    server: str | None = None


class SecretConnect(BaseModel):
    provider: str
    secret: str = ""
    nickname: str | None = None


class AccountUpdate(BaseModel):
    nickname: str


class CalendarCreate(BaseModel):
    name: str
    color: str | None = None
    icon: str | None = None


class CalendarUpdate(BaseModel):
    name: str | None = None
    color: str | None = None
    icon: str | None = None
    visible: bool | None = None
    sort_order: int | None = None


class SourceAdd(BaseModel):
    account_id: str
    remote_id: str
    remote_name: str
    color: str | None = None


class SourceUpdate(BaseModel):
    enabled: bool | None = None
    color: str | None = None


class EventBody(BaseModel):
    title: str | None = None
    start: str | None = None
    end: str | None = None
    all_day: bool | None = None
    location: str | None = None
    description: str | None = None
    calendar_id: str | None = None


# --------------------------------------------------------------------------- app factory
def create_app(
    config: Config | None = None,
    token: str | None = None,
    static_dir: str | Path | None = None,
    watch: bool = True,
    secret_store=None,
    http=None,
) -> FastAPI:
    config = config or load_config()
    db = Database(config.db_path)
    bus = EventBus()
    vaults = VaultService(db, config, bus)
    terminals = TerminalManager(bus.publish)
    repos = RepoService(db, terminals, bus.publish)
    gitsync = VaultGitSync(vaults, terminals, bus.publish)
    accounts = AccountService(db, secret_store or default_secrets(config.home), bus.publish, http)
    calendars = CalendarService(db, accounts, bus.publish)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        if watch:
            await asyncio.to_thread(vaults.start_watching)
            calendars.start_background_sync()
        yield
        calendars.stop()
        vaults.stop_watching()
        terminals.close_all()
        db.close()

    app = FastAPI(title="BRAIN2", version=__version__, lifespan=lifespan)
    app.state.vaults = vaults
    app.state.db = db
    app.state.bus = bus
    app.state.config = config
    app.state.token = token
    app.state.terminals = terminals
    app.state.repos = repos
    app.state.accounts = accounts
    app.state.calendars = calendars

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],  # every request still needs the bearer token
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.exception_handler(VaultError)
    async def vault_error(_: Request, exc: VaultError):
        return JSONResponse({"detail": str(exc)}, status_code=exc.status)

    @app.exception_handler(RepoError)
    async def repo_error(_: Request, exc: RepoError):
        return JSONResponse({"detail": str(exc)}, status_code=exc.status)

    @app.exception_handler(TerminalError)
    async def terminal_error(_: Request, exc: TerminalError):
        return JSONResponse({"detail": str(exc)}, status_code=exc.status)

    @app.exception_handler(AccountError)
    async def account_error(_: Request, exc: AccountError):
        return JSONResponse({"detail": str(exc)}, status_code=exc.status)

    @app.exception_handler(CalendarError)
    async def calendar_error(_: Request, exc: CalendarError):
        return JSONResponse({"detail": str(exc)}, status_code=exc.status)

    @app.exception_handler(ProviderError)
    async def provider_error(_: Request, exc: ProviderError):
        return JSONResponse({"detail": str(exc)}, status_code=400)

    @app.exception_handler(GitError)
    async def git_error(_: Request, exc: GitError):
        return JSONResponse({"detail": str(exc)}, status_code=400)

    def auth(request: Request) -> None:
        if not token:
            return
        header = request.headers.get("authorization", "")
        supplied = header[7:] if header.lower().startswith("bearer ") else request.query_params.get("token", "")
        if not secrets.compare_digest(supplied, token):
            raise HTTPException(status_code=401, detail="Invalid or missing token")

    api = Depends(auth)

    # ---------------------------------------------------------------- system
    @app.get("/api/health")
    def health() -> dict[str, Any]:
        return {"ok": True, "app": "BRAIN2", "version": __version__}

    @app.get("/api/system", dependencies=[api])
    def system() -> dict[str, Any]:
        return {
            "version": __version__,
            "home": str(config.home),
            "db": str(config.db_path),
            "internal_vaults": str(config.vaults_dir),
            "platform": platform.system(),
            "python": platform.python_version(),
        }

    @app.get("/api/settings", dependencies=[api])
    def get_settings() -> dict[str, Any]:
        return db.get_settings()

    @app.put("/api/settings", dependencies=[api])
    def put_settings(values: dict[str, Any]) -> dict[str, Any]:
        result = db.update_settings(values)
        bus.publish({"type": "settings.changed"})
        return result

    # ---------------------------------------------------------------- vault registry
    @app.get("/api/vaults", dependencies=[api])
    def list_vaults():
        return vaults.list_vaults()

    @app.post("/api/vaults", dependencies=[api], status_code=201)
    def create_vault(body: VaultCreate):
        return vaults.create_vault(body.name, body.path, body.icon, body.connections)

    @app.get("/api/vaults/{vault_id}", dependencies=[api])
    def get_vault(vault_id: str):
        return vaults.get_vault(vault_id)

    @app.patch("/api/vaults/{vault_id}", dependencies=[api])
    def update_vault(vault_id: str, body: VaultUpdate):
        return vaults.update_vault(vault_id, **body.model_dump())

    @app.delete("/api/vaults/{vault_id}", dependencies=[api])
    def delete_vault(vault_id: str, delete_files: bool = False):
        vaults.delete_vault(vault_id, delete_files)
        return {"ok": True}

    @app.post("/api/vaults/{vault_id}/reindex", dependencies=[api])
    def reindex(vault_id: str, force: bool = True):
        result = vaults.index_vault(vault_id, force=force)
        bus.publish({"type": "vault.changed", "vault_id": vault_id, "paths": [], "origin": "api"})
        return result

    # ---------------------------------------------------------------- files
    @app.get("/api/vaults/{vault_id}/tree", dependencies=[api])
    def tree(vault_id: str):
        return vaults.tree(vault_id)

    @app.get("/api/vaults/{vault_id}/files", dependencies=[api])
    def list_files(vault_id: str, kind: str | None = None):
        return vaults.list_files(vault_id, kind)

    @app.get("/api/vaults/{vault_id}/file", dependencies=[api])
    def read_file(vault_id: str, path: str):
        return vaults.read_file(vault_id, path)

    @app.put("/api/vaults/{vault_id}/file", dependencies=[api])
    def write_file(vault_id: str, body: FileWrite):
        return vaults.write_file(vault_id, body.path, body.content, body.create_only)

    @app.post("/api/vaults/{vault_id}/file", dependencies=[api], status_code=201)
    def create_file(vault_id: str, body: FileCreate):
        return vaults.create_file(vault_id, body.folder, body.name, body.ext, body.content)

    @app.post("/api/vaults/{vault_id}/folder", dependencies=[api], status_code=201)
    def create_folder(vault_id: str, body: FolderCreate):
        return vaults.create_folder(vault_id, body.parent, body.name)

    @app.post("/api/vaults/{vault_id}/move", dependencies=[api])
    def move(vault_id: str, body: MoveRequest):
        return vaults.move(vault_id, body.src, body.dst, body.update_links)

    @app.delete("/api/vaults/{vault_id}/entry", dependencies=[api])
    def delete_entry(vault_id: str, path: str, permanent: bool = False):
        return vaults.delete(vault_id, path, permanent)

    @app.post("/api/vaults/{vault_id}/attachment", dependencies=[api], status_code=201)
    def attachment(vault_id: str, body: AttachmentUpload):
        return vaults.save_attachment(vault_id, body.folder, body.name, body.data_base64)

    @app.get("/api/vaults/{vault_id}/raw", dependencies=[api])
    def raw(vault_id: str, path: str):
        p = vaults.abs_path(vault_id, path)
        if not p.is_file():
            raise HTTPException(404, "Not found")
        return FileResponse(p, headers={"Cache-Control": "no-cache"})

    @app.get("/api/vaults/{vault_id}/meta", dependencies=[api])
    def meta(vault_id: str, path: str = ""):
        return vaults.sidecar(vault_id, path)

    # ---------------------------------------------------------------- knowledge queries
    @app.get("/api/vaults/{vault_id}/search", dependencies=[api])
    def search(vault_id: str, q: str = Query(""), limit: int = 50):
        return vaults.search(vault_id, q, limit)

    @app.get("/api/vaults/{vault_id}/resolve", dependencies=[api])
    def resolve(vault_id: str, link: str, src: str | None = None):
        return {"path": vaults.resolve_link(vault_id, link, src)}

    @app.get("/api/vaults/{vault_id}/backlinks", dependencies=[api])
    def backlinks(vault_id: str, path: str):
        return vaults.backlinks(vault_id, path)

    @app.get("/api/vaults/{vault_id}/links", dependencies=[api])
    def links(vault_id: str, path: str):
        return vaults.outgoing_links(vault_id, path)

    @app.get("/api/vaults/{vault_id}/outline", dependencies=[api])
    def outline(vault_id: str, path: str):
        return vaults.outline(vault_id, path)

    @app.get("/api/vaults/{vault_id}/tags", dependencies=[api])
    def tags(vault_id: str):
        return vaults.tags(vault_id)

    @app.get("/api/vaults/{vault_id}/graph", dependencies=[api])
    def graph(vault_id: str, attachments: bool = False, unresolved: bool = True, tags: bool = False):
        return vaults.graph(vault_id, attachments, unresolved, tags)

    @app.get("/api/vaults/{vault_id}/icons", dependencies=[api])
    def get_icons(vault_id: str):
        return vaults.get_icons(vault_id)

    @app.put("/api/vaults/{vault_id}/icons", dependencies=[api])
    def set_icon(vault_id: str, body: IconSet):
        return vaults.set_icon(vault_id, body.path, body.icon)

    # ---------------------------------------------------------------- vault git sync
    @app.get("/api/vaults/{vault_id}/git", dependencies=[api])
    def vault_git_status(vault_id: str):
        return gitsync.status(vault_id)

    @app.put("/api/vaults/{vault_id}/git", dependencies=[api])
    def vault_git_attach(vault_id: str, body: VaultGitAttach):
        return gitsync.attach(vault_id, body.url)

    @app.post("/api/vaults/{vault_id}/git/sync", dependencies=[api])
    def vault_git_sync(vault_id: str):
        return gitsync.sync(vault_id)

    @app.post("/api/vaults/{vault_id}/git/resolve", dependencies=[api])
    def vault_git_resolve(vault_id: str, body: VaultResolve):
        return gitsync.resolve(vault_id, body.choices)

    @app.post("/api/vaults/{vault_id}/git/abort", dependencies=[api])
    def vault_git_abort(vault_id: str):
        return gitsync.abort(vault_id)

    # ---------------------------------------------------------------- terminals
    @app.get("/api/terminals", dependencies=[api])
    def list_terminals():
        return terminals.list()

    @app.post("/api/terminals", dependencies=[api], status_code=201)
    def create_terminal(body: TerminalCreate):
        return terminals.create(body.cwd, body.title, body.key).info()

    @app.patch("/api/terminals/{tid}", dependencies=[api])
    def rename_terminal(tid: str, body: TerminalUpdate):
        return terminals.rename(tid, body.title)

    @app.delete("/api/terminals/{tid}", dependencies=[api])
    def close_terminal(tid: str):
        terminals.close(tid)
        return {"ok": True}

    @app.post("/api/terminals/{tid}/cd", dependencies=[api])
    def terminal_cd(tid: str, path: str):
        job = terminals.cd(tid, path)
        return {"job_id": job.id}

    @app.post("/api/terminals/{tid}/run", dependencies=[api])
    def terminal_run(tid: str, body: TerminalRun):
        t = terminals.get(tid)
        job = t.run(body.command, body.cwd)
        if body.wait:
            return {"job_id": job.id, **job.future.result()}
        return {"job_id": job.id}

    @app.websocket("/api/terminals/{tid}/ws")
    async def terminal_ws(ws: WebSocket, tid: str):
        if token and not secrets.compare_digest(ws.query_params.get("token", ""), token):
            await ws.close(code=4401)
            return
        try:
            term = terminals.get(tid)
        except TerminalError:
            await ws.close(code=4404)
            return
        await ws.accept()
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue[bytes] = asyncio.Queue()
        snapshot = term.snapshot()
        unsubscribe = term.subscribe(lambda data: loop.call_soon_threadsafe(queue.put_nowait, data))
        if snapshot:
            await ws.send_bytes(snapshot)

        async def pump() -> None:
            while True:
                chunk = await queue.get()
                while not queue.empty() and len(chunk) < 65536:
                    chunk += queue.get_nowait()
                await ws.send_bytes(chunk)

        sender = asyncio.create_task(pump())
        try:
            while True:
                msg = await ws.receive_json()
                if msg.get("type") == "input":
                    term.write(str(msg.get("data", "")))
                elif msg.get("type") == "resize":
                    term.resize(int(msg.get("cols", 0)), int(msg.get("rows", 0)))
        except (WebSocketDisconnect, RuntimeError, ValueError):
            pass
        finally:
            sender.cancel()
            unsubscribe()

    # ---------------------------------------------------------------- repos
    @app.get("/api/repos", dependencies=[api])
    def list_repos():
        return repos.list_repos()

    @app.get("/api/repos/inspect", dependencies=[api])
    def inspect_repo(path: str):
        return repos.inspect(path)

    @app.post("/api/repos/clone", dependencies=[api], status_code=201)
    def clone_repo(body: RepoClone):
        return repos.clone(body.url, body.parent, body.name, body.icon, body.terminal_id)

    @app.post("/api/repos/create", dependencies=[api], status_code=201)
    def create_repo(body: RepoCreateLocal):
        return repos.create_local(body.parent, body.folder, body.name, body.icon, body.terminal_id)

    @app.post("/api/repos/locate", dependencies=[api], status_code=201)
    def locate_repo(body: RepoLocate):
        return repos.locate(body.path, body.name, body.icon, body.terminal_id)

    @app.get("/api/repos/{repo_id}", dependencies=[api])
    def get_repo(repo_id: str):
        return repos.get_repo(repo_id)

    @app.patch("/api/repos/{repo_id}", dependencies=[api])
    def update_repo(repo_id: str, body: RepoUpdate):
        return repos.update(repo_id, body.name, body.icon, body.sort_order)

    @app.delete("/api/repos/{repo_id}", dependencies=[api])
    def delete_repo(repo_id: str, delete_files: bool = False):
        repos.remove(repo_id, delete_files)
        return {"ok": True}

    @app.post("/api/repos/{repo_id}/terminal", dependencies=[api])
    def repo_terminal(repo_id: str):
        return repos.repo_terminal(repo_id)

    @app.post("/api/repos/{repo_id}/sync", dependencies=[api])
    def sync_repo(repo_id: str):
        return repos.sync(repo_id)

    @app.post("/api/repos/{repo_id}/command", dependencies=[api])
    def repo_command(repo_id: str, body: RepoCommand):
        argv = repo_command_argv(body.action, body.args)
        return repos.run_in_repo(repo_id, argv, wait=body.action not in ("pr-create",))

    @app.get("/api/repos/{repo_id}/refs", dependencies=[api])
    def repo_refs(repo_id: str):
        return repos.refs(repo_id)

    @app.get("/api/repos/{repo_id}/tree", dependencies=[api])
    def repo_tree(repo_id: str, ref: str | None = None, path: str = ""):
        return repos.tree(repo_id, ref, path)

    @app.get("/api/repos/{repo_id}/blob", dependencies=[api])
    def repo_blob(repo_id: str, path: str, ref: str | None = None):
        return repos.blob(repo_id, ref, path)

    @app.get("/api/repos/{repo_id}/commits", dependencies=[api])
    def repo_commits(repo_id: str, ref: str | None = None, path: str | None = None, author: str | None = None,
                     q: str | None = None, skip: int = 0, limit: int = 50, all: bool = False):
        return repos.commits(repo_id, ref, path, author, q, skip, limit, all)

    @app.get("/api/repos/{repo_id}/commits/{sha}", dependencies=[api])
    def repo_commit(repo_id: str, sha: str):
        return repos.commit(repo_id, sha)

    @app.get("/api/repos/{repo_id}/branches", dependencies=[api])
    def repo_branches(repo_id: str):
        return repos.branches(repo_id)

    @app.get("/api/repos/{repo_id}/tags", dependencies=[api])
    def repo_tags(repo_id: str):
        return repos.tags(repo_id)

    @app.get("/api/repos/{repo_id}/pushes", dependencies=[api])
    def repo_pushes(repo_id: str):
        return repos.pushes(repo_id)

    @app.get("/api/repos/{repo_id}/pulls", dependencies=[api])
    def repo_pulls(repo_id: str, state: str = "open"):
        return repos.pull_requests(repo_id, state)

    # ---------------------------------------------------------------- account connectors
    @app.get("/api/connectors", dependencies=[api])
    def connectors():
        return accounts.connectors()

    @app.put("/api/connectors/{provider}/config", dependencies=[api])
    def configure_provider(provider: str, values: dict[str, str]):
        return accounts.configure(provider, values)

    @app.post("/api/accounts/oauth/start", dependencies=[api])
    def oauth_start(body: OAuthStart):
        return accounts.start_oauth(body.provider, body.nickname)

    @app.get("/api/accounts/oauth/{flow_id}", dependencies=[api])
    def oauth_status(flow_id: str):
        return accounts.flow_status(flow_id)

    @app.post("/api/accounts/apple", dependencies=[api], status_code=201)
    def connect_apple(body: AppleConnect):
        return accounts.connect_apple(body.apple_id, body.app_password, body.nickname, body.server)

    @app.post("/api/accounts/secret", dependencies=[api], status_code=201)
    def connect_secret(body: SecretConnect):
        return accounts.connect_secret(body.provider, body.secret, body.nickname)

    @app.patch("/api/accounts/{account_id}", dependencies=[api])
    def rename_account(account_id: str, body: AccountUpdate):
        return accounts.rename(account_id, body.nickname)

    @app.delete("/api/accounts/{account_id}", dependencies=[api])
    def remove_account(account_id: str):
        accounts.remove(account_id)
        bus.publish({"type": "calendars.changed"})
        bus.publish({"type": "events.changed"})
        return {"ok": True}

    @app.get("/api/accounts/{account_id}/calendars", dependencies=[api])
    def account_calendars(account_id: str):
        return accounts.remote_calendars(account_id)

    # ---------------------------------------------------------------- calendars
    @app.get("/api/calendars", dependencies=[api])
    def list_calendars():
        return calendars.list()

    @app.post("/api/calendars", dependencies=[api], status_code=201)
    def create_calendar(body: CalendarCreate):
        return calendars.create(body.name, body.color, body.icon)

    @app.post("/api/calendars/sync", dependencies=[api])
    def sync_all_calendars():
        return calendars.sync()

    @app.patch("/api/calendars/{cid}", dependencies=[api])
    def update_calendar(cid: str, body: CalendarUpdate):
        return calendars.update(cid, **body.model_dump())

    @app.delete("/api/calendars/{cid}", dependencies=[api])
    def delete_calendar(cid: str):
        calendars.delete(cid)
        return {"ok": True}

    @app.post("/api/calendars/{cid}/sync", dependencies=[api])
    def sync_calendar(cid: str):
        return calendars.sync(cid)

    @app.post("/api/calendars/{cid}/sources", dependencies=[api], status_code=201)
    def add_source(cid: str, body: SourceAdd):
        return calendars.add_source(cid, body.account_id, body.remote_id, body.remote_name, body.color)

    @app.patch("/api/calendars/{cid}/sources/{sid}", dependencies=[api])
    def update_source(cid: str, sid: str, body: SourceUpdate):
        return calendars.update_source(cid, sid, body.enabled, body.color)

    @app.delete("/api/calendars/{cid}/sources/{sid}", dependencies=[api])
    def remove_source(cid: str, sid: str):
        calendars.remove_source(cid, sid)
        return {"ok": True}

    @app.post("/api/calendars/{cid}/events", dependencies=[api], status_code=201)
    def create_event(cid: str, body: EventBody):
        return calendars.create_event(cid, body.model_dump())

    @app.get("/api/events", dependencies=[api])
    def list_events(start: str, end: str, calendars_: str | None = Query(None, alias="calendars")):
        ids = [c for c in (calendars_ or "").split(",") if c] or None
        return calendars.events(start, end, ids)

    @app.patch("/api/events/{eid}", dependencies=[api])
    def update_event(eid: str, body: EventBody):
        return calendars.update_event(eid, body.model_dump(exclude_none=True))

    @app.delete("/api/events/{eid}", dependencies=[api])
    def delete_event(eid: str):
        calendars.delete_event(eid)
        return {"ok": True}

    # ---------------------------------------------------------------- live events
    @app.websocket("/api/events")
    async def events(ws: WebSocket):
        if token and not secrets.compare_digest(ws.query_params.get("token", ""), token):
            await ws.close(code=4401)
            return
        await ws.accept()
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue[dict] = asyncio.Queue()
        unsubscribe = bus.subscribe(lambda ev: loop.call_soon_threadsafe(queue.put_nowait, ev))
        async def pump() -> None:
            while True:
                await ws.send_json(await queue.get())

        sender = asyncio.create_task(pump())
        try:
            # Reading notices disconnects (and server shutdown) even when no events flow.
            while True:
                await ws.receive_text()
        except (WebSocketDisconnect, RuntimeError):
            pass
        finally:
            sender.cancel()
            unsubscribe()

    # ---------------------------------------------------------------- web UI (server mode)
    if static_dir and Path(static_dir, "index.html").is_file():
        app.mount("/", StaticFiles(directory=str(static_dir), html=True), name="ui")

    return app


REF_RE = __import__("re").compile(r"^[A-Za-z0-9._/@+-]+$")


def _ref(value: Any) -> str:
    v = str(value or "").strip()
    if not v or v.startswith("-") or ".." in v or not REF_RE.match(v):
        raise RepoError(f"Invalid name: {v!r}")
    return v


def repo_command_argv(action: str, a: dict[str, Any]) -> list[str]:
    """Whitelisted git/gh actions the UI may run in a repo terminal."""
    if action == "checkout":
        return ["git", "switch", _ref(a.get("branch"))]
    if action == "checkout-remote":
        return ["git", "switch", "--track", _ref(a.get("branch"))]
    if action == "branch-create":
        return ["git", "switch", "-c", _ref(a.get("name")), _ref(a.get("from") or "HEAD")]
    if action == "branch-delete":
        return ["git", "branch", "-D" if a.get("force") else "-d", _ref(a.get("name"))]
    if action == "branch-delete-remote":
        remote, _, name = _ref(a.get("name")).partition("/")
        return ["git", "push", remote, "--delete", _ref(name)]
    if action == "push-branch":
        return ["git", "push", "-u", "origin", _ref(a.get("name"))]
    if action == "fetch":
        return ["git", "fetch", "--all", "--prune"]
    if action == "pull":
        return ["git", "pull", "--ff-only"]
    if action == "push":
        return ["git", "push"]
    if action == "tag-create":
        name, target = _ref(a.get("name")), _ref(a.get("target") or "HEAD")
        msg = str(a.get("message") or "").strip()
        return ["git", "tag", "-a", name, target, "-m", msg] if msg else ["git", "tag", name, target]
    if action == "tag-delete":
        return ["git", "tag", "-d", _ref(a.get("name"))]
    if action == "tag-push":
        return ["git", "push", "origin", f"refs/tags/{_ref(a.get('name'))}"]
    if action == "pr-checkout":
        return ["gh", "pr", "checkout", str(int(a.get("number")))]
    if action == "pr-create":
        argv = ["gh", "pr", "create", "--web"]
        if a.get("base"):
            argv += ["--base", _ref(a.get("base"))]
        if a.get("head"):
            argv += ["--head", _ref(a.get("head"))]
        return argv
    if action == "status":
        return ["git", "status"]
    raise RepoError(f"Unknown action: {action}")
