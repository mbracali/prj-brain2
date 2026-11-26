import { useEffect, useRef } from "react";
import { createNote, openDailyNote } from "../actions";
import { Icon, UserIcon } from "../components/Icon";
import { Spinner } from "../components/Spinner";
import { modKey } from "../lib/bridge";
import { displayName } from "../lib/links";
import { type Pane, reportError, useApp, useWorkspace } from "../store";
import { FileView } from "./FileView";
import { GraphView } from "./GraphView";
import { CommandPalette, QuickSwitcher } from "./Palettes";
import { RightPanel } from "./RightPanel";

export function VaultWorkspace({ vaultId, initialFile }: { vaultId: string; initialFile?: string | null }) {
  const split = useWorkspace((s) => s.tabs.some((t) => t.pane === 1));
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
  if (loadedFor !== vaultId) {
    return (
      <div className="page center">
        <Spinner label={`Opening ${vault?.name ?? "vault"}${vault?.file_count ? ` · ${vault.file_count.toLocaleString()} files` : ""}…`} />
      </div>
    );
  }

  return (
    <div className="workspace">
      <div className={`workspace-main${split ? " split" : ""}`}>
        <PaneColumn pane={0} split={split} />
        {split && <SplitResizer />}
        {split && <PaneColumn pane={1} split={split} />}
      </div>
      {rightOpen && <RightPanel />}
      <QuickSwitcher />
      <CommandPalette />
    </div>
  );
}

/** One side of the workspace: its tab bar and the documents of its tabs. */
function PaneColumn({ pane, split }: { pane: Pane; split: boolean }) {
  const all = useWorkspace((s) => s.tabs);
  const tabs = all.filter((t) => (t.pane === 1 ? 1 : 0) === pane);
  const shown = useWorkspace((s) => s.paneActive[pane]);
  const focused = useWorkspace((s) => s.focusedPane === pane);
  const ratio = useApp((s) => s.settings.splitRatio || 0.5);
  return (
    <div
      className={`pane-column${split && focused ? " focused" : ""}`}
      style={split ? { flex: `${pane === 0 ? ratio : 1 - ratio} 1 0` } : undefined}
      onMouseDownCapture={() => useWorkspace.getState().focusPane(pane)}
      onFocusCapture={() => useWorkspace.getState().focusPane(pane)}
    >
      <TabBar pane={pane} split={split} />
      <div className="panes">
        {tabs.map((t) => (
          <div key={t.id} className="pane" style={t.id === shown ? undefined : { display: "none" }}>
            {t.type === "graph" ? (
              <GraphView active={t.id === shown} />
            ) : (
              <FileView tab={t} active={t.id === shown && focused} />
            )}
          </div>
        ))}
        {!tabs.length && <EmptyPane />}
      </div>
    </div>
  );
}

/** Drag handle between the two panes. */
function SplitResizer() {
  return (
    <div
      className="split-resizer"
      onMouseDown={(e) => {
        e.preventDefault();
        const host = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
        const move = (ev: MouseEvent) => {
          const r = Math.min(0.8, Math.max(0.2, (ev.clientX - host.left) / host.width));
          useApp.getState().updateSettings({ splitRatio: Math.round(r * 1000) / 1000 });
        };
        const up = () => {
          window.removeEventListener("mousemove", move);
          window.removeEventListener("mouseup", up);
          document.body.classList.remove("resizing-col");
        };
        document.body.classList.add("resizing-col");
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
      }}
      onDoubleClick={() => useApp.getState().updateSettings({ splitRatio: 0.5 })}
      title="Drag to resize · double-click to reset"
    />
  );
}

