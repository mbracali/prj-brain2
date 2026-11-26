// Floating formatting bar shown above markdown notes (live preview and source mode).
import type { EditorView } from "@codemirror/view";
import { Icon } from "../components/Icon";
import {
  CODE_TEMPLATE,
  HR_TEMPLATE,
  TABLE_TEMPLATE,
  calloutTemplate,
  insertBlock,
  insertLink,
  setHeading,
  toggleLinePrefix,
  wrap,
} from "../editor/format";
import { modKey } from "../lib/bridge";
import { type MenuItem, useApp } from "../store";

const CALLOUTS: [string, string, string][] = [
  ["note", "Note", "edit_note"],
  ["info", "Info", "info"],
  ["tip", "Tip", "lightbulb"],
  ["success", "Success", "check_circle"],
  ["question", "Question", "help"],
  ["warning", "Warning", "warning"],
  ["danger", "Danger", "bolt"],
  ["bug", "Bug", "bug_report"],
  ["example", "Example", "list"],
  ["quote", "Quote", "format_quote"],
];

type Item =
  | { sep: true }
  | { icon: string; title: string; run: (v: EditorView, e: React.MouseEvent) => void; sep?: false };

export function FormatBar({ view }: { view: () => EditorView | null }) {
  const showMenu = useApp((s) => s.showMenu);
  const menuAt = (e: React.MouseEvent, items: MenuItem[]) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    showMenu({ clientX: r.left, clientY: r.bottom + 4 }, items);
  };
  const items: Item[] = [
    {
      icon: "format_h1",
      title: "Heading",
      run: (v, e) =>
        menuAt(e, [
          ...[1, 2, 3, 4, 5, 6].map((n) => ({ label: `Heading ${n}`, icon: `format_h${n}`, action: () => setHeading(v, n) })),
          { separator: true },
          { label: "Normal text", icon: "format_paragraph", action: () => setHeading(v, 0) },
        ]),
    },
    { sep: true },
    { icon: "format_bold", title: `Bold (${modKey}+B)`, run: (v) => wrap(v, "**") },
    { icon: "format_italic", title: `Italic (${modKey}+I)`, run: (v) => wrap(v, "*") },
    { icon: "format_strikethrough", title: `Strikethrough (${modKey}+⇧+X)`, run: (v) => wrap(v, "~~") },
    { icon: "ink_highlighter", title: `Highlight (${modKey}+⇧+H)`, run: (v) => wrap(v, "==") },
    { icon: "code", title: `Inline code (${modKey}+\`)`, run: (v) => wrap(v, "`") },
    { sep: true },
    { icon: "format_list_bulleted", title: "Bulleted list", run: (v) => toggleLinePrefix(v, "bullet") },
    { icon: "format_list_numbered", title: "Numbered list", run: (v) => toggleLinePrefix(v, "number") },
    { icon: "checklist", title: `Task list (${modKey}+Enter)`, run: (v) => toggleLinePrefix(v, "task") },
    { icon: "format_quote", title: "Quote", run: (v) => toggleLinePrefix(v, "quote") },
    { sep: true },
    { icon: "link", title: "Link", run: (v) => insertLink(v) },
    { icon: "note_stack", title: `Internal link [[…]] (${modKey}+K)`, run: (v) => wrap(v, "[[", "]]") },
    { icon: "table", title: "Table", run: (v) => insertBlock(v, TABLE_TEMPLATE) },
    { icon: "data_object", title: "Code block", run: (v) => insertBlock(v, CODE_TEMPLATE) },
    {
      icon: "chat_info",
      title: "Callout",
      run: (v, e) =>
        menuAt(e, [
          ...CALLOUTS.map(([type, label, icon]) => ({ label, icon, action: () => insertBlock(v, calloutTemplate(type)) })),
          { separator: true },
          {
            label: "Custom callout",
            icon: "palette",
            action: () => insertBlock(v, "> [(blue),(star),(|CURSOR|Label)]\n> {sel}\n"),
          },
        ]),
    },
    { icon: "horizontal_rule", title: "Divider", run: (v) => insertBlock(v, HR_TEMPLATE) },
  ];
  return (
    <div className="format-bar-wrap">
      <div className="format-bar" role="toolbar" aria-label="Formatting">
        {items.map((it, i) =>
          it.sep ? (
            <span key={i} className="format-bar-sep" />
          ) : (
            <button
              key={i}
              className="icon-button"
              title={it.title}
              // Keep the editor's selection: don't let the button take focus.
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                const v = view();
                if (v) it.run(v, e);
              }}
            >
              <Icon name={it.icon} size={18} />
            </button>
          ),
        )}
      </div>
    </div>
  );
}
