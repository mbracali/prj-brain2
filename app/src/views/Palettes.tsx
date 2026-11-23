import { useEffect, useMemo, useRef, useState } from "react";
import { commands } from "../commands";
import { Icon } from "../components/Icon";
import { api } from "../lib/api";
import { modKey } from "../lib/bridge";
import { fuzzyFilter } from "../lib/fuzzy";
import { dirname, displayName } from "../lib/links";
import { reportError, useWorkspace } from "../store";

function usePaletteKeys<T>(items: T[], onPick: (item: T, e: React.KeyboardEvent) => void, onClose: () => void) {
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => setIndex(0), [items]);
  useEffect(() => {
    listRef.current?.querySelector(".palette-item.active")?.scrollIntoView({ block: "nearest" });
  }, [index]);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
      e.preventDefault();
      setIndex((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
      e.preventDefault();
      setIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (items[index] !== undefined) onPick(items[index], e);
      else onPick(undefined as T, e);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };
  return { index, setIndex, onKeyDown, listRef };
}

function Palette({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="modal-backdrop palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette">{children}</div>
    </div>
  );
}

export function QuickSwitcher() {
  const open = useWorkspace((s) => s.quickSwitcherOpen);
  const files = useWorkspace((s) => s.files);
  const [q, setQ] = useState("");
  const close = () => (useWorkspace.getState().set({ quickSwitcherOpen: false }), setQ(""));
  const results = useMemo(
    () => (open ? fuzzyFilter(files, q, (f) => f.path.replace(/\.(md|markdown)$/i, ""), 60) : []),
    [files, q, open],
  );
  const pick = async (f: (typeof results)[number] | undefined, e: React.KeyboardEvent | React.MouseEvent) => {
    const ws = useWorkspace.getState();
    const newTab = e.metaKey || e.ctrlKey;
    if (f && !e.shiftKey) {
      ws.openFile(f.path, { newTab });
      close();
      return;
    }
    // Shift+Enter (or no match): create a note with this name.
    const name = q.trim();
    if (!name) return;
    close();
    try {
      const path = name.toLowerCase().endsWith(".md") ? name : `${name}.md`;
      await api.writeFile(ws.vaultId!, path, "", true);
      await ws.refresh();
      ws.openFile(path, { newTab, mode: "live" });
    } catch (err) {
      reportError(err);
    }
  };
  const { index, setIndex, onKeyDown, listRef } = usePaletteKeys(results, pick, close);
  if (!open) return null;
  return (
    <Palette onClose={close}>
      <input
        className="palette-input"
        autoFocus
        placeholder="Find or create a note…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="palette-list" ref={listRef}>
        {results.map((f, i) => (
          <button
            key={f.path}
            className={`palette-item${i === index ? " active" : ""}`}
            onMouseEnter={() => setIndex(i)}
            onClick={(e) => pick(f, e)}
          >
            <span className="palette-title">{displayName(f.path)}</span>
            {dirname(f.path) && <span className="palette-detail">{dirname(f.path)}</span>}
          </button>
        ))}
        {!results.length && q.trim() && (
          <div className="palette-empty">
            Press <kbd>Enter</kbd> to create “{q.trim()}”
          </div>
        )}
      </div>
      <div className="palette-footer">
        <span><kbd>↑↓</kbd> navigate</span>
        <span><kbd>↵</kbd> open</span>
        <span><kbd>{modKey} ↵</kbd> new tab</span>
        <span><kbd>⇧ ↵</kbd> create</span>
        <span><kbd>esc</kbd> dismiss</span>
      </div>
    </Palette>
  );
}

export function CommandPalette() {
  const open = useWorkspace((s) => s.paletteOpen);
  const [q, setQ] = useState("");
  const close = () => (useWorkspace.getState().set({ paletteOpen: false }), setQ(""));
  const list = useMemo(() => (open ? commands().filter((c) => !c.when || c.when()) : []), [open]);
  const results = useMemo(() => fuzzyFilter(list, q, (c) => c.name, 80), [list, q]);
  const pick = (c: (typeof results)[number] | undefined) => {
    if (!c) return;
    close();
    setTimeout(() => c.run(), 0);
  };
  const { index, setIndex, onKeyDown, listRef } = usePaletteKeys(results, pick, close);
  if (!open) return null;
  return (
    <Palette onClose={close}>
      <input
        className="palette-input"
        autoFocus
        placeholder="Type a command…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="palette-list" ref={listRef}>
        {results.map((c, i) => (
          <button
            key={c.id}
            className={`palette-item${i === index ? " active" : ""}`}
            onMouseEnter={() => setIndex(i)}
            onClick={() => pick(c)}
          >
            <Icon name={c.icon} size={18} />
            <span className="palette-title">{c.name}</span>
            {c.hotkey && <kbd className="palette-hotkey">{c.hotkey}</kbd>}
          </button>
        ))}
        {!results.length && <div className="palette-empty">No matching commands.</div>}
      </div>
    </Palette>
  );
}
