// Types for account connectors and calendars.

export type ProviderKind = "account" | "llm" | "chat";

export interface ProviderInfo {
  id: string; // google | microsoft | apple | openai | anthropic | deepseek | claude-code | codex | slack
  kind: ProviderKind;
  name: string;
  icon: string; // material symbol
  /** How an account is connected. */
  connect: "oauth" | "password" | "apikey" | "cli" | "token";
  /** OAuth providers need a client id (bring-your-own app registration) before connecting. */
  needs_setup: boolean;
  configured: boolean;
  config: Record<string, string>; // non-secret config (client_id, tenant…)
  usable: boolean; // false = "not used by BRAIN2 yet"
  detected?: string | null; // CLI providers: path of the detected executable
  help: string;
  /** This build ships its own sign-in client for the provider (no setup needed). */
  builtin?: boolean;
  /** The user entered their own app credentials (they win over the built-in client). */
  own_app?: boolean;
}

export interface DetectedProvider {
  provider: "google" | "microsoft" | "apple" | null;
  custom_domain: boolean;
  email: string;
  /** BRAIN2 can sign in to this provider right away. */
  ready?: boolean;
}

export interface Account {
  id: string;
  provider: string;
  kind: ProviderKind;
  nickname: string;
  email: string | null;
  status: "ok" | "error";
  error: string | null;
  created_at: string;
}

export interface Connectors {
  providers: ProviderInfo[];
  accounts: Account[];
  keychain: string; // where secrets live, e.g. "macOS Keychain"
}

export interface OAuthFlow {
  flow_id: string;
  auth_url: string;
}

export interface OAuthStatus {
  state: "pending" | "done" | "error";
  account?: Account;
  error?: string;
  /** e.g. "You signed in as X, not Y". */
  note?: string;
}

export interface RemoteCalendar {
  id: string;
  name: string;
  color: string | null;
  primary: boolean;
  read_only: boolean;
}

export interface CalendarSource {
  id: string;
  calendar_id: string;
  account_id: string;
  provider: string;
  account_label: string;
  remote_id: string;
  remote_name: string;
  color: string | null;
  enabled: boolean;
  last_sync: string | null;
  error: string | null;
}

export interface Calendar {
  id: string;
  name: string;
  color: string; // hex
  icon: string | null;
  visible: boolean;
  sort_order: number;
  sources: CalendarSource[];
  last_sync: string | null;
}

export interface CalEvent {
  id: string;
  calendar_id: string;
  source_id: string | null; // null = local BRAIN2 event
  title: string;
  start: string; // ISO datetime (with offset) or YYYY-MM-DD when all_day
  end: string; // exclusive end
  all_day: boolean;
  location: string | null;
  description: string | null;
  url: string | null;
  color: string; // resolved display color
  editable: boolean;
  provider: string | null;
}

export interface EventInput {
  title: string;
  start: string;
  end: string;
  all_day: boolean;
  location?: string | null;
  description?: string | null;
}
