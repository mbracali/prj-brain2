import { type ReactNode, useEffect, useState } from "react";
import { api } from "../lib/api";
import { bridge } from "../lib/bridge";
import type { Settings } from "../lib/types";
import { useApp } from "../store";
import { Icon } from "./Icon";
import { Modal } from "./Modal";

const SECTIONS: { id: string; label: string; icon: string; group: string }[] = [
  { id: "general", label: "Appearance", icon: "palette", group: "System settings" },
  { id: "editor", label: "Editor", icon: "edit_note", group: "System settings" },
  { id: "files", label: "Files & links", icon: "folder", group: "System settings" },
  { id: "about", label: "About", icon: "info", group: "System settings" },
  { id: "connectors", label: "Account connectors", icon: "hub", group: "Options" },
  { id: "system-prompts", label: "System prompts", icon: "terminal", group: "Options" },
  { id: "agent-prompts", label: "Agent prompts", icon: "smart_toy", group: "Options" },
  { id: "sync", label: "Sync & data", icon: "sync", group: "Options" },
];

export const SKINS: { id: Settings["skin"]; name: string; description: string }[] = [
  { id: "typewriter", name: "Typewriter", description: "Default. Calm, monospaced writing focus." },
  { id: "primary", name: "Primary", description: "Soft, friendly and colourful." },
  { id: "blue-topaz", name: "Blue Topaz", description: "Airy blues with colourful headings." },
];

