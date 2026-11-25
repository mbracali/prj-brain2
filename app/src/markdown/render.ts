// Obsidian-flavoured markdown -> sanitized HTML.
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import * as yaml from "js-yaml";
import MarkdownIt, { type MarkdownIt as MD, type StateCore, type StateInline } from "markdown-it";
import { full as emojiPlugin } from "markdown-it-emoji";
import footnote from "markdown-it-footnote";
import { LinkResolver, displayName, parseLinkText } from "../lib/links";

export interface RenderEnv {
  resolver: LinkResolver;
  path: string | null;
  lineOffset: number;
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export const TAG_CHARS = String.raw`[^\s#!@$%^&*(),.?":{}|<>\[\]'\x60~+=;\\]`;
const TAG_AT_RE = new RegExp(String.raw`^#(${TAG_CHARS}+)`);
const MI_RE = /^:mi-([a-z0-9_]+):/;

function wikilinkRule(state: StateInline, silent: boolean): boolean {
  const src = state.src;
  let pos = state.pos;
  const embed = src.charCodeAt(pos) === 0x21; /* ! */
  if (embed) pos++;
  if (src.charCodeAt(pos) !== 0x5b || src.charCodeAt(pos + 1) !== 0x5b) return false;
  const end = src.indexOf("]]", pos + 2);
  if (end < 0) return false;
  const inner = src.slice(pos + 2, end);
  if (!inner || inner.includes("\n") || inner.includes("[[")) return false;
  if (!silent) {
    const token = state.push("wikilink", "", 0);
    token.meta = { inner, embed };
  }
  state.pos = end + 2;
  return true;
}

function tagRule(state: StateInline, silent: boolean): boolean {
  if (state.src.charCodeAt(state.pos) !== 0x23 /* # */) return false;
  const prev = state.pos > 0 ? state.src[state.pos - 1] : " ";
  if (!/\s/.test(prev)) return false;
  const m = TAG_AT_RE.exec(state.src.slice(state.pos));
  if (!m || /^[\d/]+$/.test(m[1])) return false;
  if (!silent) {
    const token = state.push("tag", "", 0);
    token.meta = { tag: m[1].replace(/\/$/, "") };
  }
  state.pos += m[0].length;
  return true;
}

function materialIconRule(state: StateInline, silent: boolean): boolean {
  if (state.src.charCodeAt(state.pos) !== 0x3a /* : */) return false;
  const m = MI_RE.exec(state.src.slice(state.pos));
  if (!m) return false;
  if (!silent) {
    const token = state.push("material_icon", "", 0);
    token.meta = { name: m[1] };
  }
  state.pos += m[0].length;
  return true;
}

/** ==highlight== -> <mark> (inner markdown is still parsed). */
function highlightRule(state: StateInline, silent: boolean): boolean {
  const src = state.src;
  const start = state.pos;
  if (src.charCodeAt(start) !== 0x3d || src.charCodeAt(start + 1) !== 0x3d) return false;
  const end = src.indexOf("==", start + 2);
  if (end < 0 || end === start + 2 || src.slice(start + 2, end).includes("\n")) return false;
  if (!silent) {
    const oldMax = state.posMax;
    state.push("mark_open", "mark", 1);
    state.pos = start + 2;
    state.posMax = end;
    state.md.inline.tokenize(state);
    state.posMax = oldMax;
    state.push("mark_close", "mark", -1);
  }
  state.pos = end + 2;
  return true;
}

/** `- [ ] task` list items -> checkboxes that know their source line. */
function taskListRule(state: StateCore) {
  const tokens = state.tokens;
  for (let i = 2; i < tokens.length; i++) {
    const inline = tokens[i];
    if (inline.type !== "inline" || tokens[i - 1].type !== "paragraph_open" || tokens[i - 2].type !== "list_item_open")
      continue;
    const m = /^\[([ xX\-/])\][ \t]/.exec(inline.content);
    if (!m || !inline.children?.length) continue;
    const first = inline.children[0];
    if (first.type !== "text" || !first.content.startsWith(m[0].trimEnd())) continue;
    first.content = first.content.slice(m[0].length - 1).replace(/^\s/, "");
    const checked = m[1] !== " ";
    const line = (tokens[i - 2].map?.[0] ?? 0) + ((state.env as unknown as RenderEnv).lineOffset ?? 0);
    const box = new state.Token("html_inline", "", 0);
    box.content = `<input type="checkbox" class="task-checkbox" data-task-line="${line}"${checked ? " checked" : ""}>`;
    inline.children.unshift(box);
    tokens[i - 2].attrJoin("class", `task-list-item${checked ? " is-checked" : ""}`);
    tokens[i - 2].attrSet("data-task", m[1]);
  }
}

/** Source line numbers on block elements (scroll-to-line, outline). */
function lineAttrRule(state: StateCore) {
  const offset = (state.env as unknown as RenderEnv).lineOffset ?? 0;
  for (const t of state.tokens) {
    if (t.map && t.nesting === 1) t.attrSet("data-line", String(t.map[0] + offset));
  }
}

function createMd(breaks: boolean): MD {
  const md: MD = new MarkdownIt({
    html: true,
    linkify: true,
    breaks,
    typographer: false,
    highlight(code, lang) {
      if (lang && hljs.getLanguage(lang)) {
        try {
          return `<pre class="hljs"><code class="language-${escapeHtml(lang)}">${
            hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
          }</code></pre>`;
        } catch {
          /* fall through */
        }
      }
      return `<pre class="hljs"><code>${escapeHtml(code)}</code></pre>`;
    },
  });
  md.use(emojiPlugin).use(footnote);
  md.inline.ruler.before("link", "wikilink", wikilinkRule);
  md.inline.ruler.before("emphasis", "tag", tagRule);
  md.inline.ruler.before("emphasis", "material_icon", materialIconRule);
  md.inline.ruler.before("emphasis", "highlight", highlightRule);
  md.core.ruler.after("inline", "task_list", taskListRule);
  md.core.ruler.push("line_attrs", lineAttrRule);

  md.renderer.rules.wikilink = (tokens, idx, _opts, rawEnv) => {
    const env = rawEnv as unknown as RenderEnv;
    const { inner, embed } = tokens[idx].meta as { inner: string; embed: boolean };
    const { target, fragment, alias } = parseLinkText(inner);
    const resolved = target ? env.resolver.resolve(target, env.path) : env.path;
    const attrs =
      `data-href="${escapeHtml(target)}" data-fragment="${escapeHtml(fragment)}"` +
      (resolved ? ` data-resolved="${escapeHtml(resolved)}"` : "");
    if (embed) {
      return `<span class="internal-embed" ${attrs} data-alias="${escapeHtml(alias)}"></span>`;
    }
    const label = alias || (target ? displayName(target) : "") + (fragment ? (target ? " > " : "") + fragment : "");
    return `<a href="#" class="internal-link${resolved ? "" : " is-unresolved"}" ${attrs}>${escapeHtml(label)}</a>`;
  };
  md.renderer.rules.tag = (tokens, idx) => {
    const tag = (tokens[idx].meta as { tag: string }).tag;
    return `<a href="#" class="tag" data-tag="${escapeHtml(tag)}">#${escapeHtml(tag)}</a>`;
  };
  md.renderer.rules.material_icon = (tokens, idx) => {
    const name = (tokens[idx].meta as { name: string }).name;
    return `<span class="material-symbols-outlined mi-inline" aria-hidden="true">${escapeHtml(name)}</span>`;
  };
  const defaultLinkOpen =
    md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const href = String(tokens[idx].attrGet("href") ?? "");
    const renv = env as unknown as RenderEnv;
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
      tokens[idx].attrJoin("class", "external-link");
    } else if (href && !href.startsWith("#")) {
      const target = decodeURIComponent(href.split("#")[0]);
      const resolved = renv.resolver.resolve(target, renv.path);
      tokens[idx].attrJoin("class", `internal-link${resolved ? "" : " is-unresolved"}`);
      tokens[idx].attrSet("data-href", target);
      if (resolved) tokens[idx].attrSet("data-resolved", resolved);
    }
    return defaultLinkOpen(tokens, idx, options, env, self);
  };
  return md;
}

