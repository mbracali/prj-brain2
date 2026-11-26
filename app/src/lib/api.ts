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
import type {
  Blob, Branch, CommandResult, Commit, CommitDetail, PullList, PushEvent, Refs, Repo, RepoInspect, RepoTree, SyncResult,
  Tag, TerminalInfo, VaultGitStatus,
} from "./repoTypes";
import type { Account, CalEvent, Calendar, CalendarSource, Connectors, DetectedProvider, EventInput, OAuthFlow, OAuthStatus, RemoteCalendar } from "./calTypes";

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
const r = (id: string) => `/api/repos/${encodeURIComponent(id)}`;
const t = (id: string) => `/api/terminals/${encodeURIComponent(id)}`;

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
  graph: (id: string, opts: { attachments?: boolean; unresolved?: boolean; tags?: boolean } = {}) =>
    request<GraphData>("GET", `${v(id)}/graph`, undefined, opts),
  icons: (id: string) => request<Record<string, string>>("GET", `${v(id)}/icons`),
  setIcon: (id: string, path: string, icon: string) =>
    request<Record<string, string>>("PUT", `${v(id)}/icons`, { path, icon }),

  // vault git sync
  vaultGit: (id: string) => request<VaultGitStatus>("GET", `${v(id)}/git`),
  attachVaultGit: (id: string, url: string | null) => request<{ ok: boolean; empty?: boolean }>("PUT", `${v(id)}/git`, { url }),
  syncVault: (id: string) => request<SyncResult>("POST", `${v(id)}/git/sync`),
  resolveVault: (id: string, choices: Record<string, string>) =>
    request<SyncResult>("POST", `${v(id)}/git/resolve`, { choices }),
  abortVaultSync: (id: string) => request<SyncResult>("POST", `${v(id)}/git/abort`),

  // terminals
  terminals: () => request<TerminalInfo[]>("GET", "/api/terminals"),
  createTerminal: (body: { cwd?: string; title?: string; key?: string }) =>
    request<TerminalInfo>("POST", "/api/terminals", body),
  renameTerminal: (id: string, title: string) => request<TerminalInfo>("PATCH", t(id), { title }),
  closeTerminal: (id: string) => request<{ ok: true }>("DELETE", t(id)),
  terminalCd: (id: string, path: string) => request<{ job_id: string }>("POST", `${t(id)}/cd`, undefined, { path }),

  // repos
  repos: () => request<Repo[]>("GET", "/api/repos"),
  repo: (id: string) => request<Repo>("GET", r(id)),
  inspectRepo: (path: string) => request<RepoInspect>("GET", "/api/repos/inspect", undefined, { path }),
  cloneRepo: (body: { url: string; parent: string; name?: string; icon?: string; terminal_id?: string }) =>
    request<Repo>("POST", "/api/repos/clone", body),
  createRepo: (body: { parent: string; folder: string; name?: string; icon?: string; terminal_id?: string }) =>
    request<Repo>("POST", "/api/repos/create", body),
  locateRepo: (body: { path: string; name?: string; icon?: string; terminal_id?: string }) =>
    request<Repo>("POST", "/api/repos/locate", body),
  updateRepo: (id: string, body: { name?: string; icon?: string }) => request<Repo>("PATCH", r(id), body),
  removeRepo: (id: string, deleteFiles = false) =>
    request<{ ok: true }>("DELETE", r(id), undefined, { delete_files: deleteFiles }),
  repoTerminal: (id: string) => request<TerminalInfo>("POST", `${r(id)}/terminal`),
  syncRepo: (id: string) =>
    request<{ ok: boolean; steps: { command: string; code: number; error?: string }[]; warnings: string[] }>(
      "POST", `${r(id)}/sync`),
  repoCommand: (id: string, action: string, args: Record<string, unknown> = {}) =>
    request<CommandResult>("POST", `${r(id)}/command`, { action, args }),
  refs: (id: string) => request<Refs>("GET", `${r(id)}/refs`),
  repoTree: (id: string, ref: string | undefined, path: string) =>
    request<RepoTree>("GET", `${r(id)}/tree`, undefined, { ref, path }),
  blob: (id: string, ref: string | undefined, path: string) =>
    request<Blob>("GET", `${r(id)}/blob`, undefined, { ref, path }),
  commits: (id: string, q: { ref?: string; path?: string; author?: string; q?: string; skip?: number; limit?: number; all?: boolean }) =>
    request<{ commits: Commit[]; more: boolean }>("GET", `${r(id)}/commits`, undefined, q),
  commit: (id: string, sha: string) => request<CommitDetail>("GET", `${r(id)}/commits/${sha}`),
  branches: (id: string) =>
    request<{ default: string; current: string; me: string; branches: Branch[] }>("GET", `${r(id)}/branches`),
  repoTags: (id: string) => request<Tag[]>("GET", `${r(id)}/tags`),
  pushes: (id: string) => request<PushEvent[]>("GET", `${r(id)}/pushes`),
  pulls: (id: string, state: string) => request<PullList>("GET", `${r(id)}/pulls`, undefined, { state }),
};

