// Command registry: the command palette, keyboard shortcuts and the native menu all go through here.
import { copyText, createFolder, createNote, deletePath, openDailyNote, renamePath, revealInOS } from "./actions";
import { wrapSelection } from "./editor/setup";
import { api } from "./lib/api";
import { bridge, modKey } from "./lib/bridge";
import { getActiveEditor } from "./lib/editorRegistry";
import { reportError, useApp, useWorkspace } from "./store";

export interface Command {
  id: string;
  name: string;
  icon: string;
  hotkey?: string;
  when?: () => boolean;
  run: () => void;
}

const ws = () => useWorkspace.getState();
const inVault = () => !!ws().vaultId && useApp.getState().route.module === "vault";
const activeFile = () => {
  const t = ws().activeTab();
  return t?.type === "file" ? t.path : null;
};
const hasEditor = () => !!getActiveEditor() && ws().activeTab()?.mode !== "reading";
const editorCmd = (before: string, after?: string) => () => {
  const v = getActiveEditor();
  if (v) {
    wrapSelection(v, before, after);
    v.focus();
  }
};

export function toggleReading() {
  window.dispatchEvent(new Event("brain2:toggle-reading"));
}

export function commands(): Command[] {
  return [
    { id: "quick-switcher", name: "Quick switcher: open a note", icon: "search", hotkey: `${modKey}+O`, when: inVault, run: () => ws().set({ quickSwitcherOpen: true }) },
    { id: "new-note", name: "Create new note", icon: "edit_square", hotkey: `${modKey}+N`, when: inVault, run: () => createNote() },
    { id: "new-folder", name: "Create new folder", icon: "create_new_folder", when: inVault, run: () => createFolder() },
    { id: "daily-note", name: "Open today's daily note", icon: "today", when: inVault, run: () => openDailyNote() },
    { id: "search", name: "Search in vault", icon: "manage_search", hotkey: `${modKey}+⇧+F`, when: inVault, run: () => ws().set({ leftOpen: true, leftTab: "search" }) },
    { id: "graph", name: "Open graph view", icon: "hub", hotkey: `${modKey}+G`, when: inVault, run: () => ws().openGraph() },
    { id: "toggle-reading", name: "Toggle reading view", icon: "chrome_reader_mode", hotkey: `${modKey}+E`, when: () => !!activeFile(), run: toggleReading },
    {
      id: "toggle-source",
      name: "Toggle live preview / source mode",
      icon: "code",
      when: () => !!activeFile(),
      run: () => {
        const t = ws().activeTab();
        if (t) ws().setMode(t.id, t.mode === "source" ? "live" : "source");
      },
    },
    { id: "toggle-left", name: "Toggle left sidebar", icon: "left_panel_close", hotkey: `${modKey}+\\`, when: inVault, run: () => ws().set({ leftOpen: !ws().leftOpen }) },
    { id: "toggle-right", name: "Toggle right sidebar", icon: "right_panel_close", hotkey: `${modKey}+⇧+\\`, when: inVault, run: () => ws().set({ rightOpen: !ws().rightOpen }) },
    { id: "go-back", name: "Navigate back", icon: "arrow_back", when: inVault, run: () => ws().goBack() },
    { id: "go-forward", name: "Navigate forward", icon: "arrow_forward", when: inVault, run: () => ws().goForward() },
    {
      id: "close-tab",
      name: "Close current tab",
      icon: "close",
      hotkey: `${modKey}+W`,
      when: () => !!ws().activeId,
      run: () => {
        const id = ws().activeId;
        if (id) ws().closeTab(id);
      },
    },
    { id: "rename", name: "Rename file", icon: "edit", when: () => !!activeFile(), run: () => renamePath(activeFile()!, false) },
    { id: "delete", name: "Delete current file", icon: "delete", when: () => !!activeFile(), run: () => deletePath(activeFile()!, false) },
    { id: "copy-path", name: "Copy file path", icon: "content_copy", when: () => !!activeFile(), run: () => copyText(activeFile()!) },
    { id: "reveal", name: "Reveal file in file manager", icon: "folder_open", when: () => !!activeFile(), run: () => revealInOS(activeFile()!) },
    { id: "open-window", name: "Open current file in new window", icon: "open_in_new", when: () => !!activeFile(), run: () => bridge.openWindow({ vault: ws().vaultId!, file: activeFile()! }) },
    { id: "bold", name: "Toggle bold", icon: "format_bold", hotkey: `${modKey}+B`, when: hasEditor, run: editorCmd("**") },
    { id: "italic", name: "Toggle italic", icon: "format_italic", hotkey: `${modKey}+I`, when: hasEditor, run: editorCmd("*") },
    { id: "strike", name: "Toggle strikethrough", icon: "strikethrough_s", when: hasEditor, run: editorCmd("~~") },
    { id: "highlight", name: "Toggle highlight", icon: "ink_highlighter", when: hasEditor, run: editorCmd("==") },
    { id: "code", name: "Toggle inline code", icon: "code", when: hasEditor, run: editorCmd("`") },
    { id: "link", name: "Insert internal link", icon: "link", hotkey: `${modKey}+K`, when: hasEditor, run: editorCmd("[[", "]]") },
    {
      id: "reindex",
      name: "Rebuild vault index",
      icon: "refresh",
      when: inVault,
      run: async () => {
        try {
          const r = await api.reindex(ws().vaultId!);
          useApp.getState().toast(`Indexed ${r.files} files`);
          await ws().refresh();
        } catch (e) {
          reportError(e);
        }
      },
    },
    { id: "settings", name: "Open settings", icon: "settings", hotkey: `${modKey}+,`, run: () => useApp.getState().openSettings("general") },
    { id: "new-vault", name: "Create or open a vault", icon: "inventory_2", run: () => useApp.getState().setCreateVaultOpen(true) },
    { id: "vaults", name: "Manage vaults", icon: "inventory_2", run: () => useApp.getState().navigate({ module: "vaults" }) },
  ];
}

export function runCommand(id: string) {
  const c = commands().find((x) => x.id === id);
  if (c && (!c.when || c.when())) c.run();
}
