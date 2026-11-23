// "Live preview" for CodeMirror 6: renders markdown inline and reveals the raw
// syntax only on the lines the cursor is on — the way Obsidian's editor works.
import { syntaxTree } from "@codemirror/language";
import { type EditorState, type Range, StateEffect } from "@codemirror/state";
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
import { TAG_CHARS } from "../markdown/render";

export interface LivePreviewOptions {
  resolver: () => LinkResolver;
  path: () => string;
  imageUrl: (vaultPath: string) => string;
  openLink: (target: string, newTab: boolean) => void;
  openTag: (tag: string) => void;
  openExternal: (url: string) => void;
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
            for (let l = first; l <= last; l++) {
              const cls = `cm-codeblock${l === first ? " cm-codeblock-begin" : ""}${l === last ? " cm-codeblock-end" : ""}`;
              lineClass(doc.line(l).from, cls);
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

  // Frontmatter block styling.
  const fm = /^---[ \t]*\n[\s\S]*?\n(?:---|\.\.\.)[ \t]*(?:\n|$)/.exec(doc.sliceString(0, Math.min(doc.length, 20000)));
  if (fm) {
    const last = doc.lineAt(Math.max(0, fm[0].replace(/\n$/, "").length)).number;
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

  return [plugin, clicks];
}
