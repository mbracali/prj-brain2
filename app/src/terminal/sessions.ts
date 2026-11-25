// xterm.js sessions, one per backend terminal. They live outside React so the
// scrollback and connection survive panel unmounts (switching modules).
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { terminalSocketUrl } from "../lib/api";
import { bridge } from "../lib/bridge";

function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

export function terminalTheme() {
  // The terminal is always dark (very dark gray), whatever the app theme.
  return {
    background: cssVar("--terminal-bg", "#161616"),
    foreground: "#d4d4d4",
    cursor: cssVar("--accent", "#1a9cf0"),
    cursorAccent: "#161616",
    selectionBackground: "rgba(120,160,255,0.35)",
  };
}

function fontFamily() {
  const mono = cssVar("--font-mono", "");
  return `${mono ? `${mono}, ` : ""}"MesloLGS NF", "JetBrainsMono Nerd Font", "Hack Nerd Font", Menlo, Consolas, monospace`;
}

export class Session {
  readonly term: Terminal;
  readonly fit = new FitAddon();
  readonly host: HTMLDivElement;
  private ws: WebSocket | null = null;
  private disposed = false;
  private retry = 500;
  onExit?: () => void;

  constructor(readonly id: string) {
    this.term = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      fontSize: 13,
      lineHeight: 1.15,
      scrollback: 8000,
      fontFamily: fontFamily(),
      theme: terminalTheme(),
      macOptionIsMeta: true,
    });
    this.term.loadAddon(this.fit);
    this.term.loadAddon(new WebLinksAddon((_e, url) => bridge.openExternal(url)));
    this.host = document.createElement("div");
    this.host.className = "xterm-host";
    this.term.open(this.host);
    this.term.onData((data) => this.send({ type: "input", data }));
    this.term.onBinary((data) => this.send({ type: "input", data }));
    this.term.onResize(({ cols, rows }) => this.send({ type: "resize", cols, rows }));
    this.connect();
  }

  private connect() {
    if (this.disposed) return;
    const ws = new WebSocket(terminalSocketUrl(this.id));
    ws.binaryType = "arraybuffer";
    let first = true;
    ws.onopen = () => {
      this.retry = 500;
      this.send({ type: "resize", cols: this.term.cols, rows: this.term.rows });
    };
    ws.onmessage = (m) => {
      if (first) {
        // The backend replays its scrollback on (re)connect.
        first = false;
        this.term.reset();
      }
      this.term.write(typeof m.data === "string" ? m.data : new Uint8Array(m.data as ArrayBuffer));
    };
    ws.onclose = (e) => {
      this.ws = null;
      if (e.code === 4404) {
        this.onExit?.();
        return;
      }
      if (!this.disposed) setTimeout(() => this.connect(), (this.retry = Math.min(this.retry * 2, 8000)));
    };
    this.ws = ws;
  }

  private send(msg: Record<string, unknown>) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  attach(container: HTMLElement) {
    if (this.host.parentElement !== container) container.appendChild(this.host);
    this.fitNow();
  }

  fitNow() {
    if (!this.host.isConnected || this.host.clientWidth === 0) return;
    try {
      this.fit.fit();
    } catch {
      /* not visible yet */
    }
  }

  restyle() {
    this.term.options.theme = terminalTheme();
    this.term.options.fontFamily = fontFamily();
    this.fitNow();
  }

  dispose() {
    this.disposed = true;
    this.ws?.close();
    this.term.dispose();
    this.host.remove();
  }
}

const sessions = new Map<string, Session>();

export function getSession(id: string): Session {
  let s = sessions.get(id);
  if (!s) {
    s = new Session(id);
    sessions.set(id, s);
  }
  return s;
}

export function dropSession(id: string) {
  sessions.get(id)?.dispose();
  sessions.delete(id);
}

export function pruneSessions(alive: Set<string>) {
  for (const id of [...sessions.keys()]) if (!alive.has(id)) dropSession(id);
}

export function restyleSessions() {
  sessions.forEach((s) => s.restyle());
}