const mdLoose = createMd(true);
const mdStrict = createMd(false);

/** App-wide rendering preferences (set from Settings). */
export const renderDefaults = { strictLineBreaks: false, properties: "visible" as "visible" | "hidden" | "source" };

export const FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

export function splitFrontmatter(src: string): { data: Record<string, unknown> | null; body: string; lines: number } {
  const m = FRONTMATTER_RE.exec(src);
  if (!m) return { data: null, body: src, lines: 0 };
  let data: Record<string, unknown> | null = null;
  try {
    const parsed = yaml.load(m[1]);
    data = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    data = {};
  }
  return { data, body: src.slice(m[0].length), lines: m[0].split("\n").length - 1 };
}

function renderProperties(data: Record<string, unknown>): string {
  const rows = Object.entries(data)
    .map(([k, v]) => {
      let value: string;
      if (Array.isArray(v)) {
        value = v
          .map((x) =>
            k === "tags" || k === "tag"
              ? `<a href="#" class="tag" data-tag="${escapeHtml(String(x).replace(/^#/, ""))}">#${escapeHtml(String(x).replace(/^#/, ""))}</a>`
              : `<span class="pill">${escapeHtml(String(x))}</span>`,
          )
          .join(" ");
      } else if (v instanceof Date) {
        value = escapeHtml(v.toISOString().slice(0, 10));
      } else if (v && typeof v === "object") {
        value = `<code>${escapeHtml(JSON.stringify(v))}</code>`;
      } else {
        value = escapeHtml(String(v ?? ""));
      }
      return `<div class="property"><span class="property-key">${escapeHtml(k)}</span><span class="property-value">${value}</span></div>`;
    })
    .join("");
  return rows ? `<div class="properties"><div class="properties-title">Properties</div>${rows}</div>` : "";
}

