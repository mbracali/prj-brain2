import { revealVault, vaultMenu } from "../vaultActions";
import { isElectron, isMac } from "../lib/bridge";
import { useApp } from "../store";
import { VaultSidebar } from "../views/VaultSidebar";
import { RepoSidebar } from "../repos/RepoView";
import { useRepos } from "../repos/store";
import { useCalendars } from "../calendars/store";
import { useTerminals } from "../terminal/store";
import { startVaultSync } from "../vaultSync";
import { Icon, UserIcon } from "./Icon";
import { Resizer } from "./Resizer";

export const MODULES = [
  { id: "vaults", label: "Vaults", icon: "inventory_2", unit: "vaults" },
  { id: "repos", label: "Repos", icon: "account_tree", unit: "repos" },
  { id: "messages", label: "Message queues", icon: "forum", unit: "queues" },
  { id: "calendars", label: "Calendars", icon: "calendar_month", unit: "calendars" },
  { id: "boards", label: "Boards", icon: "view_kanban", unit: "boards" },
  { id: "echoes", label: "Echoes", icon: "graphic_eq", unit: "echoes" },
] as const;

export function Sidebar() {
  const sidebar = useApp((s) => s.sidebar);
  const route = useApp((s) => s.route);
  const inVault = route.module === "vault";
  return (
    <aside className={`sidebar${isElectron && isMac ? " has-traffic-lights" : ""}`}>
      <div className="sidebar-drag" />
      {inVault ? (
        <VaultSidebar vaultId={route.vaultId} />
      ) : route.module === "repo" ? (
        <RepoSidebar repoId={route.repoId} page={route.page ?? "files"} />
      ) : sidebar === "vaults" ? (
        <VaultList />
      ) : (
        <ModuleList />
      )}
      <SidebarFooter />
      <Resizer side="left" />
    </aside>
  );
}

function ModuleList() {
  const vaults = useApp((s) => s.vaults);
  const repoCount = useRepos((s) => s.repos.length);
  const calendarCount = useCalendars((s) => s.calendars.length);
  const navigate = useApp((s) => s.navigate);
  const route = useApp((s) => s.route);
  return (
    <div className="sidebar-body">
      <button className="brand" onClick={() => navigate({ module: "dashboard" })}>
        <Icon name="neurology" size={22} /> <span>BRAIN2</span> <span className="version">v0.1</span>
      </button>
      <nav className="module-list">
        {MODULES.map((m) => {
          const count = m.id === "vaults" ? vaults.length : m.id === "repos" ? repoCount : m.id === "calendars" ? calendarCount : 0;
          const active = route.module === "coming" ? route.name === m.id : route.module === m.id;
          return (
            <button
              key={m.id}
              className={`module-item${active ? " active" : ""}`}
              onClick={() =>
                m.id === "vaults"
                  ? (useApp.getState().setSidebar("vaults"), navigate({ module: "vaults" }))
                  : m.id === "repos"
                    ? navigate({ module: "repos" })
                    : m.id === "calendars"
                      ? navigate({ module: "calendars" })
                      : navigate({ module: "coming", name: m.id })
              }
            >
              <Icon name={m.icon} size={20} />
              <span className="module-text">
                <span className="module-label">{m.label}</span>
                <span className="module-count">
                  {count} local {m.unit}
                </span>
              </span>
              <Icon name="chevron_right" size={18} className="module-arrow" />
            </button>
          );
        })}
      </nav>
    </div>
  );
}

function VaultList() {
  const vaults = useApp((s) => s.vaults);
  const navigate = useApp((s) => s.navigate);
  const showMenu = useApp((s) => s.showMenu);
  return (
    <div className="sidebar-body">
      <div className="sidebar-header">
        <button className="icon-button" title="Back" onClick={() => (useApp.getState().setSidebar("modules"), navigate({ module: "dashboard" }))}>
          <Icon name="arrow_back" size={20} />
        </button>
        <span className="sidebar-title">Vaults</span>
        <button className="icon-button" title="New vault" onClick={() => useApp.getState().setCreateVaultOpen(true)}>
          <Icon name="add" size={20} />
        </button>
      </div>
      <div className="vault-list">
        {vaults.map((v) => (
          <button
            key={v.id}
            className={`vault-item${v.exists ? "" : " missing"}`}
            onClick={() => navigate({ module: "vault", vaultId: v.id })}
            onContextMenu={(e) => {
              e.preventDefault();
              showMenu(e, vaultMenu(v));
            }}
            onDoubleClick={() => revealVault(v)}
            title={v.path}
          >
            <UserIcon value={v.icon} fallback="inventory_2" size={20} />
            <span className="vault-text">
              <span className="vault-name">{v.name}</span>
              <span className="vault-meta">
                {v.exists ? `${v.note_count} notes · ${v.file_count} files` : "Folder not found"}
              </span>
            </span>
            {v.connections?.git?.length ? (
              <span
                role="button"
                className="icon-button vault-item-sync"
                title="Sync with git"
                onClick={(e) => {
                  e.stopPropagation();
                  startVaultSync(v.id);
                }}
              >
                <Icon name="sync" size={18} />
              </span>
            ) : null}
          </button>
        ))}
        {!vaults.length && <div className="empty small">No vaults yet.</div>}
      </div>
    </div>
  );
}

function SidebarFooter() {
  const openSettings = useApp((s) => s.openSettings);
  return (
    <div className="sidebar-footer">
      <button className="icon-button" title="Settings" onClick={() => openSettings("general")}>
        <Icon name="settings" size={20} />
      </button>
      <button className="icon-button" title="Account connectors" onClick={() => openSettings("connectors")}>
        <Icon name="hub" size={20} />
      </button>
      <button className="icon-button" title="Sync & data" onClick={() => openSettings("sync")}>
        <Icon name="sync" size={20} />
      </button>
      <span className="spacer" />
      <button className="icon-button" title="Toggle terminal (Ctrl+`)" onClick={() => useTerminals.getState().toggle()}>
        <Icon name="terminal" size={20} />
      </button>
    </div>
  );
}
