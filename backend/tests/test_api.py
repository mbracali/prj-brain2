import base64

from fastapi.testclient import TestClient

from brain2.api.app import create_app
from brain2.config import load_config


def make_client(tmp_path, token="secret"):
    app = create_app(load_config(tmp_path / "home"), token=token, watch=False)
    return TestClient(app)


def test_auth_required(tmp_path):
    with make_client(tmp_path) as c:
        assert c.get("/api/health").status_code == 200
        assert c.get("/api/vaults").status_code == 401
        assert c.get("/api/vaults", headers={"Authorization": "Bearer secret"}).status_code == 200
        assert c.get("/api/vaults?token=secret").status_code == 200


def test_vault_flow(tmp_path):
    with make_client(tmp_path) as c:
        c.headers["Authorization"] = "Bearer secret"
        v = c.post("/api/vaults", json={"name": "Notes"}).json()
        vid = v["id"]
        assert c.post("/api/vaults", json={"name": "bad/name"}).status_code == 400

        r = c.post(f"/api/vaults/{vid}/file", json={"folder": "", "ext": "md"})
        assert r.status_code == 201 and r.json()["path"] == "Untitled.md"
        c.put(f"/api/vaults/{vid}/file", json={"path": "Untitled.md", "content": "# Hi\n[[Other]]"})
        c.put(f"/api/vaults/{vid}/file", json={"path": "Other.md", "content": "other"})
        assert c.get(f"/api/vaults/{vid}/file", params={"path": "Untitled.md"}).json()["title"] == "Hi"
        assert c.get(f"/api/vaults/{vid}/backlinks", params={"path": "Other.md"}).json()[0]["path"] == "Untitled.md"
        assert c.get(f"/api/vaults/{vid}/resolve", params={"link": "Other"}).json() == {"path": "Other.md"}
        assert c.get(f"/api/vaults/{vid}/outline", params={"path": "Untitled.md"}).json()[0]["text"] == "Hi"

        png = base64.b64encode(b"\x89PNG\r\n\x1a\nfake").decode()
        att = c.post(f"/api/vaults/{vid}/attachment", json={"name": "pic.png", "data_base64": png}).json()
        raw = c.get(f"/api/vaults/{vid}/raw", params={"path": att["path"]})
        assert raw.status_code == 200 and raw.content.startswith(b"\x89PNG")

        assert c.post(f"/api/vaults/{vid}/move", json={"src": "Other.md", "dst": "Moved.md"}).status_code == 200
        assert "[[Moved]]" in c.get(f"/api/vaults/{vid}/file", params={"path": "Untitled.md"}).json()["content"]
        assert c.get(f"/api/vaults/{vid}/meta", params={"path": "Moved.md"}).json()["name"] == "Moved.md"
        assert c.delete(f"/api/vaults/{vid}/entry", params={"path": "Moved.md"}).status_code == 200
        assert c.get(f"/api/vaults/{vid}/file", params={"path": "Moved.md"}).status_code == 404
        assert c.get(f"/api/vaults/{vid}/raw", params={"path": "../../brain2.db"}).status_code == 400

        assert c.put("/api/settings", json={"skin": "typewriter"}).json()["skin"] == "typewriter"
        assert c.delete(f"/api/vaults/{vid}").status_code == 200
        assert c.get("/api/vaults").json() == []


def test_websocket_events(tmp_path):
    with make_client(tmp_path) as c:
        c.headers["Authorization"] = "Bearer secret"
        with c.websocket_connect("/api/events?token=secret") as ws:
            c.post("/api/vaults", json={"name": "W"})
            assert ws.receive_json()["type"] == "vaults.changed"
