"""Integrated terminals.

Every terminal runs the user's own shell (login shell on macOS/Linux, PowerShell
on Windows) inside a pseudo terminal, so all of the user's configuration —
PATH, git credential helpers, SSH agent, ``gh`` auth, prompts, aliases — just
works. The UI renders the stream with xterm.js.

Actions the app performs on the user's behalf (clone, fetch, push, sync, ...)
are *typed into* one of these terminals, so the user always sees exactly what
ran. To know when such a command finished (and with which exit code) we define
a tiny helper function ``b2done`` when the shell starts; each job's command line
ends with ``; b2done <job> <status>``, which prints an invisible OSC escape
sequence that we strip from the stream.
"""

from __future__ import annotations

import os
import re
import shlex
import shutil
import sys
import threading
import time
import uuid
from concurrent.futures import Future
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

IS_WINDOWS = sys.platform == "win32"
MAX_BUFFER = 512 * 1024  # scrollback kept for (re)attaching clients
MARK_RE = re.compile(rb"\x1b\]7337;([^;\x07]*);([^\x07]*)\x07")
MARK_PREFIX = b"\x1b]7337;"
ANSI_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|\r")


def strip_ansi(text: str) -> str:
    return ANSI_RE.sub("", text)


# --------------------------------------------------------------------------- shells
def default_shell() -> list[str]:
    """The user's default shell, started as a login shell where that makes sense."""
    if IS_WINDOWS:
        for exe in ("pwsh.exe", "powershell.exe"):
            found = shutil.which(exe)
            if found:
                return [found, "-NoLogo"]
        return [os.environ.get("COMSPEC", "cmd.exe")]
    shell = os.environ.get("SHELL") or ""
    if not shell or not Path(shell).exists():
        try:
            import pwd

            shell = pwd.getpwuid(os.getuid()).pw_shell
        except Exception:  # pragma: no cover - exotic systems
            shell = "/bin/sh"
    return [shell, "-l"]


def shell_flavor(argv: list[str]) -> str:
    name = Path(argv[0]).name.lower().removesuffix(".exe")
    if name in ("pwsh", "powershell"):
        return "powershell"
    if name == "fish":
        return "fish"
    if name == "cmd":
        return "cmd"
    return "posix"


def quote(arg: str, flavor: str) -> str:
    """Quote one argument for the given shell."""
    if flavor == "powershell":
        return "'" + arg.replace("'", "''") + "'"
    if flavor == "cmd":
        return '"' + arg.replace('"', '""') + '"'
    return shlex.quote(arg)


def command_line(argv: list[str], flavor: str) -> str:
    """Build a readable command line: plain words stay unquoted."""
    safe = re.compile(r"^[A-Za-z0-9_@%+=:,./~-]+$")
    parts = []
    for i, a in enumerate(argv):
        if safe.match(a) and not (flavor == "powershell" and i > 0 and a.startswith("@")):
            parts.append(a)
        else:
            parts.append(quote(a, flavor))
    if flavor == "powershell" and parts and parts[0] != argv[0]:
        parts[0] = "& " + parts[0]  # a quoted program name needs the call operator
    return " ".join(parts)


INIT = {
    # Leading space keeps it out of history where the shell honours that.
    "posix": " b2done() { printf '\\033]7337;%s;%s\\007' \"$1\" \"$2\"; }; printf '\\033]7337;ready;0\\007'; clear\r",
    "fish": " function b2done; printf '\\e]7337;%s;%s\\a' $argv[1] $argv[2]; end; printf '\\e]7337;ready;0\\a'; clear\r",
    "powershell": (
        " function b2done($i, $ok, $c) { if ($ok) { $c = 0 } elseif (-not $c) { $c = 1 }; "
        "[Console]::Write([char]27 + ']7337;' + $i + ';' + $c + [char]7) }; "
        "[Console]::Write([char]27 + ']7337;ready;0' + [char]7); Clear-Host\r"
    ),
}

SUFFIX = {
    "posix": "; b2done {id} $?",
    "fish": "; b2done {id} $status",
    "powershell": "; b2done {id} $? $LASTEXITCODE",
}


def terminal_env() -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if not k.startswith(("ELECTRON_", "VITE_", "BRAIN2_TOKEN"))}
    env.pop("PYTHONUNBUFFERED", None)
    env.update({"TERM": "xterm-256color", "COLORTERM": "truecolor", "TERM_PROGRAM": "BRAIN2"})
    if not IS_WINDOWS:
        env.setdefault("LANG", "en_US.UTF-8")
    return env


