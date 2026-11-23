import { create } from "zustand";
import { api } from "./lib/api";
import { LinkResolver, dirname } from "./lib/links";
import {
  DEFAULT_SETTINGS,
  type FileEntry,
  type Settings,
  type TreeFolder,
  type Vault,
  type ViewMode,
} from "./lib/types";

// ============================================================================ app store
export type Route =
  | { module: "dashboard" }
  | { module: "vaults" }
  | { module: "vault"; vaultId: string }
  | { module: "coming"; name: string };

export interface MenuItem {
  label?: string;
  icon?: string;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
  action?: () => void;
}

export type DialogSpec =
  | { kind: "prompt"; title: string; label?: string; value?: string; okLabel?: string; resolve: (v: string | null) => void }
  | { kind: "confirm"; title: string; message: string; okLabel?: string; danger?: boolean; resolve: (v: boolean) => void };

interface AppState {
  settings: Settings;
  vaults: Vault[];
  vaultsLoaded: boolean;
  route: Route;
  sidebar: "modules" | "vaults";
  settingsSection: string | null;
  createVaultOpen: boolean;
  dialog: DialogSpec | null;
  contextMenu: { x: number; y: number; items: MenuItem[] } | null;
  toasts: { id: number; text: string; kind: "info" | "error" }[];

  loadSettings(): Promise<void>;
  updateSettings(patch: Partial<Settings>): Promise<void>;
  loadVaults(): Promise<void>;
  navigate(route: Route): void;
  setSidebar(s: AppState["sidebar"]): void;
  openSettings(section?: string | null): void;
  setCreateVaultOpen(open: boolean): void;
  showMenu(e: { clientX: number; clientY: number }, items: MenuItem[]): void;
  closeMenu(): void;
  toast(text: string, kind?: "info" | "error"): void;
}

let toastId = 0;

export const useApp = create<AppState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  vaults: [],
  vaultsLoaded: false,
  route: { module: "dashboard" },
  sidebar: "modules",
  settingsSection: null,
  createVaultOpen: false,
  dialog: null,
  contextMenu: null,
  toasts: [],

  async loadSettings() {
    const stored = await api.getSettings();
    set({ settings: { ...DEFAULT_SETTINGS, ...(stored as Partial<Settings>) } });
  },
  async updateSettings(patch) {
    set({ settings: { ...get().settings, ...patch } });
    await api.putSettings(patch as Record<string, unknown>);
  },
  async loadVaults() {
    const vaults = await api.listVaults();
    set({ vaults, vaultsLoaded: true });
  },
  navigate(route) {
    set({ route, sidebar: route.module === "vaults" || route.module === "vault" ? "vaults" : get().sidebar });
  },
  setSidebar(sidebar) {
    set({ sidebar });
  },
  openSettings(section = "general") {
    set({ settingsSection: section });
  },
  setCreateVaultOpen(open) {
    set({ createVaultOpen: open });
  },
  showMenu(e, items) {
    set({ contextMenu: { x: e.clientX, y: e.clientY, items } });
  },
  closeMenu() {
    set({ contextMenu: null });
  },
  toast(text, kind = "info") {
    const id = ++toastId;
    set({ toasts: [...get().toasts, { id, text, kind }] });
    setTimeout(() => set({ toasts: get().toasts.filter((t) => t.id !== id) }), kind === "error" ? 6000 : 3000);
  },
}));

export function promptDialog(title: string, opts: { label?: string; value?: string; okLabel?: string } = {}) {
  return new Promise<string | null>((resolve) =>
    useApp.setState({ dialog: { kind: "prompt", title, ...opts, resolve } }),
  );
}

export function confirmDialog(title: string, message: string, opts: { okLabel?: string; danger?: boolean } = {}) {
  return new Promise<boolean>((resolve) =>
    useApp.setState({ dialog: { kind: "confirm", title, message, ...opts, resolve } }),
  );
}

export function reportError(err: unknown) {
  useApp.getState().toast(err instanceof Error ? err.message : String(err), "error");
}

// ============================================================================ workspace store
export interface Tab {
  id: string;
  type: "file" | "graph";
  path: string; // file path (or "" for graph)
  mode: ViewMode;
  back: string[];
  forward: string[];
  /** Line to scroll to after opening (from search/backlinks/outline). */
  focusLine?: number;
  focusHeading?: string;
  focusNonce?: number;
}

