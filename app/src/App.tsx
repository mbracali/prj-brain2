import { useEffect, useState } from "react";
import { runCommand, toggleReading } from "./commands";
import { ContextMenu } from "./components/ContextMenu";
import { CreateVaultDialog } from "./components/CreateVaultDialog";
import { ComingSoon, Dashboard, VaultsHome } from "./components/Dashboard";
import { Dialogs, Toasts } from "./components/Dialogs";
import { SettingsModal } from "./components/SettingsModal";
import { Sidebar } from "./components/Sidebar";
import { subscribeEvents } from "./lib/api";
import { bridge, isElectron, isMac } from "./lib/bridge";
import { emitFilesChanged } from "./lib/events";
import { reportError, useApp, useWorkspace } from "./store";
import { VaultWorkspace } from "./views/VaultWorkspace";

const params = new URLSearchParams(location.search);
const INITIAL_VAULT = params.get("vault");
const INITIAL_FILE = params.get("file");

function useTheme() {
  const settings = useApp((s) => s.settings);
  const [systemDark, setSystemDark] = useState(() => matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const fn = () => setSystemDark(mq.matches);
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, []);
  useEffect(() => {
    const dark = settings.colorScheme === "dark" || (settings.colorScheme === "system" && systemDark);
    const root = document.documentElement;
    root.dataset.skin = settings.skin;
    root.dataset.theme = dark ? "dark" : "light";
    root.dataset.platform = isMac ? "mac" : "other";
    root.style.setProperty("--font-text-size", `${settings.fontSize}px`);
  }, [settings, systemDark]);
}

function handleAction(action: string, payload?: string) {
  const app = useApp.getState();
  switch (action) {
    case "settings":
      return app.openSettings(payload ?? "general");
    case "new-vault":
      return app.setCreateVaultOpen(true);
    case "toggle-reading":
      return toggleReading();
    case "command-palette":
      return useWorkspace.getState().vaultId && app.route.module === "vault"
        ? useWorkspace.getState().set({ paletteOpen: true })
        : undefined;
    default:
      return runCommand(action);
  }
}

/** Keyboard shortcuts for browser (server) mode; in Electron the native menu owns them. */
function useBrowserShortcuts() {
  useEffect(() => {
    if (isElectron) return;
    const onKey = (e: KeyboardEvent) => {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      const map: Record<string, string> = {
        o: "quick-switcher",
        p: "command-palette",
        e: "toggle-reading",
        g: "graph",
        ",": "settings",
        "\\": e.shiftKey ? "toggle-right" : "toggle-left",
      };
      if (e.shiftKey && key === "f") map.f = "search";
      if (e.altKey && key === "n") map.n = "new-note";
      const action = map[key];
      if (action) {
        e.preventDefault();
        handleAction(action, action === "settings" ? "general" : undefined);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export function App() {
  const route = useApp((s) => s.route);
  const [ready, setReady] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
  useTheme();
  useBrowserShortcuts();

  useEffect(() => {
    const app = useApp.getState();
    Promise.all([app.loadSettings(), app.loadVaults()])
      .then(() => {
        if (INITIAL_VAULT && useApp.getState().vaults.some((v) => v.id === INITIAL_VAULT)) {
          app.navigate({ module: "vault", vaultId: INITIAL_VAULT });
        }
        setReady(true);
      })
      .catch((e) => setFatal(e instanceof Error ? e.message : String(e)));
  }, []);

  // Live updates from the backend (other windows, external editors, agents via API/MCP).
  useEffect(() => {
    let timer: number | undefined;
    const pending = new Set<string>();
    return subscribeEvents((ev) => {
      if (ev.type === "vaults.changed") {
        useApp.getState().loadVaults().catch(reportError);
      } else if (ev.type === "settings.changed") {
        useApp.getState().loadSettings().catch(reportError);
      } else if (ev.type === "vault.changed" && ev.vault_id === useWorkspace.getState().vaultId) {
        (ev.paths ?? []).forEach((p) => pending.add(p));
        window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          const paths = [...pending];
          pending.clear();
          useWorkspace
            .getState()
            .refresh()
            .then(() => emitFilesChanged(paths))
            .catch(() => undefined);
          useApp.getState().loadVaults().catch(() => undefined);
        }, 150);
      }
    });
  }, []);

  useEffect(() => bridge.onMenu(handleAction), []);

  useEffect(() => {
    if (route.module !== "vault" && useWorkspace.getState().vaultId) useWorkspace.getState().closeVault();
  }, [route]);

  if (fatal) {
    return (
      <div className="page center">
        <div className="hero">
          <h2>Cannot reach the BRAIN2 backend</h2>
          <p className="muted">{fatal}</p>
          {!isElectron && <p className="muted small">Open the URL printed by <code>brain2 serve</code> (it includes the access token).</p>}
        </div>
      </div>
    );
  }
  if (!ready) return null;

  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        {route.module === "dashboard" && <Dashboard />}
        {route.module === "vaults" && <VaultsHome />}
        {route.module === "coming" && <ComingSoon name={route.name} />}
        {route.module === "vault" && (
          <VaultWorkspace vaultId={route.vaultId} initialFile={route.vaultId === INITIAL_VAULT ? INITIAL_FILE : null} />
        )}
      </main>
      <CreateVaultDialog />
      <SettingsModal />
      <Dialogs />
      <ContextMenu />
      <Toasts />
    </div>
  );
}
