// Client-side port of the backend's Obsidian-style link resolution
// (brain2/vaults/service.py: pick_link) so rendering doesn't need a round-trip per link.

const KNOWN_EXTS = new Set([
  "md", "markdown", "txt", "json", "yaml", "yml", "pdf",
  "png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "avif",
  "mp3", "wav", "ogg", "m4a", "mp4", "webm", "mov",
]);

export const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "avif"]);
export const AUDIO_EXTS = new Set(["mp3", "wav", "ogg", "m4a"]);
export const VIDEO_EXTS = new Set(["mp4", "webm", "mov"]);

export function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

export function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(0, i) : "";
}

export function splitExt(name: string): [string, string] {
  const i = name.lastIndexOf(".");
  if (i > 0) {
    const ext = name.slice(i + 1).toLowerCase();
    if (KNOWN_EXTS.has(ext)) return [name.slice(0, i), ext];
  }
  return [name, ""];
}

export function extOf(path: string): string {
  return splitExt(basename(path))[1];
}

export function displayName(path: string): string {
  const [stem, ext] = splitExt(basename(path));
  return ext === "md" || ext === "markdown" ? stem : basename(path);
}

function normalize(p: string): string {
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

export function pickLink(target: string, srcPath: string | null, candidates: string[]): string | null {
  const t = target.trim().replace(/\\/g, "/");
  const base = basename(t);
  const [, ext] = splitExt(base);
  const names = ext ? [base.toLowerCase()] : [`${base}.md`, `${base}.markdown`, base].map((n) => n.toLowerCase());
  let cands = candidates.filter((p) => names.includes(basename(p).toLowerCase()));
  if (!cands.length) return null;
  const byLower = new Map(cands.map((p) => [p.toLowerCase(), p]));
  const tdir = dirname(t.replace(/^\/+/, ""));
  for (const n of names) {
    const key = tdir ? `${tdir}/${n}`.toLowerCase() : n;
    if (byLower.has(key)) return byLower.get(key)!;
  }
  if (srcPath !== null && !t.startsWith("/")) {
    for (const n of names) {
      const joined = normalize(`${dirname(srcPath)}/${dirname(t)}/${n}`).toLowerCase();
      if (byLower.has(joined)) return byLower.get(joined)!;
    }
  }
  if (tdir) {
    const suffixes = names.map((n) => `/${tdir}/${n}`.toLowerCase());
    cands = cands.filter((p) => suffixes.some((s) => p.toLowerCase().endsWith(s)));
    if (!cands.length) return null;
  }
  return cands.sort((a, b) => a.split("/").length - b.split("/").length || a.length - b.length || a.localeCompare(b))[0];
}

/** Resolver bound to a file list, indexed by lowercased stem. */
export class LinkResolver {
  private byStem = new Map<string, string[]>();
  constructor(paths: string[]) {
    for (const p of paths) {
      const stem = splitExt(basename(p))[0].toLowerCase();
      const list = this.byStem.get(stem);
      if (list) list.push(p);
      else this.byStem.set(stem, [p]);
    }
  }
  resolve(target: string, src: string | null): string | null {
    const stem = splitExt(basename(target.trim()))[0].toLowerCase();
    return pickLink(target, src, this.byStem.get(stem) ?? []);
  }
}

export function parseLinkText(inner: string): { target: string; fragment: string; alias: string } {
  const [targetPart, ...aliasParts] = inner.split("|");
  const hash = targetPart.indexOf("#");
  return {
    target: (hash >= 0 ? targetPart.slice(0, hash) : targetPart).trim(),
    fragment: hash >= 0 ? targetPart.slice(hash + 1).trim() : "",
    alias: aliasParts.join("|").trim(),
  };
}
