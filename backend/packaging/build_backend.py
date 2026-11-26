"""Freeze the backend into a self-contained folder for the desktop installers.

    python packaging/build_backend.py            ->  backend/dist/brain2-server/brain2-server[.exe]

The desktop app (electron-builder) copies that folder into its resources and starts it instead of
a system Python, so end users don't need Python installed. Runs on the OS you build for (PyInstaller
does not cross-compile): CI builds it once per platform.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parent

# Packages that load parts of themselves dynamically (uvicorn protocols, keyring backends, tz data…).
COLLECT_ALL = ["uvicorn", "keyring", "icalendar", "recurring_ical_events", "x_wr_timezone", "tzdata"]
COLLECT_SUBMODULES = ["brain2", "websockets", "watchdog", "httpx", "anyio"]
HIDDEN = (["winpty"] if sys.platform == "win32" else ["ptyprocess"]) + (
    ["keyring.backends.macOS"] if sys.platform == "darwin" else
    ["keyring.backends.Windows"] if sys.platform == "win32" else
    ["keyring.backends.SecretService"]
)


def main() -> None:
    dist = BACKEND / "dist"
    shutil.rmtree(dist / "brain2-server", ignore_errors=True)
    cmd = [
        sys.executable, "-m", "PyInstaller",
        "--noconfirm", "--clean", "--onedir",
        "--name", "brain2-server",
        "--console",  # stdout/stderr go to the app's log; the window is hidden by the desktop app
        "--distpath", str(dist),
        "--workpath", str(BACKEND / "build" / "pyinstaller"),
        "--specpath", str(BACKEND / "build"),
        "--paths", str(BACKEND),
    ]
    for pkg in COLLECT_ALL:
        cmd += ["--collect-all", pkg]
    for pkg in COLLECT_SUBMODULES:
        cmd += ["--collect-submodules", pkg]
    for mod in HIDDEN:
        cmd += ["--hidden-import", mod]
    if sys.platform == "darwin":
        # Same bundle id family as the app: keychain items stay attributed to BRAIN2.
        cmd += ["--osx-bundle-identifier", "app.brain2.server"]
    cmd.append(str(HERE / "brain2_server.py"))
    print(" ".join(cmd), flush=True)
    subprocess.run(cmd, check=True, cwd=BACKEND)
    exe = dist / "brain2-server" / ("brain2-server.exe" if sys.platform == "win32" else "brain2-server")
    if not exe.exists():
        sys.exit(f"Build finished but {exe} is missing")
    print(f"Built {exe}")


if __name__ == "__main__":
    main()
