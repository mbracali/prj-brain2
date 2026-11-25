import type { CSSProperties } from "react";

/** Google Material Symbols (bundled locally via the `material-symbols` package). */
export function Icon({ name, size, fill, className, style, title }: {
  name: string;
  size?: number;
  fill?: boolean;
  className?: string;
  style?: CSSProperties;
  title?: string;
}) {
  return (
    <span
      className={`material-symbols-outlined icon${fill ? " icon-fill" : ""}${className ? ` ${className}` : ""}`}
      style={size ? { fontSize: size, ...style } : style}
      aria-hidden={title ? undefined : true}
      title={title}
    >
      {name}
    </span>
  );
}

/** Renders a user chosen icon: an emoji, or a Material Symbol name. */
export function UserIcon({ value, fallback, size }: { value: string | null | undefined; fallback: string; size?: number }) {
  const v = value?.trim();
  if (v && /^[a-z0-9_]+$/.test(v)) return <Icon name={v} size={size} />;
  if (v) return <span className="emoji-icon" style={size ? { fontSize: size * 0.9 } : undefined}>{v}</span>;
  return <Icon name={fallback} size={size} />;
}
