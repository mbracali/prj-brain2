// User-level vault actions shared by the explorer, menus, command palette and editor.
import { api } from "./lib/api";
import { bridge } from "./lib/bridge";
import { basename, dirname, splitExt } from "./lib/links";
import { flushSaves } from "./lib/editorRegistry";
import { confirmDialog, promptDialog, reportError, useApp, useWorkspace } from "./store";

const ws = () => useWorkspace.getState();
const app = () => useApp.getState();

function vaultId(): string {
  const id = ws().vaultId;
  if (!id) throw new Error("No vault open");
  return id;
}

export async function createNote(folder = ws().currentFolder(), opts: { name?: string; content?: string } = {}) {
  try {
    const f = await api.createFile(vaultId(), { folder, name: opts.name, ext: "md", content: opts.content ?? "" });
    await ws().refresh();
    ws().openFile(f.path, { mode: app().settings.defaultViewMode === "reading" ? "live" : undefined });
    return f.path;
  } catch (e) {
    reportError(e);
    return null;
  }
}

export async function createFolder(parent = ws().currentFolder()) {
  const name = await promptDialog("New folder", { label: "Folder name", value: "Untitled", okLabel: "Create" });
  if (!name) return;
  try {
    const f = await api.createFolder(vaultId(), parent, name);
    if (parent) ws().toggleFolder(parent, true);
    ws().set({ selected: f.path });
    await ws().refresh();
  } catch (e) {
    reportError(e);
  }
}

export async function renamePath(path: string, isFolder: boolean) {
  const name = basename(path);
  const [stem, ext] = splitExt(name);
  const isNote = !isFolder && (ext === "md" || ext === "markdown");
  const value = await promptDialog(isFolder ? "Rename folder" : "Rename file", {
    label: "New name",
    value: isNote ? stem : name,
    okLabel: "Rename",
  });
  if (!value || value === (isNote ? stem : name)) return;
  const newName = isNote && !value.toLowerCase().endsWith(`.${ext}`) ? `${value}.${ext}` : value;
  const parent = dirname(path);
  await movePath(path, parent ? `${parent}/${newName}` : newName);
}

export async function movePath(src: string, dst: string) {
  if (src === dst) return;
  try {
    await flushSaves();
    const res = await api.move(vaultId(), src, dst, app().settings.updateLinksOnMove);
    await ws().refresh({ rename: [src, res.path] });
    if (res.updated_links_in?.length) {
      app().toast(`Updated links in ${res.updated_links_in.length} note${res.updated_links_in.length > 1 ? "s" : ""}`);
    }
  } catch (e) {
    reportError(e);
  }
}

export async function deletePath(path: string, isFolder: boolean) {
  if (app().settings.confirmDelete) {
    const ok = await confirmDialog(
      isFolder ? "Delete folder" : "Delete file",
      `Move "${basename(path)}"${isFolder ? " and everything inside it" : ""} to the vault trash (.brain2/trash)?`,
      { okLabel: "Delete", danger: true },
    );
    if (!ok) return;
  }
  try {
    await flushSaves();
    await api.remove(vaultId(), path);
    ws().dropPaths(path);
    await ws().refresh();
  } catch (e) {
    reportError(e);
  }
}

export async function openDailyNote() {
  const d = new Date();
  const name = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const folder = app().settings.dailyNotesFolder.replace(/^\/+|\/+$/g, "");
  const path = folder ? `${folder}/${name}.md` : `${name}.md`;
  if (ws().files.some((f) => f.path === path)) return ws().openFile(path);
  try {
    await api.writeFile(vaultId(), path, `# ${d.toDateString()}\n\n`, true);
    await ws().refresh();
    ws().openFile(path, { mode: "live" });
  } catch (e) {
    reportError(e);
  }
}

/** Open a [[link]] target; creates the note if it does not exist (Obsidian behaviour). */
export async function openLink(link: string, fromPath: string | null, newTab = false) {
  const hash = link.indexOf("#");
  const target = (hash >= 0 ? link.slice(0, hash) : link).trim();
  const heading = hash >= 0 ? link.slice(hash + 1).trim() : undefined;
  if (!target) {
    if (fromPath && heading) ws().openFile(fromPath, { heading });
    return;
  }
  const resolved = ws().resolver.resolve(target, fromPath);
  if (resolved) return ws().openFile(resolved, { newTab, heading });
  const clean = target.replace(/^\/+/, "");
  const [, ext] = splitExt(basename(clean));
  const path = ext ? clean : `${clean}.md`;
  try {
    await api.writeFile(vaultId(), path, "", true);
    await ws().refresh();
    ws().openFile(path, { newTab, mode: "live" });
  } catch (e) {
    reportError(e);
  }
}

function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",", 2)[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

/** Saves dropped/pasted files to the attachment folder, returns their vault paths. */
export async function saveAttachments(files: File[], folderOverride?: string): Promise<string[]> {
  const folder = folderOverride ?? app().settings.attachmentFolder.replace(/^\/+|\/+$/g, "");
  const out: string[] = [];
  for (const file of files) {
    try {
      const ext = file.type.split("/")[1]?.replace("jpeg", "jpg").replace("svg+xml", "svg") || "bin";
      const name = file.name && file.name !== "image.png" ? file.name : `Pasted image ${Date.now()}.${ext}`;
      const res = await api.attachment(vaultId(), folder, name, await fileToBase64(file));
      out.push(res.path);
    } catch (e) {
      reportError(e);
    }
  }
  if (out.length) await ws().refresh();
  return out;
}

export function absolutePath(rel: string): string | null {
  const vault = app().vaults.find((v) => v.id === ws().vaultId);
  if (!vault) return null;
  const sep = vault.path.includes("\\") ? "\\" : "/";
  return rel ? `${vault.path}${sep}${rel.split("/").join(sep)}` : vault.path;
}

export function revealInOS(rel: string) {
  const p = absolutePath(rel);
  if (p) bridge.reveal(p);
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    app().toast("Copied to clipboard");
  } catch (e) {
    reportError(e);
  }
}
