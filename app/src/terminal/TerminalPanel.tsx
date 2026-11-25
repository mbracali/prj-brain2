// Bottom terminal panel (VS Code style): one tab per terminal, resizable, available in every module.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { modKey } from "../lib/bridge";
import { promptDialog, useApp } from "../store";
import { getSession, restyleSessions } from "./sessions";
import { contextFolder, useTerminals } from "./store";

function TerminalView({ id }: { id: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const height = useTerminals((s) => s.height);
  const maximized = useTerminals((s) => s.maximized);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const session = getSession(id);
    session.onExit = () => useTerminals.getState().refresh();
    session.attach(el);
    session.term.focus();
    const ro = new ResizeObserver(() => session.fitNow());
    ro.observe(el);
    return () => ro.disconnect();
  }, [id]);
  useEffect(() => {
    getSession(id).fitNow();
  }, [id, height, maximized]);
  return <div className="terminal-view" ref={ref} />;
}

export function TerminalPanel({ forced }: { forced?: boolean }) {
  const { terminals, activeId, open, height, maximized } = useTerminals();
  const settings = useApp((s) => s.settings);
  const [dragging, setDragging] = useState(false);
  const visible = open || forced;

  useEffect(() => {
    // Restyle after the theme variables have been applied.
    const t = setTimeout(restyleSessions, 50);
    return () => clearTimeout(t);
  }, [settings]);

  useEffect(() => {
    if (forced && !terminals.length) useTerminals.getState().create({ cwd: contextFolder() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forced]);

  if (!visible) return null;

  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    setDragging(true);
    const move = (ev: PointerEvent) => useTerminals.getState().setHeight(startH + (startY - ev.clientY));
    const up = () => {
      setDragging(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const t = useTerminals.getState();
  const active = terminals.find((x) => x.id === activeId) ?? null;

  return (
    <section
      className={`terminal-panel${maximized ? " maximized" : ""}${dragging ? " dragging" : ""}`}
      style={maximized ? undefined : { height }}
    >
      <div className="terminal-resizer" onPointerDown={startDrag} onDoubleClick={() => t.setHeight(260)} />
      <header className="terminal-header">
        <span className="terminal-heading">
          <Icon name="terminal" size={16} /> Terminal
        </span>
        <div className="terminal-tabs" role="tablist">
          {terminals.map((term) => (
            <div
              key={term.id}
              role="tab"
              aria-selected={term.id === activeId}
              className={`terminal-tab${term.id === activeId ? " active" : ""}${term.alive ? "" : " exited"}`}
              title={`${term.title} — ${term.cwd} (${term.shell})`}
              onClick={() => t.activate(term.id)}
              onDoubleClick={async () => {
                const title = await promptDialog("Rename terminal", { value: term.title, okLabel: "Rename" });
                if (title) t.rename(term.id, title);
              }}
              onAuxClick={(e) => e.button === 1 && t.close(term.id)}
            >
              <Icon name={term.key?.startsWith("repo:") ? "account_tree" : term.key?.startsWith("vault:") ? "sync" : "terminal"} size={15} />
              <span className="terminal-tab-title">{term.title}</span>
              <button
                className="terminal-tab-close"
                title="Kill terminal"
                onClick={(e) => {
                  e.stopPropagation();
                  t.close(term.id);
                }}
              >
                <Icon name="close" size={14} />
              </button>
            </div>
          ))}
        </div>
        <div className="terminal-actions">
          <button className="icon-button" title={`New terminal (${modKey === "⌘" ? "⌃" : "Ctrl"}+⇧+\`)`} onClick={() => t.create({ cwd: contextFolder() })}>
            <Icon name="add" size={18} />
          </button>
          <button
            className="icon-button"
            title="Kill active terminal"
            disabled={!active}
            onClick={() => active && t.close(active.id)}
          >
            <Icon name="delete" size={18} />
          </button>
          <button className="icon-button" title={maximized ? "Restore panel size" : "Maximize panel"} onClick={() => t.setMaximized(!maximized)}>
            <Icon name={maximized ? "keyboard_arrow_down" : "keyboard_arrow_up"} size={18} />
          </button>
          {!forced && (
            <button className="icon-button" title={`Hide terminal (${modKey === "⌘" ? "⌃" : "Ctrl"}+\`)`} onClick={() => t.setOpen(false)}>
              <Icon name="close" size={18} />
            </button>
          )}
        </div>
      </header>
      <div className="terminal-body">
        {active ? (
          <TerminalView key={active.id} id={active.id} />
        ) : (
          <div className="empty small">
            No terminal open.
            <button className="btn btn-small" onClick={() => t.create({ cwd: contextFolder() })}>
              <Icon name="add" size={16} /> New terminal
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
