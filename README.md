# BRAIN2

The first **Personal Assistant Harness**: vaults, repos, messaging, calendars, boards and *Echoes*
(agents acting on your behalf) in one app.

> **Status — Wave 1: Vaults.** The other modules (Repos, Message queues, Calendars, Boards, Echoes)
> and Options (connectors, prompts, sync) are placeholders and arrive in later waves.

## Quick start

Requirements: Python ≥ 3.11, Node ≥ 20 (macOS, Linux, Windows 10/11).

**Launch the latest version** with the shortcut in the repo root. It installs missing or outdated
dependencies and rebuilds the UI when the code changed, then starts the app:

| OS | Shortcut |
|---|---|
| macOS | double-click `BRAIN2.command` (or drag it to the Dock / `alias brain2=…/brain2.sh`) |
| Linux / terminal | `./brain2.sh` (add `--detach` to return to the shell) |
| Windows | double-click `BRAIN2.bat` |

Or with `make`:

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
- Live preview renders tables, callouts, properties and code blocks (fences hidden); click to edit the markdown
- **Kanban boards** in markdown, compatible with the Obsidian Kanban plugin (`kanban-plugin: board`):
  drag cards and lists, check/archive cards, links and tags inside cards; switch to markdown anytime
- **Excalidraw drawings**: `.excalidraw` and Obsidian's `.excalidraw.md` (incl. compressed data and
  embedded images); embed with `![[Drawing.excalidraw]]`. Fonts are bundled — works offline
- **Graph view** like Obsidian's: filters (tags, attachments, orphans, existing files), color groups
  by query, arrows / text fade / node size / link thickness, force sliders, plus a **local graph** panel
- Custom icons for any file or folder (Material Symbols or emoji) — no icon unless you set one
- Paste / drop images into a note → saved to the attachment folder and embedded
- External edits (other apps, sync, agents) are picked up live
- Skins (Options → System settings): **Typewriter** (default), **Primary**, **Blue Topaz**, each light/dark;
  accent color, interface / text / monospace fonts (installed fonts suggested), font size with
  ⌘/Ctrl + scroll, optional current-line highlight, line numbers, folding, Vim keys, strict line breaks
- Resizable sidebars (drag the edge, double-click to reset)

### Indexing & metadata files

Everything is indexed in SQLite. In addition, each vault keeps human-readable JSON metadata in a
hidden `.brain2/` folder (so your note folders stay clean, like `.obsidian/`):

```
<vault>/.brain2/vault.json                       vault identity + connections to other modules
<vault>/.brain2/index/<path/to/note.md>.json     per document: parent folder, name, description, tags…
<vault>/.brain2/index/<folder>/__folder__.json   per folder: children + summary
<vault>/.brain2/icons.json                       custom file/folder icons
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

## Repos module and integrated terminal (wave 2)

- **Terminal everywhere**: `Ctrl+`` toggles the bottom terminal panel, `Ctrl+Shift+`` opens one in the folder you're looking at (vault folder, active note's folder, open repo). Terminals run your own login shell (zsh/bash/fish, PowerShell on Windows) in a PTY owned by the backend, so your git, SSH, credential helpers and `gh` auth just work. Tabs survive switching modules.
- **Everything visible**: clone, init, sync, push, branch/tag operations and vault sync are *typed into* a terminal tab (one tab per repo/vault). The backend detects completion with an invisible `b2done` marker.
- **Repos**: clone (any https/ssh/file git URL), create a local repo, add an existing clone; per repo: Files (tree, README, contents, history), Commits (graph, filters, diff), Pushes (from the remote-tracking reflog), Branches (Mine/All/Stale, ahead/behind), Tags, Pull requests (GitHub via `gh`).
- **Vault git sync** (Settings → Vault settings): connect a vault to a repo with a `main` branch; Sync commits on `sync/<user>-<date>`, merges `origin/main`, squash-merges into `main`, pushes and deletes the branch. Conflicts open a dialog: keep mine / theirs / both (line union) / edited manually, or cancel (restores your edits). `.brain2/` (index, trash) is git-ignored.

## Calendars and account connectors (wave 3)

- **Settings → Account connectors** has three groups: *Account providers* (Google, Microsoft, Apple iCloud), *LLM providers* and *Chat providers* (can be connected; not used yet). Secrets live in the OS keychain.
- Google and Microsoft use browser sign-in (OAuth + PKCE, loopback redirect) with **your own free app registration** (BRAIN2 has no company servers); the setup steps are shown in the app. Apple uses CalDAV with an app-specific password.
- **Calendars**: create any number; each one combines remote calendars from any number of accounts plus its own local events. Month / Week / Day / Agenda views; background sync every 15 minutes. Remote events are read-only for now.
