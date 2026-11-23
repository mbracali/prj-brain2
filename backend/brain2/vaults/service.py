"""Vault service: registry, file operations, indexing, queries.

A vault is a plain folder on disk (exactly like an Obsidian vault). BRAIN2
keeps its per-vault bookkeeping inside ``<vault>/.brain2/``::

    .brain2/vault.json                 vault identity + module connections
    .brain2/index/<path>.json          one sidecar per document
    .brain2/index/<folder>/__folder__.json   one sidecar per folder
    .brain2/trash/<timestamp>/...      deleted files (recoverable)

Everything is also indexed into the global SQLite database.
"""

from __future__ import annotations

import base64
import json
import os
import posixpath
import re
import shutil
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable

from ..config import Config
from ..db import Database
from .markdown import (
    kind_for_ext,
    link_stem,
    parse_markdown,
    rewrite_wikilinks,
    shorten,
    split_ext,
)

META_DIR = ".brain2"
FOLDER_SIDECAR = "__folder__.json"
TEXT_KINDS = {"markdown", "text", "json", "yaml"}
MAX_TEXT_BYTES = 20 * 1024 * 1024
MAX_FTS_CHARS = 2_000_000


class VaultError(Exception):
    status = 400


class NotFound(VaultError):
    status = 404


class Conflict(VaultError):
    status = 409


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def is_hidden(rel: str) -> bool:
    return any(part.startswith(".") for part in rel.split("/") if part)


def norm_rel(rel: str | None) -> str:
    """Normalize a user supplied vault-relative path; reject escapes."""
    rel = (rel or "").replace("\\", "/").strip()
    rel = rel.strip("/")
    if not rel:
        return ""
    parts = []
    for part in rel.split("/"):
        if part in ("", "."):
            continue
        if part == "..":
            raise VaultError("Path may not contain '..'")
        parts.append(part)
    out = "/".join(parts)
    if is_hidden(out):
        raise VaultError("Hidden paths (starting with '.') are not allowed")
    return out


INVALID_NAME_RE = re.compile(r'[\\/:*?"<>|\x00-\x1f]')


def check_name(name: str) -> str:
    name = name.strip()
    if not name or name in (".", "..") or name.startswith("."):
        raise VaultError("Invalid name")
    if INVALID_NAME_RE.search(name):
        raise VaultError('Names cannot contain any of: \\ / : * ? " < > |')
    return name


class EventBus:
    """Thread-safe pub/sub used to push change notifications to clients."""

    def __init__(self) -> None:
        self._subs: list[Callable[[dict], None]] = []
        self._lock = threading.Lock()

    def subscribe(self, fn: Callable[[dict], None]) -> Callable[[], None]:
        with self._lock:
            self._subs.append(fn)

        def unsubscribe() -> None:
            with self._lock:
                if fn in self._subs:
                    self._subs.remove(fn)

        return unsubscribe

    def publish(self, event: dict) -> None:
        with self._lock:
            subs = list(self._subs)
        for fn in subs:
            try:
                fn(event)
            except Exception:  # pragma: no cover - subscribers must not break publishers
                pass


def pick_link(target: str, src_path: str | None, candidates: Iterable[str]) -> str | None:
    """Obsidian-style link resolution among ``candidates`` (paths whose stem matches).

    Order: exact vault path -> path relative to the source note -> shortest
    path whose tail matches the link.
    """
    t = target.strip().replace("\\", "/")
    base = posixpath.basename(t)
    _, ext = split_ext(base)
    names = [base.lower()] if ext else [base.lower() + ".md", base.lower() + ".markdown", base.lower()]
    cands = [p for p in candidates if posixpath.basename(p).lower() in names]
    if not cands:
        return None
    by_lower = {p.lower(): p for p in cands}
    tdir = posixpath.dirname(t.lstrip("/"))
    for n in names:
        key = posixpath.join(tdir, n).lower() if tdir else n
        if key in by_lower:
            return by_lower[key]
    if src_path is not None and not t.startswith("/"):
        sdir = posixpath.dirname(src_path)
        for n in names:
            joined = posixpath.normpath(posixpath.join(sdir, posixpath.dirname(t), n)).lower()
            if joined in by_lower:
                return by_lower[joined]
    if tdir:
        suffixes = [(tdir + "/" + n).lower() for n in names]
        cands = [p for p in cands if any(p.lower().endswith("/" + s) for s in suffixes)]
        if not cands:
            return None
    return sorted(cands, key=lambda p: (p.count("/"), len(p), p))[0]


