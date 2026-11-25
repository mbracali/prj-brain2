import { startVaultSync, useVaultSync } from "../vaultSync";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  changeIcon,
  copyText,
  createBoard,
  createDrawing,
  createFolder,
  createNote,
  deletePath,
  movePath,
  renamePath,
  revealInOS,
  openTerminalAt,
  saveAttachments,
} from "../actions";
import { Icon, UserIcon } from "../components/Icon";
import { api } from "../lib/api";
import { bridge } from "../lib/bridge";
import { basename, dirname, displayName, splitExt } from "../lib/links";
import type { SearchHit, TreeFile, TreeFolder, TreeNode } from "../lib/types";
import { type MenuItem, reportError, useApp, useWorkspace } from "../store";
import { vaultMenu } from "../vaultActions";

const DRAG_TYPE = "application/x-brain2-path";
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function VaultSyncButton({ vaultId }: { vaultId: string }) {
  const busy = useVaultSync((s) => !!s.busy[vaultId]);
  return (
    <button className="icon-button" title="Sync with git" disabled={busy} onClick={() => startVaultSync(vaultId)}>
      <Icon name="sync" size={19} className={busy ? "spin" : ""} />
    </button>
  );
}

export function VaultSidebar({ vaultId }: { vaultId: string }) {
  const vault = useApp((s) => s.vaults.find((v) => v.id === vaultId));
  const leftTab = useWorkspace((s) => s.leftTab);
  const leftOpen = useWorkspace((s) => s.leftOpen);
  const set = useWorkspace((s) => s.set);
  const showMenu = useApp((s) => s.showMenu);
  if (!leftOpen) return <div className="sidebar-body collapsed" />;

  return (
    <div className="sidebar-body">
      <div className="sidebar-header">
        <button className="icon-button" title="All vaults" onClick={() => useApp.getState().navigate({ module: "vaults" })}>
          <Icon name="arrow_back" size={20} />
        </button>
        <button
          className="vault-switcher"
          title={vault?.path}
          onClick={(e) => vault && showMenu(e, vaultSwitchMenu(vault.id))}
          onContextMenu={(e) => (e.preventDefault(), vault && showMenu(e, vaultMenu(vault)))}
        >
          <UserIcon value={vault?.icon} fallback="inventory_2" size={18} />
          <span className="sidebar-title">{vault?.name ?? "Vault"}</span>
          <Icon name="unfold_more" size={16} />
        </button>
        {vault?.connections?.git?.length ? <VaultSyncButton vaultId={vault.id} /> : null}
      </div>
      <div className="panel-tabs">
        {(
          [
            ["files", "folder", "Files"],
            ["search", "search", "Search"],
            ["tags", "sell", "Tags"],
          ] as const
        ).map(([id, icon, label]) => (
          <button key={id} className={`panel-tab${leftTab === id ? " active" : ""}`} title={label} onClick={() => set({ leftTab: id })}>
            <Icon name={icon} size={18} />
          </button>
        ))}
      </div>
      {leftTab === "files" && <FileExplorer />}
      {leftTab === "search" && <SearchPanel />}
      {leftTab === "tags" && <TagsPanel />}
    </div>
  );
}

function vaultSwitchMenu(currentId: string): MenuItem[] {
  const app = useApp.getState();
  return [
    ...app.vaults.map((v) => ({
      label: v.name,
      icon: v.id === currentId ? "check" : "inventory_2",
      action: () => app.navigate({ module: "vault", vaultId: v.id }),
    })),
    { separator: true },
    { label: "Manage vaults…", icon: "settings", action: () => app.navigate({ module: "vaults" }) },
    { label: "Create vault…", icon: "add", action: () => app.setCreateVaultOpen(true) },
  ];
}

// ============================================================================ files
function sortChildren(children: TreeNode[]): TreeNode[] {
  return [...children].sort((a, b) =>
    a.type !== b.type ? (a.type === "folder" ? -1 : 1) : collator.compare(a.name, b.name),
  );
}

