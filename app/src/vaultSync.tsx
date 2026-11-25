// Vault ⇄ git sync: start a sync (visible in the vault's terminal tab), resolve conflicts, settings UI.
import { useEffect, useState } from "react";
import { create } from "zustand";
import { Icon, UserIcon } from "./components/Icon";
import { Modal } from "./components/Modal";
import { api } from "./lib/api";
import type { Conflict, VaultGitStatus } from "./lib/repoTypes";
import type { Vault } from "./lib/types";
import { flushSaves } from "./lib/editorRegistry";
import { reportError, useApp, useWorkspace } from "./store";
import { useTerminals } from "./terminal/store";

interface SyncState {
  busy: Record<string, boolean>;
  conflicts: { vaultId: string; items: Conflict[] } | null;
  set(p: Partial<SyncState>): void;
}

export const useVaultSync = create<SyncState>((set) => ({
  busy: {},
  conflicts: null,
  set: (p) => set(p),
}));

function setBusy(id: string, v: boolean) {
  const s = useVaultSync.getState();
  s.set({ busy: { ...s.busy, [id]: v } });
}

async function showSyncTerminal(vault: Vault) {
  await useTerminals.getState().showKey(`vault:${vault.id}`, `Sync · ${vault.name}`, vault.path);
}

export async function startVaultSync(vaultId: string) {
  const app = useApp.getState();
  const vault = app.vaults.find((v) => v.id === vaultId);
  if (!vault) return;
  if (useVaultSync.getState().busy[vaultId]) return;
  setBusy(vaultId, true);
  try {
    // Unsaved edits must reach the disk before git looks at the folder.
    await flushSaves();
    await showSyncTerminal(vault);
    const r = await api.syncVault(vaultId);
    if (r.state === "conflicts") {
      useVaultSync.getState().set({ conflicts: { vaultId, items: r.conflicts ?? [] } });
    } else {
      app.toast(r.pushed ? `${vault.name}: synced and pushed` : `${vault.name}: up to date`);
    }
  } catch (e) {
    reportError(e);
  } finally {
    setBusy(vaultId, false);
    if (useWorkspace.getState().vaultId === vaultId) useWorkspace.getState().refresh().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------- conflicts
const CHOICES: { id: string; label: string; icon: string; hint: string }[] = [
  { id: "mine", label: "Keep mine", icon: "person", hint: "Use your version of the file" },
  { id: "theirs", label: "Keep theirs", icon: "group", hint: "Use the version from the repository" },
  { id: "both", label: "Keep both", icon: "join", hint: "Merge both versions line by line (no markers)" },
  { id: "manual", label: "I edited it", icon: "edit", hint: "Open the file, fix the <<<<<<< markers, then continue" },
];

export function SyncConflictDialog() {
  const conflicts = useVaultSync((s) => s.conflicts);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [busy, setBusyLocal] = useState(false);
  useEffect(() => {
    if (conflicts) {
      // Markdown merges cleanly line by line: default to keeping both sides.
      setChoices(Object.fromEntries(conflicts.items.map((c) => [c.path, c.mine_deleted || c.theirs_deleted ? "theirs" : "both"])));
    }
  }, [conflicts]);
  if (!conflicts) return null;
  const vault = useApp.getState().vaults.find((v) => v.id === conflicts.vaultId);
  const close = () => useVaultSync.getState().set({ conflicts: null });

  const apply = async () => {
    setBusyLocal(true);
    try {
      const r = await api.resolveVault(conflicts.vaultId, choices);
      if (r.state === "conflicts") {
        useVaultSync.getState().set({ conflicts: { vaultId: conflicts.vaultId, items: r.conflicts ?? [] } });
      } else {
        close();
        useApp.getState().toast(`${vault?.name ?? "Vault"}: conflicts resolved and synced`);
        useWorkspace.getState().refresh().catch(() => undefined);
      }
    } catch (e) {
      reportError(e);
    } finally {
      setBusyLocal(false);
    }
  };
  const abort = async () => {
    setBusyLocal(true);
    try {
      await api.abortVaultSync(conflicts.vaultId);
      close();
      useApp.getState().toast("Sync cancelled — your edits are untouched");
      useWorkspace.getState().refresh().catch(() => undefined);
    } catch (e) {
      reportError(e);
    } finally {
      setBusyLocal(false);
    }
  };
  const open = (path: string) => {
    if (useWorkspace.getState().vaultId === conflicts.vaultId) useWorkspace.getState().openFile(path, { newTab: true });
    else useApp.getState().navigate({ module: "vault", vaultId: conflicts.vaultId });
  };

  return (
    <Modal
      title={<><Icon name="warning" size={20} /> Sync conflicts — {vault?.name}</>}
      onClose={close}
      className="modal-medium conflict-dialog"
      footer={
        <>
          <button className="btn" disabled={busy} onClick={abort}><Icon name="undo" size={18} /> Cancel sync</button>
          <button className="btn btn-primary" disabled={busy} onClick={apply}><Icon name="sync" size={18} /> Resolve and sync</button>
        </>
      }
    >
      <p className="muted small">
        Someone else changed the same parts of {conflicts.items.length === 1 ? "this file" : "these files"} since your last sync.
        Choose what to keep for each one. “Cancel sync” leaves your files exactly as they were.
      </p>
      <div className="conflict-list">
        {conflicts.items.map((c) => (
          <div key={c.path} className="conflict-row">
            <button className="conflict-path link-button" title="Open the file" onClick={() => open(c.path)}>
              <Icon name="description" size={18} /> {c.path}
              {c.mine_deleted && <span className="kind-badge">you deleted it</span>}
              {c.theirs_deleted && <span className="kind-badge">deleted remotely</span>}
            </button>
            <div className="segmented small">
              {CHOICES.map((ch) => (
                <button key={ch.id} title={ch.hint} className={choices[c.path] === ch.id ? "active" : ""} onClick={() => setChoices({ ...choices, [c.path]: ch.id })}>
                  <Icon name={ch.icon} size={15} /> {ch.label}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------- settings section
function VaultGitRow({ vault }: { vault: Vault }) {
  const url = vault.connections?.git?.[0] ?? "";
  const [value, setValue] = useState(url);
  const [status, setStatus] = useState<VaultGitStatus | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const busy = useVaultSync((s) => !!s.busy[vault.id]);

  useEffect(() => setValue(url), [url]);
  useEffect(() => {
    api.vaultGit(vault.id).then(setStatus).catch(() => setStatus(null));
  }, [vault.id, url, busy]);

  const connect = async () => {
    setMsg(null);
    setChecking(true);
    try {
      await showSyncTerminal(vault);
      const r = await api.attachVaultGit(vault.id, value.trim() || null);
      await useApp.getState().loadVaults();
      setMsg({
        ok: true,
        text: value.trim()
          ? r.empty
            ? "Connected. The repository is empty — the first sync creates its main branch."
            : "Connected. The repository has a main branch."
          : "Disconnected.",
      });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="vault-git-row">
      <div className="vault-git-head">
        <UserIcon value={vault.icon} fallback="inventory_2" size={20} />
        <div className="vault-git-title">
          <strong>{vault.name}</strong>
          <span className="muted tiny path">{vault.path}</span>
        </div>
        {url && (
          <button className="btn btn-small" disabled={busy} onClick={() => startVaultSync(vault.id)}>
            <Icon name="sync" size={16} className={busy ? "spin" : ""} /> {busy ? "Syncing…" : "Sync"}
          </button>
        )}
      </div>
      <div className="row">
        <input
          className="input"
          placeholder="https://github.com/you/notes.git"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && connect()}
        />
        <button className="btn" disabled={checking || value.trim() === url} onClick={connect}>
          <Icon name={value.trim() ? "link" : "link_off"} size={16} /> {checking ? "Checking…" : value.trim() ? "Connect" : "Disconnect"}
        </button>
      </div>
      {msg && <div className={`muted small ${msg.ok ? "ok-text" : "danger-text"}`}>{msg.text}</div>}
      {status && url && (
        <div className="muted tiny vault-git-status">
          {status.state === "conflicts" ? (
            <button className="link-button danger-text" onClick={() => useVaultSync.getState().set({ conflicts: { vaultId: vault.id, items: status.conflicts } })}>
              {status.conflicts.length} conflict(s) waiting — resolve
            </button>
          ) : status.last_sync ? (
            <>Last synced state {new Date(status.last_sync).toLocaleString()} · {status.changes} local change(s)</>
          ) : (
            <>Never synced</>
          )}
        </div>
      )}
    </div>
  );
}

export function VaultSettingsSection() {
  const vaults = useApp((s) => s.vaults);
  return (
    <>
      <h2>Vault settings</h2>
      <p className="muted small">
        Connect a vault to a git repository (GitHub, GitLab, Azure DevOps, any https or SSH remote with a <code>main</code> branch) to
        sync it between machines and people. Each sync commits your changes on a branch named after you and the date, merges
        everybody else's work from <code>main</code>, squash-merges into <code>main</code>, pushes, and deletes the branch. Everything runs
        in the vault's terminal tab with your own git credentials. BRAIN2's local index (<code>.brain2/</code>) is not synced.
      </p>
      {vaults.map((v) => <VaultGitRow key={v.id} vault={v} />)}
      {!vaults.length && <div className="empty small">No vaults yet.</div>}
    </>
  );
}
