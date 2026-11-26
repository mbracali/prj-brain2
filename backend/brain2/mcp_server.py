"""MCP (Model Context Protocol) server exposing vault capabilities to agents.

Run with ``brain2 mcp`` (stdio transport). It shares the same SQLite index and
service layer as the HTTP API.
"""

from __future__ import annotations

from typing import Any

from mcp.server.mcpserver import MCPServer

from .config import load_config
from .db import Database
from .vaults.service import VaultService


def build_server(service: VaultService | None = None) -> MCPServer:
    if service is None:
        config = load_config()
        service = VaultService(Database(config.db_path, config.settings_path), config)
    svc = service
    mcp = MCPServer("brain2", instructions="Read and write the notes in the user's BRAIN2 vaults.")

    def vault_id(vault: str) -> str:
        for v in svc.list_vaults():
            if vault in (v["id"], v["name"]):
                return v["id"]
        raise ValueError(f"Unknown vault: {vault}")

    @mcp.tool()
    def list_vaults() -> list[dict[str, Any]]:
        """List all BRAIN2 vaults (id, name, path, note counts)."""
        return [{k: v[k] for k in ("id", "name", "path", "note_count", "file_count")} for v in svc.list_vaults()]

    @mcp.tool()
    def create_vault(name: str, path: str | None = None) -> dict[str, Any]:
        """Create a vault. Without `path` it is created inside BRAIN2's internal-vaults folder;
        with `path` an existing folder is opened as a vault."""
        return svc.create_vault(name, path)

    @mcp.tool()
    def list_files(vault: str, kind: str | None = None) -> list[dict[str, Any]]:
        """List files in a vault (path, kind, title, description). `kind` filters by markdown/pdf/text/json/yaml/image."""
        return svc.list_files(vault_id(vault), kind)

    @mcp.tool()
    def read_file(vault: str, path: str) -> dict[str, Any]:
        """Read a file's content and metadata (frontmatter, tags, description)."""
        return svc.read_file(vault_id(vault), path)

    @mcp.tool()
    def write_file(vault: str, path: str, content: str) -> dict[str, Any]:
        """Create or overwrite a file in a vault."""
        return svc.write_file(vault_id(vault), path, content)

    @mcp.tool()
    def append_to_file(vault: str, path: str, content: str) -> dict[str, Any]:
        """Append text to a file (creating it if needed)."""
        vid = vault_id(vault)
        try:
            existing = svc.read_file(vid, path).get("content", "")
        except Exception:
            existing = ""
        sep = "" if not existing or existing.endswith("\n") else "\n"
        return svc.write_file(vid, path, existing + sep + content)

    @mcp.tool()
    def create_folder(vault: str, path: str) -> dict[str, Any]:
        """Create a folder (path relative to the vault root)."""
        parent, _, name = path.strip("/").rpartition("/")
        return svc.create_folder(vault_id(vault), parent, name)

    @mcp.tool()
    def move(vault: str, src: str, dst: str) -> dict[str, Any]:
        """Rename or move a file/folder. Wiki links pointing at it are updated."""
        return svc.move(vault_id(vault), src, dst)

    @mcp.tool()
    def delete(vault: str, path: str) -> dict[str, Any]:
        """Move a file/folder to the vault trash (.brain2/trash)."""
        return svc.delete(vault_id(vault), path)

    @mcp.tool()
    def search(vault: str, query: str, limit: int = 20) -> list[dict[str, Any]]:
        """Full-text search. Supports `tag:x`, `#x`, `path:dir`, `file:name` operators."""
        return svc.search(vault_id(vault), query, limit)

    @mcp.tool()
    def backlinks(vault: str, path: str) -> list[dict[str, Any]]:
        """Notes linking to `path`."""
        return svc.backlinks(vault_id(vault), path)

    @mcp.tool()
    def outgoing_links(vault: str, path: str) -> list[dict[str, Any]]:
        """Links found in `path`, with their resolved targets."""
        return svc.outgoing_links(vault_id(vault), path)

    @mcp.tool()
    def tags(vault: str) -> list[dict[str, Any]]:
        """All tags in a vault with usage counts."""
        return svc.tags(vault_id(vault))

    return mcp


def run_stdio() -> None:
    build_server().run()