interface WorkspaceState {
  vaultId: string | null;
  tree: TreeFolder | null;
  files: FileEntry[];
  resolver: LinkResolver;
  revision: number;
  tabs: Tab[];
  activeId: string | null;
  expanded: Record<string, boolean>;
  selected: string | null;
  leftTab: "files" | "search" | "tags";
  leftOpen: boolean;
  rightOpen: boolean;
  searchQuery: string;
  quickSwitcherOpen: boolean;
  paletteOpen: boolean;
  dirty: Record<string, boolean>;

  openVault(vaultId: string): Promise<void>;
  closeVault(): void;
  refresh(opts?: { rename?: [string, string] }): Promise<void>;
  openFile(path: string, opts?: { newTab?: boolean; line?: number; heading?: string; mode?: ViewMode }): void;
  openGraph(): void;
  closeTab(id: string): void;
  activate(id: string): void;
  setMode(id: string, mode: ViewMode): void;
  goBack(): void;
  goForward(): void;
  renamePaths(from: string, to: string): void;
  dropPaths(path: string): void;
  toggleFolder(path: string, open?: boolean): void;
  set(patch: Partial<WorkspaceState>): void;
  activeTab(): Tab | null;
  currentFolder(): string;
}

function renamePatch(s: WorkspaceState, from: string, to: string): Partial<WorkspaceState> {
  const map = (p: string) => (p === from ? to : p.startsWith(from + "/") ? to + p.slice(from.length) : p);
  const expanded: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(s.expanded)) expanded[map(k)] = v;
  return {
    tabs: s.tabs.map((t) => ({ ...t, path: map(t.path), back: t.back.map(map), forward: t.forward.map(map) })),
    selected: s.selected ? map(s.selected) : null,
    expanded,
  };
}

let tabSeq = 0;
const newTabId = () => `t${Date.now().toString(36)}${(tabSeq++).toString(36)}`;

function persistKey(vaultId: string) {
  return `brain2.workspace.${vaultId}`;
}

function persist(s: WorkspaceState) {
  if (!s.vaultId) return;
  try {
    localStorage.setItem(
      persistKey(s.vaultId),
      JSON.stringify({
        tabs: s.tabs.map(({ id, type, path, mode }) => ({ id, type, path, mode })),
        activeId: s.activeId,
        expanded: s.expanded,
        leftOpen: s.leftOpen,
        rightOpen: s.rightOpen,
      }),
    );
  } catch {
    /* storage unavailable */
  }
}

