import { useApp } from "../store";

const LIMITS = { left: [180, 560], right: [200, 600] } as const;
const DEFAULTS = { left: 268, right: 280 };

/** Drag handle on a panel edge. Width is applied live and saved when the drag ends. */
export function Resizer({ side }: { side: "left" | "right" }) {
  const key = side === "left" ? "leftWidth" : "rightWidth";
  const cssVar = side === "left" ? "--left-width" : "--right-width";
  const clamp = (w: number) => Math.round(Math.min(LIMITS[side][1], Math.max(LIMITS[side][0], w)));

  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = useApp.getState().settings[key];
    let width = startW;
    document.body.classList.add("resizing");
    const move = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      width = clamp(side === "left" ? startW + dx : startW - dx);
      document.documentElement.style.setProperty(cssVar, `${width}px`);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.classList.remove("resizing");
      if (width !== startW) useApp.getState().updateSettings({ [key]: width });
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return (
    <div
      className={`resizer resizer-${side}`}
      role="separator"
      aria-orientation="vertical"
      title="Drag to resize · double-click to reset"
      onMouseDown={onMouseDown}
      onDoubleClick={() => useApp.getState().updateSettings({ [key]: DEFAULTS[side] })}
    />
  );
}