function Row({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <div className="setting-row">
      <div className="setting-info">
        <div className="setting-title">{title}</div>
        {description && <div className="setting-description">{description}</div>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button className={`toggle${value ? " on" : ""}`} role="switch" aria-checked={value} onClick={() => onChange(!value)}>
      <span />
    </button>
  );
}

function Coming({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="coming">
      <Icon name="construction" size={32} />
      <h3>{title}</h3>
      <p className="muted">This area arrives in a later wave. Planned:</p>
      <ul>
        {items.map((i) => (
          <li key={i}>{i}</li>
        ))}
      </ul>
    </div>
  );
}

export function SettingsModal() {
  const section = useApp((s) => s.settingsSection);
  const settings = useApp((s) => s.settings);
  const update = useApp((s) => s.updateSettings);
  const [system, setSystem] = useState<Record<string, string> | null>(null);

  useEffect(() => {
    if (section) api.system().then(setSystem).catch(() => undefined);
  }, [section]);

  if (!section) return null;
  const close = () => useApp.setState({ settingsSection: null });
  const go = (id: string) => useApp.setState({ settingsSection: id });
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => update({ [k]: v } as Partial<Settings>);
  const groups = [...new Set(SECTIONS.map((s) => s.group))];

  return (
    <Modal onClose={close} className="modal-settings">
      <div className="settings">
        <nav className="settings-nav">
          {groups.map((g) => (
            <div key={g}>
              <div className="settings-group">{g}</div>
              {SECTIONS.filter((s) => s.group === g).map((s) => (
                <button key={s.id} className={`settings-nav-item${section === s.id ? " active" : ""}`} onClick={() => go(s.id)}>
                  <Icon name={s.icon} size={18} /> {s.label}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="settings-content">
          <button className="icon-button settings-close" onClick={close} aria-label="Close">
            <Icon name="close" size={20} />
          </button>
          {section === "general" && (
            <>
              <h2>Appearance</h2>
              <Row title="Skin" description="Themes inspired by popular Obsidian themes.">
                <div className="skin-grid">
                  {SKINS.map((s) => (
                    <button
                      key={s.id}
                      className={`skin-card${settings.skin === s.id ? " active" : ""}`}
                      data-skin-preview={s.id}
                      onClick={() => set("skin", s.id)}
                    >
                      <span className="skin-swatch" />
                      <strong>{s.name}</strong>
                      <span className="muted small">{s.description}</span>
                    </button>
                  ))}
                </div>
              </Row>
              <Row title="Color scheme">
                <select className="select" value={settings.colorScheme} onChange={(e) => set("colorScheme", e.target.value as Settings["colorScheme"])}>
                  <option value="system">Follow system</option>
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
                </select>
              </Row>
              <Row title="Font size" description={`${settings.fontSize}px`}>
                <input
                  type="range"
                  min={12}
                  max={24}
                  value={settings.fontSize}
                  onChange={(e) => set("fontSize", Number(e.target.value))}
                />
              </Row>
              <Row title="Readable line length" description="Limit the maximum line length in notes.">
                <Toggle value={settings.readableLineLength} onChange={(v) => set("readableLineLength", v)} />
              </Row>
            </>
          )}
          {section === "editor" && (
            <>
              <h2>Editor</h2>
              <Row title="Default view for new tabs" description="Live preview hides markdown syntax except on the line you are editing.">
                <select className="select" value={settings.defaultViewMode} onChange={(e) => set("defaultViewMode", e.target.value as Settings["defaultViewMode"])}>
                  <option value="live">Live preview</option>
                  <option value="source">Source mode</option>
                  <option value="reading">Reading view</option>
                </select>
              </Row>
              <Row title="Show line numbers">
                <Toggle value={settings.showLineNumbers} onChange={(v) => set("showLineNumbers", v)} />
              </Row>
              <Row title="Spellcheck">
                <Toggle value={settings.spellcheck} onChange={(v) => set("spellcheck", v)} />
              </Row>
              <Row title="Autosave delay" description={`Changes are saved ${settings.autosaveDelay} ms after you stop typing.`}>
                <input
                  type="range"
                  min={200}
                  max={5000}
                  step={100}
                  value={settings.autosaveDelay}
                  onChange={(e) => set("autosaveDelay", Number(e.target.value))}
                />
              </Row>
            </>
          )}
          {section === "files" && (
            <>
              <h2>Files &amp; links</h2>
              <Row title="Default location for new notes">
                <select className="select" value={settings.newNoteLocation} onChange={(e) => set("newNoteLocation", e.target.value as Settings["newNoteLocation"])}>
                  <option value="current">Same folder as current file</option>
                  <option value="root">Vault root</option>
                </select>
              </Row>
              <Row title="Attachment folder" description="Pasted and dropped files are stored here (relative to the vault root).">
                <input className="input" value={settings.attachmentFolder} onChange={(e) => set("attachmentFolder", e.target.value)} />
              </Row>
              <Row title="Daily notes folder">
                <input className="input" value={settings.dailyNotesFolder} onChange={(e) => set("dailyNotesFolder", e.target.value)} />
              </Row>
              <Row title="Automatically update internal links" description="When a file is renamed or moved, update [[links]] pointing to it.">
                <Toggle value={settings.updateLinksOnMove} onChange={(v) => set("updateLinksOnMove", v)} />
              </Row>
              <Row title="Confirm file deletion" description="Deleted files go to the vault trash (.brain2/trash).">
                <Toggle value={settings.confirmDelete} onChange={(v) => set("confirmDelete", v)} />
              </Row>
            </>
          )}
          {section === "about" && (
            <>
              <h2>About BRAIN2</h2>
              <p className="muted">The Personal Assistant Harness. Free and open source — please credit BRAIN2 when you reuse it.</p>
              {system && (
                <div className="kv">
                  <span>Version</span><code>{system.version}</code>
                  <span>Home</span>
                  <code className="link" onClick={() => bridge.openPath(system.home)}>{system.home}</code>
                  <span>Index (SQLite)</span><code>{system.db}</code>
                  <span>Internal vaults</span><code>{system.internal_vaults}</code>
                  <span>Platform</span><code>{system.platform} · Python {system.python}</code>
                </div>
              )}
              <h3>API &amp; MCP</h3>
              <p className="muted small">
                Every vault feature is available over the local HTTP API (<code>/api/…</code>, see <code>/docs</code>) and as an MCP
                server: <code>brain2 mcp</code>.
              </p>
            </>
          )}
          {section === "connectors" && (
            <Coming
              title="Account connectors"
              items={[
                "Accounts: Google, Microsoft, Apple (calendars & email) — multiple accounts with nicknames",
                "Repo providers: GitHub, Azure DevOps, Bitbucket, GitLab",
                "LLM providers: ChatGPT, Claude, DeepSeek… and detection of Claude Code / Codex CLIs",
                "Chat providers: Slack",
              ]}
            />
          )}
          {section === "system-prompts" && <Coming title="System prompts" items={["View and edit the prompts BRAIN2 uses internally"]} />}
          {section === "agent-prompts" && <Coming title="Agent prompts" items={["See and edit which prompts your Echoes use, and when"]} />}
          {section === "sync" && (
            <Coming title="Sync & data" items={["Back up everything to a private git repository", "Export / import all data as an archive"]} />
          )}
        </div>
      </div>
    </Modal>
  );
}
