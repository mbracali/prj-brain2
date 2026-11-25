import json
import time
from pathlib import Path

import pytest

from brain2.config import load_config
from brain2.db import Database
from brain2.vaults.service import Conflict, VaultError, VaultService


@pytest.fixture
def svc(tmp_path):
    config = load_config(tmp_path / "home")
    s = VaultService(Database(config.db_path), config)
    yield s
    s.stop_watching()


def test_home_layout(svc):
    for d in ("internal-vaults", "internal-repos", "internal-echoes"):
        assert (svc.config.home / d).is_dir()


def test_create_internal_vault_and_write(svc):
    v = svc.create_vault("Main")
    root = Path(v["path"])
    assert root == svc.config.vaults_dir / "Main"
    assert json.loads((root / ".brain2/vault.json").read_text())["id"] == v["id"]

    svc.write_file(v["id"], "Projects/Idea.md", "# Idea\n\nA small idea #todo")
    info = svc.read_file(v["id"], "Projects/Idea.md")
    assert info["title"] == "Idea" and info["tags"] == ["todo"]
    assert info["content"].startswith("# Idea")

    side = json.loads((root / ".brain2/index/Projects/Idea.md.json").read_text())
    assert side["parent_folder"] == "Projects"
    assert side["name"] == "Idea.md"
    assert side["description"] == "A small idea todo"
    folder = json.loads((root / ".brain2/index/Projects/__folder__.json").read_text())
    assert folder["files"] == [{"name": "Idea.md", "kind": "markdown"}]

    tree = svc.tree(v["id"])
    assert tree["children"][0]["name"] == "Projects"
    assert tree["children"][0]["children"][0]["path"] == "Projects/Idea.md"


def test_duplicate_and_bad_paths(svc):
    v = svc.create_vault("V")
    with pytest.raises(Conflict):
        svc.create_vault("Other", v["path"])
    with pytest.raises(VaultError):
        svc.write_file(v["id"], "../escape.md", "x")
    with pytest.raises(VaultError):
        svc.write_file(v["id"], ".brain2/x.md", "x")


def test_open_existing_folder_indexes_everything(svc, tmp_path):
    folder = tmp_path / "existing"
    (folder / "sub").mkdir(parents=True)
    (folder / "a.md").write_text("link to [[b]]")
    (folder / "sub/b.md").write_text("# B")
    (folder / "data.json").write_text('{"k": 1}')
    (folder / "conf.yaml").write_text("k: 1")
    (folder / "notes.txt").write_text("plain text here")
    (folder / ".hidden.md").write_text("x")
    v = svc.create_vault("Existing", str(folder))
    kinds = {f["path"]: f["kind"] for f in svc.list_files(v["id"])}
    assert kinds == {"a.md": "markdown", "sub/b.md": "markdown", "data.json": "json",
                     "conf.yaml": "yaml", "notes.txt": "text"}
    assert svc.backlinks(v["id"], "sub/b.md")[0]["path"] == "a.md"
    assert svc.outgoing_links(v["id"], "a.md")[0]["resolved"] == "sub/b.md"


def test_create_file_unique_names(svc):
    v = svc.create_vault("V")
    a = svc.create_file(v["id"])
    b = svc.create_file(v["id"])
    assert (a["path"], b["path"]) == ("Untitled.md", "Untitled 1.md")
    f = svc.create_folder(v["id"])
    assert f["path"] == "Untitled"


def test_move_updates_links(svc):
    v = svc.create_vault("V")
    vid = v["id"]
    svc.write_file(vid, "Target.md", "# T")
    svc.write_file(vid, "Ref.md", "see [[Target#h|alias]] and ![[Target]]")
    res = svc.move(vid, "Target.md", "Folder/Renamed.md")
    assert res["path"] == "Folder/Renamed.md"
    assert svc.read_file(vid, "Ref.md")["content"] == "see [[Renamed#h|alias]] and ![[Renamed]]"
    assert svc.backlinks(vid, "Folder/Renamed.md")[0]["path"] == "Ref.md"
    assert not (Path(v["path"]) / ".brain2/index/Target.md.json").exists()


def test_move_folder(svc):
    v = svc.create_vault("V")
    vid = v["id"]
    svc.write_file(vid, "A/n.md", "x")
    svc.move(vid, "A", "B")
    assert [f["path"] for f in svc.list_files(vid)] == ["B/n.md"]
    with pytest.raises(VaultError):
        svc.move(vid, "B", "B/inner")


def test_delete_goes_to_trash(svc):
    v = svc.create_vault("V")
    svc.write_file(v["id"], "gone.md", "x")
    res = svc.delete(v["id"], "gone.md")
    assert (Path(v["path"]) / res["trashed_to"]).is_file()
    assert svc.list_files(v["id"]) == []


