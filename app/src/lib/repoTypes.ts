// Types for the repos module, terminals and vault git sync.

export interface TerminalInfo {
  id: string;
  title: string;
  cwd: string;
  key: string | null;
  shell: string;
  flavor: string;
  alive: boolean;
  created_at: number;
}

export type RepoState = "missing" | "not-a-repo" | "local" | "synced" | "ahead" | "behind" | "diverged" | "changes";

export interface Repo {
  id: string;
  name: string;
  path: string;
  icon: string | null;
  sort_order: number;
  exists: boolean;
  is_git: boolean;
  branch: string | null;
  upstream: string | null;
  remote: string | null;
  web_url: string | null;
  provider: "github" | "gitlab" | "azure" | "bitbucket" | "git" | null;
  ahead: number;
  behind: number;
  changes: number;
  state: RepoState;
}

export interface RepoInspect {
  ok: boolean;
  error?: string;
  path?: string;
  name?: string;
  remote?: string | null;
  branch?: string | null;
  kind?: "remote" | "local";
  registered?: { id: string; name: string } | null;
}

export interface TreeEntry {
  name: string;
  path: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size: number | null;
  last?: { sha: string; subject: string; author: string; date: string } | null;
}

export interface RepoTree {
  ref: string;
  path: string;
  entries: TreeEntry[];
  readme?: string | null;
  empty?: boolean;
}

export interface Blob {
  path: string;
  ref: string;
  size: number;
  binary: boolean;
  truncated: boolean;
  content: string | null;
}

export interface Commit {
  sha: string;
  parents: string[];
  author: string;
  email: string;
  date: string;
  committer: string;
  committed: string;
  subject: string;
  refs: string[];
}

export interface CommitDetail extends Omit<Commit, "subject" | "refs"> {
  message: string;
  files: { path: string; added: number | null; deleted: number | null }[];
  patch: string;
}

export interface Branch {
  name: string;
  remote: boolean;
  sha: string;
  author: string;
  date: string;
  subject: string;
  upstream: string | null;
  track: string | null;
  current: boolean;
  default: boolean;
  mine: boolean;
  ahead: number;
  behind: number;
}

export interface Tag {
  name: string;
  annotated: boolean;
  commit: string;
  tagger: string;
  date: string;
  message: string;
}

export interface PushEvent {
  ref: string;
  sha: string;
  previous: string | null;
  kind: "push" | "fetch" | "update";
  message: string;
  date: string;
  by: string;
  commits: { sha: string; subject: string; author: string }[];
  forced: boolean;
}

export interface PullRequest {
  number: number;
  title: string;
  author: { login: string; name?: string };
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  createdAt: string;
  updatedAt: string;
  url: string;
  reviewDecision: string;
  labels: { name: string; color: string }[];
}

export interface PullList {
  supported: boolean;
  provider: string | null;
  web_url: string | null;
  reason?: string;
  error?: string;
  me?: string;
  items: PullRequest[];
}

export interface Refs {
  current: string;
  default: string;
  local: string[];
  remote: string[];
  tags: string[];
}

export interface CommandResult {
  code: number;
  output: string;
  error?: string;
  terminal_id: string;
}

export interface VaultGitStatus {
  url: string | null;
  is_repo: boolean;
  state: "idle" | "conflicts";
  conflicts: Conflict[];
  branch: string | null;
  changes: number;
  last_sync: string | null;
}

export interface Conflict {
  path: string;
  code: string;
  mine_deleted: boolean;
  theirs_deleted: boolean;
}

export interface SyncResult {
  state: "synced" | "conflicts" | "idle";
  conflicts?: Conflict[];
  pushed?: boolean;
  terminal_id: string;
}
