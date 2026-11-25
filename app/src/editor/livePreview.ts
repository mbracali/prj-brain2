// "Live preview" for CodeMirror 6: renders markdown inline and reveals the raw
// syntax only on the lines the cursor is on — the way Obsidian's editor works.
import { redo, undo } from "@codemirror/commands";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { type EditorState, type Range, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import emojiData from "markdown-it-emoji/lib/data/full.mjs";
import { IMAGE_EXTS, type LinkResolver, displayName, extOf, parseLinkText } from "../lib/links";
import { CUSTOM_CALLOUT_RE, TAG_CHARS } from "../markdown/render";
import { type TableModel, addColumn, addRow, cleanCell, parseTable, serializeTable } from "./table";

export interface LivePreviewOptions {
  resolver: () => LinkResolver;
  path: () => string;
  imageUrl: (vaultPath: string) => string;
  openLink: (target: string, newTab: boolean) => void;
  openTag: (tag: string) => void;
  openExternal: (url: string) => void;
  /** Markdown -> sanitized HTML for block widgets. */
  render: (markdown: string) => string;
  propertiesMode: () => "visible" | "hidden" | "source";
  drawingSvg: (vaultPath: string) => Promise<Element>;
}

/** Dispatch this to force decorations to be rebuilt (e.g. file list changed). */
export const refreshLivePreview = StateEffect.define<null>();

// ------------------------------------------------------------------ widgets
class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean, readonly pos: number) {
    super();
  }
  eq(other: CheckboxWidget) {
    return other.checked === this.checked && other.pos === this.pos;
  }
  toDOM(view: EditorView) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "task-checkbox cm-task-checkbox";
    box.checked = this.checked;
    box.addEventListener("mousedown", (e) => {
      e.preventDefault();
      view.dispatch({ changes: { from: this.pos + 1, to: this.pos + 2, insert: this.checked ? " " : "x" } });
    });
    return box;
  }
  ignoreEvent() {
    return false;
  }
}

class BulletWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-bullet";
    s.textContent = "•";
    return s;
  }
}

class TextWidget extends WidgetType {
  constructor(readonly text: string, readonly cls: string) {
    super();
  }
  eq(o: TextWidget) {
    return o.text === this.text && o.cls === this.cls;
  }
  toDOM() {
    const s = document.createElement("span");
    s.className = this.cls;
    s.textContent = this.text;
    return s;
  }
}

class LinkWidget extends WidgetType {
  constructor(readonly text: string, readonly cls: string, readonly target: string) {
    super();
  }
  eq(o: LinkWidget) {
    return o.text === this.text && o.cls === this.cls && o.target === this.target;
  }
  toDOM() {
    const s = document.createElement("span");
    s.className = this.cls;
    s.textContent = this.text;
    s.dataset.target = this.target;
    return s;
  }
  ignoreEvent() {
    return false;
  }
}

class ImageWidget extends WidgetType {
  constructor(readonly src: string, readonly alt: string, readonly width: string) {
    super();
  }
  eq(o: ImageWidget) {
    return o.src === this.src && o.width === this.width;
  }
  toDOM() {
    const img = document.createElement("img");
    img.src = this.src;
    img.alt = this.alt;
    img.className = "cm-embed-image";
    if (this.width) img.style.width = `${this.width}px`;
    return img;
  }
}

class DrawingWidget extends WidgetType {
  constructor(readonly path: string, readonly opts: LivePreviewOptions) {
    super();
  }
  eq(o: DrawingWidget) {
    return o.path === this.path;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-drawing-embed";
    el.textContent = "Loading drawing…";
    this.opts
      .drawingSvg(this.path)
      .then((svg) => el.replaceChildren(svg))
      .catch(() => (el.textContent = `Could not render ${this.path}`));
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      this.opts.openLink(this.path, e.metaKey || e.ctrlKey);
    });
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

class HrWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const hr = document.createElement("span");
    hr.className = "cm-hr-widget";
    return hr;
  }
}

const hide = Decoration.replace({});
const WIKI_RE = /(!?)\[\[([^\[\]\n]+?)\]\]/g;
const TAG_RE = new RegExp(String.raw`(^|\s)#(${TAG_CHARS}+)`, "g");
const MI_RE = /:mi-([a-z0-9_]+):/g;
const EMOJI_RE = /:([a-z0-9_+-]+):/g;
const HIGHLIGHT_RE = /==([^=\n]+)==/g;

