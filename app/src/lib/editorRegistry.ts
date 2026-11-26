// Tracks the focused editor (for command palette formatting commands) and
// pending autosaves (flushed before renames/deletes so no edit is lost).
import type { EditorView } from "@codemirror/view";

let active: EditorView | null = null;
const savers = new Map<string, () => Promise<void>>();

export function setActiveEditor(view: EditorView | null) {
  active = view;
}

export function getActiveEditor(): EditorView | null {
  return active && active.dom.isConnected ? active : null;
}

export function registerSaver(id: string, flush: () => Promise<void>): () => void {
  savers.set(id, flush);
  return () => {
    if (savers.get(id) === flush) savers.delete(id);
  };
}

export async function flushSaves(): Promise<void> {
  await Promise.all([...savers.values()].map((f) => f().catch(() => undefined)));
}

// ---------------------------------------------------------------- live sync between panes
// The same note can be open in both panes of a split view: every edit is mirrored to the other
// editors of that file right away (the editor that made the edit owns saving it).
type DocListener = (path: string, text: string, sourceId: string) => void;
const docListeners = new Set<DocListener>();

export function publishDoc(path: string, text: string, sourceId: string) {
  for (const fn of docListeners) fn(path, text, sourceId);
}

export function onDocEdited(fn: DocListener): () => void {
  docListeners.add(fn);
  return () => docListeners.delete(fn);
}

/** Smallest single change turning `from` into `to` (keeps cursors and undo history sane). */
export function minimalChange(from: string, to: string): { from: number; to: number; insert: string } | null {
  if (from === to) return null;
  let start = 0;
  const max = Math.min(from.length, to.length);
  while (start < max && from.charCodeAt(start) === to.charCodeAt(start)) start++;
  let endA = from.length;
  let endB = to.length;
  while (endA > start && endB > start && from.charCodeAt(endA - 1) === to.charCodeAt(endB - 1)) {
    endA--;
    endB--;
  }
  return { from: start, to: endA, insert: to.slice(start, endB) };
}
