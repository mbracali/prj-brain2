"""Sync a vault with a git repository (shared by one or more people).

Flow of one sync (all commands typed into the vault's terminal tab)::

    git fetch origin
    git switch -c sync/<user>-<date>          # work branch
    git add -A && git commit                  # local changes
    git merge origin/main                     # bring in everybody else's work
      └─ conflicts? → the user picks per file: mine / theirs / both / edit
    git switch main && git merge --ff-only origin/main
    git merge --squash sync/<user>-<date> && git commit
    git push origin main
    git branch -D sync/<user>-<date>

Only ``main`` is ever pushed; it always equals the last synced state, so the
working tree between syncs is "main + the user's edits".
"""

from __future__ import annotations

import getpass
import re
import tempfile
import threading
from datetime import datetime
from pathlib import Path
from typing import Any

from ..gitcli import GitError, git, git_bytes, run
from ..terminals import TerminalManager
from .service import VaultError, VaultService

GITIGNORE_BLOCK = """
# BRAIN2: local index and trash are rebuilt on every machine
.brain2/*
!.brain2/icons.json
.DS_Store
"""


class SyncError(VaultError):
    pass


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-") or "user"


class VaultGitSync:
    def __init__(self, vaults: VaultService, terminals: TerminalManager, publish=None):
        self.vaults = vaults
        self.terms = terminals
        self.publish = publish or (lambda ev: None)
        self._locks: dict[str, threading.Lock] = {}

    # ---------------------------------------------------------------- config
    def remote_url(self, vault_id: str) -> str | None:
        v = self.vaults.get_vault(vault_id)
        urls = (v.get("connections") or {}).get("git") or []
        return urls[0] if urls else None

    def _terminal(self, vault_id: str):
        v = self.vaults.get_vault(vault_id)
        return self.terms.ensure(f"vault:{vault_id}", f"Sync · {v['name']}", v["path"])

    def validate(self, vault_id: str, url: str) -> dict[str, Any]:
        """Check the URL in the vault's terminal (so credentials prompts are visible). Needs a `main` branch."""
        url = url.strip()
        if not re.match(r"^(https?://\S+|git@[^\s:]+:\S+|ssh://\S+|file://\S+)$", url):
            raise SyncError("Enter a git repository URL (https://… or git@…)")
        term = self._terminal(vault_id)
        res = term.run_wait(["git", "ls-remote", "--heads", url])
        if res["code"] != 0:
            raise SyncError("Could not reach the repository — check the URL and your access (see the terminal).")
        heads = re.findall(r"^[0-9a-f]{40}\s+refs/heads/(\S+)", res["output"], re.M)
        if heads and "main" not in heads:
            raise SyncError(f"The repository has no 'main' branch (found: {', '.join(heads[:5])}).")
        return {"ok": True, "empty": not heads, "terminal_id": term.id}

    def attach(self, vault_id: str, url: str | None) -> dict[str, Any]:
        v = self.vaults.get_vault(vault_id)
        connections = dict(v.get("connections") or {})
        result: dict[str, Any] = {"ok": True}
        if url:
            result = self.validate(vault_id, url)
            connections["git"] = [url.strip()]
        else:
            connections.pop("git", None)
        self.vaults.update_vault(vault_id, connections=connections)
        self.publish({"type": "vaults.changed"})
        return result

    # ---------------------------------------------------------------- status
    def status(self, vault_id: str) -> dict[str, Any]:
        root = self.vaults.root(vault_id)
        url = self.remote_url(vault_id)
        out: dict[str, Any] = {"url": url, "is_repo": (root / ".git").exists(), "state": "idle",
                               "conflicts": [], "branch": None, "changes": 0, "last_sync": None}
        if not out["is_repo"]:
            return out
        out["branch"] = git(root, "branch", "--show-current", check=False).strip() or None
        out["changes"] = len([l for l in git(root, "status", "--porcelain", check=False).splitlines() if l])
        if (root / ".git" / "MERGE_HEAD").exists():
            out["state"] = "conflicts"
            out["conflicts"] = self._conflicts(root)
        last = git(root, "log", "-1", "--format=%cI", "main", check=False).strip()
        out["last_sync"] = last or None
        return out

    def _conflicts(self, root: Path) -> list[dict[str, Any]]:
        files = []
        for line in git(root, "status", "--porcelain", check=False).splitlines():
            code, path = line[:2], line[3:]
            if code in ("UU", "AA", "DU", "UD", "AU", "UA", "DD"):
                files.append({"path": path.strip('"'), "code": code,
                              "mine_deleted": code[0] == "D", "theirs_deleted": code[1] == "D"})
        return files

    # ---------------------------------------------------------------- sync
    def sync(self, vault_id: str) -> dict[str, Any]:
        lock = self._locks.setdefault(vault_id, threading.Lock())
        if not lock.acquire(blocking=False):
            raise SyncError("A sync of this vault is already running")
        try:
            return self._sync(vault_id)
        finally:
            lock.release()
            self.publish({"type": "vault.sync", "vault_id": vault_id})

    def _step(self, term, argv: list[str] | str, ok_codes=(0,)) -> dict[str, Any]:
        res = term.run_wait(argv)
        if res["code"] not in ok_codes:
            tail = [l for l in res["output"].splitlines() if l.strip() and "b2done" not in l][-6:]
            raise SyncError("\n".join(tail) or f"Command failed (exit {res['code']})")
        return res

    def _identity(self, root: Path) -> str:
        name = git(root, "config", "user.name", check=False).strip()
        email = git(root, "config", "user.email", check=False).strip()
        if not name or not email:
            raise SyncError("Git needs your name and email to commit. In the terminal run:\n"
                            'git config --global user.name "Your Name"\n'
                            'git config --global user.email "you@example.com"')
        return name

    def _sync(self, vault_id: str) -> dict[str, Any]:
        url = self.remote_url(vault_id)
        if not url:
            raise SyncError("Attach a git repository to this vault first (Settings → Vault settings)")
        root = self.vaults.root(vault_id)
        term = self._terminal(vault_id)
        self._step(term, ["cd", str(root)])
        if (root / ".git" / "MERGE_HEAD").exists():
            return {"state": "conflicts", "conflicts": self._conflicts(root), "terminal_id": term.id}

        if not (root / ".git").exists():
            self._step(term, ["git", "init", "-b", "main"])
        remotes = git(root, "remote", check=False).split()
        if "origin" not in remotes:
            self._step(term, ["git", "remote", "add", "origin", url])
        elif git(root, "remote", "get-url", "origin", check=False).strip() != url:
            self._step(term, ["git", "remote", "set-url", "origin", url])
        self._ensure_gitignore(root)
        user = self._identity(root)

        self._step(term, ["git", "fetch", "origin"])
        has_remote_main = bool(git(root, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/main", check=False).strip())
        unborn = not git(root, "rev-parse", "--verify", "--quiet", "HEAD", check=False).strip()
        current = git(root, "branch", "--show-current", check=False).strip()

        if unborn and has_remote_main:
            # First sync of an existing folder with a populated repo: adopt the remote history
            # without touching local files, then restore remote files that don't exist locally.
            self._step(term, ["git", "reset", "origin/main"])
            missing = [l for l in git(root, "ls-files", "--deleted", check=False).splitlines() if l]
            for i in range(0, len(missing), 200):
                self._step(term, ["git", "checkout", "--", *missing[i:i + 200]])
            current = "main"
        elif current and current != "main" and not current.startswith("sync/"):
            raise SyncError(f"The vault is on branch '{current}'. Switch back to main to sync.")

        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        branch = f"sync/{_slug(user or getpass.getuser())}-{stamp}"
        if current.startswith("sync/"):
            branch = current  # resume an interrupted sync
        else:
            self._step(term, ["git", "checkout", "-q", "-b", branch])
        self._step(term, ["git", "add", "-A"])
        dirty = bool(git(root, "status", "--porcelain", check=False).strip())
        if dirty:
            self._step(term, ["git", "commit", "-q", "-m", f"Vault sync: {user} {stamp}"])

        if not has_remote_main:
            # Empty remote repository: our branch becomes main.
            if not git(root, "rev-parse", "--verify", "--quiet", "HEAD", check=False).strip():
                self._step(term, ["git", "commit", "-q", "--allow-empty", "-m", "Initial vault sync"])
            self._step(term, ["git", "branch", "-M", "main"])
            self._step(term, ["git", "push", "-u", "origin", "main"])
            return self._done(vault_id, term, pushed=True)

        res = term.run_wait(["git", "merge", "--no-edit", "origin/main"])
        if res["code"] != 0:
            conflicts = self._conflicts(root)
            if conflicts:
                self.publish({"type": "vault.sync", "vault_id": vault_id})
                return {"state": "conflicts", "conflicts": conflicts, "terminal_id": term.id, "branch": branch}
            raise SyncError("Merging the remote changes failed — see the terminal.")
        return self._finish(vault_id, term, root, branch, user, stamp)

    def _finish(self, vault_id: str, term, root: Path, branch: str, user: str, stamp: str) -> dict[str, Any]:
        has_main = bool(git(root, "rev-parse", "--verify", "--quiet", "refs/heads/main", check=False).strip())
        if has_main:
            self._step(term, ["git", "switch", "main"])
            self._step(term, ["git", "merge", "--ff-only", "origin/main"])
        else:
            self._step(term, ["git", "switch", "-c", "main", "origin/main"])
        self._step(term, ["git", "merge", "--squash", branch])
        changed = bool(git(root, "diff", "--cached", "--name-only", check=False).strip())
        pushed = False
        if changed:
            self._step(term, ["git", "commit", "-q", "-m", f"Vault sync: {user} {stamp}"])
            res = term.run_wait(["git", "push", "origin", "main"])
            if res["code"] != 0:
                # Somebody pushed in the meantime: integrate once more and retry.
                self._step(term, ["git", "fetch", "origin"])
                merge = term.run_wait(["git", "rebase", "origin/main"])
                if merge["code"] != 0:
                    term.run_wait(["git", "rebase", "--abort"])
                    raise SyncError("The remote changed while syncing and the changes overlap. Sync again.")
                self._step(term, ["git", "push", "origin", "main"])
            pushed = True
        self._step(term, ["git", "branch", "-D", branch])
        return self._done(vault_id, term, pushed)

    def _done(self, vault_id: str, term, pushed: bool) -> dict[str, Any]:
        self.vaults.index_vault(vault_id)
        self.publish({"type": "vault.changed", "vault_id": vault_id, "paths": [], "origin": "sync"})
        return {"state": "synced", "pushed": pushed, "terminal_id": term.id}

    def _ensure_gitignore(self, root: Path) -> None:
        gi = root / ".gitignore"
        text = gi.read_text("utf-8") if gi.exists() else ""
        if ".brain2/*" not in text:
            gi.write_text(text.rstrip("\n") + ("\n" if text else "") + GITIGNORE_BLOCK.lstrip("\n"), "utf-8")

    # ---------------------------------------------------------------- conflicts
    def resolve(self, vault_id: str, choices: dict[str, str]) -> dict[str, Any]:
        """Resolve conflicts: choice per path is mine | theirs | both | manual (already edited)."""
        root = self.vaults.root(vault_id)
        term = self._terminal(vault_id)
        if not (root / ".git" / "MERGE_HEAD").exists():
            raise SyncError("There is no sync waiting for conflict resolution")
        conflicts = {c["path"]: c for c in self._conflicts(root)}
        for path, choice in choices.items():
            c = conflicts.get(path)
            if not c:
                continue
            if choice == "mine":
                if c["mine_deleted"]:
                    self._step(term, ["git", "rm", "-q", "--", path])
                else:
                    self._step(term, ["git", "checkout", "--ours", "--", path])
                    self._step(term, ["git", "add", "--", path])
            elif choice == "theirs":
                if c["theirs_deleted"]:
                    self._step(term, ["git", "rm", "-q", "--", path])
                else:
                    self._step(term, ["git", "checkout", "--theirs", "--", path])
                    self._step(term, ["git", "add", "--", path])
            elif choice == "both":
                if c["mine_deleted"] or c["theirs_deleted"]:
                    side = "--theirs" if c["mine_deleted"] else "--ours"
                    self._step(term, ["git", "checkout", side, "--", path])
                else:
                    (root / path).write_bytes(self._union(root, path))
                self._step(term, ["git", "add", "--", path])
            elif choice == "manual":
                text = (root / path).read_text("utf-8", "replace") if (root / path).exists() else ""
                if re.search(r"^<<<<<<< ", text, re.M):
                    raise SyncError(f"{path} still contains conflict markers (<<<<<<<)")
                self._step(term, ["git", "add", "-A", "--", path])
        remaining = self._conflicts(root)
        if remaining:
            return {"state": "conflicts", "conflicts": remaining, "terminal_id": term.id}
        self._step(term, ["git", "commit", "--no-edit", "-q"])
        branch = git(root, "branch", "--show-current", check=False).strip()
        user = self._identity(root)
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        lock = self._locks.setdefault(vault_id, threading.Lock())
        with lock:
            result = self._finish(vault_id, term, root, branch, user, stamp)
        self.publish({"type": "vault.sync", "vault_id": vault_id})
        return result

    def _union(self, root: Path, path: str) -> bytes:
        """Keep both sides: a line-union 3-way merge (no conflict markers)."""
        with tempfile.TemporaryDirectory() as tmp:
            names = []
            for stage, label in ((2, "ours"), (1, "base"), (3, "theirs")):
                target = Path(tmp) / label
                try:
                    target.write_bytes(git_bytes(root, "show", f":{stage}:{path}"))
                except GitError:
                    target.write_bytes(b"")
                names.append(str(target))
            try:
                return run(["git", "merge-file", "-p", "--union", *names], check=False).encode("utf-8")
            except GitError:
                return Path(names[0]).read_bytes()

    def abort(self, vault_id: str) -> dict[str, Any]:
        """Cancel a sync with conflicts and put the vault back to 'main + my edits'."""
        root = self.vaults.root(vault_id)
        term = self._terminal(vault_id)
        branch = git(root, "branch", "--show-current", check=False).strip()
        if (root / ".git" / "MERGE_HEAD").exists():
            self._step(term, ["git", "merge", "--abort"])
        if branch.startswith("sync/"):
            has_main = bool(git(root, "rev-parse", "--verify", "--quiet", "refs/heads/main", check=False).strip())
            if has_main:
                self._step(term, ["git", "reset", "-q", "--soft", "main"])
                self._step(term, ["git", "switch", "main"])
                self._step(term, ["git", "branch", "-D", branch])
                self._step(term, ["git", "reset", "-q"])
        self.publish({"type": "vault.sync", "vault_id": vault_id})
        return {"state": "idle", "terminal_id": term.id}
