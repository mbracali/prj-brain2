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
  | { module: "repos" }
  | { module: "repo"; repoId: string; page?: RepoPage; arg?: string }
  | { module: "calendars" }
  | { module: "calendar"; calendarId: string }
  | { module: "coming"; name: string };

export type RepoPage = "files" | "commits" | "pushes" | "branches" | "tags" | "pulls";

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
/** Where the last context menu opened; follow-up popovers (icon picker) appear there. */
export let lastMenuPos = { x: 200, y: 200 };
let settingsTimer: number | undefined;
const pendingSettings: Record<string, unknown> = {};

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
    // Coalesce rapid changes (dragging, ctrl+scroll, typing a font name) into one write.
    Object.assign(pendingSettings, patch);
    window.clearTimeout(settingsTimer);
    settingsTimer = window.setTimeout(() => {
      const values = { ...pendingSettings };
      for (const k of Object.keys(pendingSettings)) delete pendingSettings[k];
      api.putSettings(values).catch(reportError);
    }, 400);
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
    lastMenuPos = { x: e.clientX, y: e.clientY };
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
  /** Pinned tabs stay at the left, can't be closed by Cmd+W and never get replaced by navigation. */
  pinned?: boolean;
  /** Which side of a split view the tab lives in (0 = left/only pane, 1 = right pane). */
  pane?: Pane;
  /** Line to scroll to after opening (from search/backlinks/outline). */
  focusLine?: number;
  focusHeading?: string;
  focusNonce?: number;
}

export type Pane = 0 | 1;
const paneOf = (t: Tab): Pane => (t.pane === 1 ? 1 : 0);

interface WorkspaceState {
  vaultId: string | null;
  tree: TreeFolder | null;
  files: FileEntry[];
  icons: Record<string, string>;
  loading: boolean;
  resolver: LinkResolver;
  revision: number;
  tabs: Tab[];
  /** Active tab of the focused pane. */
  activeId: string | null;
  /** Active tab of each pane (split view). */
  paneActive: [string | null, string | null];
  focusedPane: Pane;
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
  loadIcons(): Promise<void>;
  openFile(path: string, opts?: { newTab?: boolean; line?: number; heading?: string; mode?: ViewMode }): void;
  openGraph(): void;
  closeTab(id: string, opts?: { force?: boolean }): void;
  togglePin(id: string): void;
  activate(id: string): void;
  /** True when the right pane has tabs. */
  isSplit(): boolean;
  focusPane(pane: Pane): void;
  /** Open the tab's document (default: the active one) in the other pane, like Obsidian's "Split right". */
  splitRight(id?: string): void;
  /** Move a tab to the other pane. */
  moveToPane(id: string, pane: Pane): void;
  closeSplit(): void;
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
        tabs: s.tabs.map(({ id, type, path, mode, pinned, pane }) => ({
          id, type, path, mode, ...(pinned ? { pinned } : {}), ...(pane === 1 ? { pane } : {}),
        })),
        activeId: s.activeId,
        paneActive: s.paneActive,
        focusedPane: s.focusedPane,
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
    return normalizePanes({
      tabs: (data.tabs ?? []).map((t: Tab) => ({ ...t, back: [], forward: [] })),
      activeId: data.activeId ?? null,
      paneActive: Array.isArray(data.paneActive) ? data.paneActive : [data.activeId ?? null, null],
      focusedPane: data.focusedPane === 1 ? 1 : 0,
      expanded: data.expanded ?? {},
      leftOpen: data.leftOpen ?? true,
      rightOpen: data.rightOpen ?? true,
    } as WorkspaceState);
  } catch {
    return {};
  }
}

/**
 * Keep the pane bookkeeping consistent after any change to the tab list: an empty right pane
 * closes the split, an empty left pane takes over the right one, and each pane's active tab
 * (and the focused pane's `activeId`) always points to a tab of that pane.
 */
