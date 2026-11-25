// Excalidraw drawings: plain `.excalidraw` JSON, and the Obsidian Excalidraw
// plugin's `.excalidraw.md` (markdown wrapper + JSON / compressed-json scene,
// with embedded images referenced as vault files).
import LZString from "lz-string";

export interface Scene {
  type?: string;
  version?: number;
  source?: string;
  elements: Record<string, unknown>[];
  appState?: Record<string, unknown>;
  files?: Record<string, { id: string; mimeType: string; dataURL: string; created?: number }>;
}

export interface ParsedDrawing {
  scene: Scene;
  /** fileId -> vault link target, from the "## Embedded Files" section (.excalidraw.md only). */
  embedded: Record<string, string>;
  frontmatter: string;
}

export const isMarkdownDrawing = (path: string) => /\.excalidraw\.md$/i.test(path);
export const isDrawing = (path: string) => /\.excalidraw(\.md)?$/i.test(path);

const DEFAULT_FM = "---\n\nexcalidraw-plugin: parsed\ntags: [excalidraw]\n\n---";
const BANNER =
  "==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠== " +
  "You can decompress Drawing data with the command palette: 'Decompress current Excalidraw file'. " +
  "For more info check in plugin settings under 'Saving'";

const emptyScene = (): Scene => ({ type: "excalidraw", version: 2, source: "brain2", elements: [], appState: {}, files: {} });

export function parseDrawing(path: string, text: string): ParsedDrawing {
  if (!isMarkdownDrawing(path)) {
    if (!text.trim()) return { scene: emptyScene(), embedded: {}, frontmatter: "" };
    const scene = JSON.parse(text) as Scene;
    return { scene: { ...emptyScene(), ...scene }, embedded: {}, frontmatter: "" };
  }
  const src = text.replace(/\r\n/g, "\n");
  const fm = /^---[ \t]*\n[\s\S]*?\n---[ \t]*(?:\n|$)/.exec(src);
  const block = /```(compressed-json|json)\n([\s\S]*?)\n```/.exec(src);
  let scene = emptyScene();
  if (block) {
    const raw = block[1] === "compressed-json" ? LZString.decompressFromBase64(block[2].replace(/\s+/g, "")) : block[2];
    if (!raw) throw new Error("Could not decompress the drawing data");
    scene = { ...scene, ...(JSON.parse(raw) as Scene) };
  }
  const embedded: Record<string, string> = {};
  const section = /^##\s+Embedded Files\s*\n([\s\S]*?)(?=\n#|\n%%|$)/im.exec(src);
  if (section) {
    for (const line of section[1].split("\n")) {
      const m = /^([0-9a-f]{20,}):\s*!?\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/i.exec(line.trim());
      if (m) embedded[m[1]] = m[2];
    }
  }
  return { scene, embedded, frontmatter: fm ? fm[0].trimEnd() : DEFAULT_FM };
}

/** Text elements are written out (searchable, linkable) like the Obsidian plugin does. */
function textElements(scene: Scene): string {
  return scene.elements
    .filter((e) => e.type === "text" && !e.isDeleted && typeof e.text === "string")
    .map((e) => `${String(e.text).replace(/\n/g, " ")} ^${String(e.id).replace(/[^A-Za-z0-9]/g, "").slice(0, 8)}`)
    .join("\n\n");
}

/** `json` = scene JSON (for .excalidraw.md the binary files must already be externalized). */
export function serializeDrawing(path: string, json: string, scene: Scene, embedded: Record<string, string>, frontmatter: string): string {
  if (!isMarkdownDrawing(path)) return json;
  const files = Object.entries(embedded)
    .map(([id, target]) => `${id}: [[${target}]]`)
    .join("\n");
  return [
    frontmatter || DEFAULT_FM,
    BANNER,
    "",
    "",
    "# Excalidraw Data",
    "",
    "## Text Elements",
    textElements(scene),
    "",
    ...(files ? ["## Embedded Files", files, ""] : []),
    "%%",
    "## Drawing",
    "```json",
    json,
    "```",
    "%%",
    "",
  ].join("\n");
}

export function emptyDrawingMarkdown(): string {
  const scene = emptyScene();
  return serializeDrawing("x.excalidraw.md", JSON.stringify({ ...scene, files: undefined }, null, "\t"), scene, {}, DEFAULT_FM);
}
