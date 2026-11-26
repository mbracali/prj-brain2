import json

from brain2.config import load_config
from brain2.db import Database


def test_settings_live_in_config_dir_and_migrate(tmp_path, monkeypatch):
    monkeypatch.delenv("BRAIN2_CONFIG_DIR", raising=False)
    config = load_config(tmp_path / "home")
    assert config.config_dir == tmp_path / "home" / "config"

    # Settings written by an older version (inside the database) move to settings.json once.
    old = Database(config.db_path)
    old.update_settings({"theme": "dark", "fontSize": 18})
    old.close()

    db = Database(config.db_path, config.settings_path)
    assert json.loads(config.settings_path.read_text())["theme"] == "dark"
    db.update_settings({"fontSize": 20, "theme": None})
    assert db.get_settings() == {"fontSize": 20}
    db.close()

    # Reopening never resets the file.
    again = Database(config.db_path, config.settings_path)
    assert again.get_settings() == {"fontSize": 20}


def test_broken_settings_file_is_kept(tmp_path):
    config = load_config(tmp_path / "home")
    config.settings_path.write_text("{ not json")
    db = Database(config.db_path, config.settings_path)
    assert db.get_settings() == {}
    assert list(config.config_dir.glob("settings.broken-*.json"))


def test_config_dir_override(tmp_path, monkeypatch):
    monkeypatch.setenv("BRAIN2_CONFIG_DIR", str(tmp_path / "cfg"))
    assert load_config(tmp_path / "home").config_dir == (tmp_path / "cfg").resolve()
