import pytest


@pytest.fixture(autouse=True)
def _no_keychain(monkeypatch):
    """Tests never touch the real OS keychain."""
    monkeypatch.setenv("BRAIN2_SECRETS", "memory")