# --------------------------------------------------------------------------- pty backends
class _Pty:
    def __init__(self, argv: list[str], cwd: str, env: dict[str, str], cols: int, rows: int):
        if IS_WINDOWS:  # pragma: no cover - exercised on Windows only
            from winpty import PtyProcess  # type: ignore[import-not-found]

            self._p = PtyProcess.spawn(argv, cwd=cwd, env=env, dimensions=(rows, cols))
            self._text = True
        else:
            import warnings

            from ptyprocess import PtyProcess

            with warnings.catch_warnings():  # fork+exec right away: safe despite our threads
                warnings.simplefilter("ignore", DeprecationWarning)
                self._p = PtyProcess.spawn(argv, cwd=cwd, env=env, dimensions=(rows, cols))
            self._text = False
        self.pid = self._p.pid

    def read(self) -> bytes:
        data = self._p.read(65536)
        return data.encode("utf-8", "replace") if isinstance(data, str) else data

    def write(self, data: str) -> None:
        self._p.write(data if self._text else data.encode("utf-8"))

    def resize(self, cols: int, rows: int) -> None:
        self._p.setwinsize(rows, cols)

    def alive(self) -> bool:
        return self._p.isalive()

    def kill(self) -> None:
        try:
            self._p.terminate(force=True)
        except Exception:
            pass


# --------------------------------------------------------------------------- terminals
@dataclass
class Job:
    id: str
    command: str
    start: int  # buffer offset when the job was submitted
    future: Future = field(default_factory=Future)


class TerminalError(Exception):
    status = 400


class Terminal:
    def __init__(self, manager: "TerminalManager", tid: str, title: str, cwd: str, key: str | None,
                 shell: list[str], cols: int = 100, rows: int = 24):
        self.manager = manager
        self.id = tid
        self.title = title
        self.cwd = cwd
        self.key = key
        self.shell = shell
        self.flavor = shell_flavor(shell)
        self.created_at = time.time()
        self.exit_code: int | None = None
        self._buffer = bytearray()
        self._dropped = 0  # bytes trimmed from the front of the buffer
        self._carry = b""
        self._subs: list[Callable[[bytes], None]] = []
        self._lock = threading.RLock()
        self._jobs: dict[str, Job] = {}
        self._ready = threading.Event()
        self._pre: bytearray = bytearray()  # output swallowed until the helper is installed
        self._pty = _Pty(shell, cwd, terminal_env(), cols, rows)
        threading.Thread(target=self._reader, name=f"term-{tid}", daemon=True).start()
        if self.flavor in INIT:
            self._pty.write(INIT[self.flavor])
            threading.Timer(4.0, self._force_ready).start()
        else:
            self._ready.set()

    # ------------------------------------------------------------ io
    def _force_ready(self) -> None:
        if not self._ready.is_set():
            with self._lock:
                pre, self._pre = bytes(self._pre), bytearray()
                self._ready.set()
            self._emit(pre)

    def _reader(self) -> None:
        while True:
            try:
                data = self._pty.read()
            except (EOFError, OSError):
                break
            if not data:
                if not self._pty.alive():
                    break
                continue
            self._feed(data)
        self.exit_code = 0
        for job in list(self._jobs.values()):
            if not job.future.done():
                job.future.set_result({"code": -1, "output": "Terminal closed"})
        self._emit(b"\r\n\x1b[2m[process exited]\x1b[0m\r\n")
        self.manager._on_exit(self)

    def _feed(self, data: bytes) -> None:
        data = self._carry + data
        self._carry = b""
        # Keep an incomplete marker for the next chunk.
        cut = data.rfind(MARK_PREFIX)
        if cut != -1 and b"\x07" not in data[cut:]:
            data, self._carry = data[:cut], data[cut:]
            if len(self._carry) > 256:  # not ours after all
                data, self._carry = data + self._carry, b""
        if not self._ready.is_set():
            ready = re.search(rb"\x1b\]7337;ready;[^\x07]*\x07", data)
            with self._lock:
                if not ready:
                    self._pre.extend(data)
                    return
                self._pre = bytearray()
                self._ready.set()
            # Everything before "ready" was the startup noise + helper definition echo: drop it.
            data = data[ready.end():]
        marks = MARK_RE.findall(data)
        if marks:
            data = MARK_RE.sub(b"", data)
        self._emit(data)
        for job_id, code in marks:
            self._finish(job_id.decode(errors="replace"), code.decode(errors="replace"))

    def _emit(self, data: bytes) -> None:
        if not data:
            return
        with self._lock:
            self._buffer.extend(data)
            if len(self._buffer) > MAX_BUFFER:
                drop = len(self._buffer) - MAX_BUFFER
                del self._buffer[:drop]
                self._dropped += drop
            subs = list(self._subs)
        for fn in subs:
            try:
                fn(data)
            except Exception:
                pass

    def _finish(self, job_id: str, code: str) -> None:
        job = self._jobs.pop(job_id, None)
        if not job or job.future.done():
            return
        try:
            exit_code = int(code.strip() or "0")
        except ValueError:
            exit_code = 1
        with self._lock:
            start = max(0, job.start - self._dropped)
            raw = bytes(self._buffer[start:])
        output = strip_ansi(raw.decode("utf-8", "replace"))
        job.future.set_result({"code": exit_code, "output": output})
        self.manager.publish({"type": "terminal.job", "terminal_id": self.id, "job_id": job_id, "code": exit_code})

    def snapshot(self) -> bytes:
        with self._lock:
            return bytes(self._buffer)

    def subscribe(self, fn: Callable[[bytes], None]) -> Callable[[], None]:
        with self._lock:
            self._subs.append(fn)

        def unsubscribe() -> None:
            with self._lock:
                if fn in self._subs:
                    self._subs.remove(fn)

        return unsubscribe

    def write(self, data: str) -> None:
        if self.exit_code is None:
            self._pty.write(data)

    def resize(self, cols: int, rows: int) -> None:
        if self.exit_code is None and cols > 0 and rows > 0:
            try:
                self._pty.resize(cols, rows)
            except Exception:
                pass

    # ------------------------------------------------------------ jobs
    def run(self, argv: list[str] | str, cwd: str | None = None) -> Job:
        """Type a command into the terminal; the returned job resolves with its exit code + output."""
        if self.exit_code is not None:
            raise TerminalError("This terminal has exited")
        if self.flavor not in SUFFIX:
            raise TerminalError("Commands can only be run in bash/zsh/fish/PowerShell terminals")
        self._ready.wait(5)
        cmd = argv if isinstance(argv, str) else command_line(argv, self.flavor)
        if cwd:
            cmd = f"cd {quote(cwd, self.flavor)} && {cmd}" if self.flavor != "powershell" else \
                f"Set-Location -LiteralPath {quote(cwd, self.flavor)}; {cmd}"
        job_id = uuid.uuid4().hex[:8]
        with self._lock:
            job = Job(job_id, cmd, self._dropped + len(self._buffer))
            self._jobs[job_id] = job
        clear_line = "" if self.flavor == "powershell" else "\x05\x15"  # end-of-line, kill line
        self._pty.write(clear_line + cmd + SUFFIX[self.flavor].format(id=job_id) + "\r")
        return job

    def run_wait(self, argv: list[str] | str, cwd: str | None = None, timeout: float | None = None) -> dict[str, Any]:
        job = self.run(argv, cwd)
        return job.future.result(timeout=timeout)

    def info(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "cwd": self.cwd,
            "key": self.key,
            "shell": Path(self.shell[0]).name,
            "flavor": self.flavor,
            "alive": self.exit_code is None,
            "created_at": self.created_at,
        }

    def close(self) -> None:
        self._pty.kill()


