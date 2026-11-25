"""Read-only git/gh helpers used to *display* repository data.

Anything that changes a repository or talks to a remote goes through a visible
terminal instead (see ``terminals.py``). These helpers run with the user's
login-shell environment so ``git``/``gh`` resolve exactly like in their terminal
(GUI apps on macOS otherwise get a minimal PATH).
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import threading
from pathlib import Path

IS_WINDOWS = sys.platform == "win32"
_env: dict[str, str] | None = None
_env_lock = threading.Lock()


class GitError(Exception):
    status = 400

    def __init__(self, message: str, code: int = 1):
        super().__init__(message)
        self.code = code


def login_env() -> dict[str, str]:
    """Environment of the user's login shell (cached)."""
    global _env
    with _env_lock:
        if _env is not None:
            return _env
        env = dict(os.environ)
        if not IS_WINDOWS and not os.environ.get("BRAIN2_NO_LOGIN_ENV"):
            shell = os.environ.get("SHELL") or "/bin/sh"
            try:
                out = subprocess.run([shell, "-ilc", "env -0"], capture_output=True, timeout=8,
                                     stdin=subprocess.DEVNULL).stdout
                for item in out.split(b"\0"):
                    k, sep, v = item.decode("utf-8", "replace").partition("=")
                    if sep and k and "\n" not in k:
                        env[k] = v
            except (OSError, subprocess.SubprocessError):
                pass
        env["GIT_TERMINAL_PROMPT"] = "0"  # never block waiting for credentials in the background
        env["GH_PROMPT_DISABLED"] = "1"
        env.pop("GIT_DIR", None)
        _env = env
        return env


def which(program: str) -> str | None:
    return shutil.which(program, path=login_env().get("PATH"))


def run(args: list[str], cwd: str | Path | None = None, check: bool = True, timeout: float = 30,
        input: str | None = None) -> str:
    try:
        p = subprocess.run(args, cwd=str(cwd) if cwd else None, env=login_env(), capture_output=True,
                           timeout=timeout, input=input.encode() if input is not None else None,
                           stdin=None if input is not None else subprocess.DEVNULL)
    except FileNotFoundError as e:
        raise GitError(f"'{args[0]}' is not installed or not on PATH", 127) from e
    except subprocess.TimeoutExpired as e:
        raise GitError(f"'{' '.join(args[:3])}' timed out", 124) from e
    out = p.stdout.decode("utf-8", "replace")
    if check and p.returncode != 0:
        msg = p.stderr.decode("utf-8", "replace").strip() or out.strip() or f"exit code {p.returncode}"
        raise GitError(msg, p.returncode)
    return out


def git(cwd: str | Path, *args: str, check: bool = True, timeout: float = 30) -> str:
    return run(["git", "-c", "core.quotepath=off", "-c", "color.ui=never", *args], cwd, check, timeout)


def git_bytes(cwd: str | Path, *args: str, timeout: float = 30) -> bytes:
    p = subprocess.run(["git", *args], cwd=str(cwd), env=login_env(), capture_output=True, timeout=timeout,
                       stdin=subprocess.DEVNULL)
    if p.returncode != 0:
        raise GitError(p.stderr.decode("utf-8", "replace").strip() or "git failed", p.returncode)
    return p.stdout


def toplevel(path: str | Path) -> str | None:
    try:
        return git(path, "rev-parse", "--show-toplevel").strip() or None
    except (GitError, NotADirectoryError, OSError):
        return None
