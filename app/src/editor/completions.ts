import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import emojiData from "markdown-it-emoji/lib/data/full.mjs";
import { MATERIAL_ICONS } from "../lib/icons";
import { basename, dirname, displayName, splitExt } from "../lib/links";
import type { FileEntry } from "../lib/types";

export interface CompletionSources {
  files: () => FileEntry[];
  tags: () => string[];
}

const EMOJI_OPTIONS: Completion[] = Object.entries(emojiData).map(([name, ch]) => ({
  label: `:${name}:`,
  displayLabel: `${ch}  ${name}`,
  type: "text",
  apply: `:${name}:`,
}));

const ICON_OPTIONS: Completion[] = MATERIAL_ICONS.map((name) => ({
  label: `:mi-${name}:`,
  displayLabel: name,
  detail: "material icon",
  type: "constant",
  apply: `:mi-${name}:`,
}));

export function markdownCompletions(src: CompletionSources) {
  return (ctx: CompletionContext): CompletionResult | null => {
    // [[wikilinks]] and ![[embeds]]
    const link = ctx.matchBefore(/\[\[[^\[\]\n|#]*$/);
    if (link) {
      const from = link.from + 2;
      const files = src.files();
      const stems = new Map<string, number>();
      for (const f of files) {
        const s = splitExt(basename(f.path))[0].toLowerCase();
        stems.set(s, (stems.get(s) ?? 0) + 1);
      }
      const after = ctx.state.sliceDoc(ctx.pos, ctx.pos + 2);
      const options: Completion[] = files.map((f) => {
        const isNote = f.kind === "markdown";
        const unique = stems.get(splitExt(basename(f.path))[0].toLowerCase()) === 1;
        const text = isNote
          ? unique
            ? displayName(f.path)
            : f.path.replace(/\.(md|markdown)$/i, "")
          : unique
            ? basename(f.path)
            : f.path;
        return {
          label: text,
          displayLabel: isNote ? displayName(f.path) : basename(f.path),
          detail: dirname(f.path) || undefined,
          type: isNote ? "text" : "variable",
          apply: (view, _c, a, b) => {
            const close = after === "]]" ? "" : "]]";
            view.dispatch({
              changes: { from: a, to: b, insert: text + close },
              selection: { anchor: a + text.length + 2 },
            });
          },
        };
      });
      return { from, options, validFor: /^[^\[\]\n|#]*$/ };
    }

    // #tags
    const tag = ctx.matchBefore(/(?:^|\s)#[^\s#]*$/);
    if (tag) {
      const hash = tag.text.indexOf("#");
      const from = tag.from + hash + 1;
      const line = ctx.state.doc.lineAt(ctx.pos);
      if (/^#+\s/.test(line.text) && tag.from + hash === line.from) return null;
      if (ctx.pos === from && !ctx.explicit) return null;
      return {
        from,
        options: src.tags().map((t) => ({ label: t, type: "keyword" })),
        validFor: /^[^\s#]*$/,
      };
    }

    // :emoji: and :mi-icon:
    const emo = ctx.matchBefore(/:[a-z0-9_+-]{2,}$/);
    if (emo) {
      const q = emo.text.slice(1);
      const options = q.startsWith("mi-") ? ICON_OPTIONS : [...EMOJI_OPTIONS, ...ICON_OPTIONS];
      return { from: emo.from, options, validFor: /^:[a-z0-9_+-]*$/ };
    }
    return null;
  };
}
