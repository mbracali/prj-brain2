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


class AttachmentUpload(BaseModel):
    folder: str = ""
    name: str
    data_base64: str


# --------------------------------------------------------------------------- app factory
def create_app(
    config: Config | None = None,
    token: str | None = None,
    static_dir: str | Path | None = None,
    watch: bool = True,
) -> FastAPI:
    config = config or load_config()
    db = Database(config.db_path)
    bus = EventBus()
    vaults = VaultService(db, config, bus)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        if watch:
            await asyncio.to_thread(vaults.start_watching)
        yield
        vaults.stop_watching()
        db.close()

    app = FastAPI(title="BRAIN2", version=__version__, lifespan=lifespan)
    app.state.vaults = vaults
    app.state.db = db
    app.state.bus = bus
    app.state.config = config
    app.state.token = token

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],  # every request still needs the bearer token
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.exception_handler(VaultError)
    async def vault_error(_: Request, exc: VaultError):
        return JSONResponse({"detail": str(exc)}, status_code=exc.status)

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
    def graph(vault_id: str, attachments: bool = False, unresolved: bool = True):
        return vaults.graph(vault_id, attachments, unresolved)

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