export const CALLOUT_COLORS = ["gray", "grey", "blue", "red", "yellow", "gold", "silver", "orange", "purple", "blood", "cyan", "black"];
/**
 * BRAIN2 custom callouts: `> [color, material_icon, Label]` (each part may be wrapped in parentheses,
 * the icon may be empty, and `]+` / `]-` make it foldable like Obsidian callouts).
 */
export const CUSTOM_CALLOUT_RE = new RegExp(
  `^\\[\\s*\\(?\\s*(${CALLOUT_COLORS.join("|")})\\s*\\)?\\s*,\\s*\\(?\\s*([a-z0-9_]*)\\s*\\)?\\s*,\\s*([^\\]\\n]*?)\\s*\\]([+-]?)[ \\t]*([^\\n]*)`,
  "i",
);

function parseCalloutHeader(text: string) {
  const m = /^\[!([\w-]+)\]([+-]?)[ \t]*([^\n]*)/.exec(text);
  if (m) return { type: m[1].toLowerCase(), fold: m[2], title: m[3], color: null as string | null, icon: calloutIcon(m[1].toLowerCase()), matched: m[0] };
  const c = CUSTOM_CALLOUT_RE.exec(text);
  if (!c) return null;
  let label = c[3].trim();
  if (/^\(.*\)$/.test(label)) label = label.slice(1, -1).trim();
  const extra = c[5].trim();
  return {
    type: "custom",
    fold: c[4],
    title: [label, extra].filter(Boolean).join(" "),
    color: c[1].toLowerCase() === "grey" ? "gray" : c[1].toLowerCase(),
    icon: c[2].toLowerCase(),
    matched: c[0],
  };
}

