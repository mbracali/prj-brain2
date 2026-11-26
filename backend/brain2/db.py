"""SQLite storage. One connection shared across threads, guarded by a lock."""

from __future__ import annotations

import json
import time
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

SCHEMA_VERSION = 1

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL            -- JSON
);

CREATE TABLE IF NOT EXISTS vaults (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  path        TEXT NOT NULL UNIQUE,
  icon        TEXT,
  internal    INTEGER NOT NULL DEFAULT 0,  -- 1 = lives in <home>/internal-vaults
  connections TEXT NOT NULL DEFAULT '{}',  -- JSON: {"repos": [...], "echoes": [...], ...}
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS folders (
  vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  path     TEXT NOT NULL,         -- posix, relative to vault root ('' = root)
  name     TEXT NOT NULL,
  parent   TEXT,
  PRIMARY KEY (vault_id, path)
);

CREATE TABLE IF NOT EXISTS files (
  vault_id    TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  path        TEXT NOT NULL,
  name        TEXT NOT NULL,      -- file name with extension
  stem        TEXT NOT NULL,      -- lowercased name without extension (link resolution)
  ext         TEXT NOT NULL,
  kind        TEXT NOT NULL,      -- markdown | pdf | text | json | yaml | image | other
  folder      TEXT NOT NULL,
  size        INTEGER NOT NULL,
  mtime       REAL NOT NULL,
  title       TEXT,
  description TEXT,
  frontmatter TEXT,               -- JSON
  PRIMARY KEY (vault_id, path)
);
CREATE INDEX IF NOT EXISTS files_stem ON files(vault_id, stem);

CREATE TABLE IF NOT EXISTS links (
  vault_id    TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  src_path    TEXT NOT NULL,
  target      TEXT NOT NULL,      -- raw link target, without #heading / |alias
  target_stem TEXT NOT NULL,      -- lowercased basename w/o .md (lookup key)
  kind        TEXT NOT NULL,      -- wiki | embed | md
  line        INTEGER NOT NULL,
  context     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS links_src ON links(vault_id, src_path);
CREATE INDEX IF NOT EXISTS links_target ON links(vault_id, target_stem);

CREATE TABLE IF NOT EXISTS tags (
  vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  path     TEXT NOT NULL,
  tag      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tags_path ON tags(vault_id, path);
CREATE INDEX IF NOT EXISTS tags_tag ON tags(vault_id, tag);

CREATE TABLE IF NOT EXISTS headings (
  vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  path     TEXT NOT NULL,
  level    INTEGER NOT NULL,
  text     TEXT NOT NULL,
  line     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS headings_path ON headings(vault_id, path);

CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
  vault_id UNINDEXED,
  path UNINDEXED,
  title,
  content,
  tokenize = 'unicode61 remove_diacritics 2'
);
"""


class Database:
    def __init__(self, path: Path | str, settings_file: Path | str | None = None):
        """``settings_file``: user settings live in this JSON file (outside the index database)."""
        self.path = str(path)
        self.settings_file = Path(settings_file) if settings_file else None
        self._conn = sqlite3.connect(self.path, check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.RLock()
        with self._lock:
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.execute("PRAGMA foreign_keys=ON")
            self._conn.executescript(SCHEMA)
            self._conn.execute(
                "INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', ?)",
                (str(SCHEMA_VERSION),),
            )
        if self.settings_file and not self.settings_file.exists():
            # One-time move: settings used to be stored in the database.
            old = {r["key"]: json.loads(r["value"]) for r in self.query("SELECT key, value FROM settings")}
            self._write_settings(old)

    @contextmanager
    def tx(self) -> Iterator[sqlite3.Connection]:
        """Serialized transaction."""
        with self._lock:
            self._conn.execute("BEGIN")
            try:
                yield self._conn
            except BaseException:
                self._conn.execute("ROLLBACK")
                raise
            else:
                self._conn.execute("COMMIT")

    def query(self, sql: str, params: tuple | dict = ()) -> list[sqlite3.Row]:
        with self._lock:
            return self._conn.execute(sql, params).fetchall()

    def one(self, sql: str, params: tuple | dict = ()) -> sqlite3.Row | None:
        with self._lock:
            return self._conn.execute(sql, params).fetchone()

    def execute(self, sql: str, params: tuple | dict = ()) -> None:
        with self._lock:
            self._conn.execute(sql, params)

    # -- settings -------------------------------------------------------
    def _read_settings(self) -> dict[str, Any]:
        assert self.settings_file
        try:
            data = json.loads(self.settings_file.read_text("utf-8"))
            return data if isinstance(data, dict) else {}
        except FileNotFoundError:
            return {}
        except ValueError:
            # Never overwrite a file the user broke by hand: keep a copy, then start clean.
            backup = self.settings_file.with_name(f"settings.broken-{int(time.time())}.json")
            try:
                self.settings_file.replace(backup)
            except OSError:
                pass
            return {}

    def _write_settings(self, data: dict[str, Any]) -> None:
        assert self.settings_file
        self.settings_file.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.settings_file.with_name(self.settings_file.name + ".tmp")
        tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False, sort_keys=True) + "\n", "utf-8")
        tmp.replace(self.settings_file)

    def get_settings(self) -> dict[str, Any]:
        if self.settings_file:
            with self._lock:
                return self._read_settings()
        return {r["key"]: json.loads(r["value"]) for r in self.query("SELECT key, value FROM settings")}

    def update_settings(self, values: dict[str, Any]) -> dict[str, Any]:
        if self.settings_file:
            with self._lock:
                data = self._read_settings()
                for k, v in values.items():
                    if v is None:
                        data.pop(k, None)
                    else:
                        data[k] = v
                self._write_settings(data)
                return data
        with self.tx() as c:
            for k, v in values.items():
                if v is None:
                    c.execute("DELETE FROM settings WHERE key = ?", (k,))
                else:
                    c.execute(
                        "INSERT INTO settings(key, value) VALUES (?, ?) "
                        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                        (k, json.dumps(v)),
                    )
        return self.get_settings()

    def close(self) -> None:
        with self._lock:
            self._conn.close()
