import { type ReactNode, useEffect } from "react";
import { Icon } from "./Icon";

export function Modal({ title, onClose, children, className, footer }: {
  title?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  footer?: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${className ? ` ${className}` : ""}`} role="dialog" aria-modal="true">
        {title !== undefined && (
          <div className="modal-header">
            <div className="modal-title">{title}</div>
            <button className="icon-button" onClick={onClose} aria-label="Close">
              <Icon name="close" size={20} />
            </button>
          </div>
        )}
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}