function activeLines(state: EditorState, focused: boolean): Set<number> {
  const set = new Set<number>();
  if (!focused) return set;
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    const b = state.doc.lineAt(r.to).number;
    for (let l = a; l <= b; l++) set.add(l);
  }
  return set;
}

function build(view: EditorView, opts: LivePreviewOptions): DecorationSet {
  const { state } = view;
  const doc = state.doc;
  const active = activeLines(state, view.hasFocus);
  const lineActive = (pos: number) => active.has(doc.lineAt(pos).number);
  const rangeActive = (from: number, to: number) => {
    const a = doc.lineAt(from).number;
    const b = doc.lineAt(to).number;
    for (let l = a; l <= b; l++) if (active.has(l)) return true;
    return false;
  };
  const decos: Range<Decoration>[] = [];
  const code: [number, number][] = [];
  const lineClass = (pos: number, cls: string) => decos.push(Decoration.line({ class: cls }).range(doc.lineAt(pos).from));
  const tree = syntaxTree(state);

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name;
        const parent = node.node.parent;
        const heading = /^ATXHeading(\d)$/.exec(name);
        if (heading) {
          lineClass(node.from, `cm-heading cm-h${heading[1]}`);
          return;
        }
        switch (name) {
          case "HeaderMark": {
            if (parent && /^ATXHeading/.test(parent.name) && !lineActive(node.from)) {
              const next = doc.sliceString(node.to, node.to + 1);
              decos.push(hide.range(node.from, next === " " ? node.to + 1 : node.to));
            }
            break;
          }
          case "Emphasis":
            decos.push(Decoration.mark({ class: "cm-em" }).range(node.from, node.to));
            break;
          case "StrongEmphasis":
            decos.push(Decoration.mark({ class: "cm-strong" }).range(node.from, node.to));
            break;
          case "Strikethrough":
            decos.push(Decoration.mark({ class: "cm-strike" }).range(node.from, node.to));
            break;
          case "EmphasisMark":
          case "StrikethroughMark":
            if (parent && !rangeActive(parent.from, parent.to)) decos.push(hide.range(node.from, node.to));
            break;
          case "InlineCode":
            code.push([node.from, node.to]);
            decos.push(Decoration.mark({ class: "cm-inline-code" }).range(node.from, node.to));
            break;
          case "CodeMark":
            if (parent?.name === "InlineCode" && !rangeActive(parent.from, parent.to))
              decos.push(hide.range(node.from, node.to));
            break;
          case "FencedCode":
          case "CodeBlock": {
            code.push([node.from, node.to]);
            const first = doc.lineAt(node.from).number;
            const last = doc.lineAt(node.to).number;
            const fenced = name === "FencedCode";
            const editing = rangeActive(node.from, node.to);
            const closed = fenced && last > first && /^\s*(`{3,}|~{3,})\s*$/.test(doc.line(last).text);
            for (let l = first; l <= last; l++) {
              const fence = fenced && !editing && (l === first || (l === last && closed));
              const cls = `cm-codeblock${l === first ? " cm-codeblock-begin" : ""}${l === last ? " cm-codeblock-end" : ""}${fence ? " cm-fence-hidden" : ""}`;
              lineClass(doc.line(l).from, cls);
            }
            if (fenced && !editing) {
              // Hide the ``` fences (Obsidian style); show the language as a small label.
              const open = doc.line(first);
              const lang = open.text.replace(/^\s*(`{3,}|~{3,})/, "").trim();
              if (open.length) decos.push(Decoration.replace({ widget: new TextWidget(lang, "cm-code-lang") }).range(open.from, open.to));
              const close = doc.line(last);
              if (closed && close.length) decos.push(hide.range(close.from, close.to));
            }
            return false;
          }
          case "Blockquote": {
            const first = doc.lineAt(node.from).number;
            const last = doc.lineAt(node.to).number;
            for (let l = first; l <= last; l++) lineClass(doc.line(l).from, "cm-blockquote");
            break;
          }
          case "QuoteMark":
            if (!lineActive(node.from)) {
              const next = doc.sliceString(node.to, node.to + 1);
              decos.push(hide.range(node.from, next === " " ? node.to + 1 : node.to));
            }
            break;
          case "HorizontalRule":
            if (!lineActive(node.from)) decos.push(Decoration.replace({ widget: new HrWidget() }).range(node.from, node.to));
            break;
          case "ListMark": {
            const item = parent;
            const list = item?.parent;
            const after = doc.sliceString(node.to, node.to + 4);
            const isTask = /^ \[[ xX\-/]\]/.test(after);
            if (isTask) {
              if (!lineActive(node.from)) decos.push(hide.range(node.from, node.to + 1));
            } else if (list?.name === "BulletList" && !lineActive(node.from)) {
              decos.push(Decoration.replace({ widget: new BulletWidget() }).range(node.from, node.to));
            }
            break;
          }
          case "TaskMarker": {
            const checked = /\[[xX\-/]\]/.test(doc.sliceString(node.from, node.to));
            const sel = state.selection.main;
            const inside = view.hasFocus && sel.from >= node.from && sel.to <= node.to && sel.empty && sel.from > node.from;
            if (!inside) {
              decos.push(Decoration.replace({ widget: new CheckboxWidget(checked, node.from) }).range(node.from, node.to));
              if (checked) {
                const line = doc.lineAt(node.from);
                if (node.to + 1 < line.to)
                  decos.push(Decoration.mark({ class: "cm-task-done" }).range(node.to + 1, line.to));
              }
            }
            break;
          }
          case "Link": {
            if (rangeActive(node.from, node.to)) break;
            const marks = node.node.getChildren("LinkMark");
            const url = node.node.getChild("URL");
            if (marks.length >= 2 && url) {
              const href = doc.sliceString(url.from, url.to);
              decos.push(hide.range(marks[0].from, marks[0].to));
              decos.push(hide.range(marks[1].from, node.to));
              const external = /^[a-z][a-z0-9+.-]*:/i.test(href);
              decos.push(
                Decoration.mark({
                  class: external ? "cm-link cm-external-link" : "cm-wikilink cm-link-rendered",
                  attributes: external ? { "data-url": href } : { "data-target": decodeURIComponent(href.split("#")[0]) },
                }).range(marks[0].to, marks[1].from),
              );
            }
            return false;
          }
          case "Image": {
            if (rangeActive(node.from, node.to)) break;
            const url = node.node.getChild("URL");
            if (!url) break;
            const href = doc.sliceString(url.from, url.to);
            const src = /^(https?:|data:)/.test(href)
              ? href
              : (() => {
                  const resolved = opts.resolver().resolve(decodeURIComponent(href), opts.path());
                  return resolved ? opts.imageUrl(resolved) : "";
                })();
            if (src) decos.push(Decoration.replace({ widget: new ImageWidget(src, "", "") }).range(node.from, node.to));
            return false;
          }
          case "URL":
            if (parent?.name === "Autolink" || parent?.name === "Document" || parent?.name === "Paragraph") {
              decos.push(
                Decoration.mark({ class: "cm-link cm-external-link", attributes: { "data-url": doc.sliceString(node.from, node.to) } }).range(
                  node.from,
                  node.to,
                ),
              );
            }
            break;
        }
      },
    });
  }

  const inCode = (a: number, b: number) => code.some(([f, t]) => a < t && b > f);
  const resolver = opts.resolver();
  const path = opts.path();

  for (const { from, to } of view.visibleRanges) {
    const text = doc.sliceString(from, to);
    let m: RegExpExecArray | null;

    WIKI_RE.lastIndex = 0;
    while ((m = WIKI_RE.exec(text))) {
      const start = from + m.index;
      const end = start + m[0].length;
      if (inCode(start, end)) continue;
      const embed = m[1] === "!";
      const { target, fragment, alias } = parseLinkText(m[2]);
      const resolved = target ? resolver.resolve(target, path) : path;
      const cls = `cm-wikilink${resolved ? "" : " is-unresolved"}`;
      const attrs = { "data-target": target + (fragment ? `#${fragment}` : "") };
      if (rangeActive(start, end)) {
        decos.push(Decoration.mark({ class: `${cls} cm-wikilink-source`, attributes: attrs }).range(start, end));
        continue;
      }
      if (embed && resolved && /\.excalidraw(\.md)?$/i.test(resolved)) {
        decos.push(Decoration.replace({ widget: new DrawingWidget(resolved, opts) }).range(start, end));
        continue;
      }
      if (embed && resolved && IMAGE_EXTS.has(extOf(resolved))) {
        const width = /^\d+(x\d+)?$/.test(alias) ? alias.split("x")[0] : "";
        decos.push(Decoration.replace({ widget: new ImageWidget(opts.imageUrl(resolved), target, width) }).range(start, end));
        continue;
      }
      const label = alias || (target ? displayName(target) : "") + (fragment ? (target ? " > " : "") + fragment : "");
      decos.push(
        Decoration.replace({
          widget: new LinkWidget(embed ? `⧉ ${label}` : label, `${cls} cm-link-rendered`, attrs["data-target"]),
        }).range(start, end),
      );
    }

    TAG_RE.lastIndex = 0;
    while ((m = TAG_RE.exec(text))) {
      const start = from + m.index + m[1].length;
      const end = start + 1 + m[2].length;
      if (inCode(start, end) || /^[\d/]+$/.test(m[2])) continue;
      const line = doc.lineAt(start);
      if (start === line.from && /^#+\s/.test(line.text)) continue;
      decos.push(Decoration.mark({ class: "cm-tag", attributes: { "data-tag": m[2] } }).range(start, end));
    }

    MI_RE.lastIndex = 0;
    while ((m = MI_RE.exec(text))) {
      const start = from + m.index;
      const end = start + m[0].length;
      if (inCode(start, end) || rangeActive(start, end)) continue;
      decos.push(Decoration.replace({ widget: new TextWidget(m[1], "material-symbols-outlined mi-inline") }).range(start, end));
    }

    EMOJI_RE.lastIndex = 0;
    while ((m = EMOJI_RE.exec(text))) {
      const start = from + m.index;
      const end = start + m[0].length;
      const emoji = emojiData[m[1]];
      if (!emoji || inCode(start, end) || rangeActive(start, end)) continue;
      decos.push(Decoration.replace({ widget: new TextWidget(emoji, "cm-emoji") }).range(start, end));
    }

    HIGHLIGHT_RE.lastIndex = 0;
    while ((m = HIGHLIGHT_RE.exec(text))) {
      const start = from + m.index;
      const end = start + m[0].length;
      if (inCode(start, end)) continue;
      decos.push(Decoration.mark({ class: "cm-highlight" }).range(start, end));
      if (!rangeActive(start, end)) {
        decos.push(hide.range(start, start + 2));
        decos.push(hide.range(end - 2, end));
      }
    }
  }

  // Frontmatter block styling (when shown as source).
  const fm = frontmatterRange(state);
  if (fm) {
    const last = doc.lineAt(fm.to).number;
    for (let l = 1; l <= last; l++) lineClass(doc.line(l).from, "cm-frontmatter");
  }

  return Decoration.set(dedupeReplacements(decos), true);
}

/** Drop replace decorations nested inside other replace decorations (CodeMirror rejects overlaps). */
function dedupeReplacements(decos: Range<Decoration>[]): Range<Decoration>[] {
  const isReplace = (d: Range<Decoration>) =>
    d.from < d.to && (d.value as unknown as { isReplace?: boolean }).isReplace === true;
  const replaces = decos.filter(isReplace).sort((a, b) => a.from - b.from || b.to - a.to);
  const keep = new Set<Range<Decoration>>();
  let coveredTo = -1;
  for (const r of replaces) {
    if (r.from >= coveredTo) {
      keep.add(r);
      coveredTo = r.to;
    }
  }
  return decos.filter((d) => !isReplace(d) || keep.has(d));
}

export function livePreview(opts: LivePreviewOptions) {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view, opts);
      }
      update(u: ViewUpdate) {
        if (
          u.docChanged ||
          u.viewportChanged ||
          u.selectionSet ||
          u.focusChanged ||
          syntaxTree(u.startState) !== syntaxTree(u.state) ||
          u.transactions.some((t) => t.effects.some((e) => e.is(refreshLivePreview)))
        ) {
          this.decorations = build(u.view, opts);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );

  const clicks = EditorView.domEventHandlers({
    mousedown(e) {
      const el = e.target as HTMLElement;
      const mod = e.metaKey || e.ctrlKey;
      const tag = el.closest<HTMLElement>(".cm-tag");
      if (tag && mod) {
        e.preventDefault();
        opts.openTag(tag.dataset.tag ?? "");
        return true;
      }
      const ext = el.closest<HTMLElement>(".cm-external-link");
      if (ext?.dataset.url && (mod || !ext.closest(".cm-line")?.classList.contains("cm-activeLine"))) {
        e.preventDefault();
        opts.openExternal(ext.dataset.url);
        return true;
      }
      const rendered = el.closest<HTMLElement>(".cm-link-rendered");
      if (rendered) {
        e.preventDefault();
        opts.openLink(rendered.dataset.target ?? "", mod);
        return true;
      }
      const source = el.closest<HTMLElement>(".cm-wikilink-source");
      if (source && mod) {
        e.preventDefault();
        opts.openLink(source.dataset.target ?? "", true);
        return true;
      }
      return false;
    },
  });

  return [plugin, clicks, blockWidgets(opts)];
}

// ------------------------------------------------------------------ block widgets
const isCalloutLine = (line: string) => {
  const rest = line.replace(/^\s*>\s*/, "");
  return rest.startsWith("[!") || CUSTOM_CALLOUT_RE.test(rest);
};

// Whole-block renderings (tables, callouts, properties). Block replacements must come
// from a StateField; they reveal their markdown when the cursor enters the block.

function frontmatterRange(state: EditorState): { from: number; to: number } | null {
  const head = state.doc.sliceString(0, Math.min(state.doc.length, 20000));
  const m = /^---[ \t]*\n[\s\S]*?\n(?:---|\.\.\.)[ \t]*(?:\n|$)/.exec(head);
  if (!m) return null;
  return { from: 0, to: state.doc.lineAt(Math.max(0, m[0].replace(/\n$/, "").length)).to };
}

class BlockWidget extends WidgetType {
  constructor(
    readonly html: string,
    readonly cls: string,
    readonly from: number,
    readonly opts: LivePreviewOptions,
  ) {
    super();
  }
  eq(o: BlockWidget) {
    return o.html === this.html && o.cls === this.cls && o.from === this.from;
  }
  toDOM(view: EditorView) {
    const el = document.createElement("div");
    el.className = `cm-block-widget markdown-rendered ${this.cls}`;
    el.innerHTML = this.html;
    el.addEventListener("mousedown", (e) => {
      const t = e.target as HTMLElement;
      const link = t.closest<HTMLElement>("a.internal-link");
      const tag = t.closest<HTMLElement>("a.tag");
      const ext = t.closest<HTMLAnchorElement>("a.external-link");
      e.preventDefault();
      if (link) return this.opts.openLink((link.dataset.href ?? "") + (link.dataset.fragment ? `#${link.dataset.fragment}` : ""), e.metaKey || e.ctrlKey);
      if (tag) return this.opts.openTag(tag.dataset.tag ?? "");
      if (ext) return this.opts.openExternal(ext.getAttribute("href") ?? "");
      if (t.closest(".callout-fold")) return el.querySelector(".callout")?.classList.toggle("is-collapsed");
      // Anywhere else: reveal the markdown for editing.
      view.dispatch({ selection: { anchor: this.from } });
      view.focus();
    });
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

// ------------------------------------------------------------------ editable tables
// Tables stay rendered while you edit them: every cell is editable in place and edits are
// written back to the markdown. Double-clicking the header row shows the raw markdown.

/** Line range of the table block containing `pos` (contiguous non-blank lines with a pipe). */
function tableBounds(state: EditorState, pos: number): { from: number; to: number } {
  const doc = state.doc;
  const isRow = (n: number) => {
    const t = doc.line(n).text;
    return t.trim() !== "" && t.includes("|");
  };
  let a = doc.lineAt(Math.min(pos, doc.length)).number;
  let b = a;
  while (a > 1 && isRow(a - 1)) a--;
  while (b < doc.lines && isRow(b + 1)) b++;
  return { from: doc.line(a).from, to: doc.line(b).to };
}

const revealTable = StateEffect.define<number | null>();

/** Start of the table currently shown as markdown source (after a header double-click). */
const revealedTable = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(revealTable)) return e.value;
    if (value === null) return null;
    const pos = tr.changes.mapPos(value);
    if (tr.selection || tr.docChanged) {
      const b = tableBounds(tr.state, pos);
      const inside = tr.state.selection.ranges.some((r) => r.head >= b.from && r.head <= b.to);
      if (!inside) return null;
    }
    return pos;
  },
});

interface TableDomState {
  source: string;
  model: TableModel;
}
const tableStates = new WeakMap<HTMLElement, TableDomState>();

function inlineHtml(opts: LivePreviewOptions, text: string): string {
  if (!text.trim()) return "";
  return opts.render(text).trim().replace(/^<p[^>]*>/, "").replace(/<\/p>$/, "");
}

class TableWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly opts: LivePreviewOptions,
  ) {
    super();
  }
  eq(o: TableWidget) {
    return o.source === this.source;
  }
  toDOM(view: EditorView) {
    const el = document.createElement("div");
    el.className = "cm-block-widget markdown-rendered cm-table-widget cm-table-editable";
    tableStates.set(el, { source: this.source, model: parseTable(this.source) });
    this.build(el, view);
    return el;
  }
  updateDOM(dom: HTMLElement, view: EditorView) {
    const st = tableStates.get(dom);
    if (!st) return false;
    if (st.source === this.source) return true; // our own edit: DOM already up to date
    st.source = this.source;
    st.model = parseTable(this.source);
    this.build(dom, view);
    return true;
  }
  ignoreEvent() {
    return true;
  }

  /** (Re)renders the table, keeping keyboard focus on the same cell. */
  private build(el: HTMLElement, view: EditorView, focusAt?: { r: number; c: number; caret?: "end" | "start" }) {
    const st = tableStates.get(el)!;
    const active = document.activeElement as HTMLElement | null;
    const focus =
      focusAt ??
      (active && el.contains(active) && active.dataset.r !== undefined
        ? { r: Number(active.dataset.r), c: Number(active.dataset.c), caret: "end" as const }
        : undefined);
    const m = st.model;
    const opts = this.opts;
    el.replaceChildren();
    const wrap = document.createElement("div");
    wrap.className = "table-wrap";
    const table = document.createElement("table");
    const cellAt = (r: number, c: number) => table.querySelector<HTMLElement>(`[data-r="${r}"][data-c="${c}"]`);

    const commit = (next: TableModel, focusNext?: { r: number; c: number; caret?: "end" | "start" }) => {
      const from = view.posAtDOM(el);
      const text = serializeTable(next);
      if (view.state.doc.sliceString(from, from + st.source.length) !== st.source) return;
      const old = st.source;
      st.source = text;
      st.model = next;
      if (focusNext) this.build(el, view, focusNext);
      view.dispatch({ changes: { from, to: from + old.length, insert: text }, userEvent: "input.table" });
    };
    const focusCell = (r: number, c: number, caret: "end" | "start" = "end") => {
      const cell = cellAt(r, c);
      if (!cell) return;
      cell.focus();
      const range = document.createRange();
      range.selectNodeContents(cell);
      range.collapse(caret === "start");
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    };
    const leave = (after: boolean) => {
      const from = view.posAtDOM(el);
      const to = from + st.source.length;
      const doc = view.state.doc;
      const pos = after ? Math.min(doc.length, to + 1) : Math.max(0, from - 1);
      view.focus();
      view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
    };

    const makeCell = (tag: "th" | "td", r: number, c: number, text: string) => {
      const cell = document.createElement(tag);
      cell.dataset.r = String(r);
      cell.dataset.c = String(c);
      cell.contentEditable = "plaintext-only";
      cell.spellcheck = view.contentDOM.spellcheck;
      if (m.align[c]) cell.style.textAlign = m.align[c]!;
      cell.innerHTML = inlineHtml(opts, text);
      cell.addEventListener("mousedown", (e) => {
        if (document.activeElement === cell) return;
        const t = e.target as HTMLElement;
        const link = t.closest<HTMLElement>("a.internal-link");
        const tag = t.closest<HTMLElement>("a.tag");
        const ext = t.closest<HTMLAnchorElement>("a.external-link");
        if (link || tag || ext) {
          e.preventDefault();
          if (link) opts.openLink((link.dataset.href ?? "") + (link.dataset.fragment ? `#${link.dataset.fragment}` : ""), e.metaKey || e.ctrlKey);
          else if (tag) opts.openTag(tag.dataset.tag ?? "");
          else if (ext) opts.openExternal(ext.getAttribute("href") ?? "");
        }
      });
      cell.addEventListener("focus", () => {
        const raw = r < 0 ? st.model.header[c] : st.model.rows[r]?.[c] ?? "";
        if (cell.textContent !== raw || cell.childElementCount) {
          cell.textContent = raw;
          focusCell(r, c);
        }
        el.classList.add("is-editing");
      });
      cell.addEventListener("blur", () => {
        const raw = r < 0 ? st.model.header[c] : st.model.rows[r]?.[c] ?? "";
        cell.innerHTML = inlineHtml(opts, raw);
        el.classList.remove("is-editing");
      });
      cell.addEventListener("input", () => {
        const value = cleanCell(cell.textContent ?? "");
        const next: TableModel = {
          ...st.model,
          header: r < 0 ? st.model.header.map((h, i) => (i === c ? value : h)) : st.model.header,
          rows: r < 0 ? st.model.rows : st.model.rows.map((row, i) => (i === r ? row.map((x, j) => (j === c ? value : x)) : row)),
        };
        commit(next);
      });
      cell.addEventListener("keydown", (e) => {
        const cols = st.model.header.length;
        const last = st.model.rows.length - 1;
        const mod = e.metaKey || e.ctrlKey;
        if (mod && e.key.toLowerCase() === "z") {
          e.preventDefault();
          (e.shiftKey ? redo : undo)(view);
          return;
        }
        if (mod && e.key.toLowerCase() === "y") {
          e.preventDefault();
          redo(view);
          return;
        }
        if (e.key === "Tab") {
          e.preventDefault();
          let nr = r;
          let nc = c + (e.shiftKey ? -1 : 1);
          if (nc >= cols) (nc = 0), nr++;
          if (nc < 0) (nc = cols - 1), nr--;
          if (nr < -1) return;
          if (nr > last) return commit(addRow(st.model), { r: nr, c: nc });
          return focusCell(nr, nc);
        }
        if (e.key === "Enter") {
          e.preventDefault();
          if (r >= last) return commit(addRow(st.model), { r: r + 1, c });
          return focusCell(r + 1, c);
        }
        if (e.key === "Escape") {
          e.preventDefault();
          return leave(true);
        }
        const sel = window.getSelection();
        const atStart = sel?.anchorOffset === 0 && sel.isCollapsed;
        const atEnd = sel?.isCollapsed && sel.anchorOffset === (sel.anchorNode?.textContent ?? "").length;
        if (e.key === "ArrowDown") {
          e.preventDefault();
          return r >= last ? leave(true) : focusCell(r + 1, c);
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          return r <= -1 ? leave(false) : focusCell(r - 1, c);
        }
        if (e.key === "ArrowRight" && atEnd && c < cols - 1) {
          e.preventDefault();
          return focusCell(r, c + 1, "start");
        }
        if (e.key === "ArrowLeft" && atStart && c > 0) {
          e.preventDefault();
          return focusCell(r, c - 1, "end");
        }
      });
      return cell;
    };

    const thead = document.createElement("thead");
    const hr = document.createElement("tr");
    m.header.forEach((h, c) => hr.append(makeCell("th", -1, c, h)));
    hr.title = "Double-click to edit the table as markdown";
    hr.addEventListener("dblclick", (e) => {
      e.preventDefault();
      const from = view.posAtDOM(el);
      (document.activeElement as HTMLElement | null)?.blur();
      view.focus();
      view.dispatch({ effects: revealTable.of(from), selection: { anchor: from } });
    });
    thead.append(hr);
    const tbody = document.createElement("tbody");
    m.rows.forEach((row, r) => {
      const tr = document.createElement("tr");
      row.forEach((cell, c) => tr.append(makeCell("td", r, c, cell)));
      tbody.append(tr);
    });
    table.append(thead, tbody);
    const addR = document.createElement("button");
    addR.className = "table-add table-add-row";
    addR.title = "Add row";
    addR.textContent = "+";
    addR.addEventListener("mousedown", (e) => {
      e.preventDefault();
      commit(addRow(st.model), { r: st.model.rows.length, c: 0 });
    });
    const addC = document.createElement("button");
    addC.className = "table-add table-add-col";
    addC.title = "Add column";
    addC.textContent = "+";
    addC.addEventListener("mousedown", (e) => {
      e.preventDefault();
      commit(addColumn(st.model), { r: -1, c: st.model.header.length });
    });
    wrap.append(table, addC, addR);
    el.append(wrap);
    if (focus) {
      const r = Math.min(focus.r, st.model.rows.length - 1);
      const c = Math.min(focus.c, st.model.header.length - 1);
      // Defer so the DOM is attached when CodeMirror swaps the widget in.
      queueMicrotask(() => focusCell(r, c, focus.caret));
    }
  }
}

