import emojiData from "markdown-it-emoji/lib/data/full.mjs";
import { useMemo, useRef, useState } from "react";
import { MATERIAL_ICONS } from "../lib/icons";
import { Icon, UserIcon } from "./Icon";

const EMOJI = Object.entries(emojiData);

/** Pick either a Material Symbol or an emoji. Value: icon name or the emoji character. */
export function IconPicker({ value, onChange, fallback }: { value: string; onChange: (v: string) => void; fallback: string }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"icons" | "emoji">("icons");
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  const icons = useMemo(() => MATERIAL_ICONS.filter((n) => n.includes(q.toLowerCase().trim())), [q]);
  const emoji = useMemo(() => EMOJI.filter(([n]) => n.includes(q.toLowerCase().trim())).slice(0, 400), [q]);
  const custom = /^[a-z0-9_]+$/.test(q.trim()) && !MATERIAL_ICONS.includes(q.trim()) ? q.trim() : null;

  return (
    <div className="icon-picker" ref={ref}>
      <button className="btn icon-picker-button" onClick={() => setOpen(!open)} title="Choose icon">
        <UserIcon value={value} fallback={fallback} size={20} />
      </button>
      {open && (
        <div
          className="icon-picker-pop"
          onMouseLeave={() => undefined}
          onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setOpen(false))}
        >
          <div className="row">
            <input className="input" autoFocus placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
            <button className="icon-button" title="Remove icon" onClick={() => (onChange(""), setOpen(false))}>
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
                <button key={n} title={n} onClick={() => (onChange(n), setOpen(false))}>
                  <Icon name={n} size={20} />
                </button>
              ))}
            {tab === "emoji" &&
              emoji.map(([n, ch]) => (
                <button key={n} title={n} onClick={() => (onChange(ch), setOpen(false))}>
                  <span className="emoji-icon">{ch}</span>
                </button>
              ))}
          </div>
          <div className="muted small">
            Any name from fonts.google.com/icons works. In notes, write <code>:mi-name:</code> for icons and <code>:name:</code> for emoji.
          </div>
        </div>
      )}
    </div>
  );
}
