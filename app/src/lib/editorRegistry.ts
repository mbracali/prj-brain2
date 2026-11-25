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
