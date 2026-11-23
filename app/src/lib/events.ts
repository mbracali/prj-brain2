// In-app event bus between the websocket listener and open views.
type Listener = (paths: string[], origin: string | undefined) => void;
const listeners = new Set<Listener>();

export function onFilesChanged(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emitFilesChanged(paths: string[], origin?: string) {
  for (const fn of listeners) fn(paths, origin);
}
