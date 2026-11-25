import { useEffect, useState } from "react";

/** Spinner that only appears if the wait lasts longer than `delay` ms (avoids flicker on fast loads). */
export function Spinner({ label, delay = 250 }: { label?: string; delay?: number }) {
  const [show, setShow] = useState(delay === 0);
  useEffect(() => {
    const t = setTimeout(() => setShow(true), delay);
    return () => clearTimeout(t);
  }, [delay]);
  if (!show) return null;
  return (
    <div className="loading" role="status" aria-live="polite">
      <div className="spinner" />
      {label && <div className="muted small">{label}</div>}
    </div>
  );
}
