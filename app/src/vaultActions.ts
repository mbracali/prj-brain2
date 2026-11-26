// Actions on whole vaults (vault list context menu, dashboard).
import { api } from "./lib/api";
import { bridge } from "./lib/bridge";
import type { Vault } from "./lib/types";
import { pickIcon } from "./components/IconPicker";
import { contextFolder, useTerminals } from "./terminal/store";
import { startVaultSync } from "./vaultSync";
import { type MenuItem, confirmDialog, lastMenuPos, promptDialog, reportError, useApp, useWorkspace } from "./store";

export function revealVault(v: Vault) {
  bridge.reveal(v.path);
}

export async function renameVault(v: Vault) {
  const name = await promptDialog("Rename vault", { value: v.name, okLabel: "Rename" });
  if (!name || name === v.name) return;
  try {
    await api.updateVault(v.id, { name });
    await useApp.getState().loadVaults();
  } catch (e) {
    reportError(e);
  }
}

export async function setVaultIcon(v: Vault) {
  const icon = await pickIcon(lastMenuPos, v.icon ?? "");
  if (icon === null) return;
  try {
    await api.updateVault(v.id, { icon });
    await useApp.getState().loadVaults();
  } catch (e) {
    reportError(e);
  }
}

export async function removeVault(v: Vault, deleteFiles: boolean) {
  const ok = await confirmDialog(
    deleteFiles ? "Delete vault" : "Remove vault from BRAIN2",
    deleteFiles
      ? `Permanently delete "${v.name}" and all of its files from disk? This cannot be undone.`
      : `Remove "${v.name}" from BRAIN2? The folder and its files stay on disk at ${v.path}.`,
    { okLabel: deleteFiles ? "Delete forever" : "Remove", danger: true },
  );
  if (!ok) return;
  try {
    await api.deleteVault(v.id, deleteFiles);
    const app = useApp.getState();
    if (app.route.module === "vault" && app.route.vaultId === v.id) {
      useWorkspace.getState().closeVault();
      app.navigate({ module: "vaults" });
    }
    await app.loadVaults();
  } catch (e) {
    reportError(e);
  }
}

export function vaultMenu(v: Vault): MenuItem[] {
  const app = useApp.getState();
  return [
    { label: "Open", icon: "open_in_browser", action: () => app.navigate({ module: "vault", vaultId: v.id }) },
    { label: "Open in new window", icon: "open_in_new", action: () => bridge.openWindow({ vault: v.id }) },
    { separator: true },
    { label: "Rename…", icon: "edit", action: () => renameVault(v) },
    { label: "Change icon…", icon: "mood", action: () => setVaultIcon(v) },
    { label: "Reveal in file manager", icon: "folder_open", action: () => revealVault(v) },
    {
      label: "Open in terminal",
      icon: "terminal",
      // In the open vault: the focused note's folder (or the vault root when no note is focused).
      action: () => {
        const here = app.route.module === "vault" && app.route.vaultId === v.id ? contextFolder() : undefined;
        useTerminals.getState().openAt(here ?? v.path, here && here !== v.path ? undefined : v.name).catch(reportError);
      },
    },
    ...(v.connections?.git?.length
      ? [{ label: "Sync with git", icon: "sync", action: () => startVaultSync(v.id) }]
      : [{ label: "Connect a git repository…", icon: "cloud_sync", action: () => app.openSettings("vaults") }]),
    {
      label: "Rebuild index",
      icon: "refresh",
      action: async () => {
        try {
          const r = await api.reindex(v.id);
          app.toast(`Indexed ${r.files} files`);
          await app.loadVaults();
        } catch (e) {
          reportError(e);
        }
      },
    },
    { separator: true },
    { label: "Remove from BRAIN2", icon: "link_off", danger: true, action: () => removeVault(v, false) },
    ...(v.internal ? [{ label: "Delete vault and files", icon: "delete_forever", danger: true, action: () => removeVault(v, true) }] : []),
  ];
}
