import { vaultMenu } from "../vaultActions";
import { modKey } from "../lib/bridge";
import { useApp } from "../store";
import { useRepos } from "../repos/store";
import { useCalendars } from "../calendars/store";
import { startVaultSync } from "../vaultSync";
import { Icon, UserIcon } from "./Icon";
import { MODULES } from "./Sidebar";

export function Dashboard() {
  const vaults = useApp((s) => s.vaults);
  const repoCount = useRepos((s) => s.repos.length);
  const calendarCount = useCalendars((s) => s.calendars.length);
  const navigate = useApp((s) => s.navigate);
  return (
    <div className="page">
      <div className="page-inner">
        <h1 className="page-title">
          <Icon name="neurology" size={34} /> BRAIN2
        </h1>
        <p className="muted">Your personal assistant harness. Vaults and repos, with a terminal everywhere (Ctrl+`).</p>
        <div className="card-grid">
          {MODULES.map((m) => (
            <button
              key={m.id}
              className={`card${m.id === "vaults" || m.id === "repos" || m.id === "calendars" ? "" : " card-disabled"}`}
              onClick={() =>
                navigate(
                  m.id === "vaults" ? { module: "vaults" }
                  : m.id === "repos" ? { module: "repos" }
                  : m.id === "calendars" ? { module: "calendars" }
                  : { module: "coming", name: m.id },
                )
              }
            >
              <Icon name={m.icon} size={26} />
              <strong>{m.label}</strong>
              <span className="muted small">
                {m.id === "vaults" ? `${vaults.length} local vaults` : m.id === "repos" ? `${repoCount} local repos` : m.id === "calendars" ? `${calendarCount} calendars` : "Coming in a next wave"}
              </span>
            </button>
          ))}
        </div>
        <div className="muted small shortcuts">
          <kbd>{modKey}</kbd>+<kbd>O</kbd> quick switcher · <kbd>{modKey}</kbd>+<kbd>P</kbd> command palette ·{" "}
          <kbd>{modKey}</kbd>+<kbd>,</kbd> settings
        </div>
      </div>
    </div>
  );
}

export function VaultsHome() {
  const vaults = useApp((s) => s.vaults);
  const loaded = useApp((s) => s.vaultsLoaded);
  const navigate = useApp((s) => s.navigate);
  const showMenu = useApp((s) => s.showMenu);
  const create = () => useApp.getState().setCreateVaultOpen(true);
  if (!loaded) return null;
  if (!vaults.length) {
    return (
      <div className="page center">
        <div className="hero">
          <Icon name="inventory_2" size={56} />
          <h2>Create your first vault</h2>
          <p className="muted">
            A vault is a folder of notes — markdown, PDFs, text, JSON and YAML. Create a new one, or open any existing folder
            (an Obsidian vault works too).
          </p>
          <button className="btn btn-primary btn-large" onClick={create}>
            <Icon name="add" size={20} /> Create vault
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-head">
          <h1 className="page-title">Vaults</h1>
          <button className="btn btn-primary" onClick={create}>
            <Icon name="add" size={18} /> New vault
          </button>
        </div>
        <div className="card-grid">
          {vaults.map((v) => (
            <button
              key={v.id}
              className="card"
              onClick={() => navigate({ module: "vault", vaultId: v.id })}
              onContextMenu={(e) => {
                e.preventDefault();
                showMenu(e, vaultMenu(v));
              }}
            >
              <UserIcon value={v.icon} fallback="inventory_2" size={26} />
              <strong>{v.name}</strong>
              <span className="muted small">{v.exists ? `${v.note_count} notes · ${v.file_count} files` : "Folder not found"}</span>
              <span className="muted tiny path">{v.path}</span>
              {v.connections?.git?.length ? (
                <span
                  role="button"
                  className="btn btn-small card-sync"
                  title="Sync with git"
                  onClick={(e) => {
                    e.stopPropagation();
                    startVaultSync(v.id);
                  }}
                >
                  <Icon name="sync" size={16} /> Sync
                </span>
              ) : null}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function ComingSoon({ name }: { name: string }) {
  const m = MODULES.find((x) => x.id === name);
  return (
    <div className="page center">
      <div className="hero">
        <Icon name={m?.icon ?? "construction"} size={56} />
        <h2>{m?.label ?? name}</h2>
        <p className="muted">This module arrives in a next wave.</p>
      </div>
    </div>
  );
}