const c = (id: string) => `/api/calendars/${encodeURIComponent(id)}`;

export const accountsApi = {
  connectors: () => request<Connectors>("GET", "/api/connectors"),
  configureProvider: (provider: string, config: Record<string, string>) =>
    request<Connectors>("PUT", `/api/connectors/${provider}/config`, config),
  startOAuth: (provider: string, nickname?: string, loginHint?: string) =>
    request<OAuthFlow>("POST", "/api/accounts/oauth/start", { provider, nickname, login_hint: loginHint }),
  detect: (email: string) => request<DetectedProvider>("POST", "/api/accounts/detect", { email }),
  oauthStatus: (flowId: string) => request<OAuthStatus>("GET", `/api/accounts/oauth/${flowId}`),
  connectApple: (body: { apple_id: string; app_password: string; nickname?: string }) =>
    request<Account>("POST", "/api/accounts/apple", body),
  connectSecret: (body: { provider: string; secret: string; nickname?: string }) =>
    request<Account>("POST", "/api/accounts/secret", body),
  renameAccount: (id: string, nickname: string) => request<Account>("PATCH", `/api/accounts/${id}`, { nickname }),
  removeAccount: (id: string) => request<{ ok: true }>("DELETE", `/api/accounts/${id}`),
  remoteCalendars: (id: string) => request<RemoteCalendar[]>("GET", `/api/accounts/${id}/calendars`),
};

export const calendarApi = {
  list: () => request<Calendar[]>("GET", "/api/calendars"),
  create: (body: { name: string; color?: string; icon?: string }) => request<Calendar>("POST", "/api/calendars", body),
  update: (id: string, body: Partial<Pick<Calendar, "name" | "color" | "icon" | "visible" | "sort_order">>) =>
    request<Calendar>("PATCH", c(id), body),
  remove: (id: string) => request<{ ok: true }>("DELETE", c(id)),
  addSource: (id: string, body: { account_id: string; remote_id: string; remote_name: string; color?: string | null }) =>
    request<CalendarSource>("POST", `${c(id)}/sources`, body),
  updateSource: (id: string, sourceId: string, body: { enabled?: boolean; color?: string | null }) =>
    request<CalendarSource>("PATCH", `${c(id)}/sources/${sourceId}`, body),
  removeSource: (id: string, sourceId: string) => request<{ ok: true }>("DELETE", `${c(id)}/sources/${sourceId}`),
  sync: (id?: string) => request<{ synced: number; errors: string[] }>("POST", id ? `${c(id)}/sync` : "/api/calendars/sync"),
  events: (start: string, end: string, calendars?: string[]) =>
    request<CalEvent[]>("GET", "/api/events", undefined, { start, end, calendars: calendars?.join(",") }),
  createEvent: (calendarId: string, body: EventInput) => request<CalEvent>("POST", `${c(calendarId)}/events`, body),
  updateEvent: (eventId: string, body: Partial<EventInput>) => request<CalEvent>("PATCH", `/api/events/${encodeURIComponent(eventId)}`, body),
  deleteEvent: (eventId: string) => request<{ ok: true }>("DELETE", `/api/events/${encodeURIComponent(eventId)}`),
};

export function terminalSocketUrl(id: string): string {
  const url = new URL(config.baseUrl.replace(/^http/, "ws") + `${t(id)}/ws`);
  if (config.token) url.searchParams.set("token", config.token);
  return url.toString();
}

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