function FileExplorer() {
  const tree = useWorkspace((s) => s.tree);
  const set = useWorkspace((s) => s.set);
  const [dropRoot, setDropRoot] = useState(false);
  if (!tree) return <div className="panel-body empty small">Loading…</div>;

  const onDropRoot = (e: React.DragEvent) => {
    e.preventDefault();
    setDropRoot(false);
    handleDrop(e, "");
  };

  return (
    <>
      <div className="panel-toolbar">
        <button className="icon-button" title="New note" onClick={() => createNote()}>
          <Icon name="edit_square" size={18} />
        </button>
        <button className="icon-button" title="New folder" onClick={() => createFolder()}>
          <Icon name="create_new_folder" size={18} />
        </button>
        <button className="icon-button" title="New drawing" onClick={() => createDrawing()}>
          <Icon name="draw" size={18} />
        </button>
        <button className="icon-button" title="New kanban board" onClick={() => createBoard()}>
          <Icon name="view_kanban" size={18} />
        </button>
        <button className="icon-button" title="Graph view" onClick={() => useWorkspace.getState().openGraph()}>
          <Icon name="graph_3" size={18} />
        </button>
        <button className="icon-button" title="Collapse all" onClick={() => set({ expanded: {} })}>
          <Icon name="unfold_less" size={18} />
        </button>
      </div>
      <div
        className={`panel-body tree${dropRoot ? " drop-target" : ""}`}
        onDragOver={(e) => {
          if (e.target === e.currentTarget) {
            e.preventDefault();
            setDropRoot(true);
          }
        }}
        onDragLeave={() => setDropRoot(false)}
        onDrop={onDropRoot}
        onContextMenu={(e) => {
          if (e.target !== e.currentTarget) return;
          e.preventDefault();
          useApp.getState().showMenu(e, folderMenu(""));
        }}
      >
        {sortChildren(tree.children).map((n) => (
          <TreeItem key={n.path} node={n} depth={0} />
        ))}
        {!tree.children.length && (
          <div className="empty small">
            This vault is empty.
            <button className="btn btn-small" onClick={() => createNote("")}>Create a note</button>
          </div>
        )}
      </div>
    </>
  );
}

async function handleDrop(e: React.DragEvent, folder: string) {
  const src = e.dataTransfer.getData(DRAG_TYPE);
  if (src) {
    if (dirname(src) === folder || src === folder) return;
    await movePath(src, folder ? `${folder}/${basename(src)}` : basename(src));
    if (folder) useWorkspace.getState().toggleFolder(folder, true);
    return;
  }
  const files = Array.from(e.dataTransfer.files);
  if (files.length) await saveAttachments(files, folder);
}

function folderMenu(path: string): MenuItem[] {
  return [
    { label: "New note", icon: "edit_square", action: () => createNote(path) },
    { label: "New folder", icon: "create_new_folder", action: () => createFolder(path) },
    { label: "New drawing", icon: "draw", action: () => createDrawing(path) },
    { label: "New kanban board", icon: "view_kanban", action: () => createBoard(path) },
    { separator: true },
    ...(path
      ? [
          { label: "Rename…", icon: "edit", action: () => renamePath(path, true) },
          { label: "Change icon…", icon: "mood", action: () => changeIcon(path) },
          { label: "Copy path", icon: "content_copy", action: () => copyText(path) },
        ]
      : []),
    { label: "Reveal in file manager", icon: "folder_open", action: () => revealInOS(path) },
    { label: "Open in terminal", icon: "terminal", action: () => openTerminalAt(path, true) },
    ...(path ? [{ separator: true }, { label: "Delete", icon: "delete", danger: true, action: () => deletePath(path, true) }] : []),
  ];
}

