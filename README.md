# BRAIN2

The first **Personal Assistant Harness**: vaults, repos, messaging, calendars, boards and *Echoes*
(agents acting on your behalf) in one app.

> **Status — Wave 1: Vaults.** The other modules (Repos, Message queues, Calendars, Boards, Echoes)
> and Options (connectors, prompts, sync) are placeholders and arrive in later waves.

## Quick start

Requirements: Python ≥ 3.11, Node ≥ 20 (macOS, Linux, Windows 10/11).

```bash
make setup     # backend venv + npm install
make start     # build the UI and launch the desktop app
make dev       # same, with hot reload
make test      # backend tests + UI type-check
```

Without `make`: `cd backend && python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'`,
then `cd app && npm install && npm start`.

### Run modes

| Mode | How | Notes |
|---|---|---|
| Desktop (local) | `make start` | Electron starts the Python backend on a random local port with a random token. |
| Server | `make serve` / `brain2 serve --host 0.0.0.0 --port 8765` | Serves API **and** web UI. Open the printed `…/?token=…` URL. |
| Terminal (Linux & co.) | `brain2 serve` + a browser | AppImage / signed builds come later. |
| MCP | `brain2 mcp` | stdio MCP server for agents (Claude Code, Codex, …). |

Data lives in `~/Brain2` (override with `BRAIN2_HOME` or `--home`):

```
~/Brain2/
  brain2.db           SQLite index (everything is indexed here)
  internal-vaults/    vaults created inside BRAIN2
  internal-repos/ internal-messages/ internal-calendars/ internal-boards/ internal-echoes/
```

## Vaults (Wave 1)

A vault is a plain folder — exactly like Obsidian — but BRAIN2 can have **many vaults open**, and
each can open in its own window (right-click → *Open in new window*). Create a new vault inside
BRAIN2 or open any existing folder (existing Obsidian vaults work).

Supported files: Markdown (`.md`, `.markdown`), PDF, `.txt`, `.json`, `.yaml`/`.yml`, plus images,
audio and video as attachments.

Obsidian-style features:

- File explorer: create / rename / move (drag & drop) / delete (to `.brain2/trash`), drop files from the OS
- Tabs, back/forward history, inline title rename, quick switcher (⌘/Ctrl+O), command palette (⌘/Ctrl+P)
- Editor with **Live preview**, **Source** and **Reading** modes (⌘/Ctrl+E), autosave
- `[[Wikilinks]]`, `[[note#heading|alias]]`, `![[embeds]]` (notes, sections, images, PDFs, media),
  `#tags` and `#nested/tags`, YAML frontmatter as *Properties*, callouts `> [!tip]`, tasks,
  `==highlights==`, footnotes, code highlighting
- Link autocomplete (`[[`), tag autocomplete (`#`), emoji (`:smile:`) and Google Material icons
  (`:mi-home:`) — rendered everywhere
- Links update automatically when notes are renamed or moved
- Backlinks, outgoing links, outline, file info; full-text search (SQLite FTS5) with
  `tag:`, `path:`, `file:` operators; tags pane; graph view; daily notes
- Paste / drop images into a note → saved to the attachment folder and embedded
- External edits (other apps, sync, agents) are picked up live
- Skins (Options → System settings): **Typewriter** (default), **Primary**, **Blue Topaz**, each light/dark

### Indexing & metadata files

Everything is indexed in SQLite. In addition, each vault keeps human-readable JSON metadata in a
hidden `.brain2/` folder (so your note folders stay clean, like `.obsidian/`):

```
<vault>/.brain2/vault.json                       vault identity + connections to other modules
<vault>/.brain2/index/<path/to/note.md>.json     per document: parent folder, name, description, tags…
<vault>/.brain2/index/<folder>/__folder__.json   per folder: children + summary
<vault>/.brain2/trash/                           deleted files
```

## API & MCP

Every vault operation is available over HTTP (`/api/…`, OpenAPI docs at `/docs`), live change
events over WebSocket (`/api/events`), and as MCP tools (`list_vaults`, `read_file`, `write_file`,
`search`, `backlinks`, `move`, …). Requests need `Authorization: Bearer <token>` (or `?token=`).

## Repository layout

```
backend/   Python: FastAPI API, SQLite index, vault service, file watcher, MCP server, tests
app/       Electron main/preload + React/Vite renderer (CodeMirror 6 editor)
spike-*/   Design spikes (repo organization, resources)
```

## License

Free and open source to use, modify and distribute, **with credit to BRAIN2**. Offering it as a
service is allowed; charging for the code itself or modifications of it is not.
(Exact license text to be finalized.)