function TabBar({ pane, split }: { pane: Pane; split: boolean }) {
  const all = useWorkspace((s) => s.tabs);
  const tabs = all.filter((t) => (t.pane === 1 ? 1 : 0) === pane);
  const activeId = useWorkspace((s) => s.paneActive[pane]);
  const dirty = useWorkspace((s) => s.dirty);
  const icons = useWorkspace((s) => s.icons);
  const leftOpen = useWorkspace((s) => s.leftOpen);
  const rightOpen = useWorkspace((s) => s.rightOpen);
  const ws = useWorkspace.getState;

  return (
    <div
      className="tab-bar"
      onDragOver={(e) => dragTabId && e.preventDefault()}
      onDrop={(e) => {
        // Dropping on the empty part of a tab bar moves the tab to the end of that pane.
        const from = dragTabId;
        dragTabId = null;
        if (!from) return;
        e.preventDefault();
        ws().moveToPane(from, pane);
      }}
    >
      {pane === 0 && (
        <button className="icon-button" title={`Toggle left sidebar (${modKey}+\\)`} onClick={() => ws().set({ leftOpen: !leftOpen })}>
          <Icon name={leftOpen ? "left_panel_close" : "left_panel_open"} size={18} />
        </button>
      )}
      <div className="tabs">
        {tabs.map((t) => (
          <div
            key={t.id}
            className={`tab${t.id === activeId ? " active" : ""}${t.pinned ? " pinned" : ""}`}
            draggable
            onDragStart={(e) => {
              dragTabId = t.id;
              e.dataTransfer.setData("application/x-brain2-tab", t.id);
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragEnd={() => (dragTabId = null)}
            onDragOver={(e) => dragTabId && e.preventDefault()}
            onDrop={(e) => {
              const from = dragTabId;
              dragTabId = null;
              if (!from || from === t.id) return;
              e.preventDefault();
              e.stopPropagation();
              const list = [...ws().tabs];
              const a = list.findIndex((x) => x.id === from);
              const [moved] = list.splice(a, 1);
              const b = list.findIndex((x) => x.id === t.id);
              // Dropping on a tab of the other pane moves the tab there.
              list.splice(b, 0, { ...moved, pane: pane === 1 ? 1 : undefined });
              // Pinned tabs always stay grouped on the left.
              ws().set({ tabs: [...list.filter((x) => x.pinned), ...list.filter((x) => !x.pinned)], activeId: from });
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
                { label: t.pinned ? "Unpin" : "Pin", icon: "keep", action: () => ws().togglePin(t.id) },
                ...(t.type === "file"
                  ? [{ label: split ? "Open in other pane" : "Split right", icon: "splitscreen_right", action: () => ws().splitRight(t.id) }]
                  : []),
                ...(split
                  ? [
                      { label: "Move to other pane", icon: "move_group", action: () => ws().moveToPane(t.id, pane === 0 ? 1 : 0) },
                    ]
                  : []),
                { separator: true },
                { label: "Close", icon: "close", action: () => ws().closeTab(t.id, { force: true }) },
                {
                  label: "Close others",
                  icon: "tab_close",
                  action: () =>
                    ws().set({ tabs: ws().tabs.filter((x) => x.id === t.id || x.pinned || (x.pane === 1 ? 1 : 0) !== pane), activeId: t.id }),
                },
                {
                  label: "Close all",
                  icon: "tab_close_right",
                  action: () => {
                    const keep = ws().tabs.filter((x) => x.pinned || (x.pane === 1 ? 1 : 0) !== pane);
                    ws().set({ tabs: keep, activeId: keep.find((x) => x.id === ws().activeId)?.id ?? keep[0]?.id ?? null });
                  },
                },
              ]);
            }}
            title={t.path || "Graph view"}
          >
            {t.type === "graph" ? (
              <Icon name="graph_3" size={15} className="tab-icon" />
            ) : (
              icons[t.path] && <UserIcon value={icons[t.path]} fallback="" size={15} />
            )}
            <span className="tab-title">{t.type === "graph" ? "Graph view" : displayName(t.path).replace(/\.excalidraw$/i, "")}</span>
            {dirty[t.path] && <span className="tab-dirty" />}
            {t.pinned ? (
              <button
                className="tab-close tab-pin"
                title="Pinned — click to unpin"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  ws().togglePin(t.id);
                }}
              >
                <Icon name="keep" size={14} />
              </button>
            ) : (
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
            )}
          </div>
        ))}
        <button className="icon-button tab-new" title={`New note (${modKey}+N)`} onClick={() => createNote()}>
          <Icon name="add" size={18} />
        </button>
      </div>
      <div className="tab-bar-drag" aria-hidden="true" />
      {split ? (
        <button className="icon-button" title="Close this pane" onClick={() => closePane(pane)}>
          <Icon name="close_fullscreen" size={17} />
        </button>
      ) : (
        tabs.some((t) => t.type === "file") && (
          <button className="icon-button" title="Split right — open this note side by side" onClick={() => ws().splitRight()}>
            <Icon name="splitscreen_right" size={18} />
          </button>
        )
      )}
      {(pane === 1 || !split) && (
        <button className="icon-button" title="Toggle right sidebar" onClick={() => ws().set({ rightOpen: !rightOpen })}>
          <Icon name={rightOpen ? "right_panel_close" : "right_panel_open"} size={18} />
        </button>
      )}
    </div>
  );
}

/** Tab being dragged (shared by both tab bars so tabs can move between panes). */
let dragTabId: string | null = null;

/** Close one side of the split: its tabs move to the other pane (unless they're already open there). */
function closePane(pane: Pane) {
  const ws = useWorkspace.getState();
  const other: Pane = pane === 0 ? 1 : 0;
  const otherPaths = new Set(ws.tabs.filter((t) => (t.pane === 1 ? 1 : 0) === other).map((t) => `${t.type}:${t.path}`));
  const tabs = ws.tabs
    .filter((t) => (t.pane === 1 ? 1 : 0) === other || t.pinned || !otherPaths.has(`${t.type}:${t.path}`))
    .map((t) => ({ ...t, pane: undefined }));
  ws.set({ tabs, activeId: ws.paneActive[other] });
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
