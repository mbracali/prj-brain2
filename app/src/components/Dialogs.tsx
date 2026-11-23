import { useEffect, useRef, useState } from "react";
import { useApp } from "../store";
import { Modal } from "./Modal";

export function Dialogs() {
  const dialog = useApp((s) => s.dialog);
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (dialog?.kind === "prompt") {
      setValue(dialog.value ?? "");
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [dialog]);

  if (!dialog) return null;
  const close = (result: string | null | boolean) => {
    useApp.setState({ dialog: null });
    if (dialog.kind === "prompt") dialog.resolve(typeof result === "string" ? result.trim() || null : null);
    else dialog.resolve(result === true);
  };

  if (dialog.kind === "prompt") {
    return (
      <Modal
        title={dialog.title}
        onClose={() => close(null)}
        className="modal-small"
        footer={
          <>
            <button className="btn" onClick={() => close(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={() => close(value)}>{dialog.okLabel ?? "OK"}</button>
          </>
        }
      >
        {dialog.label && <label className="field-label">{dialog.label}</label>}
        <input
          ref={inputRef}
          className="input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && close(value)}
        />
      </Modal>
    );
  }
  return (
    <Modal
      title={dialog.title}
      onClose={() => close(false)}
      className="modal-small"
      footer={
        <>
          <button className="btn" onClick={() => close(false)}>Cancel</button>
          <button className={`btn ${dialog.danger ? "btn-danger" : "btn-primary"}`} autoFocus onClick={() => close(true)}>
            {dialog.okLabel ?? "OK"}
          </button>
        </>
      }
    >
      <p>{dialog.message}</p>
    </Modal>
  );
}

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`}>{t.text}</div>
      ))}
    </div>
  );
}
