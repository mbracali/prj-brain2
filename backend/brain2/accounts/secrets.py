"""Secret storage: the OS keychain (macOS Keychain, Windows Credential Manager, Secret Service on Linux).

Falls back to a private JSON file in the BRAIN2 home (mode 0600) when no keychain is available.
Secrets never go into the SQLite database or the API responses.
"""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path

SERVICE = "BRAIN2"


class SecretStore:
    def get(self, key: str) -> str | None:  # pragma: no cover - interface
        raise NotImplementedError

    def set(self, key: str, value: str) -> None:  # pragma: no cover - interface
        raise NotImplementedError

    def delete(self, key: str) -> None:  # pragma: no cover - interface
        raise NotImplementedError

    label = "secret store"

    def get_json(self, key: str) -> dict | None:
        raw = self.get(key)
        try:
            return json.loads(raw) if raw else None
        except ValueError:
            return None

    def set_json(self, key: str, value: dict) -> None:
        self.set(key, json.dumps(value))


class MemorySecrets(SecretStore):
    label = "memory (tests)"

    def __init__(self) -> None:
        self._d: dict[str, str] = {}

    def get(self, key):
        return self._d.get(key)

    def set(self, key, value):
        self._d[key] = value

    def delete(self, key):
        self._d.pop(key, None)


class FileSecrets(SecretStore):
    label = "private file"

    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.Lock()

    def _load(self) -> dict[str, str]:
        try:
            return json.loads(self.path.read_text("utf-8"))
        except (OSError, ValueError):
            return {}

    def _save(self, data: dict[str, str]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data), "utf-8")
        try:
            os.chmod(tmp, 0o600)
        except OSError:
            pass
        tmp.replace(self.path)

    def get(self, key):
        with self._lock:
            return self._load().get(key)

    def set(self, key, value):
        with self._lock:
            d = self._load()
            d[key] = value
            self._save(d)

    def delete(self, key):
        with self._lock:
            d = self._load()
            if d.pop(key, None) is not None:
                self._save(d)


class KeyringSecrets(SecretStore):
    def __init__(self) -> None:
        import keyring

        self._k = keyring
        name = type(keyring.get_keyring()).__module__
        self.label = ("macOS Keychain" if "macOS" in name else "Windows Credential Manager" if "Windows" in name
                      else "system keyring")

    def get(self, key):
        return self._k.get_password(SERVICE, key)

    def set(self, key, value):
        self._k.set_password(SERVICE, key, value)

    def delete(self, key):
        try:
            self._k.delete_password(SERVICE, key)
        except Exception:
            pass


def default_secrets(home: Path) -> SecretStore:
    mode = os.environ.get("BRAIN2_SECRETS", "")
    if mode == "memory":
        return MemorySecrets()
    if mode != "file":
        try:
            import keyring
            from keyring.backends import fail

            if not isinstance(keyring.get_keyring(), fail.Keyring):
                return KeyringSecrets()
        except Exception:
            pass
    return FileSecrets(home / "secrets.json")
