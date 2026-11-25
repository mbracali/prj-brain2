// Applies user appearance settings (fonts, accent colour, sizes) on top of the active skin.
import type { BaseSkin, CustomTheme, Settings } from "./types";

export const BUNDLED_FONTS = ["Inter", "IBM Plex Mono", "Source Serif 4"];
export const COMMON_FONTS = [
  "system-ui", "Helvetica Neue", "Arial", "Segoe UI", "Roboto", "Georgia", "Times New Roman",
  "Palatino", "Charter", "Iowan Old Style", "Menlo", "Monaco", "SF Mono", "Consolas", "Courier New",
  "JetBrains Mono", "Fira Code", "Cascadia Code",
];

function fontStack(name: string, fallback: string): string {
  const families = name
    .split(",")
    .map((f) => f.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean)
    .map((f) => (/^[\w-]+$/.test(f) && !/\s/.test(f) ? f : `"${f.replace(/"/g, "")}"`));
  return [...families, fallback].join(", ");
}

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Colour tokens a custom theme can override, with a human label. */
export const THEME_TOKENS: { key: string; label: string }[] = [
  { key: "bg-primary", label: "Background" },
  { key: "bg-secondary", label: "Sidebar background" },
  { key: "bg-tertiary", label: "Raised surfaces" },
  { key: "border", label: "Borders" },
  { key: "text-normal", label: "Text" },
  { key: "text-muted", label: "Muted text" },
  { key: "text-faint", label: "Faint text" },
  { key: "accent", label: "Accent" },
  { key: "text-link", label: "Links" },
  { key: "code-bg", label: "Code background" },
  { key: "h1-color", label: "Heading 1" },
  { key: "h2-color", label: "Heading 2" },
  { key: "h3-color", label: "Heading 3" },
  { key: "h4-color", label: "Heading 4" },
];

type Palette = Record<string, string>;
/** Mirrors the hex tokens in styles/skins.css; used as starting values for custom themes. */
export const BASE_PALETTES: Record<BaseSkin, { light: Palette; dark: Palette }> = {
  typewriter: {
    light: { "bg-primary": "#fbfaf7", "bg-secondary": "#f2f0ea", "bg-tertiary": "#e9e6de", border: "#e2ded4", "text-normal": "#2a2925", "text-muted": "#6d6a62", "text-faint": "#a19d93", accent: "#1a9cf0", "text-link": "#1a7fc4", "code-bg": "#f0ede5", "h1-color": "#1d1c19", "h2-color": "#1d1c19", "h3-color": "#1d1c19", "h4-color": "#1d1c19" },
    dark: { "bg-primary": "#1c1c1b", "bg-secondary": "#161615", "bg-tertiary": "#262624", border: "#2c2c2a", "text-normal": "#d9d6cf", "text-muted": "#9a968d", "text-faint": "#66635d", accent: "#2fb2ff", "text-link": "#5cc0ff", "code-bg": "#242422", "h1-color": "#ecebe6", "h2-color": "#ecebe6", "h3-color": "#ecebe6", "h4-color": "#ecebe6" },
  },
  primary: {
    light: { "bg-primary": "#ffffff", "bg-secondary": "#f6f5fb", "bg-tertiary": "#ecebf6", border: "#e6e4f2", "text-normal": "#2c2a3a", "text-muted": "#6b6884", "text-faint": "#a3a0b8", accent: "#7158e2", "text-link": "#6a50e0", "code-bg": "#f4f3fa", "h1-color": "#2c2a3a", "h2-color": "#6a50e0", "h3-color": "#c0478f", "h4-color": "#2b8a9e" },
    dark: { "bg-primary": "#1e1d29", "bg-secondary": "#181722", "bg-tertiary": "#272636", border: "#2d2b3c", "text-normal": "#e3e1f0", "text-muted": "#a19eb8", "text-faint": "#6b6884", accent: "#a594ff", "text-link": "#b3a5ff", "code-bg": "#262534", "h1-color": "#f1effa", "h2-color": "#b3a5ff", "h3-color": "#f28cc4", "h4-color": "#6fd0e2" },
  },
  "blue-topaz": {
    light: { "bg-primary": "#fafcff", "bg-secondary": "#edf3fb", "bg-tertiary": "#dfe9f6", border: "#d9e4f2", "text-normal": "#1f2a3a", "text-muted": "#5b6b82", "text-faint": "#94a3b8", accent: "#2f7ae5", "text-link": "#2f7ae5", "code-bg": "#eef3fa", "h1-color": "#1d5fbf", "h2-color": "#d9534f", "h3-color": "#2e9d6a", "h4-color": "#8e5bd6" },
    dark: { "bg-primary": "#1a202b", "bg-secondary": "#141922", "bg-tertiary": "#222a37", border: "#273142", "text-normal": "#dbe4f0", "text-muted": "#94a3b8", "text-faint": "#5f6d82", accent: "#5aa9ff", "text-link": "#6cb4ff", "code-bg": "#212836", "h1-color": "#6cb4ff", "h2-color": "#ff7b72", "h3-color": "#56d39a", "h4-color": "#c39bff" },
  },
};

