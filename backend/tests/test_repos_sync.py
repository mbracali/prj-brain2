"""Terminal jobs, the repos module and vault git sync, against throwaway local repositories."""

import os
import subprocess
from pathlib import Path

import pytest

from brain2.config import load_config
from brain2.db import Database
from brain2.repos.service import RepoError, RepoService, repo_name_from_url, web_url
from brain2.terminals import TerminalManager, command_line
from brain2.vaults.gitsync import VaultGitSync
from brain2.vaults.service import VaultService


@pytest.fixture(autouse=True)
def git_identity(tmp_path_factory, monkeypatch):
    cfg = tmp_path_factory.mktemp("gitcfg") / "gitconfig"
    cfg.write_text("[user]\n\tname = Test User\n\temail = test@example.com\n[commit]\n\tgpgsign = false\n"
                   "[tag]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n")
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(cfg))
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    monkeypatch.setenv("BRAIN2_NO_LOGIN_ENV", "1")
    import brain2.gitcli as g

    monkeypatch.setattr(g, "_env", None)


def sh(cwd, *args):
    return subprocess.run(list(args), cwd=cwd, check=True, capture_output=True, text=True).stdout


@pytest.fixture
def terms():
    m = TerminalManager(shell=["/bin/sh"])
    yield m
    m.close_all()


@pytest.fixture
def remote(tmp_path):
    """A bare 'remote' with one commit on main."""
    bare = tmp_path / "remote.git"
    sh(tmp_path, "git", "init", "--bare", "-b", "main", str(bare))
    seed = tmp_path / "seed"
    sh(tmp_path, "git", "clone", str(bare), str(seed))
    (seed / "Welcome.md").write_text("# Welcome\n\nline one\nline two\n")
    sh(seed, "git", "add", "-A")
    sh(seed, "git", "commit", "-m", "seed")
    sh(seed, "git", "tag", "-a", "v1", "-m", "first")
    sh(seed, "git", "push", "origin", "main", "--tags")
    return bare


def test_helpers():
    assert repo_name_from_url("https://github.com/a/b.git") == "b"
    assert repo_name_from_url("git@github.com:a/c.git") == "c"
    assert web_url("git@github.com:a/c.git") == "https://github.com/a/c"
    assert web_url("https://user@github.com/a/c.git") == "https://github.com/a/c"
    assert command_line(["git", "commit", "-m", "it's"], "posix") == "git commit -m 'it'\"'\"'s'"
    assert command_line(["git", "x y"], "powershell") == "git 'x y'"


def test_terminal_job_exit_codes(terms, tmp_path):
    t = terms.create(cwd=str(tmp_path), title="t")
    assert t.run_wait(["git", "--version"], timeout=20)["code"] == 0
    r = t.run_wait(["ls", str(tmp_path / "nope")], timeout=20)
    assert r["code"] != 0 and "nope" in r["output"]
    assert terms.by_key("x") is None
    assert terms.ensure("k", "K").id == terms.ensure("k", "K").id


def test_clone_and_views(terms, remote, tmp_path):
    config = load_config(tmp_path / "home")
    repos = RepoService(Database(config.db_path), terms)
    dest = tmp_path / "work"
    dest.mkdir()
    with pytest.raises(RepoError):
        repos.clone("not a url", str(dest))
    repo = repos.clone(f"file://{remote}", str(dest), name="Remote", icon="🚀")
    assert repo["name"] == "Remote" and repo["is_git"] and repo["branch"] == "main"
    assert Path(repo["path"]).name == "remote" and repo["state"] == "synced"

    tree = repos.tree(repo["id"])
    assert [e["name"] for e in tree["entries"]] == ["Welcome.md"]
    assert tree["entries"][0]["last"]["subject"] == "seed"
    assert "line one" in repos.blob(repo["id"], None, "Welcome.md")["content"]
    commits = repos.commits(repo["id"])["commits"]
    assert commits[0]["subject"] == "seed"
    detail = repos.commit(repo["id"], commits[0]["sha"])
    assert detail["files"][0]["path"] == "Welcome.md" and "+line one" in detail["patch"]
    assert repos.tags(repo["id"])[0]["name"] == "v1"
    br = repos.branches(repo["id"])
    assert br["default"] == "main" and any(b["name"] == "origin/main" for b in br["branches"])

    # a local commit + sync pushes it (visible in the repo terminal)
    (Path(repo["path"]) / "New.md").write_text("new\n")
    sh(repo["path"], "git", "add", "-A")
    sh(repo["path"], "git", "commit", "-m", "local work")
    assert repos.status(repo["path"])["state"] == "ahead"
    result = repos.sync(repo["id"])
    assert result["ok"], result
    assert repos.status(repo["path"])["state"] == "synced"
    pushes = repos.pushes(repo["id"])
    assert pushes and pushes[0]["kind"] == "push" and pushes[0]["commits"][0]["subject"] == "local work"

    # locate an existing repo, and create a brand new local one
    other = tmp_path / "other"
    sh(tmp_path, "git", "init", "-b", "main", str(other))
    assert repos.inspect(str(other))["kind"] == "local"
    assert repos.inspect(str(tmp_path))["ok"] is False
    located = repos.locate(str(other), name="Other")
    assert located["state"] == "local"
    created = repos.create_local(str(dest), "fresh", name="Fresh")
    assert (dest / "fresh" / ".git").is_dir() and created["name"] == "Fresh"
    assert len(repos.list_repos()) == 3
    repos.remove(created["id"], delete_files=True)
    assert not (dest / "fresh").exists()


