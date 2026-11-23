import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useApp } from "../store";
import { Icon } from "./Icon";

export function ContextMenu() {
  const menu = useApp((s) => s.contextMenu);
  const close = useApp((s) => s.closeMenu);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  useLayoutEffect(() => {
    if (!menu || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({
      x: Math.min(menu.x, window.innerWidth - r.width - 8),
      y: Math.min(menu.y, window.innerHeight - r.height - 8),
    });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", close);
    };
  }, [menu, close]);

  if (!menu) return null;
  return (
    <div className="menu" ref={ref} style={{ left: pos.x, top: pos.y }} role="menu">
      {menu.items.map((item, i) =>
        item.separator ? (
          <div key={i} className="menu-separator" />
        ) : (
          <button
            key={i}
            className={`menu-item${item.danger ? " danger" : ""}`}
            disabled={item.disabled}
            role="menuitem"
            onClick={() => {
              close();
              item.action?.();
            }}
          >
            <Icon name={item.icon ?? "chevron_right"} size={18} className={item.icon ? "" : "invisible"} />
            <span>{item.label}</span>
          </button>
        ),
      )}
    </div>
  );
}
