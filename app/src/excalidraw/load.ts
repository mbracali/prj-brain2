// Loads a drawing file (and its embedded vault images) into an Excalidraw scene.
import { api, rawUrl } from "../lib/api";
import { useWorkspace } from "../store";
import { type ParsedDrawing, type Scene, parseDrawing } from "./format";

async function toDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export async function loadDrawing(vaultId: string, path: string, text?: string): Promise<ParsedDrawing & { text: string }> {
  const content = text ?? (await api.readFile(vaultId, path)).content ?? "";
  const parsed = parseDrawing(path, content);
  const files: NonNullable<Scene["files"]> = { ...(parsed.scene.files ?? {}) };
  const resolver = useWorkspace.getState().resolver;
  await Promise.all(
    Object.entries(parsed.embedded).map(async ([id, target]) => {
      const resolved = resolver.resolve(target, path);
      if (!resolved) return;
      try {
        const blob = await (await fetch(rawUrl(vaultId, resolved))).blob();
        files[id] = { id, mimeType: blob.type || "image/png", dataURL: await toDataUrl(blob), created: Date.now() };
      } catch {
        /* missing image: Excalidraw shows a placeholder */
      }
    }),
  );
  return { ...parsed, scene: { ...parsed.scene, files }, text: content };
}

/** Renders a drawing to SVG for embeds (`![[drawing.excalidraw]]`). */
export async function drawingSvg(vaultId: string, path: string): Promise<SVGSVGElement> {
  const [{ exportToSvg }, drawing] = await Promise.all([import("@excalidraw/excalidraw"), loadDrawing(vaultId, path)]);
  const dark = document.documentElement.dataset.theme === "dark";
  const svg = await exportToSvg({
    elements: drawing.scene.elements.filter((e) => !e.isDeleted) as never,
    appState: { ...(drawing.scene.appState ?? {}), exportBackground: false, exportWithDarkMode: dark } as never,
    files: (drawing.scene.files ?? {}) as never,
    exportPadding: 12,
    // Fonts are already loaded in the app; inlining would need eval-based subsetting (blocked by CSP).
    skipInliningFonts: true,
  });
  svg.classList.add("drawing-svg");
  return svg;
}
