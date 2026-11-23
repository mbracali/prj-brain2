import { config } from "./bridge";
import type {
  Backlink,
  BrainEvent,
  FileEntry,
  FileInfo,
  GraphData,
  Heading,
  OutLink,
  SearchHit,
  TreeFolder,
  Vault,
} from "./types";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown, query?: Record<string, unknown>): Promise<T> {
  const url = new URL(config.baseUrl + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      msg = (await res.json()).detail ?? msg;
    } catch {
      /* not json */
    }
    throw new ApiError(res.status, typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  return res.json() as Promise<T>;
}

const v = (id: string) => `/api/vaults/${encodeURIComponent(id)}`;

export const api = {
  system: () => request<Record<string, string>>("GET", "/api/system"),
  getSettings: () => request<Record<string, unknown>>("GET", "/api/settings"),
  putSettings: (values: Record<string, unknown>) => request<Record<string, unknown>>("PUT", "/api/settings", values),

  listVaults: () => request<Vault[]>("GET", "/api/vaults"),
  createVault: (body: { name: string; path?: string; icon?: string }) => request<Vault>("POST", "/api/vaults", body),
  updateVault: (id: string, body: Partial<Pick<Vault, "name" | "icon" | "sort_order">>) =>
    request<Vault>("PATCH", v(id), body),
  deleteVault: (id: string, deleteFiles = false) =>
    request<{ ok: true }>("DELETE", v(id), undefined, { delete_files: deleteFiles }),
  reindex: (id: string) => request<Record<string, number>>("POST", `${v(id)}/reindex`),

  tree: (id: string) => request<TreeFolder>("GET", `${v(id)}/tree`),
  files: (id: string) => request<FileEntry[]>("GET", `${v(id)}/files`),
  readFile: (id: string, path: string) => request<FileInfo>("GET", `${v(id)}/file`, undefined, { path }),
  writeFile: (id: string, path: string, content: string, createOnly = false) =>
    request<FileInfo>("PUT", `${v(id)}/file`, { path, content, create_only: createOnly }),
  createFile: (id: string, body: { folder?: string; name?: string; ext?: string; content?: string }) =>
    request<FileInfo>("POST", `${v(id)}/file`, body),
  createFolder: (id: string, parent: string, name?: string) =>
    request<{ path: string }>("POST", `${v(id)}/folder`, { parent, name }),
  move: (id: string, src: string, dst: string, updateLinks = true) =>
    request<{ path: string; updated_links_in: string[] }>("POST", `${v(id)}/move`, {
      src,
      dst,
      update_links: updateLinks,
    }),
  remove: (id: string, path: string, permanent = false) =>
    request<{ path: string }>("DELETE", `${v(id)}/entry`, undefined, { path, permanent }),
  attachment: (id: string, folder: string, name: string, dataBase64: string) =>
    request<{ path: string; name: string }>("POST", `${v(id)}/attachment`, { folder, name, data_base64: dataBase64 }),

  search: (id: string, q: string) => request<SearchHit[]>("GET", `${v(id)}/search`, undefined, { q }),
  backlinks: (id: string, path: string) => request<Backlink[]>("GET", `${v(id)}/backlinks`, undefined, { path }),
  links: (id: string, path: string) => request<OutLink[]>("GET", `${v(id)}/links`, undefined, { path }),
  outline: (id: string, path: string) => request<Heading[]>("GET", `${v(id)}/outline`, undefined, { path }),
  tags: (id: string) => request<{ tag: string; count: number }[]>("GET", `${v(id)}/tags`),
  graph: (id: string) => request<GraphData>("GET", `${v(id)}/graph`),
};

export function rawUrl(vaultId: string, path: string): string {
  const url = new URL(`${config.baseUrl}${v(vaultId)}/raw`);
  url.searchParams.set("path", path);
  if (config.token) url.searchParams.set("token", config.token);
  return url.toString();
}

/** Live change notifications; reconnects automatically. */
export function subscribeEvents(onEvent: (e: BrainEvent) => void): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let retry = 500;
  const connect = () => {
    const url = new URL(config.baseUrl.replace(/^http/, "ws") + "/api/events");
    if (config.token) url.searchParams.set("token", config.token);
    ws = new WebSocket(url);
    ws.onopen = () => (retry = 500);
    ws.onmessage = (m) => {
      try {
        onEvent(JSON.parse(m.data));
      } catch {
        /* ignore malformed */
      }
    };
    ws.onclose = () => {
      if (!closed) setTimeout(connect, (retry = Math.min(retry * 2, 8000)));
    };
  };
  connect();
  return () => {
    closed = true;
    ws?.close();
  };
}
