import { autocompletion } from "@codemirror/autocomplete";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import * as yaml from "js-yaml";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { absolutePath, copyText, deletePath, movePath, openLink, revealInOS, saveAttachments } from "../actions";
import { markdownCompletions } from "../editor/completions";
import { livePreview, refreshLivePreview } from "../editor/livePreview";
import {
  baseExtensions,
  gutters,
  languageFor,
  lineNumbersCompartment,
  livePreviewCompartment,
  markdownKeymap,
  placeholder,
  spellcheckCompartment,
  vimCompartment,
} from "../editor/setup";
import { KanbanView } from "../kanban/KanbanView";
import { isKanban } from "../kanban/format";
import { renderMarkdown } from "../markdown/render";
import { drawingSvg } from "../excalidraw/load";
import { Prec } from "@codemirror/state";
import { vim } from "@replit/codemirror-vim";
import { Suspense, lazy } from "react";

const ExcalidrawView = lazy(() => import("../excalidraw/ExcalidrawView"));
import { Icon } from "../components/Icon";
import { api, rawUrl } from "../lib/api";
import { bridge, modKey } from "../lib/bridge";
import { registerSaver, setActiveEditor } from "../lib/editorRegistry";
import { onFilesChanged } from "../lib/events";
import { AUDIO_EXTS, basename, dirname, displayName, extOf, splitExt } from "../lib/links";
import type { FileEntry, FileKind, ViewMode } from "../lib/types";
import { type MenuItem, type Tab, reportError, useApp, useWorkspace } from "../store";
import { ReadingView, findHeadingLine } from "./ReadingView";
import { CMEditor as CMEditorHost } from "./CMEditor";

const TEXT_KINDS: FileKind[] = ["markdown", "text", "json", "yaml", "excalidraw"];

export function FileView({ tab, active }: { tab: Tab; active: boolean }) {
  const file = useWorkspace((s) => s.files.find((f) => f.path === tab.path));
  if (!file) {
    return (
      <div className="view">
        <ViewHeader tab={tab} />
        <div className="view-empty muted">
          <Icon name="search_off" size={40} />
          <p>“{tab.path}” no longer exists.</p>
        </div>
      </div>
    );
  }
  if (file.kind === "excalidraw" && tab.mode !== "source") return <DrawingView tab={tab} file={file} />;
  if (TEXT_KINDS.includes(file.kind)) return <TextDocumentView key={tab.id} tab={tab} file={file} active={active} />;
  return <BinaryView tab={tab} file={file} />;
}

// ============================================================================ header
function ViewHeader({ tab, actions, extraMenu }: { tab: Tab; actions?: React.ReactNode; extraMenu?: MenuItem[] }) {
  const ws = useWorkspace();
  const folders = dirname(tab.path).split("/").filter(Boolean);
  const menu = (e: React.MouseEvent) =>
    useApp.getState().showMenu(e, [
      ...(extraMenu ?? []),
      ...(extraMenu?.length ? [{ separator: true } as MenuItem] : []),
      { label: "Open in new window", icon: "open_in_new", action: () => bridge.openWindow({ vault: ws.vaultId ?? "", file: tab.path }) },
      { label: "Copy path", icon: "content_copy", action: () => copyText(tab.path) },
      { label: "Reveal in file manager", icon: "folder_open", action: () => revealInOS(tab.path) },
      {
        label: "Open with default app",
        icon: "launch",
        action: () => {
          const p = absolutePath(tab.path);
          if (p) bridge.openPath(p);
        },
      },
      { separator: true },
      { label: "Delete file", icon: "delete", danger: true, action: () => deletePath(tab.path, false) },
    ]);
  return (
    <div className="view-header">
      <div className="view-nav">
        <button className="icon-button" disabled={!tab.back.length} onClick={ws.goBack} title="Back">
          <Icon name="arrow_back" size={18} />
        </button>
        <button className="icon-button" disabled={!tab.forward.length} onClick={ws.goForward} title="Forward">
          <Icon name="arrow_forward" size={18} />
        </button>
      </div>
      <div className="view-breadcrumb">
        {folders.map((f, i) => (
          <span key={i} className="crumb">
            <button
              onClick={() => {
                const path = folders.slice(0, i + 1).join("/");
                for (let j = 1; j <= i + 1; j++) ws.toggleFolder(folders.slice(0, j).join("/"), true);
                ws.set({ selected: path, leftOpen: true, leftTab: "files" });
              }}
            >
              {f}
            </button>
            <span className="crumb-sep">/</span>
          </span>
        ))}
        <span className="crumb current">{displayName(tab.path)}</span>
      </div>
      <div className="view-actions">
        {actions}
        <button className="icon-button" onClick={menu} title="More options">
          <Icon name="more_vert" size={18} />
        </button>
      </div>
    </div>
  );
}