export const BASE_SKINS: BaseSkin[] = ["typewriter", "primary", "blue-topaz"];

export function newCustomTheme(base: BaseSkin, name: string): CustomTheme {
  return {
    id: Math.random().toString(36).slice(2, 10),
    name,
    base,
    light: { ...BASE_PALETTES[base].light },
    dark: { ...BASE_PALETTES[base].dark },
    fonts: {},
  };
}

export function activeCustomTheme(s: Settings): CustomTheme | null {
  if (!s.skin.startsWith("custom:")) return null;
  const id = s.skin.slice("custom:".length);
  return (s.customThemes ?? []).find((t) => t.id === id) ?? null;
}

/** Validates/normalises an imported theme JSON. Throws on invalid input. */
export function parseThemeJson(text: string): CustomTheme {
  const raw = JSON.parse(text) as Partial<CustomTheme> & { brain2Theme?: number };
  if (!raw || typeof raw !== "object") throw new Error("Not a theme file");
  const base = BASE_SKINS.includes(raw.base as BaseSkin) ? (raw.base as BaseSkin) : "typewriter";
  const clean = (p: unknown, fallback: Palette): Palette => {
    const out: Palette = { ...fallback };
    if (p && typeof p === "object")
      for (const [k, v] of Object.entries(p)) if (THEME_TOKENS.some((t) => t.key === k) && typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v)) out[k] = v;
    return out;
  };
  if (!raw.light && !raw.dark) throw new Error("Theme file has no colors");
  const fonts = raw.fonts && typeof raw.fonts === "object" ? raw.fonts : {};
  return {
    id: Math.random().toString(36).slice(2, 10),
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 60) : "Imported theme",
    base,
    light: clean(raw.light, BASE_PALETTES[base].light),
    dark: clean(raw.dark, BASE_PALETTES[base].dark),
    fonts: {
      interface: typeof fonts.interface === "string" ? fonts.interface : undefined,
      text: typeof fonts.text === "string" ? fonts.text : undefined,
      mono: typeof fonts.mono === "string" ? fonts.mono : undefined,
    },
  };
}

export function themeToJson(t: CustomTheme): string {
  return JSON.stringify({ brain2Theme: 1, name: t.name, base: t.base, light: t.light, dark: t.dark, fonts: t.fonts ?? {} }, null, 2);
}

const ACCENT_PROPS = ["--accent", "--accent-hover", "--accent-soft", "--selection", "--text-link", "--tag-text", "--tag-bg"];
const PROPS = [
  "--font-interface", "--font-text", "--font-mono", ...ACCENT_PROPS, "--left-width", "--right-width",
  ...THEME_TOKENS.map((t) => `--${t.key}`), "--heading-color", "--bg-hover", "--bg-active",
];

