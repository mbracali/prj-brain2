import pytest


@pytest.fixture(autouse=True)
def _no_keychain(monkeypatch):
    """Tests never touch the real OS keychain."""
    monkeypatch.setenv("BRAIN2_SECRETS", "memory")


@pytest.fixture(autouse=True)
def _no_builtin_oauth(monkeypatch):
    """Tests don't see a developer's local built-in OAuth client (oauth_clients.json / env)."""
    from brain2.accounts import builtin

    for var in ("BRAIN2_GOOGLE_CLIENT_ID", "BRAIN2_GOOGLE_CLIENT_SECRET", "BRAIN2_MICROSOFT_CLIENT_ID"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setattr(builtin, "_file_clients", lambda: {})