// ============================================================================ text documents
function TextDocumentView({ tab, file, active }: { tab: Tab; file: FileEntry; active: boolean }) {
  const vaultId = useWorkspace((s) => s.vaultId)!;
  const resolver = useWorkspace((s) => s.resolver);
  const settings = useApp((s) => s.settings);
  const isMarkdown = file.kind === "markdown" || (file.kind === "excalidraw" && /\.md$/i.test(file.path));
  const isDrawingSource = file.kind === "excalidraw";
  const mode: ViewMode = isMarkdown && !isDrawingSource ? tab.mode : "source";

  const [loaded, setLoaded] = useState<{ path: string; content: string; nonce: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [saveState, setSaveState] = useState<"saved" | "dirty" | "saving">("saved");
  const savedRef = useRef("");
  const currentRef = useRef("");
  const pathRef = useRef(tab.path);
  const timer = useRef<number | undefined>(undefined);
  const viewRef = useRef<EditorView | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastEditMode = useRef<ViewMode>(tab.mode === "reading" ? "live" : tab.mode);
  const [focusTarget, setFocusTarget] = useState<{ line: number; nonce: number } | null>(null);
  const boardRef = useRef(false);

  // ---------------------------------------------------------------- persistence
  const save = useCallback(async () => {
    window.clearTimeout(timer.current);
    const content = currentRef.current;
    const path = pathRef.current;
    if (content === savedRef.current) return;
    setSaveState("saving");
    try {
      await api.writeFile(vaultId, path, content);
      savedRef.current = content;
      setSaveState(currentRef.current === content ? "saved" : "dirty");
      useWorkspace.setState((s) => ({ dirty: { ...s.dirty, [path]: currentRef.current !== content } }));
    } catch (e) {
      setSaveState("dirty");
      reportError(e);
    }
  }, [vaultId]);

  useEffect(() => registerSaver(tab.id, save), [tab.id, save]);

  const load = useCallback(
    async (path: string) => {
      try {
        const info = await api.readFile(vaultId, path);
        const content = info.content ?? "";
        savedRef.current = currentRef.current = content;
        setText(content);
        setLoaded({ path, content, nonce: Date.now() });
        setSaveState("saved");
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [vaultId],
  );

  useEffect(() => {
    const previous = pathRef.current;
    if (previous !== tab.path && currentRef.current !== savedRef.current) {
      // Navigated away inside the same tab: persist the previous file first.
      if (useWorkspace.getState().files.some((f) => f.path === previous)) save();
    }
    pathRef.current = tab.path;
    if (loaded?.path === tab.path) return;
    // A rename keeps the content: reuse it instead of reloading.
    if (loaded && previous !== tab.path && savedRef.current === currentRef.current && !useWorkspace.getState().files.some((f) => f.path === previous)) {
      setLoaded({ path: tab.path, content: currentRef.current, nonce: loaded.nonce });
      return;
    }
    load(tab.path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.path]);

  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
      if (currentRef.current !== savedRef.current) {
        api.writeFile(vaultId, pathRef.current, currentRef.current).catch(reportError);
      }
    },
    [vaultId],
  );

  // External edits (other window, another app, sync…) reload when there are no local changes.
  useEffect(
    () =>
      onFilesChanged(async (paths) => {
        if (!paths.includes(pathRef.current) || currentRef.current !== savedRef.current) return;
        try {
          const info = await api.readFile(vaultId, pathRef.current);
          const content = info.content ?? "";
          if (content === currentRef.current) return;
          savedRef.current = currentRef.current = content;
          setText(content);
          const view = viewRef.current;
          if (view) {
            const sel = view.state.selection.main;
            view.dispatch({
              changes: { from: 0, to: view.state.doc.length, insert: content },
              selection: { anchor: Math.min(sel.anchor, content.length) },
            });
            savedRef.current = currentRef.current = content;
          }
        } catch {
          /* file gone; the tab will show "no longer exists" */
        }
      }),
    [vaultId],
  );

  const onChange = useCallback(
    (next: string) => {
      currentRef.current = next;
      const dirty = next !== savedRef.current;
      setSaveState(dirty ? "dirty" : "saved");
      if (useWorkspace.getState().dirty[pathRef.current] !== dirty) {
        useWorkspace.setState((s) => ({ dirty: { ...s.dirty, [pathRef.current]: dirty } }));
      }
      window.clearTimeout(timer.current);
      if (dirty) timer.current = window.setTimeout(save, useApp.getState().settings.autosaveDelay);
      if (tabModeRef.current === "reading" || boardRef.current) setText(next);
      else scheduleTextUpdate(next);
    },
    [save],
  );

  // Throttled copy of the text for the status bar.
  const textTimer = useRef<number | undefined>(undefined);
  const scheduleTextUpdate = (next: string) => {
    window.clearTimeout(textTimer.current);
    textTimer.current = window.setTimeout(() => setText(next), 300);
  };
  const tabModeRef = useRef(mode);
  tabModeRef.current = mode;

  useEffect(() => {
    if (mode === "reading") setText(currentRef.current);
    else lastEditMode.current = mode;
  }, [mode]);

  // ---------------------------------------------------------------- editor extensions
  const extensions = useMemo<Extension[]>(() => {
    const ws = useWorkspace.getState;
    const ext: Extension[] = [
      vimCompartment.of(settings.vimMode ? Prec.highest(vim()) : []),
      ...baseExtensions({
        lineNumbers: isMarkdown ? settings.showLineNumbers : true,
        folding: isMarkdown ? settings.foldHeadings : true,
        spellcheck: isMarkdown && settings.spellcheck,
        wrap: true,
      }),
      languageFor(isMarkdown ? "markdown" : file.kind === "excalidraw" ? "json" : file.kind),
      EditorView.domEventHandlers({
        focus: (_e, view) => setActiveEditor(view),
      }),
    ];
    if (isMarkdown) {
      ext.push(
        markdownKeymap,
        placeholder("Start writing…"),
        autocompletion({
          override: [
            markdownCompletions({
              files: () => ws().files,
              tags: () => tagCache,
            }),
          ],
          icons: false,
        }),
        livePreviewCompartment.of(
          mode === "source"
            ? []
            : livePreview({
                resolver: () => ws().resolver,
                path: () => pathRef.current,
                imageUrl: (p) => rawUrl(vaultId, p),
                openLink: (target, newTab) => openLink(target, pathRef.current, newTab),
                openTag: (tag) => ws().set({ leftOpen: true, leftTab: "search", searchQuery: `tag:${tag}` }),
                openExternal: (url) => bridge.openExternal(url),
                render: (md) => renderMarkdown(md, { resolver: ws().resolver, path: pathRef.current }).html,
                propertiesMode: () => useApp.getState().settings.propertiesInDocument,
                drawingSvg: (p) => drawingSvg(vaultId, p),
              }),
        ),
        EditorView.domEventHandlers({
          paste: (e, view) => {
            const files = Array.from(e.clipboardData?.files ?? []);
            if (!files.length) return false;
            e.preventDefault();
            insertAttachments(view, files, view.state.selection.main.head);
            return true;
          },
          drop: (e, view) => {
            const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? view.state.selection.main.head;
            const internal = e.dataTransfer?.getData("application/x-brain2-path");
            if (internal) {
              e.preventDefault();
              const [stem, ext] = splitExt(basename(internal));
              const link = ext === "md" ? stem : basename(internal);
              const embed = ext && ext !== "md" ? "!" : "";
              view.dispatch({ changes: { from: pos, insert: `${embed}[[${link}]]` } });
              return true;
            }
            const files = Array.from(e.dataTransfer?.files ?? []);
            if (!files.length) return false;
            e.preventDefault();
            insertAttachments(view, files, pos);
            return true;
          },
        }),
      );
    }
    return ext;
    // Extensions are rebuilt only when the document identity changes; settings are reconfigured below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded?.nonce]);

  // Reconfigure on settings/mode changes without resetting the document.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const showNumbers = isMarkdown ? settings.showLineNumbers : true;
    const folding = isMarkdown ? settings.foldHeadings : true;
    view.dispatch({
      effects: [
        lineNumbersCompartment.reconfigure(gutters(showNumbers, folding)),
        vimCompartment.reconfigure(settings.vimMode ? Prec.highest(vim()) : []),
        spellcheckCompartment.reconfigure(
          EditorView.contentAttributes.of({ spellcheck: isMarkdown && settings.spellcheck ? "true" : "false", autocorrect: "on" }),
        ),
      ],
    });
  }, [settings.showLineNumbers, settings.spellcheck, settings.foldHeadings, settings.vimMode, isMarkdown]);

  // Re-render widgets (tables, properties) when rendering preferences change.
  useEffect(() => {
    viewRef.current?.dispatch({ effects: refreshLivePreview.of(null) });
  }, [settings.propertiesInDocument, settings.strictLineBreaks]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !isMarkdown || mode === "reading") return;
    const ws = useWorkspace.getState;
    view.dispatch({
      effects: livePreviewCompartment.reconfigure(
        mode === "source"
          ? []
          : livePreview({
              resolver: () => ws().resolver,
              path: () => pathRef.current,
              imageUrl: (p) => rawUrl(vaultId, p),
              openLink: (target, newTab) => openLink(target, pathRef.current, newTab),
              openTag: (tag) => ws().set({ leftOpen: true, leftTab: "search", searchQuery: `tag:${tag}` }),
              openExternal: (url) => bridge.openExternal(url),
              render: (md) => renderMarkdown(md, { resolver: ws().resolver, path: pathRef.current }).html,
              propertiesMode: () => useApp.getState().settings.propertiesInDocument,
              drawingSvg: (p) => drawingSvg(vaultId, p),
            }),
      ),
    });
  }, [mode, isMarkdown, vaultId]);

  // Re-decorate when the vault's file list changes (links may become resolved).
  useEffect(() => {
    viewRef.current?.dispatch({ effects: refreshLivePreview.of(null) });
  }, [resolver]);

  // Tag cache for autocompletion.
  const revision = useWorkspace((s) => s.revision);
  useEffect(() => {
    if (isMarkdown) api.tags(vaultId).then((t) => (tagCache = t.map((x) => x.tag))).catch(() => undefined);
  }, [vaultId, revision, isMarkdown]);

  // Focus/scroll requests (search results, backlinks, outline, heading links).
  useEffect(() => {
    if (!loaded || tab.focusNonce === undefined) return;
    let line = tab.focusLine;
    if (tab.focusHeading) line = findHeadingLine(currentRef.current, tab.focusHeading) ?? line;
    if (line === undefined) return;
    setFocusTarget({ line, nonce: tab.focusNonce });
    const view = viewRef.current;
    if (view && mode !== "reading") {
      const l = view.state.doc.line(Math.min(line + 1, view.state.doc.lines));
      view.dispatch({ selection: { anchor: l.from }, effects: EditorView.scrollIntoView(l.from, { y: "start", yMargin: 80 }) });
      view.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.focusNonce, loaded?.nonce]);

  useEffect(() => {
    if (active && mode !== "reading") setActiveEditor(viewRef.current);
  }, [active, mode]);

  useCtrlScrollZoom(scrollRef);

  const toggleTask = (line: number, checked: boolean) => {
    const view = viewRef.current;
    if (!view) return;
    const l = view.state.doc.line(line + 1);
    const m = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX\-/])\]/.exec(l.text);
    if (!m) return;
    const at = l.from + m[1].length;
    view.dispatch({ changes: { from: at, to: at + 1, insert: checked ? "x" : " " } });
  };

  const setMode = (m: ViewMode) => useWorkspace.getState().setMode(tab.id, m);
  const toggleReading = () => setMode(mode === "reading" ? lastEditMode.current : "reading");

  // Keyboard shortcut / menu: toggle reading view for the active tab.
  useEffect(() => {
    if (!active || !isMarkdown) return;
    const handler = () => toggleReading();
    window.addEventListener("brain2:toggle-reading", handler);
    return () => window.removeEventListener("brain2:toggle-reading", handler);
  });

  if (error) {
    return (
      <div className="view">
        <ViewHeader tab={tab} />
        <div className="view-empty muted">
          <Icon name="error" size={40} />
          <p>{error}</p>
        </div>
      </div>
    );
  }

  const board = isMarkdown && !isDrawingSource && mode !== "source" && !!loaded && isKanban(text || loaded.content);
  boardRef.current = board;
  const replaceDoc = (next: string) => {
    const v = viewRef.current;
    if (v && v.state.doc.toString() !== next) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: next } });
  };
  const kanbanSource = isMarkdown && !isDrawingSource && mode === "source" && isKanban(text);

  const words = text.trim() ? (text.replace(/^---[\s\S]*?\n---/, "").match(/\S+/g)?.length ?? 0) : 0;
  const validation = file.kind === "json" ? validateJson(text) : file.kind === "yaml" ? validateYaml(text) : null;

  return (
    <div className={`view view-${file.kind}`}>
      <ViewHeader
        tab={tab}
        actions={
          board ? (
            <button className="icon-button" onClick={() => setMode("source")} title="Edit as markdown">
              <Icon name="code" size={18} />
            </button>
          ) : kanbanSource ? (
            <button className="icon-button" onClick={() => setMode("live")} title="Open as board">
              <Icon name="view_kanban" size={18} />
            </button>
          ) : isDrawingSource ? (
            <button className="icon-button" onClick={() => setMode("live")} title="Open as drawing">
              <Icon name="draw" size={18} />
            </button>
          ) : (
            isMarkdown && (
              <button
                className="icon-button"
                onClick={toggleReading}
                title={mode === "reading" ? `Edit (${modKey}+E)` : `Reading view (${modKey}+E)`}
              >
                <Icon name={mode === "reading" ? "edit" : "chrome_reader_mode"} size={18} />
              </button>
            )
          )
        }
        extraMenu={
          isMarkdown && !isDrawingSource && !board
            ? [
                { label: "Live preview", icon: mode === "live" ? "check" : "visibility", action: () => setMode("live") },
                { label: "Source mode", icon: mode === "source" ? "check" : "code", action: () => setMode("source") },
                { label: "Reading view", icon: mode === "reading" ? "check" : "chrome_reader_mode", action: () => setMode("reading") },
              ]
            : []
        }
      />
      <div
        className={`view-content${isMarkdown && settings.readableLineLength && !board ? " readable" : ""}${
          board ? " board-view" : isMarkdown && !isDrawingSource ? ` mode-${mode}` : " code-file"
        }`}
        ref={scrollRef}
      >
        {board && <KanbanView text={text} path={tab.path} onChange={replaceDoc} />}
        <div className="note-container" style={board ? { display: "none" } : undefined}>
          {isMarkdown && !isDrawingSource && settings.showInlineTitle && (
            <InlineTitle path={tab.path} onEnter={() => viewRef.current?.focus()} />
          )}
          {loaded && mode === "reading" && (
            <ReadingView
              text={text}
              path={tab.path}
              onToggleTask={toggleTask}
              focusLine={focusTarget?.line}
              focusNonce={focusTarget?.nonce}
            />
          )}
          {loaded && (
            <div style={mode === "reading" ? { display: "none" } : undefined}>
              <CMEditorHost
                doc={loaded.content}
                docKey={`${loaded.nonce}`}
                extensions={extensions}
                onChange={onChange}
                onView={(v) => (viewRef.current = v)}
              />
            </div>
          )}
        </div>
      </div>
      <div className="status-bar">
        {validation && <span className={validation.ok ? "ok" : "error"}>{validation.message}</span>}
        {isMarkdown && <span>{mode === "reading" ? "Reading" : mode === "live" ? "Live preview" : "Source"}</span>}
        <span>{words} words</span>
        <span>{text.length} characters</span>
        <span className={`save-state ${saveState}`}>
          {saveState === "saved" ? "Saved" : saveState === "saving" ? "Saving…" : "Edited"}
        </span>
      </div>
    </div>
  );
}