function normalizePanes<T extends Pick<WorkspaceState, "tabs" | "activeId" | "paneActive" | "focusedPane">>(s: T): T {
  let tabs = s.tabs;
  if (!tabs.some((t) => paneOf(t) === 0) && tabs.some((t) => paneOf(t) === 1)) {
    tabs = tabs.map((t) => ({ ...t, pane: undefined }));
  }
  const active: [string | null, string | null] = [null, null];
  for (const pane of [0, 1] as Pane[]) {
    const mine = tabs.filter((t) => paneOf(t) === pane);
    const wanted = [s.activeId, s.paneActive?.[pane], s.paneActive?.[pane === 0 ? 1 : 0]];
    active[pane] = wanted.map((id) => mine.find((t) => t.id === id)?.id).find(Boolean) ?? mine[mine.length - 1]?.id ?? null;
  }
  // activeId wins for its own pane.
  const owner = tabs.find((t) => t.id === s.activeId);
  if (owner) active[paneOf(owner)] = owner.id;
  let focusedPane: Pane = owner ? paneOf(owner) : s.focusedPane;
  if (!active[focusedPane]) focusedPane = active[0] ? 0 : 1;
  return { ...s, tabs, paneActive: active, focusedPane, activeId: active[focusedPane] };
}

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  vaultId: null,
  tree: null,
  files: [],
  icons: {},
  loading: false,
  resolver: new LinkResolver([]),
  revision: 0,
  tabs: [],
  activeId: null,
  paneActive: [null, null],
  focusedPane: 0,
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
      icons: {},
      loading: true,
      tabs: [],
      activeId: null,
      paneActive: [null, null],
      focusedPane: 0,
      expanded: {},
      selected: null,
      searchQuery: "",
      dirty: {},
      leftOpen: true,
      rightOpen: true,
      ...restore(vaultId),
    });
    try {
      await get().refresh();
    } finally {
      set({ loading: false });
    }
    // Drop tabs whose files vanished while the vault was closed.
    const known = new Set(get().files.map((f) => f.path));
    const tabs = get().tabs.filter((t) => t.type !== "file" || known.has(t.path));
    set(normalizePanes({ ...get(), tabs }));
  },
  async loadIcons() {
    const id = get().vaultId;
    if (!id) return;
    const icons = await api.icons(id);
    if (get().vaultId === id) set({ icons });
  },
  closeVault() {
    persist(get());
    set({ vaultId: null, tree: null, files: [], tabs: [], activeId: null });
  },
  async refresh(opts = {}) {
    const id = get().vaultId;
    if (!id) return;
    const [tree, files, icons] = await Promise.all([api.tree(id), api.files(id), api.icons(id).catch(() => ({}))]);
    if (get().vaultId !== id) return;
    // Applying a rename in the same update keeps open editors mounted.
    const renamed = opts.rename ? renamePatch(get(), ...opts.rename) : {};
    set({ tree, files, icons, resolver: new LinkResolver(files.map((f) => f.path)), revision: get().revision + 1, ...renamed });
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
    const pane = s.focusedPane;
    const existing = s.tabs.find((t) => t.type === "file" && t.path === path && paneOf(t) === pane);
    if (existing && !opts.newTab) {
      tabs = s.tabs.map((t) => (t.id === existing.id ? { ...t, ...focus } : t));
      activeId = existing.id;
    } else if (active && !opts.newTab && !active.pinned) {
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
      const tab: Tab = { id: newTabId(), type: "file", path, mode, back: [], forward: [], ...focus, ...(pane === 1 ? { pane } : {}) };
      tabs = [...s.tabs, tab];
      activeId = tab.id;
    }
    const expanded = { ...s.expanded };
    for (let d = dirname(path); d; d = dirname(d)) expanded[d] = true;
    set({ ...normalizePanes({ ...s, tabs, activeId }), selected: path, expanded });
    persist(get());
  },
  openGraph() {
    const s = get();
    const existing = s.tabs.find((t) => t.type === "graph");
    if (existing) return set(normalizePanes({ ...s, activeId: existing.id }));

    const tab: Tab = { id: newTabId(), type: "graph", path: "", mode: "reading", back: [], forward: [], ...(s.focusedPane === 1 ? { pane: 1 as Pane } : {}) };
    set(normalizePanes({ ...s, tabs: [...s.tabs, tab], activeId: tab.id }));
    persist(get());
  },
  closeTab(id, opts = {}) {
    const s = get();
    const idx = s.tabs.findIndex((t) => t.id === id);
    if (idx < 0 || (s.tabs[idx].pinned && !opts.force)) return;
    const closing = s.tabs[idx];
    const tabs = s.tabs.filter((t) => t.id !== id);
    // Next tab of the same pane takes its place.
    const siblings = s.tabs.filter((t) => paneOf(t) === paneOf(closing));
    const at = siblings.findIndex((t) => t.id === id);
    const next = (siblings[at + 1] ?? siblings[at - 1])?.id ?? null;
    const paneActive = [...s.paneActive] as [string | null, string | null];
    if (paneActive[paneOf(closing)] === id) paneActive[paneOf(closing)] = next;
    const activeId = s.activeId === id ? next ?? paneActive[paneOf(closing) === 0 ? 1 : 0] : s.activeId;
    set(normalizePanes({ ...s, tabs, activeId, paneActive }));
    persist(get());
  },
  togglePin(id) {
    const tabs = get().tabs.map((t) => (t.id === id ? { ...t, pinned: !t.pinned } : t));
    // Pinned tabs first, keeping relative order otherwise.
    set({ tabs: [...tabs.filter((t) => t.pinned), ...tabs.filter((t) => !t.pinned)] });
    persist(get());
  },
  activate(id) {
    const tab = get().tabs.find((t) => t.id === id);
    set({ ...normalizePanes({ ...get(), activeId: id }), selected: tab?.path || get().selected });
    persist(get());
  },
  isSplit() {
    return get().tabs.some((t) => paneOf(t) === 1);
  },
  focusPane(pane) {
    const s = get();
    if (s.focusedPane === pane || !s.paneActive[pane]) return;
    const tab = s.tabs.find((t) => t.id === s.paneActive[pane]);
    set({ focusedPane: pane, activeId: s.paneActive[pane], selected: tab?.path || s.selected });
    persist(get());
  },
  splitRight(id) {
    const s = get();
    const src = s.tabs.find((t) => t.id === (id ?? s.activeId));
    if (!src) return;
    const target: Pane = paneOf(src) === 0 ? 1 : 0;
    const tab: Tab = { ...src, id: newTabId(), pinned: false, back: [], forward: [], pane: target === 1 ? 1 : undefined };
    if (src.type === "graph") {
      // Only one graph view: move it instead of duplicating.
      return get().moveToPane(src.id, target);
    }
    set(normalizePanes({ ...s, tabs: [...s.tabs, tab], activeId: tab.id }));
    persist(get());
  },
  moveToPane(id, pane) {
    const s = get();
    const tabs = s.tabs.map((t) => (t.id === id ? { ...t, pane: pane === 1 ? (1 as Pane) : undefined } : t));
    set(normalizePanes({ ...s, tabs, activeId: id }));
    persist(get());
  },
  closeSplit() {
    const s = get();
    set(normalizePanes({ ...s, tabs: s.tabs.map((t) => ({ ...t, pane: undefined })), focusedPane: 0, activeId: s.paneActive[0] ?? s.activeId }));
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
    set(normalizePanes({ ...s, tabs }));
    persist(get());
  },
  toggleFolder(path, open) {
    const expanded = { ...get().expanded, [path]: open ?? !get().expanded[path] };
    set({ expanded });
    persist(get());
  },
  set(patch) {
    if ("tabs" in patch || "activeId" in patch) set(normalizePanes({ ...get(), ...patch }));
    else set(patch);
    if ("leftOpen" in patch || "rightOpen" in patch || "tabs" in patch) persist(get());
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