def make_vault(tmp_path, name):
    config = load_config(tmp_path / f"home-{name}")
    return VaultService(Database(config.db_path), config)


def test_vault_sync_two_people_with_conflict(terms, remote, tmp_path):
    url = f"file://{remote}"
    a_svc, b_svc = make_vault(tmp_path, "a"), make_vault(tmp_path, "b")
    a = a_svc.create_vault("A", str(tmp_path / "vault-a"))
    b = b_svc.create_vault("B", str(tmp_path / "vault-b"))
    a_sync, b_sync = VaultGitSync(a_svc, terms), VaultGitSync(b_svc, terms)

    # Person A has local notes already; first sync adopts the remote without losing anything.
    a_root = Path(a["path"])
    (a_root / "Mine.md").write_text("mine\n")
    assert a_sync.attach(a["id"], url)["ok"]
    assert a_sync.sync(a["id"])["state"] == "synced"
    assert (a_root / "Welcome.md").exists() and (a_root / "Mine.md").exists()
    assert ".brain2/*" in (a_root / ".gitignore").read_text()
    assert sh(a_root, "git", "branch", "--list").strip() == "* main"  # work branch deleted

    # Person B gets A's note.
    b_root = Path(b["path"])
    b_sync.attach(b["id"], url)
    assert b_sync.sync(b["id"])["state"] == "synced"
    assert (b_root / "Mine.md").read_text() == "mine\n"

    # Both edit the same line → conflict for the second one to sync.
    (a_root / "Welcome.md").write_text("# Welcome\n\nline one from A\nline two\n")
    (b_root / "Welcome.md").write_text("# Welcome\n\nline one from B\nline two\n")
    assert a_sync.sync(a["id"])["state"] == "synced"
    res = b_sync.sync(b["id"])
    assert res["state"] == "conflicts" and res["conflicts"][0]["path"] == "Welcome.md"
    assert b_sync.status(b["id"])["state"] == "conflicts"
    done = b_sync.resolve(b["id"], {"Welcome.md": "both"})
    assert done["state"] == "synced"
    text = (b_root / "Welcome.md").read_text()
    assert "from A" in text and "from B" in text and "<<<<<<<" not in text

    # A receives the union.
    assert a_sync.sync(a["id"])["state"] == "synced"
    assert "from B" in (a_root / "Welcome.md").read_text()
    log = sh(a_root, "git", "log", "--format=%s", "main")
    assert "Vault sync: Test User" in log
    assert not sh(a_root, "git", "status", "--porcelain").strip()


def test_vault_sync_abort_keeps_local_edits(terms, remote, tmp_path):
    url = f"file://{remote}"
    a_svc, b_svc = make_vault(tmp_path, "a"), make_vault(tmp_path, "b")
    a = a_svc.create_vault("A", str(tmp_path / "vault-a"))
    b = b_svc.create_vault("B", str(tmp_path / "vault-b"))
    a_sync, b_sync = VaultGitSync(a_svc, terms), VaultGitSync(b_svc, terms)
    for s, v in ((a_sync, a), (b_sync, b)):
        s.attach(v["id"], url)
        s.sync(v["id"])
    (Path(a["path"]) / "Welcome.md").write_text("A\n")
    a_sync.sync(a["id"])
    (Path(b["path"]) / "Welcome.md").write_text("B\n")
    assert b_sync.sync(b["id"])["state"] == "conflicts"
    assert b_sync.abort(b["id"])["state"] == "idle"
    b_root = Path(b["path"])
    assert (b_root / "Welcome.md").read_text() == "B\n"
    assert sh(b_root, "git", "branch", "--show-current").strip() == "main"


def test_attach_rejects_repo_without_main(terms, tmp_path):
    bare = tmp_path / "nomain.git"
    sh(tmp_path, "git", "init", "--bare", "-b", "trunk", str(bare))
    seed = tmp_path / "s"
    sh(tmp_path, "git", "clone", str(bare), str(seed))
    (seed / "x").write_text("x")
    sh(seed, "git", "add", "-A")
    sh(seed, "git", "commit", "-m", "x")
    sh(seed, "git", "push", "origin", "HEAD:trunk")
    svc = make_vault(tmp_path, "c")
    v = svc.create_vault("C", str(tmp_path / "vault-c"))
    from brain2.vaults.gitsync import SyncError

    with pytest.raises(SyncError, match="main"):
        VaultGitSync(svc, terms).attach(v["id"], f"file://{bare}")
