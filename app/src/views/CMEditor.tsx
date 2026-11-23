import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useEffect, useRef } from "react";

/**
 * Thin React wrapper around a CodeMirror view.
 * `docKey` identifies the document: when it changes the editor state (and undo history) is replaced.
 */
export function CMEditor({
  doc,
  docKey,
  extensions,
  onChange,
  onView,
  className,
}: {
  doc: string;
  docKey: string;
  extensions: Extension[];
  onChange: (text: string) => void;
  onView?: (view: EditorView | null) => void;
  className?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const makeState = (text: string) =>
    EditorState.create({
      doc: text,
      extensions: [
        ...extensions,
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current(u.state.doc.toString());
        }),
      ],
    });

  useEffect(() => {
    const view = new EditorView({ state: makeState(doc), parent: host.current! });
    viewRef.current = view;
    onView?.(view);
    return () => {
      onView?.(null);
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (view && view.state.doc.toString() !== doc) view.setState(makeState(doc));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey]);

  return <div className={className} ref={host} />;
}