function fileMenu(file: TreeFile): MenuItem[] {
  const ws = useWorkspace.getState();
  const [stem, ext] = splitExt(file.name);
  const link = ext === "md" ? stem : file.name;
  return [
    { label: "Open in new tab", icon: "tab", action: () => ws.openFile(file.path, { newTab: true }) },
    {
      label: "Open in new window",
      icon: "open_in_new",
      action: () => bridge.openWindow({ vault: ws.vaultId ?? "", file: file.path }),
    },
    { separator: true },
    { label: "Rename…", icon: "edit", action: () => renamePath(file.path, false) },
    { label: "Change icon…", icon: "mood", action: () => changeIcon(file.path) },
    {
      label: "Make a copy",
      icon: "file_copy",
      action: async () => {
        try {
          const src = await api.readFile(ws.vaultId!, file.path);
          if (src.content === undefined) throw new Error("Only text files can be copied");
          const res = await api.createFile(ws.vaultId!, { folder: dirname(file.path), name: `${stem} copy.${ext}`, content: src.content });
          await ws.refresh();
          ws.openFile(res.path);
        } catch (e) {
          reportError(e);
        }
      },
    },
    { label: "Copy path", icon: "content_copy", action: () => copyText(file.path) },
    { label: "Copy wikilink", icon: "link", action: () => copyText(`[[${link}]]`) },
    { label: "Reveal in file manager", icon: "folder_open", action: () => revealInOS(file.path) },
    { label: "Open folder in terminal", icon: "terminal", action: () => openTerminalAt(file.path, false) },
    { separator: true },
    { label: "Delete", icon: "delete", danger: true, action: () => deletePath(file.path, false) },
  ];
}


function TreeItem({ node, depth }: { node: TreeNode; depth: number }) {
  const expanded = useWorkspace((s) => !!s.expanded[node.path]);
  const icon = useWorkspace((s) => s.icons[node.path]);
  const selected = useWorkspace((s) => s.selected === node.path);
  const activePath = useWorkspace((s) => s.tabs.find((t) => t.id === s.activeId)?.path);
  const [over, setOver] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const isActive = node.type === "file" && activePath === node.path;

  useEffect(() => {
    if (isActive) ref.current?.scrollIntoView({ block: "nearest" });
  }, [isActive]);

  const pad = { paddingLeft: 8 + depth * 16 };
  const dragProps = {
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.setData(DRAG_TYPE, node.path);
      const [stem, ext] = splitExt(node.name);
      e.dataTransfer.setData("text/plain", node.type === "file" ? `[[${ext === "md" ? stem : node.name}]]` : node.path);
      e.dataTransfer.effectAllowed = "copyMove";
    },
  };

  if (node.type === "folder") {
    const folder = node as TreeFolder;
    return (
      <div className="tree-folder">
        <div
          ref={ref}
          className={`tree-item folder${selected ? " selected" : ""}${over ? " drop-target" : ""}`}
          style={pad}
          {...dragProps}
          onClick={() => {
            useWorkspace.getState().toggleFolder(folder.path);
            useWorkspace.getState().set({ selected: folder.path });
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            useWorkspace.getState().set({ selected: folder.path });
            useApp.getState().showMenu(e, folderMenu(folder.path));
          }}
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setOver(false);
            handleDrop(e, folder.path);
          }}
        >
          <Icon name={expanded ? "expand_more" : "chevron_right"} size={16} className="tree-chevron" />
          {icon && <UserIcon value={icon} fallback="" size={16} />}
          <span className="tree-label">{folder.name}</span>
        </div>
        {expanded && (
          <div className="tree-children">
            {sortChildren(folder.children).map((c) => (
              <TreeItem key={c.path} node={c} depth={depth + 1} />
            ))}
          </div>
        )}
      </div>
    );
  }

  const file = node as TreeFile;
  const isNote = file.kind === "markdown";
  const label = isNote ? displayName(file.name) : file.kind === "excalidraw" ? file.name.replace(/\.excalidraw(\.md)?$/i, "") : file.name;
  return (
    <div
      ref={ref}
      className={`tree-item file${isActive ? " active" : ""}${selected ? " selected" : ""}`}
      style={pad}
      {...dragProps}
      title={file.path}
      onClick={(e) => useWorkspace.getState().openFile(file.path, { newTab: e.metaKey || e.ctrlKey })}
      onAuxClick={(e) => e.button === 1 && useWorkspace.getState().openFile(file.path, { newTab: true })}
      onContextMenu={(e) => {
        e.preventDefault();
        useWorkspace.getState().set({ selected: file.path });
        useApp.getState().showMenu(e, fileMenu(file));
      }}
    >
      {icon && <UserIcon value={icon} fallback="" size={16} />}
      <span className="tree-label">{label}</span>
      {file.kind === "excalidraw" ? <span className="tree-ext">draw</span> : !isNote && file.ext && <span className="tree-ext">{file.ext}</span>}
    </div>
  );
}