class TerminalManager:
    def __init__(self, publish: Callable[[dict], None] | None = None, shell: list[str] | None = None):
        self._terms: dict[str, Terminal] = {}
        self._lock = threading.Lock()
        self._publish = publish
        self.shell = shell

    def publish(self, event: dict) -> None:
        if self._publish:
            self._publish(event)

    def list(self) -> list[dict[str, Any]]:
        with self._lock:
            return [t.info() for t in sorted(self._terms.values(), key=lambda t: t.created_at)]

    def get(self, tid: str) -> Terminal:
        with self._lock:
            t = self._terms.get(tid)
        if not t:
            err = TerminalError("Terminal not found")
            err.status = 404
            raise err
        return t

    def by_key(self, key: str) -> Terminal | None:
        with self._lock:
            for t in self._terms.values():
                if t.key == key and t.exit_code is None:
                    return t
        return None

    def create(self, cwd: str | None = None, title: str | None = None, key: str | None = None,
               shell: list[str] | None = None) -> Terminal:
        if key:
            existing = self.by_key(key)
            if existing:
                if title and existing.title != title:
                    existing.title = title
                    self.publish({"type": "terminals.changed"})
                return existing
        home = str(Path.home())
        cwd = cwd if cwd and Path(cwd).is_dir() else home
        argv = shell or self.shell or default_shell()
        tid = uuid.uuid4().hex[:10]
        term = Terminal(self, tid, title or Path(argv[0]).name.removesuffix(".exe"), cwd, key, argv)
        with self._lock:
            self._terms[tid] = term
        if cwd != home and term.flavor in SUFFIX:
            # Shell rc files may change directory: cd visibly once the shell is ready.
            threading.Thread(target=lambda: term.run(["cd", cwd]), daemon=True).start()
        self.publish({"type": "terminals.changed"})
        return term

    def cd(self, tid: str, path: str) -> Job:
        t = self.get(tid)
        t.cwd = path
        return t.run(["cd", path])

    def ensure(self, key: str, title: str, cwd: str | None = None) -> Terminal:
        return self.create(cwd=cwd, title=title, key=key)

    def rename(self, tid: str, title: str) -> dict[str, Any]:
        t = self.get(tid)
        t.title = title.strip() or t.title
        self.publish({"type": "terminals.changed"})
        return t.info()

    def close(self, tid: str) -> None:
        t = self.get(tid)
        with self._lock:
            self._terms.pop(tid, None)
        t.close()
        self.publish({"type": "terminals.changed"})

    def _on_exit(self, term: Terminal) -> None:
        self.publish({"type": "terminals.changed"})

    def close_all(self) -> None:
        with self._lock:
            terms = list(self._terms.values())
            self._terms.clear()
        for t in terms:
            t.close()
