// Repos module home: every repository known to BRAIN2, with a terminal docked below.
import { useEffect, useState } from "react";
import { Icon, UserIcon } from "../components/Icon";
import { Spinner } from "../components/Spinner";
import { api } from "../lib/api";
import { bridge } from "../lib/bridge";
import type { Repo } from "../lib/repoTypes";
import { pickIcon } from "../components/IconPicker";
import { lastMenuPos, promptDialog, reportError, useApp } from "../store";
import { useTerminals } from "../terminal/store";
import { CloneRepoDialog, CreateRepoDialog, LocateRepoDialog, RemoveRepoDialog } from "./RepoForms";
import { useRepos } from "./store";

export const STATE_LABEL: Record<Repo["state"], string> = {
  missing: "Folder missing",
  "not-a-repo": "Not a git repository",
  local: "Local only",
  synced: "Up to date",
  ahead: "Ahead",
  behind: "Behind",
  diverged: "Diverged",
  changes: "Uncommitted changes",
};

export function RepoStatus({ repo }: { repo: Repo }) {
  const parts: string[] = [];
  if (repo.ahead) parts.push(`↑${repo.ahead}`);
  if (repo.behind) parts.push(`↓${repo.behind}`);
  if (repo.changes) parts.push(`${repo.changes} changed`);
  return (
    <span className={`repo-status state-${repo.state}`}>
      <span className="repo-status-dot" />
      {STATE_LABEL[repo.state]}
      {repo.branch && <span className="repo-branch"><Icon name="fork_right" size={14} />{repo.branch}</span>}
      {parts.length > 0 && <span className="repo-counts">{parts.join(" · ")}</span>}
    </span>
  );
}

export async function syncRepo(repo: Repo) {
  const app = useApp.getState();
  try {
    const term = await api.repoTerminal(repo.id);
    await useTerminals.getState().reveal(term.id);
    const r = await api.syncRepo(repo.id);
    if (r.warnings.length) app.toast(r.warnings.join("\n"), "error");
    else app.toast(`${repo.name} is in sync`);
  } catch (e) {
    reportError(e);
  } finally {
    useRepos.getState().load().catch(() => undefined);
    useRepos.getState().bump();
  }
}

export async function showRepoTerminal(repo: Repo) {
  const term = await api.repoTerminal(repo.id);
  await useTerminals.getState().reveal(term.id);
}

export function repoMenu(repo: Repo, onRemove: () => void) {
  const app = useApp.getState();
  return [
    { label: "Open this repo", icon: "arrow_circle_right", action: () => app.navigate({ module: "repo", repoId: repo.id, page: "files" }) },
    { label: "Open location", icon: "folder_data", action: () => bridge.reveal(repo.path) },
    { label: "Open terminal here", icon: "terminal", action: () => showRepoTerminal(repo).catch(reportError) },
    ...(repo.web_url ? [{ label: "Open on the web", icon: "open_in_new", action: () => bridge.openExternal(repo.web_url!) }] : []),
    { separator: true },
    {
      label: "Rename…",
      icon: "edit",
      action: async () => {
        const name = await promptDialog("Rename repo", { value: repo.name, okLabel: "Rename" });
        if (name) await api.updateRepo(repo.id, { name }).then(() => useRepos.getState().load()).catch(reportError);
      },
    },
    {
      label: "Change icon…",
      icon: "mood",
      action: async () => {
        const icon = await pickIcon(lastMenuPos, repo.icon ?? "");
        if (icon !== null) await api.updateRepo(repo.id, { icon }).then(() => useRepos.getState().load()).catch(reportError);
      },
    },
    { separator: true },
    { label: "Remove repo", icon: "delete", danger: true, action: onRemove },
  ];
}

export function ReposHome() {
  const { repos, loaded } = useRepos();
  const navigate = useApp((s) => s.navigate);
  const showMenu = useApp((s) => s.showMenu);
  const [dialog, setDialog] = useState<"clone" | "create" | "locate" | null>(null);
  const [removing, setRemoving] = useState<Repo | null>(null);
  const [syncing, setSyncing] = useState<string | null>(null);

  useEffect(() => {
    useRepos.getState().load().catch(reportError);
  }, []);

  return (
    <div className="page repos-page">
      <div className="repos-toolbar">
        <button className="btn" onClick={() => setDialog("clone")}>
          <Icon name="cloud_download" size={18} /> Clone a new repo
        </button>
        <button className="btn" onClick={() => setDialog("create")}>
          <Icon name="add_circle" size={18} /> Create local repo
        </button>
        <span className="spacer" />
        <button className="btn" onClick={() => setDialog("locate")}>
          <Icon name="add_circle" size={18} /> Add a local cloned repo
        </button>
      </div>
      <div className="repos-list">
        {!loaded && <Spinner label="Reading repositories…" />}
        {loaded && !repos.length && (
          <div className="hero repos-empty">
            <Icon name="account_tree" size={52} />
            <h2>No repositories yet</h2>
            <p className="muted">
              Clone any git repository over https, create a new local one, or add a repository that is already on this machine.
              Every git command runs in the terminal below, with your own git, SSH and credential setup.
            </p>
          </div>
        )}
        {repos.map((repo) => (
          <div
            key={repo.id}
            className={`repo-row${repo.exists ? "" : " missing"}`}
            onContextMenu={(e) => {
              e.preventDefault();
              showMenu(e, repoMenu(repo, () => setRemoving(repo)));
            }}
            onDoubleClick={() => navigate({ module: "repo", repoId: repo.id, page: "files" })}
          >
            <div className="repo-info">
              <span className="repo-field repo-name">
                <span className="repo-field-label">Repo:</span>
                <UserIcon value={repo.icon} fallback="account_tree" size={18} />
                <strong>{repo.name}</strong>
              </span>
              <span className="repo-field repo-location" title={repo.path}>
                <span className="repo-field-label">Location:</span>
                <code>{repo.path}</code>
              </span>
              <span className="repo-field">
                <span className="repo-field-label">Status:</span>
                <RepoStatus repo={repo} />
              </span>
            </div>
            <div className="repo-actions">
              <button className="btn btn-small" disabled={!repo.is_git} onClick={() => navigate({ module: "repo", repoId: repo.id, page: "files" })}>
                <Icon name="arrow_circle_right" size={17} /> Open this repo
              </button>
              <button className="btn btn-small" disabled={!repo.exists} onClick={() => bridge.reveal(repo.path)}>
                <Icon name="folder_data" size={17} /> Open location
              </button>
              <button
                className="btn btn-small"
                disabled={!repo.remote || syncing === repo.id}
                title={repo.remote ? `Fetch, pull and push every tracking branch of ${repo.remote}` : "No remote configured"}
                onClick={async () => {
                  setSyncing(repo.id);
                  await syncRepo(repo);
                  setSyncing(null);
                }}
              >
                <Icon name="directory_sync" size={17} className={syncing === repo.id ? "spin" : ""} /> Sync this repo
              </button>
              <span className="spacer" />
              <button className="btn btn-small btn-ghost-danger" onClick={() => setRemoving(repo)}>
                <Icon name="delete" size={17} /> Remove repo
              </button>
            </div>
          </div>
        ))}
      </div>
      {dialog === "clone" && <CloneRepoDialog onClose={() => setDialog(null)} />}
      {dialog === "create" && <CreateRepoDialog onClose={() => setDialog(null)} />}
      {dialog === "locate" && <LocateRepoDialog onClose={() => setDialog(null)} />}
      {removing && <RemoveRepoDialog repo={removing} onClose={() => setRemoving(null)} />}
    </div>
  );
}
