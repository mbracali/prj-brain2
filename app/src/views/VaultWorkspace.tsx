import { useEffect, useRef } from "react";
import { createNote, openDailyNote } from "../actions";
import { Icon } from "../components/Icon";
import { modKey } from "../lib/bridge";
import { displayName } from "../lib/links";
import { reportError, useApp, useWorkspace } from "../store";
import { FileView } from "./FileView";
import { GraphView } from "./GraphView";
import { CommandPalette, QuickSwitcher } from "./Palettes";
import { RightPanel } from "./RightPanel";

export function VaultWorkspace({ vaultId, initialFile }: { vaultId: string; initialFile?: string | null }) {
  const tabs = useWorkspace((s) => s.tabs);
  const activeId = useWorkspace((s) => s.activeId);
  const rightOpen = useWorkspace((s) => s.rightOpen);
  const loadedFor = useWorkspace((s) => (s.tree ? s.vaultId : null));
  const vault = useApp((s) => s.vaults.find((v) => v.id === vaultId));
  const openedInitial = useRef(false);

  useEffect(() => {
    useWorkspace
      .getState()
      .openVault(vaultId)
      .then(() => {
        if (initialFile && !openedInitial.current) {
          openedInitial.current = true;
          useWorkspace.getState().openFile(initialFile);
        }
      })
      .catch(reportError);
  }, [vaultId, initialFile]);

  useEffect(() => {
    document.title = vault ? `${vault.name} — BRAIN2` : "BRAIN2";
  }, [vault]);

  if (vault && !vault.exists) {
    return (
      <div className="page center">
        <div className="hero">
          <Icon name="folder_off" size={56} />
          <h2>Vault folder not found</h2>
          <p className="muted">{vault.path}</p>
        </div>
      </div>
    );
  }
  if (loadedFor !== vaultId) return <div className="page center muted">Loading vault…</div>;

  return (
    <div className="workspace">
      <div className="workspace-main">
        <TabBar />
        <div className="panes">
          {tabs.map((t) => (
            <div key={t.id} className="pane" style={t.id === activeId ? undefined : { display: "none" }}>
              {t.type === "graph" ? <GraphView active={t.id === activeId} /> : <FileView tab={t} active={t.id === activeId} />}
            </div>
          ))}
          {!tabs.length && <EmptyPane />}
        </div>
      </div>
      {rightOpen && <RightPanel />}
      <QuickSwitcher />
      <CommandPalette />
    </div>
  );
}

function TabBar() {
  const tabs = useWorkspace((s) => s.tabs);
  const activeId = useWorkspace((s) => s.activeId);
  const dirty = useWorkspace((s) => s.dirty);
  const leftOpen = useWorkspace((s) => s.leftOpen);
  const rightOpen = useWorkspace((s) => s.rightOpen);
  const ws = useWorkspace.getState;
  const dragId = useRef<string | null>(null);

  return (
    <div className="tab-bar">
      <button className="icon-button" title={`Toggle left sidebar (${modKey}+\\)`} onClick={() => ws().set({ leftOpen: !leftOpen })}>
        <Icon name={leftOpen ? "left_panel_close" : "left_panel_open"} size={18} />
      </button>
      <div className="tabs">
        {tabs.map((t) => (
          <div
            key={t.id}
            className={`tab${t.id === activeId ? " active" : ""}`}
            draggable
            onDragStart={() => (dragId.current = t.id)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => {
              const from = dragId.current;
              if (!from || from === t.id) return;
              const list = [...ws().tabs];
              const a = list.findIndex((x) => x.id === from);
              const b = list.findIndex((x) => x.id === t.id);
              const [moved] = list.splice(a, 1);
              list.splice(b, 0, moved);
              ws().set({ tabs: list });
            }}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                ws().closeTab(t.id);
              } else if (e.button === 0) ws().activate(t.id);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              useApp.getState().showMenu(e, [
                { label: "Close", icon: "close", action: () => ws().closeTab(t.id) },
                {
                  label: "Close others",
                  icon: "tab_close",
                  action: () => ws().set({ tabs: ws().tabs.filter((x) => x.id === t.id), activeId: t.id }),
                },
                { label: "Close all", icon: "tab_close_right", action: () => ws().set({ tabs: [], activeId: null }) },
              ]);
            }}
            title={t.path || "Graph view"}
          >
            <Icon name={t.type === "graph" ? "hub" : "description"} size={15} className="tab-icon" />
            <span className="tab-title">{t.type === "graph" ? "Graph view" : displayName(t.path)}</span>
            {dirty[t.path] && <span className="tab-dirty" />}
            <button
              className="tab-close"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                ws().closeTab(t.id);
              }}
            >
              <Icon name="close" size={14} />
            </button>
          </div>
        ))}
        <button className="icon-button tab-new" title={`New note (${modKey}+N)`} onClick={() => createNote()}>
          <Icon name="add" size={18} />
        </button>
      </div>
      <button className="icon-button" title="Toggle right sidebar" onClick={() => ws().set({ rightOpen: !rightOpen })}>
        <Icon name={rightOpen ? "right_panel_close" : "right_panel_open"} size={18} />
      </button>
    </div>
  );
}

function EmptyPane() {
  const ws = useWorkspace.getState;
  return (
    <div className="empty-pane">
      <div className="empty-actions">
        <button onClick={() => createNote()}>
          Create new note <kbd>{modKey}+N</kbd>
        </button>
        <button onClick={() => ws().set({ quickSwitcherOpen: true })}>
          Go to file <kbd>{modKey}+O</kbd>
        </button>
        <button onClick={() => openDailyNote()}>Open today’s daily note</button>
        <button onClick={() => ws().openGraph()}>
          Open graph view <kbd>{modKey}+G</kbd>
        </button>
        <button onClick={() => ws().set({ paletteOpen: true })}>
          Command palette <kbd>{modKey}+P</kbd>
        </button>
      </div>
    </div>
  );
}