def test_search_and_tags(svc):
    v = svc.create_vault("V")
    vid = v["id"]
    svc.write_file(vid, "alpha.md", "The quick brown fox #animals/wild")
    svc.write_file(vid, "beta.md", "Lazy dog sleeping #animals")
    svc.write_file(vid, "work/gamma.md", "quarterly report")
    assert [r["path"] for r in svc.search(vid, "quic")] == ["alpha.md"]
    assert {r["path"] for r in svc.search(vid, "tag:animals")} == {"alpha.md", "beta.md"}
    assert [r["path"] for r in svc.search(vid, "#animals/wild")] == ["alpha.md"]
    assert [r["path"] for r in svc.search(vid, "path:work report")] == ["work/gamma.md"]
    assert svc.search(vid, 'weird " query (') == []
    snippet = svc.search(vid, "brown")[0]["snippet"]
    assert "\x02brown\x03" in snippet
    assert {t["tag"] for t in svc.tags(vid)} == {"animals", "animals/wild"}


def test_graph(svc):
    v = svc.create_vault("V")
    vid = v["id"]
    svc.write_file(vid, "a.md", "[[b]] [[ghost]]")
    svc.write_file(vid, "b.md", "[[a]]")
    g = svc.graph(vid)
    edges = {(e["source"], e["target"]) for e in g["edges"]}
    assert edges == {("a.md", "b.md"), ("b.md", "a.md"), ("a.md", "unresolved:ghost")}


def test_external_edits_are_picked_up(svc):
    v = svc.create_vault("V")
    svc.start_watching()
    events = []
    svc.bus.subscribe(events.append)
    root = Path(v["path"])
    (root / "external.md").write_text("# External #ext")
    deadline = time.time() + 5
    while time.time() < deadline and not svc.list_files(v["id"]):
        time.sleep(0.1)
    assert [f["path"] for f in svc.list_files(v["id"])] == ["external.md"]
    assert any(e.get("origin") == "fs" for e in events)
    (root / "external.md").unlink()
    deadline = time.time() + 5
    while time.time() < deadline and svc.list_files(v["id"]):
        time.sleep(0.1)
    assert svc.list_files(v["id"]) == []


def test_reregister_keeps_id_and_delete_vault(svc, tmp_path):
    folder = tmp_path / "keep"
    v = svc.create_vault("Keep", str(folder))
    svc.delete_vault(v["id"])
    assert folder.is_dir()
    again = svc.create_vault("Keep", str(folder))
    assert again["id"] == v["id"]
    with pytest.raises(VaultError):
        svc.delete_vault(again["id"], delete_files=True)  # external vault files are never deleted


def test_icons_follow_moves_and_deletes(svc):
    v = svc.create_vault("V")
    vid = v["id"]
    svc.write_file(vid, "A/n.md", "x")
    svc.set_icon(vid, "A/n.md", "star")
    svc.set_icon(vid, "A", "🚀")
    svc.move(vid, "A", "B")
    assert svc.get_icons(vid) == {"B": "🚀", "B/n.md": "star"}
    svc.delete(vid, "B/n.md")
    assert svc.get_icons(vid) == {"B": "🚀"}
    svc.set_icon(vid, "B", "")
    assert svc.get_icons(vid) == {}


def test_excalidraw_files(svc):
    v = svc.create_vault("V")
    vid = v["id"]
    svc.write_file(vid, "plain.excalidraw", '{"type":"excalidraw","elements":[{"type":"text","text":"Hello sketch"}]}')
    md = "---\nexcalidraw-plugin: parsed\n---\n# Text Elements\nBox label ^abc12345\n\n# Embedded files\n[[Note]]\n\n%%\n# Drawing\n```json\n{}\n```\n%%"
    svc.write_file(vid, "Board.excalidraw.md", md)
    svc.write_file(vid, "Note.md", "see [[Board.excalidraw]] and [[plain.excalidraw]]")
    kinds = {f["path"]: f["kind"] for f in svc.list_files(vid)}
    assert kinds["plain.excalidraw"] == "excalidraw" and kinds["Board.excalidraw.md"] == "excalidraw"
    assert [r["path"] for r in svc.search(vid, "sketch")] == ["plain.excalidraw"]
    assert [r["path"] for r in svc.search(vid, "label")] == ["Board.excalidraw.md"]
    resolved = {l["target"]: l["resolved"] for l in svc.outgoing_links(vid, "Note.md")}
    assert resolved == {"Board.excalidraw": "Board.excalidraw.md", "plain.excalidraw": "plain.excalidraw"}
    assert svc.backlinks(vid, "Note.md")[0]["path"] == "Board.excalidraw.md"


def test_graph_tags(svc):
    v = svc.create_vault("V")
    svc.write_file(v["id"], "a.md", "#topic")
    g = svc.graph(v["id"], include_tags=True)
    assert {"source": "a.md", "target": "tag:topic", "weight": 1} in g["edges"]
