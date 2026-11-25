import { useEffect, useState } from "react";
import { runCommand, toggleReading } from "./commands";
import { ContextMenu } from "./components/ContextMenu";
import { CreateVaultDialog } from "./components/CreateVaultDialog";
import { IconPickerHost } from "./components/IconPicker";
import { ComingSoon, Dashboard, VaultsHome } from "./components/Dashboard";
import { Dialogs, Toasts } from "./components/Dialogs";
import { SettingsModal } from "./components/SettingsModal";
import { Sidebar } from "./components/Sidebar";
import { subscribeEvents } from "./lib/api";
import { bridge, isElectron, isMac } from "./lib/bridge";
import { emitFilesChanged } from "./lib/events";
import { applyAppearance } from "./lib/theme";
import { renderDefaults } from "./markdown/render";
import { reportError, useApp, useWorkspace } from "./store";
import { VaultWorkspace } from "./views/VaultWorkspace";
import { ReposHome } from "./repos/ReposHome";
import { RepoView } from "./repos/RepoView";
import { useRepos } from "./repos/store";
import { CalendarsPage } from "./calendars/CalendarsPage";
import { useCalendars } from "./calendars/store";
import { TerminalPanel } from "./terminal/TerminalPanel";
import { SyncConflictDialog } from "./vaultSync";
import { openTerminalHere, useTerminals } from "./terminal/store";

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
    document.documentElement.dataset.platform = isMac ? "mac" : "other";
    // macOS desktop window uses an inset title bar: content must avoid the traffic-light buttons.
    document.documentElement.toggleAttribute("data-traffic-lights", isElectron && isMac);
    applyAppearance(settings, dark);
    renderDefaults.strictLineBreaks = settings.strictLineBreaks;
    renderDefaults.properties = settings.propertiesInDocument;
    document.documentElement.toggleAttribute("data-active-line", settings.highlightActiveLine);
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
    case "toggle-terminal":
      return useTerminals.getState().toggle();
    case "new-terminal":
      return openTerminalHere();
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
    // Ctrl+` (toggle) and Ctrl+Shift+` (new terminal), like VS Code, on every platform.
    const onTermKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.metaKey && e.code === "Backquote") {
        e.preventDefault();
        e.stopPropagation();
        handleAction(e.shiftKey ? "new-terminal" : "toggle-terminal");
      }
    };
    window.addEventListener("keydown", onTermKey, true);
    return () => window.removeEventListener("keydown", onTermKey, true);
  }, []);
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
    useRepos.getState().load().catch(() => undefined);
    useCalendars.getState().load().catch(() => undefined);
    useTerminals.getState().refresh().catch(() => undefined);
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
      if (ev.type === "accounts.changed") {
        window.dispatchEvent(new Event("brain2:accounts-changed"));
        return;
      }
      if (ev.type === "terminals.changed") {
        useTerminals.getState().refresh().catch(() => undefined);
        return;
      }
      if (ev.type === "calendars.changed") {
        useCalendars.getState().load().catch(() => undefined);
        useCalendars.getState().bump();
        return;
      }
      if (ev.type === "events.changed") {
        useCalendars.getState().bump();
        return;
      }
      if (ev.type === "repos.changed" || ev.type === "repo.changed") {
        useRepos.getState().load().catch(() => undefined);
        return;
      }
      if (ev.type === "vaults.changed") {
        useApp.getState().loadVaults().catch(reportError);
      } else if (ev.type === "vault.sync") {
        useApp.getState().loadVaults().catch(() => undefined);
      } else if (ev.type === "vault.icons" && ev.vault_id === useWorkspace.getState().vaultId) {
        useWorkspace.getState().loadIcons().catch(() => undefined);
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
        {/* macOS hides the title bar: this strip lets the top of the window be dragged everywhere. */}
        <div className="window-drag" aria-hidden="true" />
        <div className="main-content">
        {route.module === "dashboard" && <Dashboard />}
        {route.module === "vaults" && <VaultsHome />}
        {route.module === "coming" && <ComingSoon name={route.name} />}
        {route.module === "vault" && (
          <VaultWorkspace vaultId={route.vaultId} initialFile={route.vaultId === INITIAL_VAULT ? INITIAL_FILE : null} />
        )}
        {route.module === "repos" && <ReposHome />}
        {route.module === "calendars" && <CalendarsPage />}
        {route.module === "repo" && <RepoView repoId={route.repoId} page={route.page ?? "files"} arg={route.arg} />}
        </div>
        <TerminalPanel forced={route.module === "repos" || route.module === "repo"} />
      </main>
      <CreateVaultDialog />
      <SettingsModal />
      <Dialogs />
      <ContextMenu />
      <IconPickerHost />
      <SyncConflictDialog />
      <Toasts />
    </div>
  );
}
