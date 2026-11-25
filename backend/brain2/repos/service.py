"""Repos module: a registry of local git repositories plus read-only views of them.

Read-only data (files, commits, pushes, branches, tags, pull requests) is read
with git/gh directly. Every action that changes a repository or talks to a
remote is typed into the repo's own terminal tab so the user sees it and their
own git/ssh/credential configuration is used.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from ..db import Database
from ..gitcli import GitError, git, git_bytes, run, toplevel, which
from ..terminals import TerminalManager

SCHEMA = """
CREATE TABLE IF NOT EXISTS repos (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  path        TEXT NOT NULL UNIQUE,
  icon        TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
"""
SEP = "\x1f"
REC = "\x1e"
MAX_FILE_BYTES = 2 * 1024 * 1024


class RepoError(Exception):
    status = 400


class RepoNotFound(RepoError):
    status = 404


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def repo_name_from_url(url: str) -> str:
    tail = url.rstrip("/").split("/")[-1].split(":")[-1]
    return tail.removesuffix(".git") or "repo"


def is_clone_url(url: str) -> bool:
    url = url.strip()
    if re.match(r"^https?://[^\s/]+/\S+", url):
        return True
    return bool(re.match(r"^(ssh://|file://|git@[^\s:]+:)\S+", url))


def web_url(remote: str | None) -> str | None:
    """Browser URL for a remote (https or scp-like ssh)."""
    if not remote:
        return None
    m = re.match(r"^git@([^:]+):(.+?)(\.git)?$", remote)
    if m:
        return f"https://{m.group(1)}/{m.group(2)}"
    m = re.match(r"^ssh://(?:[^@]+@)?([^/:]+)(?::\d+)?/(.+?)(\.git)?$", remote)
    if m:
        return f"https://{m.group(1)}/{m.group(2)}"
    if remote.startswith(("http://", "https://")):
        u = urlparse(remote)
        return f"{u.scheme}://{u.hostname}{(':' + str(u.port)) if u.port else ''}{u.path.removesuffix('.git')}"
    return None


def provider(remote: str | None) -> str | None:
    host = urlparse(web_url(remote) or "").hostname or ""
    if "github" in host:
        return "github"
    if "gitlab" in host:
        return "gitlab"
    if "dev.azure.com" in host or "visualstudio.com" in host:
        return "azure"
    if "bitbucket" in host:
        return "bitbucket"
    return "git" if host else None


class RepoService:
    def __init__(self, db: Database, terminals: TerminalManager, publish=None):
        self.db = db
        self.terms = terminals
        self.publish = publish or (lambda ev: None)
        with db._lock:  # noqa: SLF001 - module-owned table
            db._conn.executescript(SCHEMA)  # noqa: SLF001

    # ---------------------------------------------------------------- registry
    def _row(self, repo_id: str) -> dict[str, Any]:
        row = self.db.one("SELECT * FROM repos WHERE id = ?", (repo_id,))
        if not row:
            raise RepoNotFound("Repo not found")
        return dict(row)

    def path(self, repo_id: str) -> Path:
        return Path(self._row(repo_id)["path"])

    def list_repos(self, status: bool = True) -> list[dict[str, Any]]:
        rows = [dict(r) for r in self.db.query("SELECT * FROM repos ORDER BY sort_order, name COLLATE NOCASE")]
        if status and rows:
            with ThreadPoolExecutor(max_workers=8) as pool:
                stats = list(pool.map(lambda r: self.status(r["path"]), rows))
            for r, s in zip(rows, stats):
                r.update(s)
        return rows

    def get_repo(self, repo_id: str) -> dict[str, Any]:
        r = self._row(repo_id)
        r.update(self.status(r["path"]))
        return r

    def status(self, path: str) -> dict[str, Any]:
        p = Path(path)
        out: dict[str, Any] = {"exists": p.is_dir(), "is_git": False, "branch": None, "remote": None,
                               "web_url": None, "provider": None, "ahead": 0, "behind": 0, "changes": 0,
                               "upstream": None, "state": "missing"}
        if not out["exists"]:
            return out
        try:
            text = git(p, "status", "--porcelain=v2", "--branch", timeout=15)
        except GitError:
            out["state"] = "not-a-repo"
            return out
        out["is_git"] = True
        changes = 0
        for line in text.splitlines():
            if line.startswith("# branch.head "):
                out["branch"] = line.split(" ", 2)[2]
            elif line.startswith("# branch.upstream "):
                out["upstream"] = line.split(" ", 2)[2]
            elif line.startswith("# branch.ab "):
                m = re.match(r"# branch.ab \+(\d+) -(\d+)", line)
                if m:
                    out["ahead"], out["behind"] = int(m.group(1)), int(m.group(2))
            elif line and not line.startswith("#"):
                changes += 1
        out["changes"] = changes
        try:
            out["remote"] = git(p, "remote", "get-url", "origin", check=True).strip() or None
        except GitError:
            remotes = git(p, "remote", check=False).split()
            if remotes:
                out["remote"] = git(p, "remote", "get-url", remotes[0], check=False).strip() or None
        out["web_url"] = web_url(out["remote"])
        out["provider"] = provider(out["remote"])
        if not out["remote"]:
            out["state"] = "local"
        elif out["ahead"] and out["behind"]:
            out["state"] = "diverged"
        elif out["behind"]:
            out["state"] = "behind"
        elif out["ahead"]:
            out["state"] = "ahead"
        elif changes:
            out["state"] = "changes"
        else:
            out["state"] = "synced"
        return out

    def register(self, path: str, name: str | None = None, icon: str | None = None) -> dict[str, Any]:
        p = Path(path).expanduser().resolve()
        top = toplevel(p)
        if not top:
            raise RepoError(f"{p} is not a git repository")
        p = Path(top).resolve()
        existing = self.db.one("SELECT id FROM repos WHERE path = ?", (str(p),))
        if existing:
            if name or icon:
                self.update(existing["id"], name=name, icon=icon)
            return self.get_repo(existing["id"])
        rid = uuid.uuid4().hex[:12]
        order = (self.db.one("SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM repos") or {"n": 0})["n"]
        ts = now_iso()
        self.db.execute(
            "INSERT INTO repos(id, name, path, icon, sort_order, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
            (rid, (name or "").strip() or p.name, str(p), icon, order, ts, ts),
        )
        self.publish({"type": "repos.changed"})
        return self.get_repo(rid)

    def update(self, repo_id: str, name: str | None = None, icon: str | None = None,
               sort_order: int | None = None) -> dict[str, Any]:
        self._row(repo_id)
        sets, params = [], []
        if name is not None and name.strip():
            sets.append("name = ?")
            params.append(name.strip())
        if icon is not None:
            sets.append("icon = ?")
            params.append(icon or None)
        if sort_order is not None:
            sets.append("sort_order = ?")
            params.append(sort_order)
        if sets:
            sets.append("updated_at = ?")
            params += [now_iso(), repo_id]
            self.db.execute(f"UPDATE repos SET {', '.join(sets)} WHERE id = ?", tuple(params))
            self.publish({"type": "repos.changed"})
        return self.get_repo(repo_id)

    def remove(self, repo_id: str, delete_files: bool = False) -> None:
        r = self._row(repo_id)
        self.db.execute("DELETE FROM repos WHERE id = ?", (repo_id,))
        t = self.terms.by_key(f"repo:{repo_id}")
        if t:
            self.terms.close(t.id)
        if delete_files and Path(r["path"]).is_dir():
            shutil.rmtree(r["path"], onexc=_force_remove)
        self.publish({"type": "repos.changed"})

    # ---------------------------------------------------------------- inspection (locate form)
    def inspect(self, path: str) -> dict[str, Any]:
        p = Path(path).expanduser()
        if not p.is_dir():
            return {"ok": False, "error": "Folder does not exist"}
        top = toplevel(p)
        if not top:
            return {"ok": False, "error": "This folder is not a git repository"}
        st = self.status(top)
        known = self.db.one("SELECT id, name FROM repos WHERE path = ?", (str(Path(top).resolve()),))
        return {"ok": True, "path": top, "name": Path(top).name, "remote": st["remote"], "branch": st["branch"],
                "kind": "remote" if st["remote"] else "local", "registered": dict(known) if known else None}

    # ---------------------------------------------------------------- terminal-driven actions
    def terminal_for(self, repo_id: str | None, cwd: str, title: str) -> Any:
        key = f"repo:{repo_id}" if repo_id else f"repos:{cwd}"
        return self.terms.ensure(key, title, cwd)

    def clone(self, url: str, parent: str, name: str | None = None, icon: str | None = None,
              terminal_id: str | None = None) -> dict[str, Any]:
        url = url.strip()
        if not is_clone_url(url):
            raise RepoError("Enter a git URL, e.g. https://github.com/owner/repo.git")
        parent_p = Path(parent).expanduser()
        if not parent_p.is_dir():
            raise RepoError("The destination folder does not exist")
        folder = repo_name_from_url(url)
        dest = parent_p / folder
        if dest.exists() and any(dest.iterdir()):
            raise RepoError(f"'{dest}' already exists and is not empty")
        term = self.terms.get(terminal_id) if terminal_id else self.terms.ensure(
            f"clone:{folder}", f"Clone · {folder}", str(parent_p))
        if term.cwd != str(parent_p):
            self.terms.cd(term.id, str(parent_p)).future.result(timeout=30)
        result = term.run_wait(["git", "clone", url, folder])
        if result["code"] != 0:
            raise RepoError(_tail_error(result["output"]) or f"git clone failed (exit {result['code']})")
        repo = self.register(str(dest), name or folder, icon)
        term.key = f"repo:{repo['id']}"
        term.title = repo["name"]
        term.cwd = str(dest)
        self.terms.cd(term.id, str(dest))
        self.terms.publish({"type": "terminals.changed"})
        return repo

    def create_local(self, parent: str, folder: str, name: str | None = None, icon: str | None = None,
                     terminal_id: str | None = None) -> dict[str, Any]:
        parent_p = Path(parent).expanduser()
        if not parent_p.is_dir():
            raise RepoError("The destination folder does not exist")
        folder = folder.strip()
        if not folder or re.search(r'[\\/:*?"<>|]', folder) or folder.startswith("."):
            raise RepoError("Enter a valid folder name for the new repository")
        dest = parent_p / folder
        if (dest / ".git").exists():
            raise RepoError(f"'{dest}' is already a git repository — use “Add a local cloned repo”")
        term = self.terms.get(terminal_id) if terminal_id else self.terms.ensure(
            f"create:{folder}", f"New · {folder}", str(parent_p))
        if term.cwd != str(parent_p):
            self.terms.cd(term.id, str(parent_p)).future.result(timeout=30)
        result = term.run_wait(["git", "init", "-b", "main", folder])
        if result["code"] != 0:
            raise RepoError(_tail_error(result["output"]) or f"git init failed (exit {result['code']})")
        repo = self.register(str(dest), name or folder, icon)
        term.key = f"repo:{repo['id']}"
        term.title = repo["name"]
        term.cwd = str(dest)
        self.terms.cd(term.id, str(dest))
        self.terms.publish({"type": "terminals.changed"})
        return repo

    def locate(self, path: str, name: str | None = None, icon: str | None = None,
               terminal_id: str | None = None) -> dict[str, Any]:
        info = self.inspect(path)
        if not info["ok"]:
            raise RepoError(info["error"])
        repo = self.register(info["path"], name, icon)
        term = self.terms.get(terminal_id) if terminal_id else None
        if term:
            term.key, term.title = f"repo:{repo['id']}", repo["name"]
            self.terms.publish({"type": "terminals.changed"})
        else:
            term = self.terminal_for(repo["id"], repo["path"], repo["name"])
        # Show the user what we found, in their terminal.
        term.run(["git", "status", "-sb"], cwd=repo["path"])
        if info["remote"]:
            term.run(["git", "remote", "-v"])
        return repo

    def repo_terminal(self, repo_id: str) -> dict[str, Any]:
        r = self._row(repo_id)
        return self.terminal_for(repo_id, r["path"], r["name"]).info()

    def run_in_repo(self, repo_id: str, argv: list[str], wait: bool = True) -> dict[str, Any]:
        r = self._row(repo_id)
        term = self.terminal_for(repo_id, r["path"], r["name"])
        job = term.run(argv)
        if not wait:
            return {"terminal_id": term.id, "job_id": job.id}
        res = job.future.result()
        res["terminal_id"] = term.id
        if res["code"] != 0:
            res["error"] = _tail_error(res["output"])
        self.publish({"type": "repo.changed", "repo_id": repo_id})
        return res

    def sync(self, repo_id: str) -> dict[str, Any]:
        """Fetch everything, then fast-forward / push every tracking branch that can be synced safely."""
        r = self._row(repo_id)
        path = r["path"]
        term = self.terminal_for(repo_id, path, r["name"])
        steps: list[dict[str, Any]] = []

        def step(argv: list[str]) -> bool:
            res = term.run_wait(argv)
            steps.append({"command": " ".join(argv), "code": res["code"]})
            if res["code"] != 0:
                steps[-1]["error"] = _tail_error(res["output"])
            return res["code"] == 0

        st = self.status(path)
        if not st["remote"]:
            raise RepoError("This repository has no remote to sync with")
        if not step(["git", "fetch", "--all", "--prune"]):
            self.publish({"type": "repo.changed", "repo_id": repo_id})
            return {"ok": False, "steps": steps, "warnings": ["Fetch failed — see the terminal"]}
        warnings: list[str] = []
        current = git(path, "branch", "--show-current", check=False).strip()
        fmt = SEP.join(["%(refname:short)", "%(upstream:short)", "%(upstream:track,nobracket)"])
        for line in git(path, "for-each-ref", f"--format={fmt}", "refs/heads").splitlines():
            name, upstream, track = (line.split(SEP) + ["", ""])[:3]
            if not upstream or track == "gone":
                continue
            ahead = int(m.group(1)) if (m := re.search(r"ahead (\d+)", track)) else 0
            behind = int(m.group(1)) if (m := re.search(r"behind (\d+)", track)) else 0
            remote, _, rbranch = upstream.partition("/")
            if ahead and behind:
                warnings.append(f"{name} has diverged from {upstream} — merge or rebase it manually")
                continue
            if behind:
                if name == current:
                    if not step(["git", "pull", "--ff-only"]):
                        warnings.append(f"Could not fast-forward {name} (local changes?)")
                else:
                    step(["git", "fetch", remote, f"{rbranch}:{name}"])
            if ahead:
                if not step(["git", "push", remote, f"{name}:{rbranch}"]):
                    warnings.append(f"Push of {name} failed")
        self.publish({"type": "repo.changed", "repo_id": repo_id})
        return {"ok": not warnings and all(s["code"] == 0 for s in steps), "steps": steps, "warnings": warnings}

    # ---------------------------------------------------------------- read-only views
    def refs(self, repo_id: str) -> dict[str, Any]:
        p = self.path(repo_id)
        current = git(p, "branch", "--show-current", check=False).strip()
        local = [b for b in git(p, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n") if b]
        remote = [b for b in git(p, "for-each-ref", "--format=%(refname:short)", "refs/remotes").split("\n")
                  if b and not b.endswith("/HEAD") and "/" in b]
        tags = [t for t in git(p, "tag", "--sort=-creatordate").split("\n") if t]
        return {"current": current, "default": self.default_branch(p), "local": local, "remote": remote,
                "tags": tags}

    def default_branch(self, p: Path) -> str:
        head = git(p, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD", check=False).strip()
        if head:
            return head.split("/", 1)[1]
        for name in ("main", "master", "develop", "trunk"):
            if git(p, "rev-parse", "--verify", "--quiet", f"refs/heads/{name}", check=False).strip():
                return name
        return git(p, "branch", "--show-current", check=False).strip() or "main"

    def _ref(self, p: Path, ref: str | None) -> str:
        if ref:
            if ref.startswith("-"):
                raise RepoError("Invalid ref")
            return ref
        return "HEAD"

    def tree(self, repo_id: str, ref: str | None = None, path: str = "") -> dict[str, Any]:
        p = self.path(repo_id)
        rev = self._ref(p, ref)
        path = path.strip("/")
        if ".." in path.split("/"):
            raise RepoError("Invalid path")
        try:
            out = git(p, "ls-tree", "-z", "--long", rev, *( [path + "/"] if path else []))
        except GitError as e:
            if "Not a valid object name" in str(e) or "not a tree" in str(e):
                return {"ref": rev, "path": path, "entries": [], "empty": True}
            raise
        entries = []
        for item in out.split("\0"):
            if not item:
                continue
            meta, _, name = item.partition("\t")
            mode, kind, sha, size = meta.split(None, 3)
            entries.append({"name": name.rsplit("/", 1)[-1], "path": name, "type": kind, "sha": sha,
                            "size": None if size.strip() == "-" else int(size)})
        entries.sort(key=lambda e: (e["type"] != "tree", e["name"].lower()))
        readme = next((e for e in entries if e["type"] == "blob" and re.match(r"(?i)readme(\.md|\.markdown|\.txt)?$", e["name"])), None)
        last = self._last_commits(p, rev, path, [e["name"] for e in entries]) if len(entries) <= 200 else {}
        for e in entries:
            e["last"] = last.get(e["name"])
        return {"ref": rev, "path": path, "entries": entries, "readme": readme["path"] if readme else None}

    def _last_commits(self, p: Path, rev: str, base: str, names: list[str]) -> dict[str, dict]:
        """Latest commit touching each entry of a folder (bounded walk)."""
        result: dict[str, dict] = {}
        wanted = set(names)
        prefix = f"{base}/" if base else ""
        fmt = REC + SEP.join(["%H", "%s", "%an", "%aI"])
        try:
            out = git(p, "log", "-n", "400", f"--format={fmt}", "--name-only", rev, "--", base or ".", timeout=20)
        except GitError:
            return result
        for block in out.split(REC):
            if not block.strip():
                continue
            header, _, files = block.partition("\n")
            sha, subject, author, date = (header.split(SEP) + ["", "", "", ""])[:4]
            for f in files.splitlines():
                if not f.startswith(prefix):
                    continue
                top = f[len(prefix):].split("/", 1)[0]
                if top in wanted and top not in result:
                    result[top] = {"sha": sha, "subject": subject, "author": author, "date": date}
            if len(result) == len(wanted):
                break
        return result

    def blob(self, repo_id: str, ref: str | None, path: str) -> dict[str, Any]:
        p = self.path(repo_id)
        rev = self._ref(p, ref)
        data = git_bytes(p, "show", f"{rev}:{path}")
        binary = b"\0" in data[:8000]
        too_big = len(data) > MAX_FILE_BYTES
        return {"path": path, "ref": rev, "size": len(data), "binary": binary, "truncated": too_big,
                "content": None if binary else data[:MAX_FILE_BYTES].decode("utf-8", "replace")}

    def commits(self, repo_id: str, ref: str | None = None, path: str | None = None, author: str | None = None,
                search: str | None = None, skip: int = 0, limit: int = 50, all_refs: bool = False) -> dict[str, Any]:
        p = self.path(repo_id)
        fmt = SEP.join(["%H", "%P", "%an", "%ae", "%aI", "%cn", "%cI", "%s", "%D"]) + REC
        args = ["log", f"--format={fmt}", f"--skip={max(0, skip)}", f"-n{min(limit, 200) + 1}", "--topo-order"]
        if author:
            args.append(f"--author={author}")
        if search:
            args += [f"--grep={search}", "-i"]
        args.append("--all" if all_refs else self._ref(p, ref))
        if path:
            args += ["--", path]
        try:
            out = git(p, *args, timeout=30)
        except GitError as e:
            if "does not have any commits" in str(e) or "unknown revision" in str(e):
                return {"commits": [], "more": False}
            raise
        items = []
        for rec in out.split(REC):
            rec = rec.strip("\n")
            if not rec:
                continue
            f = (rec.split(SEP) + [""] * 9)[:9]
            items.append({"sha": f[0], "parents": f[1].split(), "author": f[2], "email": f[3], "date": f[4],
                          "committer": f[5], "committed": f[6], "subject": f[7],
                          "refs": [r.strip() for r in f[8].split(",") if r.strip()]})
        more = len(items) > min(limit, 200)
        return {"commits": items[: min(limit, 200)], "more": more}

    def commit(self, repo_id: str, sha: str) -> dict[str, Any]:
        p = self.path(repo_id)
        if not re.fullmatch(r"[0-9a-fA-F]{4,64}", sha):
            raise RepoError("Invalid commit id")
        fmt = SEP.join(["%H", "%P", "%an", "%ae", "%aI", "%cn", "%cI", "%B"])
        head = git(p, "show", "-s", f"--format={fmt}", sha)
        f = (head.split(SEP) + [""] * 8)[:8]
        stat = git(p, "show", "--format=", "--numstat", "-M", sha)
        files = []
        for line in stat.splitlines():
            parts = line.split("\t")
            if len(parts) == 3:
                files.append({"path": parts[2], "added": None if parts[0] == "-" else int(parts[0]),
                              "deleted": None if parts[1] == "-" else int(parts[1])})
        patch = git(p, "show", "--format=", "-M", "--no-color", "--patch", sha, timeout=30)
        if len(patch) > 1_500_000:
            patch = patch[:1_500_000] + "\n… diff truncated …\n"
        return {"sha": f[0], "parents": f[1].split(), "author": f[2], "email": f[3], "date": f[4],
                "committer": f[5], "committed": f[6], "message": f[7].strip(), "files": files, "patch": patch}

    def branches(self, repo_id: str) -> dict[str, Any]:
        p = self.path(repo_id)
        default = self.default_branch(p)
        current = git(p, "branch", "--show-current", check=False).strip()
        me = git(p, "config", "user.name", check=False).strip()
        fmt = SEP.join(["%(refname)", "%(refname:short)", "%(objectname)", "%(authorname)", "%(authordate:iso-strict)",
                        "%(subject)", "%(upstream:short)", "%(upstream:track,nobracket)"])
        out = git(p, "for-each-ref", f"--format={fmt}", "refs/heads", "refs/remotes")
        base = default if git(p, "rev-parse", "--verify", "--quiet", default, check=False).strip() else None
        items = []
        for line in out.splitlines():
            f = (line.split(SEP) + [""] * 8)[:8]
            full, short = f[0], f[1]
            if full.endswith("/HEAD") or (full.startswith("refs/remotes/") and "/" not in short):
                continue
            item = {"name": short, "remote": full.startswith("refs/remotes/"), "sha": f[2], "author": f[3],
                    "date": f[4], "subject": f[5], "upstream": f[6] or None, "track": f[7] or None,
                    "current": short == current and not full.startswith("refs/remotes/"),
                    "default": short == default, "mine": bool(me) and f[3] == me, "ahead": 0, "behind": 0}
            if base and short != default:
                cnt = git(p, "rev-list", "--left-right", "--count", f"{base}...{f[2]}", check=False).split()
                if len(cnt) == 2:
                    item["behind"], item["ahead"] = int(cnt[0]), int(cnt[1])
            items.append(item)
        return {"default": default, "current": current, "me": me, "branches": items}

    def tags(self, repo_id: str) -> list[dict[str, Any]]:
        p = self.path(repo_id)
        fmt = SEP.join(["%(refname:short)", "%(objecttype)", "%(objectname)", "%(*objectname)", "%(taggername)",
                        "%(creatordate:iso-strict)", "%(contents:subject)", "%(authorname)"])
        out = git(p, "for-each-ref", "--sort=-creatordate", f"--format={fmt}", "refs/tags")
        tags = []
        for line in out.splitlines():
            f = (line.split(SEP) + [""] * 8)[:8]
            annotated = f[1] == "tag"
            tags.append({"name": f[0], "annotated": annotated, "commit": f[3] if annotated else f[2],
                         "tagger": f[4] or f[7], "date": f[5], "message": f[6] if annotated else ""})
        return tags

    def pushes(self, repo_id: str, limit: int = 100) -> list[dict[str, Any]]:
        """Updates of remote-tracking branches recorded in the reflog (pushes from here and fetched updates)."""
        p = self.path(repo_id)
        me = git(p, "config", "user.name", check=False).strip()
        refs = [r for r in git(p, "for-each-ref", "--format=%(refname)", "refs/remotes").splitlines()
                if not r.endswith("/HEAD")]
        events = []
        fmt = SEP.join(["%H", "%gs", "%gI", "%gn"])
        for ref in refs:
            try:
                out = git(p, "reflog", "show", f"--format={fmt}", ref, "--", timeout=15)
            except GitError:
                continue
            lines = [l.split(SEP) for l in out.splitlines() if l]
            for i, f in enumerate(lines):
                if len(f) < 4:
                    continue
                sha, msg, date, who = f[0], f[1], f[2], f[3]
                prev = lines[i + 1][0] if i + 1 < len(lines) else None
                kind = "push" if "push" in msg else "fetch" if ("fetch" in msg or "pull" in msg) else "update"
                if prev and prev != sha:
                    rng = f"{prev}..{sha}"
                    commits_out = git(p, "log", "--format=%H" + SEP + "%s" + SEP + "%an", "-n", "20", rng, check=False)
                else:
                    commits_out = git(p, "log", "--format=%H" + SEP + "%s" + SEP + "%an", "-n", "1", sha, check=False)
                commits = [dict(zip(("sha", "subject", "author"), c.split(SEP))) for c in commits_out.splitlines() if c]
                pusher = (me or who) if kind == "push" else (commits[0]["author"] if commits else who)
                events.append({"ref": ref.removeprefix("refs/remotes/"), "sha": sha, "previous": prev, "kind": kind,
                               "message": msg, "date": date, "by": pusher, "commits": commits,
                               "forced": "forced" in msg})
        events.sort(key=lambda e: e["date"], reverse=True)
        return events[:limit]

    def pull_requests(self, repo_id: str, state: str = "open") -> dict[str, Any]:
        p = self.path(repo_id)
        st = self.status(str(p))
        prov = st["provider"]
        if prov != "github":
            return {"supported": False, "provider": prov, "web_url": st["web_url"], "items": [],
                    "reason": "Pull requests are listed for GitHub remotes (via the gh CLI)." if prov else
                    "This repository has no remote."}
        if not which("gh"):
            return {"supported": False, "provider": prov, "web_url": st["web_url"], "items": [],
                    "reason": "Install the GitHub CLI (gh) and run `gh auth login` in the terminal to see pull requests."}
        fields = "number,title,author,state,isDraft,headRefName,baseRefName,createdAt,updatedAt,url,reviewDecision,labels"
        try:
            out = run(["gh", "pr", "list", "--state", state if state in ("open", "closed", "merged", "all") else "open",
                       "--limit", "100", "--json", fields], cwd=p, timeout=30)
        except GitError as e:
            return {"supported": True, "provider": prov, "web_url": st["web_url"], "items": [], "error": str(e)}
        me = ""
        try:
            me = run(["gh", "api", "user", "--jq", ".login"], cwd=p, timeout=15).strip()
        except GitError:
            pass
        return {"supported": True, "provider": prov, "web_url": st["web_url"], "me": me, "items": json.loads(out or "[]")}


def _tail_error(output: str, lines: int = 6) -> str:
    rows = [l.rstrip() for l in output.splitlines() if l.strip()]
    # Drop the echoed command line (first row) and prompt noise.
    rows = [r for r in rows[1:] if "b2done" not in r]
    interesting = [r for r in rows if re.search(r"(?i)fatal|error|denied|not found|could not|failed|already exists|invalid", r)]
    return "\n".join((interesting or rows)[-lines:])


def _force_remove(func, path, _exc):  # pragma: no cover - windows read-only files in .git
    os.chmod(path, 0o700)
    func(path)