let tagCache: string[] = [];

async function insertAttachments(view: EditorView, files: File[], pos: number) {
  const paths = await saveAttachments(files);
  if (!paths.length) return;
  const resolver = useWorkspace.getState().resolver;
  const text = paths
    .map((p) => {
      const name = basename(p);
      // Use the short name when it resolves uniquely, like Obsidian's "shortest path" setting.
      const short = resolver.resolve(name, null) === p ? name : p;
      return `![[${short}]]`;
    })
    .join("\n");
  view.dispatch({ changes: { from: pos, insert: text }, selection: { anchor: pos + text.length } });
}

function validateJson(text: string): { ok: boolean; message: string } {
  if (!text.trim()) return { ok: true, message: "Empty" };
  try {
    JSON.parse(text);
    return { ok: true, message: "Valid JSON" };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Invalid JSON" };
  }
}

function validateYaml(text: string): { ok: boolean; message: string } {
  try {
    yaml.loadAll(text);
    return { ok: true, message: "Valid YAML" };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message.split("\n")[0] : "Invalid YAML" };
  }
}

/** Obsidian's inline title: edit the file name right above the note. */
function InlineTitle({ path, onEnter }: { path: string; onEnter: () => void }) {
  const [value, setValue] = useState(displayName(path));
  useEffect(() => setValue(displayName(path)), [path]);
  const commit = async () => {
    const name = value.trim();
    if (!name || name === displayName(path)) return setValue(displayName(path));
    if (/[\\/:*?"<>|]/.test(name)) {
      reportError(new Error('File names cannot contain \\ / : * ? " < > |'));
      return setValue(displayName(path));
    }
    const ext = extOf(path) || "md";
    const dir = dirname(path);
    await movePath(path, `${dir ? `${dir}/` : ""}${name}.${ext}`);
  };
  return (
    <input
      className="inline-title"
      value={value}
      spellCheck={false}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
          onEnter();
        } else if (e.key === "Escape") {
          setValue(displayName(path));
          onEnter();
        }
      }}
    />
  );
}

