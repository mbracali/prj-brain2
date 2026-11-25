import "@excalidraw/excalidraw/index.css";
import { Excalidraw, serializeAsJSON } from "@excalidraw/excalidraw";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { registerSaver } from "../lib/editorRegistry";
import { onFilesChanged } from "../lib/events";
import { basename } from "../lib/links";
import { reportError, useApp, useWorkspace } from "../store";
import { type Scene, isMarkdownDrawing, serializeDrawing } from "./format";
import { loadDrawing } from "./load";

type Api = {
  updateScene: (s: Record<string, unknown>) => void;
  addFiles: (f: unknown[]) => void;
  scrollToContent: (target?: unknown, opts?: { fitToContent?: boolean; animate?: boolean }) => void;
  getSceneElements: () => readonly unknown[];
};

function useDarkTheme() {
  const [dark, setDark] = useState(document.documentElement.dataset.theme === "dark");
  useEffect(() => {
    const mo = new MutationObserver(() => setDark(document.documentElement.dataset.theme === "dark"));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, []);
  return dark;
}

function elementsSignature(elements: readonly Record<string, unknown>[], files: Record<string, unknown> | undefined) {
  return elements.map((e) => `${e.id}:${e.version}`).join(",") + "|" + Object.keys(files ?? {}).sort().join(",");
}

export default function ExcalidrawView({ vaultId, path, tabId }: { vaultId: string; path: string; tabId: string }) {
  const dark = useDarkTheme();
  const [initial, setInitial] = useState<{ scene: Scene; key: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const meta = useRef({ embedded: {} as Record<string, string>, frontmatter: "", lastText: "", signature: "" });
  const pending = useRef<{ elements: readonly Record<string, unknown>[]; appState: Record<string, unknown>; files: Record<string, unknown> } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const apiRef = useRef<Api | null>(null);
  const pathRef = useRef(path);
  pathRef.current = path;

  const load = useCallback(async () => {
    try {
      const d = await loadDrawing(vaultId, path);
      meta.current = {
        embedded: d.embedded,
        frontmatter: d.frontmatter,
        lastText: d.text,
        signature: elementsSignature(d.scene.elements, d.scene.files),
      };
      setInitial({ scene: d.scene, key: Date.now() });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [vaultId, path]);

  useEffect(() => {
    load();
  }, [load]);

  const save = useCallback(async () => {
    window.clearTimeout(timer.current);
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    const target = pathRef.current;
    const md = isMarkdownDrawing(target);
    try {
      const files = p.files as NonNullable<Scene["files"]>;
      if (md) {
        // Images live as vault attachments; the drawing only references them.
        const known = new Set(Object.keys(meta.current.embedded));
        const folder = useApp.getState().settings.attachmentFolder.replace(/^\/+|\/+$/g, "");
        for (const [id, f] of Object.entries(files)) {
          if (known.has(id) || !f?.dataURL) continue;
          const ext = (f.mimeType.split("/")[1] || "png").replace("jpeg", "jpg").replace("svg+xml", "svg");
          const res = await api.attachment(vaultId, folder, `Pasted Image ${id.slice(0, 8)}.${ext}`, f.dataURL.split(",", 2)[1] ?? "");
          meta.current.embedded[id] = basename(res.path);
        }
      }
      const json = serializeAsJSON(p.elements as never, p.appState as never, (md ? {} : files) as never, "local");
      const text = serializeDrawing(target, json, { elements: p.elements as never }, meta.current.embedded, meta.current.frontmatter);
      if (text === meta.current.lastText) return;
      await api.writeFile(vaultId, target, text);
      meta.current.lastText = text;
    } catch (e) {
      reportError(e);
    }
  }, [vaultId]);

  useEffect(() => registerSaver(tabId, save), [tabId, save]);
  useEffect(() => () => void save(), [save]);

  // Reload when the file changes outside this view (another window, Obsidian, sync…).
  useEffect(
    () =>
      onFilesChanged(async (paths) => {
        if (!paths.includes(pathRef.current) || pending.current) return;
        try {
          const d = await loadDrawing(vaultId, pathRef.current);
          if (d.text === meta.current.lastText) return;
          meta.current = { ...meta.current, embedded: d.embedded, lastText: d.text, signature: elementsSignature(d.scene.elements, d.scene.files) };
          apiRef.current?.addFiles(Object.values(d.scene.files ?? {}));
          apiRef.current?.updateScene({ elements: d.scene.elements });
        } catch {
          /* ignore */
        }
      }),
    [vaultId],
  );

  if (error) return <div className="view-empty muted"><p>Could not open drawing: {error}</p></div>;
  if (!initial) return <div className="view-empty"><div className="spinner" /></div>;

  return (
    <div className="excalidraw-host">
      <Excalidraw
        key={initial.key}
        theme={dark ? "dark" : "light"}
        excalidrawAPI={(a) => {
          apiRef.current = a as unknown as Api;
          // Center the drawing once the canvas has its real size.
          setTimeout(() => {
            const api = apiRef.current;
            if (api && api.getSceneElements().length) api.scrollToContent(undefined, { fitToContent: true, animate: false });
          }, 120);
        }}
        initialData={{
          elements: initial.scene.elements as never,
          appState: { ...(initial.scene.appState ?? {}), collaborators: new Map() } as never,
          files: (initial.scene.files ?? {}) as never,
          scrollToContent: true,
        }}
        UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false } }}
        onChange={(elements, appState, files) => {
          const signature = elementsSignature(elements as never, files as never);
          if (signature === meta.current.signature) return;
          meta.current.signature = signature;
          pending.current = { elements: elements as never, appState: appState as never, files: files as never };
          useWorkspace.setState((s) => ({ dirty: { ...s.dirty, [pathRef.current]: true } }));
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(async () => {
            await save();
            useWorkspace.setState((s) => ({ dirty: { ...s.dirty, [pathRef.current]: false } }));
          }, 800);
        }}
      />
    </div>
  );
}
