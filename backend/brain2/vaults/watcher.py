"""Watches vault folders and keeps the index in sync with external edits."""

from __future__ import annotations

import threading
from pathlib import Path
from typing import TYPE_CHECKING

from watchdog.events import FileSystemEvent, FileSystemEventHandler
from watchdog.observers import Observer

if TYPE_CHECKING:
    from .service import VaultService

DEBOUNCE_SECONDS = 0.35


class _Handler(FileSystemEventHandler):
    def __init__(self, watcher: "VaultWatcher", vault_id: str, root: Path):
        self.watcher, self.vault_id, self.root = watcher, vault_id, root.resolve()

    def _rel(self, path: str | bytes) -> str | None:
        if isinstance(path, bytes):
            path = path.decode()
        try:
            rel = Path(path).resolve().relative_to(self.root).as_posix()
        except (ValueError, OSError):
            return None
        if rel == ".":
            return None
        if any(part.startswith(".") for part in rel.split("/")):
            return None  # .brain2, .git, temp files, dotfiles
        return rel

    def on_any_event(self, event: FileSystemEvent) -> None:
        if event.event_type in ("opened", "closed", "closed_no_write"):
            return
        if event.is_directory and event.event_type == "modified":
            return  # child changes are reported individually
        for raw in (event.src_path, getattr(event, "dest_path", "")):
            if raw:
                rel = self._rel(raw)
                if rel:
                    self.watcher.queue(self.vault_id, rel)


class VaultWatcher:
    def __init__(self, service: "VaultService"):
        self.service = service
        self.observer = Observer()
        self.watches: dict[str, object] = {}
        self.pending: dict[str, set[str]] = {}
        self.lock = threading.Lock()
        self.timer: threading.Timer | None = None

    def start(self) -> None:
        self.observer.daemon = True
        self.observer.start()

    def stop(self) -> None:
        self.observer.stop()
        if self.timer:
            self.timer.cancel()

    def watch(self, vault_id: str, root: Path) -> None:
        self.unwatch(vault_id)
        self.watches[vault_id] = self.observer.schedule(_Handler(self, vault_id, root), str(root), recursive=True)

    def unwatch(self, vault_id: str) -> None:
        w = self.watches.pop(vault_id, None)
        if w is not None:
            try:
                self.observer.unschedule(w)
            except (KeyError, ValueError):
                pass

    def queue(self, vault_id: str, rel: str) -> None:
        with self.lock:
            self.pending.setdefault(vault_id, set()).add(rel)
            if self.timer:
                self.timer.cancel()
            self.timer = threading.Timer(DEBOUNCE_SECONDS, self.flush)
            self.timer.daemon = True
            self.timer.start()

    def flush(self) -> None:
        with self.lock:
            pending, self.pending = self.pending, {}
        for vault_id, paths in pending.items():
            # Shallowest first so folder events cover their children.
            done: list[str] = []
            for rel in sorted(paths, key=lambda p: (p.count("/"), p)):
                if any(rel.startswith(d + "/") for d in done):
                    continue
                try:
                    self.service.index_path(vault_id, rel)
                    done.append(rel)
                except Exception:
                    continue
            if done:
                self.service.bus.publish({"type": "vault.changed", "vault_id": vault_id,
                                          "paths": sorted(paths), "origin": "fs"})