/** Ctrl/⌘ + mouse wheel (or trackpad pinch) changes the document font size. */
export function useCtrlScrollZoom(ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let acc = 0;
    const onWheel = (e: WheelEvent) => {
      const app = useApp.getState();
      if (!(e.ctrlKey || e.metaKey) || !app.settings.ctrlScrollZoom) return;
      e.preventDefault();
      acc += e.deltaY;
      if (Math.abs(acc) < 30) return;
      const step = acc < 0 ? 1 : -1;
      acc = 0;
      const next = Math.max(10, Math.min(32, app.settings.fontSize + step));
      if (next !== app.settings.fontSize) app.updateSettings({ fontSize: next });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [ref]);
}

// ============================================================================ drawings
function DrawingView({ tab, file }: { tab: Tab; file: FileEntry }) {
  const vaultId = useWorkspace((s) => s.vaultId)!;
  const setMode = (m: ViewMode) => useWorkspace.getState().setMode(tab.id, m);
  return (
    <div className="view view-excalidraw">
      <ViewHeader
        tab={tab}
        actions={
          <button className="icon-button" onClick={() => setMode("source")} title={/\.md$/i.test(file.path) ? "Edit as markdown" : "Edit as JSON"}>
            <Icon name="code" size={18} />
          </button>
        }
      />
      <div className="view-content binary">
        <Suspense fallback={<div className="view-empty"><div className="spinner" /></div>}>
          <ExcalidrawView vaultId={vaultId} path={file.path} tabId={tab.id} />
        </Suspense>
      </div>
    </div>
  );
}