function applyAccent(root: HTMLElement, hex: string, dark: boolean) {
  const rgb = hexToRgb(hex);
  if (rgb) {
    const [r, g, b] = rgb;
    const shade = (k: number) => `rgb(${Math.round(r * k)}, ${Math.round(g * k)}, ${Math.round(b * k)})`;
    root.style.setProperty("--accent", `rgb(${r}, ${g}, ${b})`);
    root.style.setProperty("--accent-hover", dark ? `rgb(${Math.min(255, r + 25)}, ${Math.min(255, g + 25)}, ${Math.min(255, b + 25)})` : shade(0.88));
    root.style.setProperty("--accent-soft", `rgba(${r}, ${g}, ${b}, 0.14)`);
    root.style.setProperty("--selection", `rgba(${r}, ${g}, ${b}, 0.25)`);
    root.style.setProperty("--text-link", `rgb(${r}, ${g}, ${b})`);
    root.style.setProperty("--tag-text", `rgb(${r}, ${g}, ${b})`);
    root.style.setProperty("--tag-bg", `rgba(${r}, ${g}, ${b}, 0.13)`);
  }
}

export function applyAppearance(s: Settings, dark: boolean) {
  const root = document.documentElement;
  for (const p of PROPS) root.style.removeProperty(p);
  const custom = activeCustomTheme(s);
  root.dataset.skin = custom ? custom.base : s.skin.startsWith("custom:") ? "typewriter" : s.skin;
  root.dataset.customTheme = custom ? custom.id : "";
  root.dataset.theme = dark ? "dark" : "light";
  root.style.setProperty("--font-text-size", `${s.fontSize}px`);
  root.style.setProperty("--left-width", `${s.leftWidth}px`);
  root.style.setProperty("--right-width", `${s.rightWidth}px`);
  if (custom) {
    const pal = dark ? custom.dark : custom.light;
    const basePal = BASE_PALETTES[custom.base][dark ? "dark" : "light"];
    for (const { key } of THEME_TOKENS) {
      const v = pal[key];
      if (v && v.toLowerCase() !== basePal[key]?.toLowerCase()) root.style.setProperty(`--${key}`, v);
    }
    const tr = hexToRgb(pal["text-normal"] ?? "");
    if (tr && pal["text-normal"] !== basePal["text-normal"]) {
      root.style.setProperty("--bg-hover", `rgba(${tr.join(", ")}, 0.06)`);
      root.style.setProperty("--bg-active", `rgba(${tr.join(", ")}, 0.1)`);
    }
    if (pal.accent && pal.accent.toLowerCase() !== basePal.accent?.toLowerCase()) {
      applyAccent(root, pal.accent, dark);
      if (pal["text-link"]) root.style.setProperty("--text-link", pal["text-link"]);
    }
    const f = custom.fonts ?? {};
    if (f.interface?.trim()) root.style.setProperty("--font-interface", fontStack(f.interface, "system-ui, sans-serif"));
    if (f.text?.trim()) root.style.setProperty("--font-text", fontStack(f.text, "system-ui, sans-serif"));
    if (f.mono?.trim()) root.style.setProperty("--font-mono", fontStack(f.mono, "ui-monospace, monospace"));
  }
  if (s.interfaceFont.trim()) root.style.setProperty("--font-interface", fontStack(s.interfaceFont, "system-ui, sans-serif"));
  if (s.textFont.trim()) root.style.setProperty("--font-text", fontStack(s.textFont, "system-ui, sans-serif"));
  if (s.monoFont.trim()) root.style.setProperty("--font-mono", fontStack(s.monoFont, "ui-monospace, monospace"));
  if (s.accentColor) applyAccent(root, s.accentColor, dark);
}

/** Installed fonts via the Local Font Access API (Chromium/Electron), when permitted. */
export async function localFonts(): Promise<string[]> {
  const q = (window as unknown as { queryLocalFonts?: () => Promise<{ family: string }[]> }).queryLocalFonts;
  if (!q) return [];
  try {
    const fonts = await q();
    return [...new Set(fonts.map((f) => f.family))].sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}
