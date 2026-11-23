export type FileKind = "markdown" | "pdf" | "text" | "json" | "yaml" | "image" | "media" | "other";

export interface Vault {
  id: string;
  name: string;
  path: string;
  icon: string | null;
  internal: boolean;
  connections: Record<string, string[]>;
  sort_order: number;
  created_at: string;
  updated_at: string;
  file_count: number;
  note_count: number;
  exists: boolean;
}

export interface TreeFolder {
  type: "folder";
  path: string;
  name: string;
  children: TreeNode[];
}

export interface TreeFile {
  type: "file";
  path: string;
  name: string;
  kind: FileKind;
  ext: string;
  size: number;
  mtime: number;
  title: string | null;
}

export type TreeNode = TreeFolder | TreeFile;

export interface FileEntry {
  path: string;
  name: string;
  kind: FileKind;
  ext: string;
  title: string | null;
  description: string | null;
  size: number;
  mtime: number;
}

export interface FileInfo extends FileEntry {
  folder: string;
  frontmatter: Record<string, unknown>;
  tags: string[];
  content?: string;
}

export interface SearchHit {
  path: string;
  name: string;
  kind: FileKind;
  title: string | null;
  snippet: string | null;
}

export interface Backlink {
  path: string;
  kind: string;
  line: number;
  context: string;
}

export interface OutLink {
  target: string;
  kind: string;
  line: number;
  resolved: string | null;
}

export interface Heading {
  level: number;
  text: string;
  line: number;
}

export interface GraphData {
  nodes: { id: string; label: string; kind: string }[];
  edges: { source: string; target: string; weight: number }[];
}

export type ViewMode = "live" | "source" | "reading";

export interface Settings {
  skin: "typewriter" | "primary" | "blue-topaz";
  colorScheme: "system" | "light" | "dark";
  fontSize: number;
  readableLineLength: boolean;
  defaultViewMode: ViewMode;
  showLineNumbers: boolean;
  spellcheck: boolean;
  newNoteLocation: "root" | "current";
  attachmentFolder: string;
  dailyNotesFolder: string;
  confirmDelete: boolean;
  updateLinksOnMove: boolean;
  autosaveDelay: number;
}

export const DEFAULT_SETTINGS: Settings = {
  skin: "typewriter",
  colorScheme: "system",
  fontSize: 16,
  readableLineLength: true,
  defaultViewMode: "live",
  showLineNumbers: false,
  spellcheck: true,
  newNoteLocation: "current",
  attachmentFolder: "attachments",
  dailyNotesFolder: "Daily",
  confirmDelete: true,
  updateLinksOnMove: true,
  autosaveDelay: 600,
};

export interface BrainEvent {
  type: "vaults.changed" | "vault.changed" | "settings.changed";
  vault_id?: string;
  paths?: string[];
  origin?: "api" | "fs";
  moved?: { from: string; to: string };
}
