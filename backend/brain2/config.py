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
"""

from __future__ import annotations

import os
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


@dataclass(frozen=True)
class Config:
    home: Path

    @property
    def db_path(self) -> Path:
        return self.home / "brain2.db"

    @property
    def vaults_dir(self) -> Path:
        return self.home / "internal-vaults"

    def ensure(self) -> "Config":
        self.home.mkdir(parents=True, exist_ok=True)
        for name in INTERNAL_DIRS:
            (self.home / name).mkdir(exist_ok=True)
        return self


def load_config(home: str | os.PathLike[str] | None = None) -> Config:
    raw = home or os.environ.get("BRAIN2_HOME") or Path.home() / "Brain2"
    return Config(home=Path(raw).expanduser().resolve()).ensure()
