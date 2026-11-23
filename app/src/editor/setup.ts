import { closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { json } from "@codemirror/lang-json";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { yaml, yamlFrontmatter } from "@codemirror/lang-yaml";
import {
  HighlightStyle,
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorSelection, type Extension } from "@codemirror/state";
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  placeholder,
  rectangularSelection,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import type { FileKind } from "../lib/types";

export const highlightStyle = HighlightStyle.define([
  { tag: t.heading, class: "tok-heading" },
  { tag: t.emphasis, class: "tok-em" },
  { tag: t.strong, class: "tok-strong" },
  { tag: t.strikethrough, class: "tok-strike" },
  { tag: [t.link, t.url], class: "tok-link" },
  { tag: [t.processingInstruction, t.meta, t.contentSeparator], class: "tok-meta" },
  { tag: t.monospace, class: "tok-mono" },
  { tag: t.quote, class: "tok-quote" },
  { tag: [t.keyword, t.operatorKeyword, t.modifier], class: "tok-keyword" },
  { tag: [t.string, t.special(t.string)], class: "tok-string" },
  { tag: [t.number, t.bool, t.null, t.atom], class: "tok-number" },
  { tag: [t.propertyName, t.attributeName, t.definition(t.propertyName)], class: "tok-property" },
  { tag: [t.comment, t.lineComment, t.blockComment], class: "tok-comment" },
  { tag: [t.typeName, t.className], class: "tok-type" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], class: "tok-function" },
  { tag: [t.variableName], class: "tok-variable" },
  { tag: [t.punctuation, t.bracket, t.separator], class: "tok-punct" },
  { tag: t.invalid, class: "tok-invalid" },
]);

export const lineNumbersCompartment = new Compartment();
export const spellcheckCompartment = new Compartment();
export const livePreviewCompartment = new Compartment();

export function baseExtensions(opts: { lineNumbers: boolean; spellcheck: boolean; wrap: boolean }): Extension[] {
  return [
    lineNumbersCompartment.of(opts.lineNumbers ? [lineNumbers(), highlightActiveLineGutter(), foldGutter()] : []),
    spellcheckCompartment.of(
      EditorView.contentAttributes.of({ spellcheck: opts.spellcheck ? "true" : "false", autocorrect: "on" }),
    ),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    search({ top: true }),
    syntaxHighlighting(highlightStyle),
    opts.wrap ? EditorView.lineWrapping : [],
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
      ...completionKeymap,
      indentWithTab,
    ]),
  ];
}

export function languageFor(kind: FileKind): Extension {
  switch (kind) {
    case "markdown":
      return yamlFrontmatter({ content: markdown({ base: markdownLanguage, codeLanguages: languages }) });
    case "json":
      return json();
    case "yaml":
      return yaml();
    default:
      return [];
  }
}

/** Markdown formatting commands (bold, italic, link…) used by the keymap and command palette. */
export function wrapSelection(view: EditorView, before: string, after = before): boolean {
  const changes = view.state.changeByRange((range) => {
    const text = view.state.sliceDoc(range.from, range.to);
    if (text.startsWith(before) && text.endsWith(after) && text.length >= before.length + after.length) {
      const inner = text.slice(before.length, text.length - after.length);
      return {
        changes: { from: range.from, to: range.to, insert: inner },
        range: EditorSelection.range(range.from, range.from + inner.length),
      };
    }
    return {
      changes: [
        { from: range.from, insert: before },
        { from: range.to, insert: after },
      ],
      range: EditorSelection.range(range.from + before.length, range.to + before.length),
    };
  });
  view.dispatch(view.state.update(changes, { scrollIntoView: true, userEvent: "input" }));
  return true;
}

export const markdownKeymap = keymap.of([
  { key: "Mod-b", run: (v) => wrapSelection(v, "**") },
  { key: "Mod-i", run: (v) => wrapSelection(v, "*") },
  { key: "Mod-Shift-x", run: (v) => wrapSelection(v, "~~") },
  { key: "Mod-Shift-h", run: (v) => wrapSelection(v, "==") },
  { key: "Mod-`", run: (v) => wrapSelection(v, "`") },
  { key: "Mod-k", run: (v) => wrapSelection(v, "[[", "]]") },
  {
    key: "Mod-Enter",
    run: (v) => {
      // Toggle checkbox on the current line (Obsidian: "Toggle checkbox status").
      const line = v.state.doc.lineAt(v.state.selection.main.head);
      const m = /^(\s*(?:[-*+]|\d+[.)])\s)(\[[ xX]\]\s)?/.exec(line.text);
      if (!m) {
        const indent = /^\s*/.exec(line.text)![0];
        v.dispatch({ changes: { from: line.from + indent.length, insert: "- [ ] " } });
        return true;
      }
      const at = line.from + m[1].length;
      if (!m[2]) v.dispatch({ changes: { from: at, insert: "[ ] " } });
      else v.dispatch({ changes: { from: at + 1, to: at + 2, insert: /[xX]/.test(m[2]) ? " " : "x" } });
      return true;
    },
  },
]);

export { placeholder };