function restore(vaultId: string): Partial<WorkspaceState> {
  try {
    const raw = localStorage.getItem(persistKey(vaultId));
    if (!raw) return {};
    const data = JSON.parse(raw);
    return {
      tabs: (data.tabs ?? []).map((t: Tab) => ({ ...t, back: [], forward: [] })),
      activeId: data.activeId ?? null,
      expanded: data.expanded ?? {},
      leftOpen: data.leftOpen ?? true,
      rightOpen: data.rightOpen ?? true,
    };
  } catch {
    return {};
  }
}

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  vaultId: null,
  tree: null,
  files: [],
  resolver: new LinkResolver([]),
  revision: 0,
  tabs: [],
  activeId: null,
  expanded: {},
  selected: null,
  leftTab: "files",
  leftOpen: true,
  rightOpen: true,
  searchQuery: "",
  quickSwitcherOpen: false,
  paletteOpen: false,
  dirty: {},

  async openVault(vaultId) {
    if (get().vaultId === vaultId) return;
    set({
      vaultId,
      tree: null,
      files: [],
      tabs: [],
      activeId: null,
      expanded: {},
      selected: null,
      searchQuery: "",
      dirty: {},
      leftOpen: true,
      rightOpen: true,
      ...restore(vaultId),
    });
    await get().refresh();
    // Drop tabs whose files vanished while the vault was closed.
    const known = new Set(get().files.map((f) => f.path));
    const tabs = get().tabs.filter((t) => t.type !== "file" || known.has(t.path));
    const activeId = tabs.find((t) => t.id === get().activeId)?.id ?? tabs[0]?.id ?? null;
    set({ tabs, activeId });
  },
  closeVault() {
    persist(get());
    set({ vaultId: null, tree: null, files: [], tabs: [], activeId: null });
  },
  async refresh(opts = {}) {
    const id = get().vaultId;
    if (!id) return;
    const [tree, files] = await Promise.all([api.tree(id), api.files(id)]);
    if (get().vaultId !== id) return;
    // Applying a rename in the same update keeps open editors mounted.
    const renamed = opts.rename ? renamePatch(get(), ...opts.rename) : {};
    set({ tree, files, resolver: new LinkResolver(files.map((f) => f.path)), revision: get().revision + 1, ...renamed });
    if (opts.rename) persist(get());
  },
  openFile(path, opts = {}) {
    const s = get();
    const mode = opts.mode ?? useApp.getState().settings.defaultViewMode;
    const focus =
      opts.line !== undefined || opts.heading
        ? { focusLine: opts.line, focusHeading: opts.heading, focusNonce: Date.now() }
        : {};
    const active = s.activeTab();
    let tabs: Tab[];
    let activeId: string;
    const existing = s.tabs.find((t) => t.type === "file" && t.path === path);
    if (existing && !opts.newTab) {
      tabs = s.tabs.map((t) => (t.id === existing.id ? { ...t, ...focus } : t));
      activeId = existing.id;
    } else if (active && !opts.newTab) {
      tabs = s.tabs.map((t) =>
        t.id === active.id
          ? {
              ...t,
              type: "file",
              path,
              mode: t.type === "file" ? t.mode : mode,
              back: t.path ? [...t.back, t.path] : t.back,
              forward: [],
              ...focus,
            }
          : t,
      );
      activeId = active.id;
    } else {
      const tab: Tab = { id: newTabId(), type: "file", path, mode, back: [], forward: [], ...focus };
      tabs = [...s.tabs, tab];
      activeId = tab.id;
    }
    const expanded = { ...s.expanded };
    for (let d = dirname(path); d; d = dirname(d)) expanded[d] = true;
    set({ tabs, activeId, selected: path, expanded });
    persist(get());
  },
  openGraph() {
    const s = get();
    const existing = s.tabs.find((t) => t.type === "graph");
    if (existing) return set({ activeId: existing.id });
    const tab: Tab = { id: newTabId(), type: "graph", path: "", mode: "reading", back: [], forward: [] };
    set({ tabs: [...s.tabs, tab], activeId: tab.id });
    persist(get());
  },
  closeTab(id) {
    const s = get();
    const idx = s.tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const tabs = s.tabs.filter((t) => t.id !== id);
    const activeId = s.activeId === id ? (tabs[idx] ?? tabs[idx - 1])?.id ?? null : s.activeId;
    set({ tabs, activeId });
    persist(get());
  },
  activate(id) {
    const tab = get().tabs.find((t) => t.id === id);
    set({ activeId: id, selected: tab?.path || get().selected });
    persist(get());
  },
  setMode(id, mode) {
    set({ tabs: get().tabs.map((t) => (t.id === id ? { ...t, mode } : t)) });
    persist(get());
  },
  goBack() {
    const t = get().activeTab();
    if (!t || !t.back.length) return;
    const prev = t.back[t.back.length - 1];
    set({
      tabs: get().tabs.map((x) =>
        x.id === t.id ? { ...x, path: prev, type: "file", back: x.back.slice(0, -1), forward: [x.path, ...x.forward] } : x,
      ),
      selected: prev,
    });
  },
  goForward() {
    const t = get().activeTab();
    if (!t || !t.forward.length) return;
    const next = t.forward[0];
    set({
      tabs: get().tabs.map((x) =>
        x.id === t.id ? { ...x, path: next, type: "file", back: [...x.back, x.path], forward: x.forward.slice(1) } : x,
      ),
      selected: next,
    });
  },
  renamePaths(from, to) {
    set(renamePatch(get(), from, to));
    persist(get());
  },
  dropPaths(path) {
    const gone = (p: string) => p === path || p.startsWith(path + "/");
    const s = get();
    const tabs = s.tabs.filter((t) => t.type !== "file" || !gone(t.path));
    const activeId = tabs.find((t) => t.id === s.activeId)?.id ?? tabs[tabs.length - 1]?.id ?? null;
    set({ tabs, activeId });
    persist(get());
  },
  toggleFolder(path, open) {
    const expanded = { ...get().expanded, [path]: open ?? !get().expanded[path] };
    set({ expanded });
    persist(get());
  },
  set(patch) {
    set(patch);
    if ("leftOpen" in patch || "rightOpen" in patch) persist(get());
  },
  activeTab() {
    const s = get();
    return s.tabs.find((t) => t.id === s.activeId) ?? null;
  },
  currentFolder() {
    const s = get();
    if (useApp.getState().settings.newNoteLocation === "root") return "";
    const sel = s.selected;
    if (!sel) return "";
    const isFolder = s.files.every((f) => f.path !== sel);
    return isFolder ? sel : dirname(sel);
  },
}));