/** Obsidian callouts (`> [!note] Title`) and BRAIN2 custom callouts (`> [blue, rocket_launch, Label]`). */
function transformCallouts(root: HTMLElement) {
  for (const bq of Array.from(root.querySelectorAll("blockquote"))) {
    const first = bq.firstElementChild;
    if (!first || first.tagName !== "P") continue;
    const h = parseCalloutHeader(first.textContent ?? "");
    if (!h) continue;
    const m = [h.matched, h.type, h.fold, h.title];
    const type = h.type;
    const fold = h.fold;
    // Remove the marker text from the first paragraph's first text node.
    const walker = document.createTreeWalker(first, NodeFilter.SHOW_TEXT);
    let titleHtml = escapeHtml(m[3] || (h.color ? "" : type.charAt(0).toUpperCase() + type.slice(1)));
    const firstText = walker.nextNode() as Text | null;
    if (firstText) {
      const nl = firstText.data.indexOf("\n");
      const firstLineIsAll = nl < 0;
      firstText.data = firstLineIsAll ? "" : firstText.data.slice(nl + 1);
      if (firstLineIsAll) {
        // Title may continue with inline markup until the first <br>.
        const parts: string[] = [];
        let n = firstText.nextSibling;
        while (n && n.nodeName !== "BR") {
          const next = n.nextSibling;
          parts.push(n.nodeType === 1 ? (n as Element).outerHTML : escapeHtml(n.textContent ?? ""));
          n.remove();
          n = next;
        }
        if (n?.nodeName === "BR") n.remove();
        if (parts.length) titleHtml = escapeHtml(m[3]) + parts.join("");
      }
    }
    if (!first.textContent?.trim() && !first.querySelector("img,span,a")) first.remove();
    const callout = document.createElement("div");
    callout.className = `callout${fold ? " is-collapsible" : ""}${fold === "-" ? " is-collapsed" : ""}`;
    callout.dataset.callout = type;
    if (h.color) callout.dataset.calloutColor = h.color;
    for (const [k, v] of Object.entries(bq.dataset)) if (v) callout.dataset[k] = v;
    const iconHtml = h.icon ? `<span class="callout-icon material-symbols-outlined">${escapeHtml(h.icon)}</span>` : "";
    callout.innerHTML = `<div class="callout-title">${iconHtml}<span class="callout-title-inner">${titleHtml}</span>${
      fold ? '<span class="callout-fold material-symbols-outlined">expand_more</span>' : ""
    }</div><div class="callout-content"></div>`;
    const content = callout.querySelector(".callout-content")!;
    while (bq.firstChild) content.appendChild(bq.firstChild);
    // Drop whitespace-only text nodes and a leading empty line left behind by the header.
    for (const n of Array.from(content.childNodes)) if (n.nodeType === 3 && !n.textContent?.trim()) n.remove();
    const p0 = content.firstElementChild;
    p0?.normalize();
    if (p0?.tagName === "P" && p0.firstChild?.nodeType === 3) (p0.firstChild as Text).data = (p0.firstChild as Text).data.replace(/^\s+/, "");
    if (!content.childNodes.length) content.remove();
    bq.replaceWith(callout);
  }
}

const CALLOUT_ICONS: Record<string, string> = {
  note: "edit", info: "info", todo: "check_circle", tip: "local_fire_department", hint: "local_fire_department",
  important: "local_fire_department", success: "check", check: "check", done: "check", question: "help",
  help: "help", faq: "help", warning: "warning", caution: "warning", attention: "warning", failure: "close",
  fail: "close", missing: "close", danger: "bolt", error: "bolt", bug: "bug_report", example: "list",
  quote: "format_quote", cite: "format_quote", abstract: "summarize", summary: "summarize", tldr: "summarize",
};
const calloutIcon = (type: string) => CALLOUT_ICONS[type] ?? "edit";

export function renderMarkdown(src: string, env: Omit<RenderEnv, "lineOffset">): { html: string; frontmatter: Record<string, unknown> | null } {
  const { data, body, lines } = splitFrontmatter(src);
  const md = renderDefaults.strictLineBreaks ? mdStrict : mdLoose;
  const raw = md.render(body, { ...env, lineOffset: lines });
  const fmSource = src.slice(0, src.length - body.length).trim();
  const props =
    renderDefaults.properties === "hidden" || !data
      ? ""
      : renderDefaults.properties === "source"
        ? `<pre class="frontmatter-source"><code>${escapeHtml(fmSource)}</code></pre>`
        : Object.keys(data).length
          ? renderProperties(data)
          : "";
  const clean = DOMPurify.sanitize(props + raw, {
    ADD_ATTR: ["target"],
    FORBID_TAGS: ["style", "form"],
    FORBID_ATTR: ["style"],
  });
  const holder = document.createElement("div");
  holder.innerHTML = clean;
  transformCallouts(holder);
  return { html: holder.innerHTML, frontmatter: data };
}