// ============================================================================ binary files
function BinaryView({ tab, file }: { tab: Tab; file: FileEntry }) {
  const vaultId = useWorkspace((s) => s.vaultId)!;
  const url = `${rawUrl(vaultId, file.path)}&v=${file.mtime}`;
  const ext = extOf(file.path) || file.ext;
  let body: React.ReactNode;
  if (file.kind === "pdf") {
    body = <iframe className="pdf-view" src={url} title={file.name} />;
  } else if (file.kind === "image") {
    body = (
      <div className="image-view">
        <img src={url} alt={file.name} />
      </div>
    );
  } else if (file.kind === "media") {
    body = (
      <div className="image-view">
        {AUDIO_EXTS.has(ext) ? <audio controls src={url} /> : <video controls src={url} />}
      </div>
    );
  } else {
    body = (
      <div className="view-empty muted">
        <Icon name="draft" size={40} />
        <p>BRAIN2 can’t preview “{file.name}” yet.</p>
        <button
          className="btn"
          onClick={() => {
            const p = absolutePath(file.path);
            if (p) bridge.openPath(p);
          }}
        >
          Open with default app
        </button>
      </div>
    );
  }
  return (
    <div className="view">
      <ViewHeader tab={tab} />
      <div className="view-content binary">{body}</div>
    </div>
  );
}