// ============================================================================ search
export function renderSnippet(snippet: string | null) {
  if (!snippet) return null;
  const parts = snippet.split(/(\x02[^\x03]*\x03)/);
  return parts.map((p, i) => (p.startsWith("\x02") ? <mark key={i}>{p.slice(1, -1)}</mark> : <span key={i}>{p}</span>));
}

function SearchPanel() {
  const vaultId = useWorkspace((s) => s.vaultId)!;
  const query = useWorkspace((s) => s.searchQuery);
  const revision = useWorkspace((s) => s.revision);
  const set = useWorkspace((s) => s.set);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!query.trim()) {
      setHits(null);
      return;
    }
    const t = setTimeout(() => {
      api.search(vaultId, query).then(setHits).catch(reportError);
    }, 180);
    return () => clearTimeout(t);
  }, [query, vaultId, revision]);

  return (
    <>
      <div className="panel-toolbar search-box">
        <Icon name="search" size={18} />
        <input
          ref={inputRef}
          className="input input-bare"
          placeholder="Search… (tag:x  path:dir  file:name)"
          value={query}
          onChange={(e) => set({ searchQuery: e.target.value })}
        />
        {query && (
          <button className="icon-button" onClick={() => set({ searchQuery: "" })}>
            <Icon name="close" size={16} />
          </button>
        )}
      </div>
      <div className="panel-body">
        {hits && <div className="muted tiny search-count">{hits.length} result{hits.length === 1 ? "" : "s"}</div>}
        {hits?.map((h) => (
          <button
            key={h.path}
            className="search-hit"
            onClick={(e) => useWorkspace.getState().openFile(h.path, { newTab: e.metaKey || e.ctrlKey })}
          >
            <div className="search-hit-title">{displayName(h.path)}</div>
            {dirname(h.path) && <div className="muted tiny">{dirname(h.path)}</div>}
            {h.snippet && <div className="search-hit-snippet">{renderSnippet(h.snippet)}</div>}
          </button>
        ))}
        {!hits && (
          <div className="muted small search-help">
            Full-text search across notes, PDFs, text, JSON and YAML.
            <ul>
              <li><code>tag:project</code> or <code>#project</code> — by tag</li>
              <li><code>path:Work</code> — inside a folder</li>
              <li><code>file:meeting</code> — by file name</li>
            </ul>
          </div>
        )}
      </div>
    </>
  );
}

// ============================================================================ tags
function TagsPanel() {
  const vaultId = useWorkspace((s) => s.vaultId)!;
  const revision = useWorkspace((s) => s.revision);
  const [tags, setTags] = useState<{ tag: string; count: number }[]>([]);
  useEffect(() => {
    api.tags(vaultId).then(setTags).catch(reportError);
  }, [vaultId, revision]);
  const sorted = useMemo(() => [...tags].sort((a, b) => collator.compare(a.tag, b.tag)), [tags]);
  return (
    <div className="panel-body">
      {sorted.map((t) => (
        <button
          key={t.tag}
          className="tag-row"
          style={{ paddingLeft: 10 + (t.tag.split("/").length - 1) * 14 }}
          onClick={() => useWorkspace.getState().set({ leftTab: "search", searchQuery: `tag:${t.tag}` })}
        >
          <span className="tag">#{t.tag}</span>
          <span className="muted tiny">{t.count}</span>
        </button>
      ))}
      {!tags.length && <div className="empty small">No tags yet. Add <code>#tags</code> to your notes.</div>}
    </div>
  );
}
