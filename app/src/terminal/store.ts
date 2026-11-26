// Terminal panel state: which backend terminals exist, which one is shown, panel size.
import { create } from "zustand";
import { api } from "../lib/api";
import { dirname } from "../lib/links";
import type { TerminalInfo } from "../lib/repoTypes";
import { useRepos } from "../repos/store";
import { reportError, useApp, useWorkspace } from "../store";
import { pruneSessions } from "./sessions";

const HEIGHT_KEY = "brain2.terminal.height";
const OPEN_KEY = "brain2.terminal.open";

function stored(key: string, fallback: string) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

interface TerminalState {
  terminals: TerminalInfo[];
  activeId: string | null;
  open: boolean;
  maximized: boolean;
  height: number;
  refresh(): Promise<void>;
  setOpen(open: boolean): void;
  toggle(): void;
  setHeight(h: number): void;
  setMaximized(m: boolean): void;
  activate(id: string): void;
  /** New terminal tab; cd's into `cwd` when given. */
  create(opts?: { cwd?: string; title?: string; key?: string }): Promise<TerminalInfo | null>;
  close(id: string): Promise<void>;
  rename(id: string, title: string): Promise<void>;
  /** Show (and create if needed) the terminal registered under `key`. */
  showKey(key: string, title: string, cwd?: string): Promise<TerminalInfo | null>;
  /** Open a terminal positioned in `folder` (reuses the tab for that folder). */
  openAt(folder: string, title?: string): Promise<void>;
  /** Activate the terminal with this id once it is known (after an action created it). */
  reveal(id: string): Promise<void>;
}

export const useTerminals = create<TerminalState>((set, get) => ({
  terminals: [],
  activeId: null,
  open: stored(OPEN_KEY, "0") === "1",
  maximized: false,
  height: Number(stored(HEIGHT_KEY, "260")) || 260,

  async refresh() {
    const terminals = await api.terminals();
    pruneSessions(new Set(terminals.map((t) => t.id)));
    const activeId = terminals.some((t) => t.id === get().activeId) ? get().activeId : terminals.at(-1)?.id ?? null;
    set({ terminals, activeId });
  },
  setOpen(open) {
    store(OPEN_KEY, open ? "1" : "0");
    const opening = open && !get().open;
    set({ open, maximized: open ? get().maximized : false });
    if (!opening) return;
    // Opening the panel shows a terminal in the folder you're looking at (the focused note's folder,
    // the vault, the repo), reusing one that is already there.
    const folder = contextFolder();
    if (folder) get().openAt(folder).catch(reportError);
    else if (!get().terminals.length) get().create().catch(reportError);
  },
  toggle() {
    get().setOpen(!get().open);
  },
  setHeight(height) {
    const h = Math.max(120, Math.min(height, window.innerHeight - 160));
    store(HEIGHT_KEY, String(Math.round(h)));
    set({ height: h });
  },
  setMaximized(maximized) {
    set({ maximized });
  },
  activate(id) {
    set({ activeId: id, open: true });
    store(OPEN_KEY, "1");
  },
  async create(opts = {}) {
    try {
      const info = await api.createTerminal(opts);
      await get().refresh();
      get().activate(info.id);
      return info;
    } catch (e) {
      reportError(e);
      return null;
    }
  },
  async close(id) {
    try {
      await api.closeTerminal(id);
    } catch {
      /* already gone */
    }
    await get().refresh();
  },
  async rename(id, title) {
    await api.renameTerminal(id, title);
    await get().refresh();
  },
  async showKey(key, title, cwd) {
    const existing = get().terminals.find((t) => t.key === key && t.alive);
    if (existing) {
      get().activate(existing.id);
      return existing;
    }
    return get().create({ key, title, cwd });
  },
  async openAt(folder, title) {
    const key = `dir:${folder}`;
    const same = (a: string) => a.replace(/[\\/]+$/, "") === folder.replace(/[\\/]+$/, "");
    const existing =
      get().terminals.find((t) => t.key === key && t.alive) ?? get().terminals.find((t) => !t.key && t.alive && same(t.cwd));
    if (existing) {
      get().activate(existing.id);
      return;
    }
    await get().create({ cwd: folder, key, title: title ?? (folder.split(/[\\/]/).filter(Boolean).pop() || folder) });
  },
  async reveal(id) {
    if (!get().terminals.some((t) => t.id === id)) await get().refresh();
    get().activate(id);
  },
}));

/** The folder the user is "looking at": the active note's folder, the vault, or the open repo. */
export function contextFolder(): string | undefined {
  const app = useApp.getState();
  const route = app.route;
  if (route.module === "vault") {
    const vault = app.vaults.find((v) => v.id === route.vaultId);
    if (!vault) return undefined;
    const tab = useWorkspace.getState().activeTab();
    const rel = tab?.type === "file" && tab.path ? dirname(tab.path) : "";
    return rel ? joinPath(vault.path, rel) : vault.path;
  }
  if (route.module === "repo") return useRepos.getState().repos.find((r) => r.id === route.repoId)?.path;
  if (route.module === "repos") return app.settings.reposFolder || undefined;
  return undefined;
}

export function joinPath(root: string, rel: string): string {
  const sep = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  return [root.replace(/[\\/]+$/, ""), ...rel.split("/").filter(Boolean)].join(sep);
}

export function openTerminalHere() {
  const folder = contextFolder();
  const t = useTerminals.getState();
  if (folder) t.openAt(folder).catch(reportError);
  else t.create().catch(reportError);
}
