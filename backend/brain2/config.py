"""Runtime configuration: where BRAIN2 keeps its data.

Layout of the BRAIN2 home directory (mirrors ``spike-repo-organization``)::

    <home>/
      brain2.db            SQLite index (the single source of indexing truth)
      internal-vaults/     vaults created from inside the app
      internal-repos/      (wave 2+)
      internal-messages/   (wave 2+)
      internal-calendars/  (wave 2+)
      internal-boards/     (wave 2+)
      internal-echoes/     (wave 2+)

The home defaults to ``~/Brain2`` and can be overridden with ``BRAIN2_HOME``.

User configuration (``settings.json``: preferences, custom themes, connector app ids) lives in
the OS's per-user config folder, never inside the installed app, so updating BRAIN2 can't
overwrite it and rebuilding the index can't lose it:

    macOS    ~/Library/Application Support/BRAIN2
    Windows  %APPDATA%\\BRAIN2
    Linux    $XDG_CONFIG_HOME/brain2  (~/.config/brain2)

``BRAIN2_CONFIG_DIR`` overrides it. A custom home (``--home`` / ``BRAIN2_HOME``) keeps its
config next to it in ``<home>/config`` so separate instances never share settings.
Passwords, tokens and keys are not config: they go to the OS keychain.
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from pathlib import Path

INTERNAL_DIRS = (
    "internal-vaults",
    "internal-repos",
    "internal-messages",
    "internal-calendars",
    "internal-boards",
    "internal-echoes",
)


def default_config_dir() -> Path:
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "BRAIN2"
    if sys.platform == "win32":
        base = os.environ.get("APPDATA")
        return (Path(base) if base else Path.home() / "AppData" / "Roaming") / "BRAIN2"
    base = os.environ.get("XDG_CONFIG_HOME")
    return (Path(base) if base else Path.home() / ".config") / "brain2"


@dataclass(frozen=True)
class Config:
    home: Path
    config_dir: Path

    @property
    def settings_path(self) -> Path:
        return self.config_dir / "settings.json"

    @property
    def db_path(self) -> Path:
        return self.home / "brain2.db"

    @property
    def vaults_dir(self) -> Path:
        return self.home / "internal-vaults"

    def ensure(self) -> "Config":
        self.home.mkdir(parents=True, exist_ok=True)
        self.config_dir.mkdir(parents=True, exist_ok=True)
        for name in INTERNAL_DIRS:
            (self.home / name).mkdir(exist_ok=True)
        return self


def load_config(home: str | os.PathLike[str] | None = None) -> Config:
    custom = home or os.environ.get("BRAIN2_HOME")
    root = Path(custom or Path.home() / "Brain2").expanduser().resolve()
    env_cfg = os.environ.get("BRAIN2_CONFIG_DIR")
    if env_cfg:
        cfg = Path(env_cfg).expanduser().resolve()
    elif custom:
        cfg = root / "config"
    else:
        cfg = default_config_dir()
    return Config(home=root, config_dir=cfg).ensure()
