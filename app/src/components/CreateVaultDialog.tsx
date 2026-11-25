import { useState } from "react";
import { api } from "../lib/api";
import { bridge, isElectron } from "../lib/bridge";
import { reportError, useApp } from "../store";
import { Icon } from "./Icon";
import { IconPicker } from "./IconPicker";
import { Modal } from "./Modal";
import { Spinner } from "./Spinner";

export function CreateVaultDialog() {
  const open = useApp((s) => s.createVaultOpen);
  const setOpen = useApp((s) => s.setCreateVaultOpen);
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");
  const [icon, setIcon] = useState("");
  const [busy, setBusy] = useState(false);

  if (!open) return null;
  const close = () => {
    setOpen(false);
    setName("");
    setFolder("");
    setIcon("");
    setMode("new");
  };

  const pick = async () => {
    const p = await bridge.pickFolder();
    if (p) {
      setFolder(p);
      if (!name) setName(p.split(/[\\/]/).filter(Boolean).pop() ?? "");
    }
  };

  const submit = async () => {
    if (!name.trim() || (mode === "existing" && !folder.trim())) return;
    setBusy(true);
    try {
      const vault = await api.createVault({
        name: name.trim(),
        path: mode === "existing" ? folder.trim() : undefined,
        icon: icon || undefined,
      });
      await useApp.getState().loadVaults();
      close();
      useApp.getState().navigate({ module: "vault", vaultId: vault.id });
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Create a vault"
      onClose={close}
      className="modal-medium"
      footer={
        <>
          <button className="btn" onClick={close}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !name.trim()} onClick={submit}>
            {mode === "new" ? "Create vault" : "Open as vault"}
          </button>
        </>
      }
    >
      <div className="segmented">
        <button className={mode === "new" ? "active" : ""} onClick={() => setMode("new")}>
          <Icon name="create_new_folder" size={18} /> New vault
        </button>
        <button className={mode === "existing" ? "active" : ""} onClick={() => setMode("existing")}>
          <Icon name="folder_open" size={18} /> Open folder as vault
        </button>
      </div>
      <p className="muted small">
        {mode === "new"
          ? "A new folder is created inside BRAIN2's internal-vaults directory."
          : "Any folder on your disk can be a vault — including an existing Obsidian vault. Files stay where they are."}
      </p>
      {mode === "existing" && (
        <>
          <label className="field-label">Folder</label>
          <div className="row">
            <input
              className="input"
              value={folder}
              placeholder="/path/to/folder"
              onChange={(e) => setFolder(e.target.value)}
            />
            {isElectron && (
              <button className="btn" onClick={pick}>Browse…</button>
            )}
          </div>
        </>
      )}
      {busy && <Spinner label="Creating and indexing the vault… large folders can take a moment." delay={300} />}
      <label className="field-label">Name</label>
      <div className="row">
        <IconPicker value={icon} onChange={setIcon} fallback="inventory_2" />
        <input
          className="input"
          autoFocus
          value={name}
          placeholder="My vault"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
      </div>
    </Modal>
  );
}