function blockDecorations(state: EditorState, opts: LivePreviewOptions): DecorationSet {
  const doc = state.doc;
  const sel = state.selection.ranges;
  const touched = (from: number, to: number) => sel.some((r) => r.from <= to && r.to >= from);
  const decos: Range<Decoration>[] = [];
  const render = (md: string) => opts.render(md);

  const fm = frontmatterRange(state);
  const propsMode = opts.propertiesMode();
  // A freshly opened note has its cursor at 0; that shouldn't count as editing the frontmatter.
  const atStart = sel.length === 1 && sel[0].empty && sel[0].head === 0;
  if (fm && propsMode !== "source" && (atStart || !touched(fm.from, fm.to))) {
    const html = propsMode === "hidden" ? "" : render(doc.sliceString(fm.from, fm.to) + "\n");
    decos.push(
      Decoration.replace({
        widget: new BlockWidget(html || "", propsMode === "hidden" ? "cm-props-hidden" : "cm-props", fm.from, opts),
        block: true,
      }).range(fm.from, fm.to),
    );
  }

  const revealed = state.field(revealedTable, false) ?? null;
  // Tables are only shown as markdown when explicitly revealed or when a selection lands inside them (e.g. search).
  const inside = (from: number, to: number) => sel.some((r) => (r.from > from && r.from < to) || (r.to > from && r.to < to));
  const tree = ensureSyntaxTree(state, doc.length, 40) ?? syntaxTree(state);
  tree.iterate({
    enter: (node) => {
      if (node.name === "Table") {
        const from = doc.lineAt(node.from).from;
        const to = doc.lineAt(node.to).to;
        if (fm && from <= fm.to) return false;
        const shown = (revealed !== null && revealed >= from && revealed <= to) || inside(from, to);
        if (!shown) decos.push(Decoration.replace({ widget: new TableWidget(doc.sliceString(from, to), opts), block: true }).range(from, to));
        return false;
      }
      if (node.name === "Blockquote" && isCalloutLine(doc.lineAt(node.from).text)) {
        const from = doc.lineAt(node.from).from;
        const to = doc.lineAt(node.to).to;
        if (fm && from <= fm.to) return false;
        if (!touched(from, to)) {
          decos.push(Decoration.replace({ widget: new BlockWidget(render(doc.sliceString(from, to)), "cm-callout-widget", from, opts), block: true }).range(from, to));
        }
        return false;
      }
      if (node.name === "FencedCode" || node.name === "CodeBlock") return false;
      return undefined;
    },
  });
  return Decoration.set(decos, true);
}

function blockWidgets(opts: LivePreviewOptions) {
  const field = StateField.define<DecorationSet>({
    create: (state) => blockDecorations(state, opts),
    update(value, tr) {
      if (tr.docChanged || tr.selection || tr.effects.some((e) => e.is(refreshLivePreview) || e.is(revealTable))) {
        return blockDecorations(tr.state, opts);
      }
      return value;
    },
    provide: (f) => EditorView.decorations.from(f),
  });
  return [revealedTable, field];
}
