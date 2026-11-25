import emojiData from "markdown-it-emoji/lib/data/full.mjs";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import { MATERIAL_ICONS } from "../lib/icons";
import { Icon, UserIcon } from "./Icon";

const EMOJI = Object.entries(emojiData);

interface PickerRequest {
  x: number;
  y: number;
  value: string;
  resolve: (v: string | null) => void;
}

const usePicker = create<{ req: PickerRequest | null }>(() => ({ req: null }));

/** Opens the floating icon picker at a screen position. Resolves to the icon ("" = remove) or null if dismissed. */
export function pickIcon(at: { x: number; y: number }, value = ""): Promise<string | null> {
  usePicker.getState().req?.resolve(null);
  return new Promise((resolve) => usePicker.setState({ req: { ...at, value, resolve } }));
}

/** Button that opens the picker; value is a Material Symbol name or an emoji. */
export function IconPicker({ value, onChange, fallback }: { value: string; onChange: (v: string) => void; fallback: string }) {
  return (
    <button
      type="button"
      className="btn icon-picker-button"
      title="Choose icon"
      onClick={async (e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const v = await pickIcon({ x: r.left, y: r.bottom + 6 }, value);
        if (v !== null) onChange(v);
      }}
    >
      <UserIcon value={value} fallback={fallback} size={20} />
    </button>
  );
}

/** Rendered once at the app root; draws the picker in a portal above everything else. */
export function IconPickerHost() {
  const req = usePicker((s) => s.req);
  const [tab, setTab] = useState<"icons" | "emoji">("icons");
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });

  const close = (v: string | null) => {
    req?.resolve(v);
    usePicker.setState({ req: null });
    setQ("");
  };

  useLayoutEffect(() => {
    if (!req || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(req.x, window.innerWidth - r.width - 8));
    const top = req.y + r.height > window.innerHeight - 8 ? Math.max(8, req.y - r.height - 12) : req.y;
    setPos({ left, top });
  }, [req]);

  useEffect(() => {
    if (!req) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close(null);
      }
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  });

  const query = q.toLowerCase().trim();
  const icons = useMemo(() => MATERIAL_ICONS.filter((n) => n.includes(query)), [query]);
  const emoji = useMemo(() => EMOJI.filter(([n]) => n.includes(query)).slice(0, 400), [query]);
  const custom = /^[a-z0-9_]+$/.test(query) && !MATERIAL_ICONS.includes(query) ? query : null;
  if (!req) return null;

  return createPortal(
    <div className="icon-picker-pop" ref={ref} style={pos} onMouseDown={(e) => e.stopPropagation()}>
      <div className="row">
        <input
          className="input"
          autoFocus
          placeholder="Search icons…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && tab === "icons" && (custom || icons[0])) close(custom ?? icons[0]);
          }}
        />
        <button className="icon-button" title="Remove icon" onClick={() => close("")}>
          <Icon name="block" size={18} />
        </button>
      </div>
      <div className="segmented small">
        <button className={tab === "icons" ? "active" : ""} onClick={() => setTab("icons")}>Material icons</button>
        <button className={tab === "emoji" ? "active" : ""} onClick={() => setTab("emoji")}>Emoji</button>
      </div>
      <div className="icon-grid">
        {tab === "icons" &&
          [...(custom ? [custom] : []), ...icons].map((n) => (
            <button key={n} title={n} className={req.value === n ? "active" : ""} onClick={() => close(n)}>
              <Icon name={n} size={20} />
            </button>
          ))}
        {tab === "emoji" &&
          emoji.map(([n, ch]) => (
            <button key={n} title={n} className={req.value === ch ? "active" : ""} onClick={() => close(ch)}>
              <span className="emoji-icon">{ch}</span>
            </button>
          ))}
        {tab === "icons" && !icons.length && !custom && <div className="muted small">No match.</div>}
      </div>
      <div className="muted tiny">
        Any name from fonts.google.com/icons works. In notes: <code>:mi-name:</code> for icons, <code>:name:</code> for emoji.
      </div>
    </div>,
    document.body,
  );
}
