// Markdown editing commands used by the floating format bar (and the command palette).
import { EditorSelection, type ChangeSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { wrapSelection } from "./setup";

export { wrapSelection };

const LIST_RE = /^(\s*)(?:[-*+]\s\[[ xX\-/]\]\s|[-*+]\s|\d+[.)]\s|>\s?)?/;
const HEADING_RE = /^(#{1,6})\s+/;

/** Distinct lines touched by the selection (each line once). */
function selectedLines(view: EditorView) {
  const { state } = view;
  const seen = new Set<number>();
  const lines = [];
  for (const r of state.selection.ranges) {
    for (let n = state.doc.lineAt(r.from).number; n <= state.doc.lineAt(r.to).number; n++) {
      if (!seen.has(n)) {
        seen.add(n);
        lines.push(state.doc.line(n));
      }
    }
  }
  return lines;
}

/** Heading level 1–6 on the selected lines; 0 (or the same level again) makes them normal text. */
export function setHeading(view: EditorView, level: number): boolean {
  const lines = selectedLines(view);
  const allSame = level > 0 && lines.every((l) => HEADING_RE.exec(l.text)?.[1].length === level);
  const changes: ChangeSpec[] = lines.map((l) => {
    const m = HEADING_RE.exec(l.text);
    const insert = allSame || level === 0 ? "" : "#".repeat(level) + " ";
    return { from: l.from, to: l.from + (m ? m[0].length : 0), insert };
  });
  view.dispatch({ changes, userEvent: "input", scrollIntoView: true });
  view.focus();
  return true;
}

export type LineKind = "bullet" | "number" | "task" | "quote";

function lineKind(text: string): LineKind | null {
  if (/^\s*[-*+]\s\[[ xX\-/]\]\s/.test(text)) return "task";
  if (/^\s*[-*+]\s/.test(text)) return "bullet";
  if (/^\s*\d+[.)]\s/.test(text)) return "number";
  if (/^\s*>/.test(text)) return "quote";
  return null;
}

/** Toggle a list / task / quote marker on the selected lines (switching kinds replaces the marker). */
export function toggleLinePrefix(view: EditorView, kind: LineKind): boolean {
  const lines = selectedLines(view);
  const nonEmpty = lines.filter((l) => l.text.trim());
  const remove = (nonEmpty.length ? nonEmpty : lines).every((l) => lineKind(l.text) === kind);
  let n = 0;
  const changes: ChangeSpec[] = lines.map((l) => {
    const m = LIST_RE.exec(l.text)!;
    const indent = m[1];
    const markerEnd = m[0].length;
    if (remove) return { from: l.from + indent.length, to: l.from + markerEnd, insert: "" };
    if (!l.text.trim() && lines.length > 1) return { from: l.from, insert: "" };
    n += 1;
    const marker = kind === "bullet" ? "- " : kind === "number" ? `${n}. ` : kind === "task" ? "- [ ] " : "> ";
    return { from: l.from + indent.length, to: l.from + markerEnd, insert: marker };
  });
  view.dispatch({ changes, userEvent: "input", scrollIntoView: true });
  view.focus();
  return true;
}

/** Insert a block (table, code fence, callout…) on its own lines at the cursor. `|` marks where the cursor goes. */
export function insertBlock(view: EditorView, template: string): boolean {
  const { state } = view;
  const range = state.selection.main;
  const selected = state.sliceDoc(range.from, range.to);
  let text = template.replace("{sel}", selected);
  const cursor = text.indexOf("|CURSOR|");
  text = text.replace("|CURSOR|", "");
  const startLine = state.doc.lineAt(range.from);
  const endLine = state.doc.lineAt(range.to);
  // Blocks start on their own line (after a blank line when the cursor sits in a paragraph).
  const prevLine = startLine.number > 1 ? state.doc.line(startLine.number - 1) : null;
  const before = state.sliceDoc(startLine.from, range.from).trim()
    ? "\n\n"
    : !startLine.text.trim() && prevLine?.text.trim() && !template.startsWith("\n")
      ? "\n"
      : "";
  const after = state.sliceDoc(range.to, endLine.to).trim() ? "\n" : "";
  const insert = before + text + after;
  const at = range.from + before.length + (cursor >= 0 ? cursor : text.length);
  view.dispatch({
    changes: { from: range.from, to: range.to, insert },
    selection: EditorSelection.cursor(at),
    userEvent: "input",
    scrollIntoView: true,
  });
  view.focus();
  return true;
}

export const TABLE_TEMPLATE = "| |CURSOR|Column 1 | Column 2 | Column 3 |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |\n";
export const CODE_TEMPLATE = "```|CURSOR|\n{sel}\n```\n";
export const HR_TEMPLATE = "\n---\n|CURSOR|";

export function calloutTemplate(type: string): string {
  return `> [!${type}] |CURSOR|\n> {sel}\n`;
}

/** Markdown link around the selection: `[text](url)`, cursor in the url. */
export function insertLink(view: EditorView): boolean {
  const { state } = view;
  view.dispatch(
    state.changeByRange((r) => {
      const text = state.sliceDoc(r.from, r.to);
      const isUrl = /^https?:\/\//.test(text);
      const insert = isUrl ? `[](${text})` : `[${text}]()`;
      const pos = isUrl ? r.from + 1 : r.from + text.length + 3;
      return { changes: { from: r.from, to: r.to, insert }, range: EditorSelection.cursor(pos) };
    }),
    { userEvent: "input", scrollIntoView: true },
  );
  view.focus();
  return true;
}

/** Wrap inline and keep focus in the editor (toolbar buttons). */
export function wrap(view: EditorView, before: string, after = before): boolean {
  wrapSelection(view, before, after);
  view.focus();
  return true;
}
