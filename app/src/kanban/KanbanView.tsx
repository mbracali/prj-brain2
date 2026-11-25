import { useEffect, useMemo, useRef, useState } from "react";
import { openLink } from "../actions";
import { Icon } from "../components/Icon";
import { bridge } from "../lib/bridge";
import { renderMarkdown } from "../markdown/render";
import { type MenuItem, confirmDialog, promptDialog, useApp, useWorkspace } from "../store";
import { type Board, type Card, type Lane, parseBoard, serializeBoard, uid } from "./format";

const CARD_TYPE = "application/x-brain2-card";
const LANE_TYPE = "application/x-brain2-lane";

/** Renders a markdown kanban board; every change is written back as markdown via `onChange`. */
export function KanbanView({ text, path, onChange }: { text: string; path: string; onChange: (next: string) => void }) {
  const [board, setBoard] = useState<Board>(() => parseBoard(text));
  const lastText = useRef(text);
  const [showArchive, setShowArchive] = useState(false);
  const [adding, setAdding] = useState(false);

  // Re-parse when the markdown changes from elsewhere (source mode, another app).
  useEffect(() => {
    if (text !== lastText.current) {
      lastText.current = text;
      setBoard(parseBoard(text));
    }
  }, [text]);

  const commit = (next: Board) => {
    setBoard(next);
    const md = serializeBoard(next);
    lastText.current = md;
    onChange(md);
  };

  const updateLane = (laneId: string, fn: (l: Lane) => Lane) =>
    commit({ ...board, lanes: board.lanes.map((l) => (l.id === laneId ? fn(l) : l)) });

  const moveCard = (cardId: string, toLane: string, index: number) => {
    let card: Card | undefined;
    const lanes = board.lanes.map((l) => {
      const i = l.cards.findIndex((c) => c.id === cardId);
      if (i < 0) return l;
      card = l.cards[i];
      return { ...l, cards: l.cards.filter((c) => c.id !== cardId) };
    });
    if (!card) return;
    commit({
      ...board,
      lanes: lanes.map((l) => {
        if (l.id !== toLane) return l;
        const cards = [...l.cards];
        cards.splice(Math.min(index, cards.length), 0, l.complete ? { ...card!, checked: true } : card!);
        return { ...l, cards };
      }),
    });
  };

  const moveLane = (laneId: string, index: number) => {
    const lanes = [...board.lanes];
    const from = lanes.findIndex((l) => l.id === laneId);
    const [lane] = lanes.splice(from, 1);
    lanes.splice(index > from ? index - 1 : index, 0, lane);
    commit({ ...board, lanes });
  };

  return (
    <div className="kanban">
      <div className="kanban-lanes">
        {board.lanes.map((lane, li) => (
          <LaneView
            key={lane.id}
            lane={lane}
            index={li}
            path={path}
            onUpdate={(fn) => updateLane(lane.id, fn)}
            onMoveCard={moveCard}
            onMoveLane={moveLane}
            onDelete={async () => {
              if (lane.cards.length && !(await confirmDialog("Delete list", `Delete “${lane.title}” and its ${lane.cards.length} cards?`, { danger: true, okLabel: "Delete" })))
                return;
              commit({ ...board, lanes: board.lanes.filter((l) => l.id !== lane.id) });
            }}
            onArchive={(cards) =>
              commit({
                ...board,
                lanes: board.lanes.map((l) => (l.id === lane.id ? { ...l, cards: l.cards.filter((c) => !cards.includes(c)) } : l)),
                archive: [...board.archive, ...cards],
              })
            }
          />
        ))}
        <div className="kanban-add-lane">
          {adding ? (
            <InlineInput
              placeholder="List title"
              onDone={(title) => {
                setAdding(false);
                if (title) commit({ ...board, lanes: [...board.lanes, { id: uid(), title, cards: [], complete: false }] });
              }}
            />
          ) : (
            <button className="kanban-add" onClick={() => setAdding(true)}>
              <Icon name="add" size={18} /> Add a list
            </button>
          )}
        </div>
      </div>
      {board.archive.length > 0 && (
        <div className="kanban-archive">
          <button className="kanban-add" onClick={() => setShowArchive(!showArchive)}>
            <Icon name={showArchive ? "expand_more" : "chevron_right"} size={18} /> Archive ({board.archive.length})
          </button>
          {showArchive && (
            <div className="kanban-archive-list">
              {board.archive.map((c) => (
                <div key={c.id} className="kanban-card archived">
                  <CardBody card={c} path={path} />
                  <button
                    className="icon-button"
                    title="Restore to first list"
                    onClick={() =>
                      commit({
                        ...board,
                        archive: board.archive.filter((x) => x.id !== c.id),
                        lanes: board.lanes.map((l, i) => (i === 0 ? { ...l, cards: [...l.cards, c] } : l)),
                      })
                    }
                  >
                    <Icon name="unarchive" size={16} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function LaneView({
  lane,
  index,
  path,
  onUpdate,
  onMoveCard,
  onMoveLane,
  onDelete,
  onArchive,
}: {
  lane: Lane;
  index: number;
  path: string;
  onUpdate: (fn: (l: Lane) => Lane) => void;
  onMoveCard: (cardId: string, lane: string, index: number) => void;
  onMoveLane: (laneId: string, index: number) => void;
  onDelete: () => void;
  onArchive: (cards: Card[]) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const [laneDrop, setLaneDrop] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const indexFromEvent = (e: React.DragEvent) => {
    const cards = Array.from(listRef.current?.querySelectorAll<HTMLElement>(".kanban-card") ?? []);
    const i = cards.findIndex((c) => {
      const r = c.getBoundingClientRect();
      return e.clientY < r.top + r.height / 2;
    });
    return i < 0 ? cards.length : i;
  };

  const menu = (e: React.MouseEvent) =>
    useApp.getState().showMenu(e, [
      {
        label: "Rename list…",
        icon: "edit",
        action: async () => {
          const title = await promptDialog("Rename list", { value: lane.title, okLabel: "Rename" });
          if (title) onUpdate((l) => ({ ...l, title }));
        },
      },
      {
        label: lane.complete ? "Unmark as complete list" : "Mark as complete list",
        icon: "task_alt",
        action: () => onUpdate((l) => ({ ...l, complete: !l.complete })),
      },
      { label: "Archive completed cards", icon: "archive", action: () => onArchive(lane.cards.filter((c) => c.checked)) },
      { label: "Archive all cards", icon: "inventory_2", action: () => onArchive(lane.cards) },
      { separator: true },
      { label: "Delete list", icon: "delete", danger: true, action: onDelete },
    ] as MenuItem[]);

  return (
    <div
      className={`kanban-lane${laneDrop ? " lane-drop" : ""}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(LANE_TYPE)) {
          e.preventDefault();
          setLaneDrop(true);
        }
      }}
      onDragLeave={() => setLaneDrop(false)}
      onDrop={(e) => {
        const id = e.dataTransfer.getData(LANE_TYPE);
        setLaneDrop(false);
        if (id) {
          e.preventDefault();
          onMoveLane(id, index);
        }
      }}
    >
      <div
        className="kanban-lane-header"
        draggable
        onDragStart={(e) => e.dataTransfer.setData(LANE_TYPE, lane.id)}
        onDoubleClick={async () => {
          const title = await promptDialog("Rename list", { value: lane.title, okLabel: "Rename" });
          if (title) onUpdate((l) => ({ ...l, title }));
        }}
      >
        <span className="kanban-lane-title">{lane.title}</span>
        {lane.complete && <Icon name="task_alt" size={16} className="muted" />}
        <span className="kanban-count">{lane.cards.length}</span>
        <button className="icon-button" onClick={menu} title="List options">
          <Icon name="more_horiz" size={18} />
        </button>
      </div>
      <div
        className="kanban-cards"
        ref={listRef}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(CARD_TYPE)) return;
          e.preventDefault();
          setDropAt(indexFromEvent(e));
        }}
        onDragLeave={(e) => {
          if (!listRef.current?.contains(e.relatedTarget as Node)) setDropAt(null);
        }}
        onDrop={(e) => {
          const id = e.dataTransfer.getData(CARD_TYPE);
          if (!id) return;
          e.preventDefault();
          e.stopPropagation();
          const at = indexFromEvent(e);
          setDropAt(null);
          // Dropping below itself in the same lane shifts the index by one.
          const from = lane.cards.findIndex((c) => c.id === id);
          onMoveCard(id, lane.id, from >= 0 && from < at ? at - 1 : at);
        }}
      >
        {lane.cards.map((c, i) => (
          <div key={c.id}>
            {dropAt === i && <div className="kanban-drop-line" />}
            <CardView
              card={c}
              path={path}
              onChange={(next) => onUpdate((l) => ({ ...l, cards: l.cards.map((x) => (x.id === c.id ? next : x)) }))}
              onDelete={() => onUpdate((l) => ({ ...l, cards: l.cards.filter((x) => x.id !== c.id) }))}
              onArchive={() => onArchive([c])}
            />
          </div>
        ))}
        {dropAt === lane.cards.length && <div className="kanban-drop-line" />}
      </div>
      {adding ? (
        <InlineInput
          multiline
          placeholder="Card text… (Enter to add, Shift+Enter for a new line)"
          onDone={(text, keepOpen) => {
            if (text) onUpdate((l) => ({ ...l, cards: [...l.cards, { id: uid(), text, checked: l.complete }] }));
            setAdding(!!keepOpen && !!text);
          }}
        />
      ) : (
        <button className="kanban-add" onClick={() => setAdding(true)}>
          <Icon name="add" size={18} /> Add a card
        </button>
      )}
    </div>
  );
}

function CardView({ card, path, onChange, onDelete, onArchive }: {
  card: Card;
  path: string;
  onChange: (c: Card) => void;
  onDelete: () => void;
  onArchive: () => void;
}) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <div className="kanban-card editing">
        <InlineInput
          multiline
          initial={card.text}
          onDone={(text) => {
            setEditing(false);
            if (text && text !== card.text) onChange({ ...card, text });
          }}
        />
      </div>
    );
  }
  return (
    <div
      className={`kanban-card${card.checked ? " checked" : ""}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(CARD_TYPE, card.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      onDoubleClick={() => setEditing(true)}
      onContextMenu={(e) => {
        e.preventDefault();
        useApp.getState().showMenu(e, [
          { label: "Edit card", icon: "edit", action: () => setEditing(true) },
          { label: card.checked ? "Mark as not done" : "Mark as done", icon: "check", action: () => onChange({ ...card, checked: !card.checked }) },
          { label: "Archive card", icon: "archive", action: onArchive },
          { separator: true },
          { label: "Delete card", icon: "delete", danger: true, action: onDelete },
        ]);
      }}
    >
      <input
        type="checkbox"
        className="task-checkbox"
        checked={card.checked}
        onChange={() => onChange({ ...card, checked: !card.checked })}
      />
      <CardBody card={card} path={path} />
      <button className="icon-button kanban-card-edit" title="Edit" onClick={() => setEditing(true)}>
        <Icon name="edit" size={15} />
      </button>
    </div>
  );
}

function CardBody({ card, path }: { card: Card; path: string }) {
  const resolver = useWorkspace((s) => s.resolver);
  const html = useMemo(() => renderMarkdown(card.text, { resolver, path }).html, [card.text, resolver, path]);
  return (
    <div
      className="kanban-card-body markdown-rendered"
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(e) => {
        const el = e.target as HTMLElement;
        const link = el.closest<HTMLAnchorElement>("a.internal-link");
        if (link) {
          e.preventDefault();
          openLink((link.dataset.href ?? "") + (link.dataset.fragment ? `#${link.dataset.fragment}` : ""), path, e.metaKey || e.ctrlKey);
          return;
        }
        const tag = el.closest<HTMLElement>("a.tag");
        if (tag) {
          e.preventDefault();
          useWorkspace.getState().set({ leftOpen: true, leftTab: "search", searchQuery: `tag:${tag.dataset.tag}` });
          return;
        }
        const ext = el.closest<HTMLAnchorElement>("a.external-link");
        if (ext) {
          e.preventDefault();
          bridge.openExternal(ext.href);
        }
      }}
    />
  );
}

function InlineInput({ initial = "", placeholder, multiline, onDone }: {
  initial?: string;
  placeholder?: string;
  multiline?: boolean;
  onDone: (value: string, keepOpen?: boolean) => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    }
  }, [value]);
  const finish = (v: string, keepOpen?: boolean) => {
    if (done.current && !keepOpen) return;
    if (!keepOpen) done.current = true;
    onDone(v.trim(), keepOpen);
    if (keepOpen) setValue("");
  };
  return (
    <textarea
      ref={ref}
      className="kanban-input"
      rows={multiline ? 2 : 1}
      value={value}
      placeholder={placeholder}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !(multiline && e.shiftKey)) {
          e.preventDefault();
          finish(value, !initial && !!multiline);
        } else if (e.key === "Escape") {
          e.preventDefault();
          done.current = true;
          onDone(initial);
        }
      }}
    />
  );
}
