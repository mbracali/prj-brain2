export type FileKind = "markdown" | "pdf" | "text" | "json" | "yaml" | "excalidraw" | "image" | "media" | "other";

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
  nodes: { id: string; label: string; kind: string; tags?: string[] }[];
  edges: { source: string; target: string; weight: number }[];
}

export type ViewMode = "live" | "source" | "reading";

export type BaseSkin = "typewriter" | "primary" | "blue-topaz";

/** A user-made theme: a base skin plus colour/font overrides. Exported/imported as JSON. */
export interface CustomTheme {
  id: string;
  name: string;
  base: BaseSkin;
  light: Record<string, string>; // CSS token (without --) -> colour
  dark: Record<string, string>;
  fonts?: { interface?: string; text?: string; mono?: string };
}

export interface Settings {
  skin: BaseSkin | `custom:${string}`;
  customThemes: CustomTheme[];
  colorScheme: "system" | "light" | "dark";
  accentColor: string; // "" = skin default
  interfaceFont: string; // "" = skin default
  textFont: string;
  monoFont: string;
  fontSize: number;
  ctrlScrollZoom: boolean;
  readableLineLength: boolean;
  defaultViewMode: ViewMode;
  showLineNumbers: boolean;
  highlightActiveLine: boolean;
  showInlineTitle: boolean;
  /** Floating bar with formatting buttons above markdown notes. */
  showFormatBar: boolean;
  /** Width of the left pane in split view (0.2–0.8). */
  splitRatio: number;
  propertiesInDocument: "visible" | "hidden" | "source";
  strictLineBreaks: boolean;
  vimMode: boolean;
  foldHeadings: boolean;
  spellcheck: boolean;
  leftWidth: number;
  rightWidth: number;
  newNoteLocation: "root" | "current";
  attachmentFolder: string;
  dailyNotesFolder: string;
  confirmDelete: boolean;
  updateLinksOnMove: boolean;
  autosaveDelay: number;
  /** Last folder used to clone / create repositories. */
  reposFolder: string;
}

export const DEFAULT_SETTINGS: Settings = {
  skin: "typewriter",
  customThemes: [],
  colorScheme: "system",
  accentColor: "",
  interfaceFont: "",
  textFont: "",
  monoFont: "",
  fontSize: 16,
  ctrlScrollZoom: true,
  readableLineLength: false,
  defaultViewMode: "live",
  showLineNumbers: false,
  highlightActiveLine: false,
  showInlineTitle: true,
  showFormatBar: true,
  splitRatio: 0.5,
  propertiesInDocument: "visible",
  strictLineBreaks: false,
  vimMode: false,
  foldHeadings: true,
  spellcheck: true,
  leftWidth: 268,
  rightWidth: 280,
  newNoteLocation: "current",
  attachmentFolder: "attachments",
  dailyNotesFolder: "Daily",
  confirmDelete: true,
  updateLinksOnMove: true,
  autosaveDelay: 600,
  reposFolder: "",
};

export interface BrainEvent {
  type:
    | "vaults.changed" | "vault.changed" | "vault.icons" | "settings.changed"
    | "terminals.changed" | "terminal.job" | "repos.changed" | "repo.changed" | "vault.sync"
    | "accounts.changed" | "calendars.changed" | "events.changed";
  vault_id?: string;
  repo_id?: string;
  terminal_id?: string;
  job_id?: string;
  code?: number;
  paths?: string[];
  origin?: "api" | "fs" | "sync";
  moved?: { from: string; to: string };
}