class VaultService:
    def __init__(self, db: Database, config: Config, bus: EventBus | None = None):
        self.db = db
        self.config = config
        self.bus = bus or EventBus()
        self.watcher = None  # set by start_watching()

    # ------------------------------------------------------------------ registry
    def _vault_row(self, vault_id: str) -> dict[str, Any]:
        row = self.db.one("SELECT * FROM vaults WHERE id = ?", (vault_id,))
        if not row:
            raise NotFound(f"Vault {vault_id} not found")
        return self._vault_dict(row)

    def _vault_dict(self, row) -> dict[str, Any]:
        d = dict(row)
        d["internal"] = bool(d["internal"])
        d["connections"] = json.loads(d["connections"] or "{}")
        counts = self.db.one(
            "SELECT COUNT(*) AS files, SUM(kind = 'markdown') AS notes FROM files WHERE vault_id = ?",
            (d["id"],),
        )
        d["file_count"] = counts["files"] or 0
        d["note_count"] = counts["notes"] or 0
        d["exists"] = Path(d["path"]).is_dir()
        return d

    def list_vaults(self) -> list[dict[str, Any]]:
        rows = self.db.query("SELECT * FROM vaults ORDER BY sort_order, lower(name)")
        return [self._vault_dict(r) for r in rows]

    def get_vault(self, vault_id: str) -> dict[str, Any]:
        return self._vault_row(vault_id)

    def root(self, vault_id: str) -> Path:
        path = Path(self._vault_row(vault_id)["path"])
        if not path.is_dir():
            raise NotFound(f"Vault folder is missing: {path}")
        return path

    def abs_path(self, vault_id: str, rel: str) -> Path:
        root = self.root(vault_id)
        rel = norm_rel(rel)
        p = (root / rel) if rel else root
        resolved = p.resolve()
        if resolved != root.resolve() and root.resolve() not in resolved.parents:
            raise VaultError("Path escapes the vault")
        return p

    def create_vault(
        self,
        name: str,
        path: str | None = None,
        icon: str | None = None,
        connections: dict | None = None,
    ) -> dict[str, Any]:
        name = check_name(name)
        if path:
            folder = Path(path).expanduser().resolve()
            if folder.exists() and not folder.is_dir():
                raise VaultError(f"Not a folder: {folder}")
            internal = False
        else:
            folder = self.config.vaults_dir / name
            if folder.exists() and any(folder.iterdir()):
                raise Conflict(f"A folder named '{name}' already exists in internal-vaults")
            internal = True
        if self.db.one("SELECT id FROM vaults WHERE path = ?", (str(folder),)):
            raise Conflict("This folder is already registered as a vault")
        folder.mkdir(parents=True, exist_ok=True)

        vault_id = uuid.uuid4().hex[:12]
        identity_file = folder / META_DIR / "vault.json"
        if identity_file.exists():
            try:
                old = json.loads(identity_file.read_text("utf-8"))
                old_id = str(old.get("id") or "")
                if re.fullmatch(r"[0-9a-f]{12}", old_id) and not self.db.one(
                    "SELECT 1 FROM vaults WHERE id = ?", (old_id,)
                ):
                    vault_id = old_id
                    connections = connections or old.get("connections")
            except (OSError, ValueError):
                pass

        ts = now_iso()
        order = (self.db.one("SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM vaults") or {"n": 1})["n"]
        self.db.execute(
            "INSERT INTO vaults(id, name, path, icon, internal, connections, sort_order, created_at, updated_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (vault_id, name, str(folder), icon, int(internal), json.dumps(connections or {}), order, ts, ts),
        )
        self._write_identity(vault_id)
        self.index_vault(vault_id)
        if self.watcher:
            self.watcher.watch(vault_id, folder)
        vault = self.get_vault(vault_id)
        self.bus.publish({"type": "vaults.changed"})
        return vault

    def update_vault(self, vault_id: str, **fields: Any) -> dict[str, Any]:
        self._vault_row(vault_id)
        sets, params = [], []
        if fields.get("name") is not None:
            sets.append("name = ?")
            params.append(check_name(fields["name"]))
        if "icon" in fields and fields["icon"] is not None:
            sets.append("icon = ?")
            params.append(fields["icon"] or None)
        if fields.get("connections") is not None:
            sets.append("connections = ?")
            params.append(json.dumps(fields["connections"]))
        if fields.get("sort_order") is not None:
            sets.append("sort_order = ?")
            params.append(int(fields["sort_order"]))
        if sets:
            sets.append("updated_at = ?")
            params.append(now_iso())
            self.db.execute(f"UPDATE vaults SET {', '.join(sets)} WHERE id = ?", (*params, vault_id))
            self._write_identity(vault_id)
            self.bus.publish({"type": "vaults.changed"})
        return self.get_vault(vault_id)

    def delete_vault(self, vault_id: str, delete_files: bool = False) -> None:
        vault = self._vault_row(vault_id)
        if self.watcher:
            self.watcher.unwatch(vault_id)
        with self.db.tx() as c:
            c.execute("DELETE FROM files_fts WHERE vault_id = ?", (vault_id,))
            c.execute("DELETE FROM vaults WHERE id = ?", (vault_id,))
        if delete_files:
            if not vault["internal"]:
                raise VaultError("Only vaults created inside BRAIN2 can have their files deleted")
            shutil.rmtree(vault["path"], ignore_errors=True)
        self.bus.publish({"type": "vaults.changed"})

    def _write_identity(self, vault_id: str) -> None:
        v = self._vault_row(vault_id)
        meta = Path(v["path"]) / META_DIR
        meta.mkdir(exist_ok=True)
        data = {
            "id": v["id"],
            "name": v["name"],
            "icon": v["icon"],
            "created_at": v["created_at"],
            "updated_at": v["updated_at"],
            "connections": v["connections"],
            "app": "BRAIN2",
        }
        (meta / "vault.json").write_text(json.dumps(data, indent=2, ensure_ascii=False), "utf-8")

    # ------------------------------------------------------------------ indexing
    def _walk(self, root: Path) -> tuple[list[str], list[str]]:
        folders, files = [], []
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
            rel_dir = Path(dirpath).relative_to(root).as_posix()
            rel_dir = "" if rel_dir == "." else rel_dir
            if rel_dir:
                folders.append(rel_dir)
            for f in sorted(filenames):
                if not f.startswith("."):
                    files.append(f"{rel_dir}/{f}" if rel_dir else f)
        return folders, files

    def index_vault(self, vault_id: str, force: bool = False) -> dict[str, int]:
        root = self.root(vault_id)
        folders, files = self._walk(root)
        known = {
            r["path"]: (r["mtime"], r["size"])
            for r in self.db.query("SELECT path, mtime, size FROM files WHERE vault_id = ?", (vault_id,))
        }
        indexed = 0
        for rel in files:
            try:
                st = (root / rel).stat()
            except OSError:
                continue
            if force or known.get(rel) != (st.st_mtime, st.st_size):
                self._index_file(vault_id, root, rel, write_folder_sidecar=False)
                indexed += 1
        file_set = set(files)
        removed = 0
        for rel in known.keys() - file_set:
            self._remove_file_rows(vault_id, rel)
            self._remove_sidecar(root, rel)
            removed += 1
        with self.db.tx() as c:
            c.execute("DELETE FROM folders WHERE vault_id = ?", (vault_id,))
            c.execute("INSERT INTO folders(vault_id, path, name, parent) VALUES (?, '', ?, NULL)",
                      (vault_id, root.name))
            for f in folders:
                c.execute(
                    "INSERT INTO folders(vault_id, path, name, parent) VALUES (?, ?, ?, ?)",
                    (vault_id, f, posixpath.basename(f), posixpath.dirname(f)),
                )
        for f in ["", *folders]:
            self._write_folder_sidecar(vault_id, root, f)
        self._prune_sidecars(root, file_set, set(folders))
        return {"files": len(files), "indexed": indexed, "removed": removed, "folders": len(folders)}

    def index_path(self, vault_id: str, rel: str) -> None:
        """(Re)index a single file or folder after a change; handles deletions."""
        root = self.root(vault_id)
        p = root / rel if rel else root
        if is_hidden(rel):
            return
        if p.is_dir():
            folders, files = self._walk(p)
            prefix = f"{rel}/" if rel else ""
            self._ensure_folder(vault_id, rel)
            for f in folders:
                self._ensure_folder(vault_id, prefix + f)
            known = {
                r["path"]: (r["mtime"], r["size"])
                for r in self.db.query(
                    r"SELECT path, mtime, size FROM files WHERE vault_id = ? AND path LIKE ? ESCAPE '\'",
                    (vault_id, prefix.replace("%", r"\%").replace("_", r"\_") + "%"),
                )
            }
            for f in files:
                try:
                    st = (root / (prefix + f)).stat()
                except OSError:
                    continue
                if known.get(prefix + f) != (st.st_mtime, st.st_size):
                    self._index_file(vault_id, root, prefix + f, write_folder_sidecar=False)
            for f in ["", *folders]:
                self._write_folder_sidecar(vault_id, root, (prefix + f).rstrip("/"))
            self._write_folder_sidecar(vault_id, root, posixpath.dirname(rel))
        elif p.is_file():
            self._index_file(vault_id, root, rel)
        else:
            self.remove_path(vault_id, rel)

    def remove_path(self, vault_id: str, rel: str) -> None:
        root = self.root(vault_id)
        like = rel.replace("%", r"\%").replace("_", r"\_") + "/%"
        rows = self.db.query(
            r"SELECT path FROM files WHERE vault_id = ? AND (path = ? OR path LIKE ? ESCAPE '\')",
            (vault_id, rel, like),
        )
        for r in rows:
            self._remove_file_rows(vault_id, r["path"])
            self._remove_sidecar(root, r["path"])
        self.db.execute(
            r"DELETE FROM folders WHERE vault_id = ? AND (path = ? OR path LIKE ? ESCAPE '\')",
            (vault_id, rel, like),
        )
        side_dir = root / META_DIR / "index" / rel
        if rel and side_dir.is_dir():
            shutil.rmtree(side_dir, ignore_errors=True)
        self._write_folder_sidecar(vault_id, root, posixpath.dirname(rel))

    def _ensure_folder(self, vault_id: str, rel: str) -> None:
        while True:
            self.db.execute(
                "INSERT OR IGNORE INTO folders(vault_id, path, name, parent) VALUES (?, ?, ?, ?)",
                (vault_id, rel, posixpath.basename(rel), posixpath.dirname(rel) if rel else None),
            )
            if not rel:
                return
            rel = posixpath.dirname(rel)

    def _remove_file_rows(self, vault_id: str, rel: str) -> None:
        with self.db.tx() as c:
            for table, col in (("files", "path"), ("links", "src_path"), ("tags", "path"),
                               ("headings", "path"), ("files_fts", "path")):
                c.execute(f"DELETE FROM {table} WHERE vault_id = ? AND {col} = ?", (vault_id, rel))

    def _index_file(self, vault_id: str, root: Path, rel: str, write_folder_sidecar: bool = True) -> None:
        p = root / rel
        try:
            st = p.stat()
        except OSError:
            return
        name = posixpath.basename(rel)
        stem, ext = split_ext(name)
        if not ext and "." in name:
            ext = name.rsplit(".", 1)[1].lower()
            stem = name.rsplit(".", 1)[0]
        kind = kind_for_ext(ext)
        folder = posixpath.dirname(rel)
        title, description, frontmatter = None, "", {}
        links, tags, headings = [], [], []
        content = ""

        if kind in TEXT_KINDS and st.st_size <= MAX_TEXT_BYTES:
            try:
                content = p.read_text("utf-8", errors="replace")
            except OSError:
                content = ""
            if kind == "markdown":
                note = parse_markdown(content)
                title, description, frontmatter = note.title, note.description, note.frontmatter
                links, tags, headings = note.links, note.tags, note.headings
            else:
                description = shorten(" ".join(content.split()), 200)
        elif kind == "pdf":
            content, pages = self._pdf_text(p)
            description = shorten(" ".join(content.split()), 200) or (f"PDF, {pages} pages" if pages else "PDF")

        with self.db.tx() as c:
            for table, col in (("links", "src_path"), ("tags", "path"), ("headings", "path"),
                               ("files_fts", "path")):
                c.execute(f"DELETE FROM {table} WHERE vault_id = ? AND {col} = ?", (vault_id, rel))
            c.execute(
                "INSERT INTO files(vault_id, path, name, stem, ext, kind, folder, size, mtime, title,"
                " description, frontmatter) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
                " ON CONFLICT(vault_id, path) DO UPDATE SET name = excluded.name, stem = excluded.stem,"
                " ext = excluded.ext, kind = excluded.kind, folder = excluded.folder, size = excluded.size,"
                " mtime = excluded.mtime, title = excluded.title, description = excluded.description,"
                " frontmatter = excluded.frontmatter",
                (vault_id, rel, name, stem.lower(), ext, kind, folder, st.st_size, st.st_mtime, title,
                 description, json.dumps(frontmatter, ensure_ascii=False)),
            )
            c.executemany(
                "INSERT INTO links(vault_id, src_path, target, target_stem, kind, line, context)"
                " VALUES (?, ?, ?, ?, ?, ?, ?)",
                [(vault_id, rel, ln.target or rel, ln.target_stem if ln.target else link_stem(rel),
                  ln.kind, ln.line, ln.context[:300]) for ln in links],
            )
            c.executemany(
                "INSERT INTO tags(vault_id, path, tag) VALUES (?, ?, ?)",
                [(vault_id, rel, t) for t in tags],
            )
            c.executemany(
                "INSERT INTO headings(vault_id, path, level, text, line) VALUES (?, ?, ?, ?, ?)",
                [(vault_id, rel, h.level, h.text, h.line) for h in headings],
            )
            c.execute(
                "INSERT INTO files_fts(vault_id, path, title, content) VALUES (?, ?, ?, ?)",
                (vault_id, rel, f"{stem} {title or ''}".strip(), content[:MAX_FTS_CHARS]),
            )
        self._ensure_folder(vault_id, folder)
        self._write_sidecar(root, rel, {
            "path": rel,
            "name": name,
            "parent_folder": folder,
            "description": description,
            "kind": kind,
            "title": title,
            "tags": tags,
            "size": st.st_size,
            "modified": datetime.fromtimestamp(st.st_mtime, timezone.utc).isoformat(timespec="seconds"),
        })
        if write_folder_sidecar:
            self._write_folder_sidecar(vault_id, root, folder)

    @staticmethod
    def _pdf_text(p: Path) -> tuple[str, int]:
        try:
            from pypdf import PdfReader

            reader = PdfReader(str(p))
            pages = len(reader.pages)
            parts = []
            for page in reader.pages[:300]:
                try:
                    parts.append(page.extract_text() or "")
                except Exception:
                    continue
            return "\n".join(parts), pages
        except Exception:
            return "", 0

    # ------------------------------------------------------------------ sidecars
    @staticmethod
    def _write_json_if_changed(target: Path, data: dict) -> None:
        text = json.dumps(data, indent=2, ensure_ascii=False)
        try:
            if target.read_text("utf-8") == text:
                return
        except OSError:
            pass
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, "utf-8")

    def _write_sidecar(self, root: Path, rel: str, data: dict) -> None:
        self._write_json_if_changed(root / META_DIR / "index" / f"{rel}.json", data)

    def _remove_sidecar(self, root: Path, rel: str) -> None:
        try:
            (root / META_DIR / "index" / f"{rel}.json").unlink()
        except OSError:
            pass

    def _write_folder_sidecar(self, vault_id: str, root: Path, rel: str) -> None:
        folder = root / rel if rel else root
        if not folder.is_dir():
            return
        files = self.db.query(
            "SELECT name, kind FROM files WHERE vault_id = ? AND folder = ? ORDER BY lower(name)",
            (vault_id, rel),
        )
        subfolders = self.db.query(
            "SELECT name FROM folders WHERE vault_id = ? AND parent = ? ORDER BY lower(name)",
            (vault_id, rel),
        )
        data = {
            "path": rel,
            "name": folder.name if rel else root.name,
            "parent_folder": posixpath.dirname(rel) if rel else None,
            "description": f"{len(files)} files, {len(subfolders)} folders",
            "folders": [r["name"] for r in subfolders],
            "files": [{"name": r["name"], "kind": r["kind"]} for r in files],
        }
        self._write_json_if_changed(root / META_DIR / "index" / rel / FOLDER_SIDECAR, data)

    def _prune_sidecars(self, root: Path, files: set[str], folders: set[str]) -> None:
        index_dir = root / META_DIR / "index"
        if not index_dir.is_dir():
            return
        for dirpath, dirnames, filenames in os.walk(index_dir, topdown=False):
            rel_dir = Path(dirpath).relative_to(index_dir).as_posix()
            rel_dir = "" if rel_dir == "." else rel_dir
            for f in filenames:
                if f == FOLDER_SIDECAR:
                    if rel_dir and rel_dir not in folders:
                        os.unlink(os.path.join(dirpath, f))
                    continue
                src = f"{rel_dir}/{f[:-5]}" if rel_dir else f[:-5]
                if not f.endswith(".json") or src not in files:
                    os.unlink(os.path.join(dirpath, f))
            if rel_dir and not os.listdir(dirpath):
                os.rmdir(dirpath)

    def sidecar(self, vault_id: str, rel: str) -> dict[str, Any]:
        root = self.root(vault_id)
        rel = norm_rel(rel)
        p = root / rel if rel else root
        target = (root / META_DIR / "index" / rel / FOLDER_SIDECAR) if p.is_dir() else (
            root / META_DIR / "index" / f"{rel}.json")
        try:
            return json.loads(target.read_text("utf-8"))
        except (OSError, ValueError):
            raise NotFound("No index entry for this path")

    # ------------------------------------------------------------------ tree / listing
    def tree(self, vault_id: str) -> dict[str, Any]:
        root = self.root(vault_id)
        folders = self.db.query("SELECT path, name FROM folders WHERE vault_id = ?", (vault_id,))
        files = self.db.query(
            "SELECT path, name, kind, ext, size, mtime, title FROM files WHERE vault_id = ?", (vault_id,)
        )
        nodes: dict[str, dict] = {"": {"type": "folder", "path": "", "name": root.name, "children": []}}
        for f in sorted(folders, key=lambda r: r["path"]):
            if f["path"]:
                nodes[f["path"]] = {"type": "folder", "path": f["path"], "name": f["name"], "children": []}
        for path in sorted(nodes):
            if path:
                parent = nodes.get(posixpath.dirname(path)) or nodes[""]
                parent["children"].append(nodes[path])
        for f in files:
            parent = nodes.get(posixpath.dirname(f["path"])) or nodes[""]
            parent["children"].append({"type": "file", **dict(f)})
        return nodes[""]

    def list_files(self, vault_id: str, kind: str | None = None) -> list[dict[str, Any]]:
        sql = "SELECT path, name, kind, ext, title, description, size, mtime FROM files WHERE vault_id = ?"
        params: tuple = (vault_id,)
        if kind:
            sql += " AND kind = ?"
            params += (kind,)
        return [dict(r) for r in self.db.query(sql + " ORDER BY mtime DESC", params)]

    # ------------------------------------------------------------------ file ops
    def _file_info(self, vault_id: str, rel: str) -> dict[str, Any]:
        row = self.db.one(
            "SELECT path, name, kind, ext, folder, size, mtime, title, description, frontmatter"
            " FROM files WHERE vault_id = ? AND path = ?",
            (vault_id, rel),
        )
        if not row:
            raise NotFound(f"File not indexed: {rel}")
        d = dict(row)
        d["frontmatter"] = json.loads(d["frontmatter"] or "{}")
        d["tags"] = [r["tag"] for r in self.db.query(
            "SELECT tag FROM tags WHERE vault_id = ? AND path = ?", (vault_id, rel))]
        return d

    def read_file(self, vault_id: str, rel: str) -> dict[str, Any]:
        rel = norm_rel(rel)
        p = self.abs_path(vault_id, rel)
        if not p.is_file():
            raise NotFound(f"No such file: {rel}")
        if not self.db.one("SELECT 1 FROM files WHERE vault_id = ? AND path = ?", (vault_id, rel)):
            self.index_path(vault_id, rel)
        info = self._file_info(vault_id, rel)
        if info["kind"] in TEXT_KINDS:
            if info["size"] > MAX_TEXT_BYTES:
                raise VaultError("File too large to open as text")
            info["content"] = p.read_text("utf-8", errors="replace")
        return info

    def write_file(self, vault_id: str, rel: str, content: str, create_only: bool = False) -> dict[str, Any]:
        rel = norm_rel(rel)
        if not rel:
            raise VaultError("A file path is required")
        check_name(posixpath.basename(rel))
        p = self.abs_path(vault_id, rel)
        if p.is_dir():
            raise Conflict("A folder with this name already exists")
        if create_only and p.exists():
            raise Conflict(f"'{rel}' already exists")
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_name(f".{p.name}.brain2-tmp")
        tmp.write_text(content, "utf-8", newline="")
        os.replace(tmp, p)
        self.index_path(vault_id, rel)
        self.bus.publish({"type": "vault.changed", "vault_id": vault_id, "paths": [rel], "origin": "api"})
        return self._file_info(vault_id, rel)

    def _unique(self, root: Path, folder: str, stem: str, ext: str) -> str:
        suffix = f".{ext}" if ext else ""
        for i in range(0, 10_000):
            name = f"{stem}{'' if i == 0 else f' {i}'}{suffix}"
            rel = f"{folder}/{name}" if folder else name
            if not (root / rel).exists():
                return rel
        raise Conflict("Could not find a free name")

    def create_file(self, vault_id: str, folder: str = "", name: str | None = None,
                    ext: str = "md", content: str = "") -> dict[str, Any]:
        folder = norm_rel(folder)
        root = self.root(vault_id)
        ext = ext.lstrip(".").lower()
        if name:
            stem, given_ext = split_ext(check_name(name))
            ext = given_ext or ext
            rel = f"{folder}/{stem}.{ext}" if folder else f"{stem}.{ext}"
            if (root / rel).exists():
                raise Conflict(f"'{rel}' already exists")
        else:
            rel = self._unique(root, folder, "Untitled", ext)
        return self.write_file(vault_id, rel, content, create_only=True)

    def create_folder(self, vault_id: str, parent: str = "", name: str | None = None) -> dict[str, Any]:
        parent = norm_rel(parent)
        root = self.root(vault_id)
        if name:
            rel = norm_rel(f"{parent}/{check_name(name)}")
            if (root / rel).exists():
                raise Conflict(f"'{rel}' already exists")
        else:
            rel = self._unique(root, parent, "Untitled", "")
        (root / rel).mkdir(parents=True)
        self.index_path(vault_id, rel)
        self.bus.publish({"type": "vault.changed", "vault_id": vault_id, "paths": [rel], "origin": "api"})
        return {"path": rel, "name": posixpath.basename(rel), "type": "folder"}

    def move(self, vault_id: str, src: str, dst: str, update_links: bool = True) -> dict[str, Any]:
        """Rename / move a file or folder. Updates [[wikilinks]] pointing at it."""
        src, dst = norm_rel(src), norm_rel(dst)
        if not src or not dst:
            raise VaultError("Source and destination are required")
        check_name(posixpath.basename(dst))
        root = self.root(vault_id)
        sp, dp = root / src, root / dst
        if not sp.exists():
            raise NotFound(f"No such file or folder: {src}")
        if src == dst:
            return {"path": dst}
        if dp.exists() and src.lower() != dst.lower():
            raise Conflict(f"'{dst}' already exists")
        if sp.is_dir() and (dst + "/").startswith(src + "/"):
            raise VaultError("Cannot move a folder into itself")

        # Collect inbound links before the move so we can rewrite them afterwards.
        moved_files = [src] if sp.is_file() else [
            r["path"] for r in self.db.query(
                r"SELECT path FROM files WHERE vault_id = ? AND path LIKE ? ESCAPE '\'",
                (vault_id, src.replace("%", r"\%").replace("_", r"\_") + "/%"),
            )
        ]
        rename_map = {old: dst + old[len(src):] for old in moved_files}
        inbound: dict[str, set[str]] = {}
        if update_links:
            for old in moved_files:
                for bl in self.backlinks(vault_id, old):
                    if bl["path"] in rename_map:
                        continue
                    inbound.setdefault(bl["path"], set()).add(old)

        dp.parent.mkdir(parents=True, exist_ok=True)
        os.replace(sp, dp)
        self.remove_path(vault_id, src)
        self.index_path(vault_id, dst)

        changed = [src, dst]
        for note, olds in inbound.items():
            if self._rewrite_links(vault_id, note, {o: rename_map[o] for o in olds}):
                changed.append(note)
        self.bus.publish({"type": "vault.changed", "vault_id": vault_id, "paths": changed,
                          "origin": "api", "moved": {"from": src, "to": dst}})
        return {"path": dst, "updated_links_in": changed[2:]}

    def _rewrite_links(self, vault_id: str, note: str, renames: dict[str, str]) -> bool:
        root = self.root(vault_id)
        p = root / note
        try:
            text = p.read_text("utf-8")
        except OSError:
            return False
        stems = {link_stem(posixpath.basename(o)) for o in renames}
        new_stems = {}
        for old, new in renames.items():
            base = posixpath.basename(new)
            stem, ext = split_ext(base)
            label = stem if ext in ("md", "markdown") else base
            dupes = self.db.query("SELECT path FROM files WHERE vault_id = ? AND stem = ?",
                                  (vault_id, stem.lower()))
            if len(dupes) > 1:
                label = new[: -(len(ext) + 1)] if ext in ("md", "markdown") else new
            new_stems[old] = label

        def old_target(target: str) -> str | None:
            if link_stem(target) not in stems:
                return None
            return pick_link(target, note, renames.keys())

        new_text = rewrite_wikilinks(text, lambda t: old_target(t) is not None,
                                     lambda t: new_stems[old_target(t)])
        if new_text != text:
            p.write_text(new_text, "utf-8", newline="")
            self.index_path(vault_id, note)
            return True
        return False

    def delete(self, vault_id: str, rel: str, permanent: bool = False) -> dict[str, Any]:
        rel = norm_rel(rel)
        if not rel:
            raise VaultError("Cannot delete the vault root")
        root = self.root(vault_id)
        p = root / rel
        if not p.exists():
            raise NotFound(f"No such file or folder: {rel}")
        trashed_to = None
        if permanent:
            shutil.rmtree(p) if p.is_dir() else p.unlink()
        else:
            stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
            dest = root / META_DIR / "trash" / stamp / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(p), str(dest))
            trashed_to = dest.relative_to(root).as_posix()
        self.remove_path(vault_id, rel)
        self.bus.publish({"type": "vault.changed", "vault_id": vault_id, "paths": [rel], "origin": "api"})
        return {"path": rel, "trashed_to": trashed_to}

    def save_attachment(self, vault_id: str, folder: str, name: str, data_b64: str) -> dict[str, Any]:
        folder = norm_rel(folder)
        root = self.root(vault_id)
        stem, ext = split_ext(check_name(name))
        if not ext and "." in name:
            stem, ext = name.rsplit(".", 1)
        rel = self._unique(root, folder, stem, ext.lower())
        target = root / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(base64.b64decode(data_b64))
        self.index_path(vault_id, rel)
        self.bus.publish({"type": "vault.changed", "vault_id": vault_id, "paths": [rel], "origin": "api"})
        return {"path": rel, "name": posixpath.basename(rel)}

    # ------------------------------------------------------------------ queries
    def resolve_link(self, vault_id: str, target: str, src_path: str | None = None) -> str | None:
        if not target.strip():
            return src_path
        rows = self.db.query("SELECT path FROM files WHERE vault_id = ? AND stem = ?",
                             (vault_id, link_stem(target)))
        return pick_link(target, src_path, [r["path"] for r in rows])

    def backlinks(self, vault_id: str, rel: str) -> list[dict[str, Any]]:
        rel = norm_rel(rel)
        row = self.db.one("SELECT stem FROM files WHERE vault_id = ? AND path = ?", (vault_id, rel))
        if not row:
            return []
        all_paths = [r["path"] for r in self.db.query(
            "SELECT path FROM files WHERE vault_id = ? AND stem = ?", (vault_id, row["stem"]))]
        out = []
        for ln in self.db.query(
            "SELECT src_path, target, kind, line, context FROM links WHERE vault_id = ? AND target_stem = ?"
            " ORDER BY src_path, line",
            (vault_id, row["stem"]),
        ):
            if ln["src_path"] == rel:
                continue
            if pick_link(ln["target"], ln["src_path"], all_paths) == rel:
                out.append({"path": ln["src_path"], "kind": ln["kind"], "line": ln["line"],
                            "context": ln["context"]})
        return out

    def outgoing_links(self, vault_id: str, rel: str) -> list[dict[str, Any]]:
        rel = norm_rel(rel)
        out = []
        for ln in self.db.query(
            "SELECT target, kind, line FROM links WHERE vault_id = ? AND src_path = ? ORDER BY line",
            (vault_id, rel),
        ):
            out.append({**dict(ln), "resolved": self.resolve_link(vault_id, ln["target"], rel)})
        return out

    def outline(self, vault_id: str, rel: str) -> list[dict[str, Any]]:
        return [dict(r) for r in self.db.query(
            "SELECT level, text, line FROM headings WHERE vault_id = ? AND path = ? ORDER BY line",
            (vault_id, norm_rel(rel)))]

    def tags(self, vault_id: str) -> list[dict[str, Any]]:
        return [dict(r) for r in self.db.query(
            "SELECT tag, COUNT(DISTINCT path) AS count FROM tags WHERE vault_id = ?"
            " GROUP BY lower(tag) ORDER BY lower(tag)", (vault_id,))]

    def search(self, vault_id: str, q: str, limit: int = 50) -> list[dict[str, Any]]:
        """Full-text search. Supports ``tag:foo`` / ``#foo``, ``path:dir`` and ``file:name``
        operators combined with free text."""
        tags, paths, files, words = [], [], [], []
        for tok in re.findall(r'"[^"]+"|\S+', q.strip()):
            low = tok.lower()
            if low.startswith("tag:"):
                tags.append(tok[4:].lstrip("#"))
            elif tok.startswith("#") and len(tok) > 1:
                tags.append(tok[1:])
            elif low.startswith("path:"):
                paths.append(tok[5:].strip('"'))
            elif low.startswith("file:"):
                files.append(tok[5:].strip('"'))
            else:
                words.append(tok.strip('"'))
        if not (tags or paths or files or words):
            return []

        where, params = ["f.vault_id = ?"], [vault_id]
        for t in tags:
            where.append("EXISTS (SELECT 1 FROM tags t WHERE t.vault_id = f.vault_id AND t.path = f.path"
                         " AND (lower(t.tag) = lower(?) OR lower(t.tag) LIKE lower(?) || '/%'))")
            params += [t, t]
        for pth in paths:
            where.append("instr(lower(f.path), lower(?)) > 0")
            params.append(pth)
        for fn in files:
            where.append("instr(lower(f.name), lower(?)) > 0")
            params.append(fn)

        if words:
            fts = " ".join('"' + w.replace('"', '""') + '"' for w in words) + "*"
            sql = (
                "SELECT f.path, f.name, f.kind, f.title, "
                " snippet(files_fts, 3, char(2), char(3), '…', 16) AS snippet,"
                " bm25(files_fts, 0, 0, 8.0, 1.0) AS rank"
                " FROM files_fts JOIN files f ON f.vault_id = files_fts.vault_id AND f.path = files_fts.path"
                f" WHERE files_fts MATCH ? AND files_fts.vault_id = ? AND {' AND '.join(where)}"
                " ORDER BY rank LIMIT ?"
            )
            rows = self.db.query(sql, (fts, vault_id, *params, limit))
        else:
            sql = ("SELECT f.path, f.name, f.kind, f.title, f.description AS snippet FROM files f"
                   f" WHERE {' AND '.join(where)} ORDER BY f.mtime DESC LIMIT ?")
            rows = self.db.query(sql, (*params, limit))
        return [dict(r) for r in rows]

    def graph(self, vault_id: str, include_attachments: bool = False,
              include_unresolved: bool = True) -> dict[str, Any]:
        files = self.db.query("SELECT path, stem, kind, title FROM files WHERE vault_id = ?", (vault_id,))
        by_stem: dict[str, list[str]] = {}
        for f in files:
            by_stem.setdefault(f["stem"], []).append(f["path"])
        nodes = {
            f["path"]: {"id": f["path"], "label": posixpath.basename(f["path"]).rsplit(".", 1)[0],
                        "kind": f["kind"]}
            for f in files if f["kind"] == "markdown" or include_attachments
        }
        edges: dict[tuple[str, str], int] = {}
        for ln in self.db.query("SELECT src_path, target, target_stem FROM links WHERE vault_id = ?",
                                (vault_id,)):
            dst = pick_link(ln["target"], ln["src_path"], by_stem.get(ln["target_stem"], []))
            if dst is None:
                if not include_unresolved:
                    continue
                dst = f"unresolved:{ln['target']}"
                nodes.setdefault(dst, {"id": dst, "label": ln["target"], "kind": "unresolved"})
            if dst not in nodes or ln["src_path"] not in nodes or dst == ln["src_path"]:
                continue
            edges[(ln["src_path"], dst)] = edges.get((ln["src_path"], dst), 0) + 1
        return {"nodes": list(nodes.values()),
                "edges": [{"source": s, "target": t, "weight": w} for (s, t), w in edges.items()]}

    # ------------------------------------------------------------------ lifecycle
    def start_watching(self) -> None:
        from .watcher import VaultWatcher

        self.watcher = VaultWatcher(self)
        for v in self.list_vaults():
            if v["exists"]:
                try:
                    self.index_vault(v["id"])
                except Exception:
                    pass
                self.watcher.watch(v["id"], Path(v["path"]))
        self.watcher.start()

    def stop_watching(self) -> None:
        if self.watcher:
            self.watcher.stop()
            self.watcher = None

