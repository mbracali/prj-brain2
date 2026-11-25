// Forms of the repos module: clone, create, locate and remove. Every step is mirrored in a terminal tab.
import { useEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { IconPicker } from "../components/IconPicker";
import { Modal } from "../components/Modal";
import { api } from "../lib/api";
import { bridge, isElectron } from "../lib/bridge";
import type { Repo, RepoInspect } from "../lib/repoTypes";
import { reportError, useApp } from "../store";
import { useTerminals } from "../terminal/store";
import { useRepos } from "./store";

function lastFolder() {
  return useApp.getState().settings.reposFolder || "";
}

/** A terminal tab dedicated to the open form; selecting folders `cd`s it so the user sees where things go. */
function useFormTerminal(key: string, title: string, folder: string) {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    useTerminals
      .getState()
      .showKey(key, title, folder || undefined)
      .then((t) => alive && t && setId(t.id));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const cd = (path: string) => {
    if (id && path) api.terminalCd(id, path).catch(() => undefined);
  };
  return { id, cd };
}

function ErrorBox({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div className="form-warning" role="alert">
      <Icon name="warning" size={20} />
      <div>
        <strong>That didn't work.</strong>
        <pre>{error}</pre>
      </div>
    </div>
  );
}

function FolderField({ label, value, onChange, onPicked, placeholder }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onPicked: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <>
      <label className="field-label">{label}</label>
      <div className="row">
        <input
          className="input"
          value={value}
          placeholder={placeholder ?? "/path/to/folder"}
          onChange={(e) => onChange(e.target.value)}
          onBlur={(e) => e.target.value && onPicked(e.target.value)}
        />
        {isElectron && (
          <button
            className="btn"
            onClick={async () => {
              const p = await bridge.pickFolder();
              if (p) {
                onChange(p);
                onPicked(p);
              }
            }}
          >
            <Icon name="folder_open" size={18} /> Browse…
          </button>
        )}
      </div>
    </>
  );
}

function IdentityField({ icon, setIcon, name, setName, placeholder, onEnter }: {
  icon: string;
  setIcon: (v: string) => void;
  name: string;
  setName: (v: string) => void;
  placeholder: string;
  onEnter: () => void;
}) {
  return (
    <>
      <label className="field-label">Icon and nickname</label>
      <div className="row">
        <IconPicker value={icon} onChange={setIcon} fallback="account_tree" />
        <input
          className="input"
          value={name}
          placeholder={placeholder}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onEnter()}
        />
      </div>
    </>
  );
}

function finish(repo: Repo, onClose: () => void) {
  useRepos.getState().load().catch(reportError);
  useApp.getState().toast(`${repo.name} is ready`);
  onClose();
}

function rememberFolder(folder: string) {
  if (folder && folder !== lastFolder()) useApp.getState().updateSettings({ reposFolder: folder });
}

const repoNameFromUrl = (url: string) =>
  url.trim().replace(/\/+$/, "").split(/[/:]/).pop()?.replace(/\.git$/, "") ?? "";

export function CloneRepoDialog({ onClose }: { onClose: () => void }) {
  const [url, setUrl] = useState("");
  const [folder, setFolder] = useState(lastFolder());
  const [icon, setIcon] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const term = useFormTerminal("repos:clone", "Clone", folder);
  const urlRef = useRef<HTMLInputElement>(null);
  useEffect(() => urlRef.current?.focus(), []);

  const submit = async () => {
    setError(null);
    if (!url.trim()) return setError("Paste the https link of the repository.");
    if (!folder.trim()) return setError("Choose where the repository should be saved.");
    setBusy(true);
    try {
      rememberFolder(folder.trim());
      const repo = await api.cloneRepo({
        url: url.trim(),
        parent: folder.trim(),
        name: name.trim() || undefined,
        icon: icon || undefined,
        terminal_id: term.id ?? undefined,
      });
      await useTerminals.getState().refresh();
      finish(repo, onClose);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={<><Icon name="cloud_download" size={20} /> Clone a new repo</>}
      onClose={onClose}
      className="modal-medium repo-form"
      footer={
        <>
          <button className="btn" onClick={onClose}><Icon name="cancel" size={18} /> Cancel</button>
          <button className="btn btn-primary" disabled={busy} onClick={submit}>
            <Icon name="cloud_download" size={18} className={busy ? "pulse" : ""} /> {busy ? "Cloning…" : "Clone"}
          </button>
        </>
      }
    >
      <label className="field-label">Repository link (https)</label>
      <input
        ref={urlRef}
        className="input"
        value={url}
        placeholder="https://github.com/owner/project.git"
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
      />
      <FolderField label="Save in" value={folder} onChange={setFolder} onPicked={term.cd} />
      <p className="muted tiny">The repository is cloned into a new sub-folder named after it. BRAIN2 remembers this location.</p>
      <IdentityField icon={icon} setIcon={setIcon} name={name} setName={setName} placeholder={repoNameFromUrl(url) || "Nickname"} onEnter={submit} />
      <ErrorBox error={error} />
      <p className="muted tiny form-hint"><Icon name="terminal" size={14} /> Watch the terminal below: the clone runs there, with your own git credentials.</p>
    </Modal>
  );
}

export function CreateRepoDialog({ onClose }: { onClose: () => void }) {
  const [folder, setFolder] = useState(lastFolder());
  const [dirName, setDirName] = useState("");
  const [icon, setIcon] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const term = useFormTerminal("repos:create", "New repo", folder);
  const folderName = dirName || name.trim().replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();

  const submit = async () => {
    setError(null);
    if (!folder.trim()) return setError("Choose where the repository should be created.");
    if (!folderName) return setError("Give the repository a nickname or a folder name.");
    setBusy(true);
    try {
      rememberFolder(folder.trim());
      const repo = await api.createRepo({
        parent: folder.trim(),
        folder: folderName,
        name: name.trim() || undefined,
        icon: icon || undefined,
        terminal_id: term.id ?? undefined,
      });
      await useTerminals.getState().refresh();
      finish(repo, onClose);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={<><Icon name="add_circle" size={20} /> Create local repo</>}
      onClose={onClose}
      className="modal-medium repo-form"
      footer={
        <>
          <button className="btn" onClick={onClose}><Icon name="cancel" size={18} /> Cancel</button>
          <button className="btn btn-primary" disabled={busy} onClick={submit}>
            <Icon name="create_new_folder" size={18} /> {busy ? "Creating…" : "Create"}
          </button>
        </>
      }
    >
      <FolderField label="Location" value={folder} onChange={setFolder} onPicked={term.cd} />
      <IdentityField icon={icon} setIcon={setIcon} name={name} setName={setName} placeholder="My project" onEnter={submit} />
      <label className="field-label">Folder name</label>
      <input className="input" value={dirName} placeholder={folderName || "my-project"} onChange={(e) => setDirName(e.target.value)} />
      <p className="muted tiny">Runs <code>git init -b main {folderName || "<folder>"}</code> in the terminal.</p>
      <ErrorBox error={error} />
    </Modal>
  );
}

export function LocateRepoDialog({ onClose }: { onClose: () => void }) {
  const [folder, setFolder] = useState("");
  const [icon, setIcon] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<RepoInspect | null>(null);
  const [error, setError] = useState<string | null>(null);
  const term = useFormTerminal("repos:locate", "Locate repo", lastFolder());

  const check = async (path: string) => {
    term.cd(path);
    setError(null);
    try {
      const r = await api.inspectRepo(path);
      setInfo(r);
      if (r.ok && !name) setName(r.name ?? "");
    } catch (e) {
      setInfo(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const submit = async () => {
    setError(null);
    if (!folder.trim()) return setError("Browse to the folder of the repository.");
    setBusy(true);
    try {
      const repo = await api.locateRepo({
        path: folder.trim(),
        name: name.trim() || undefined,
        icon: icon || undefined,
        terminal_id: term.id ?? undefined,
      });
      await useTerminals.getState().refresh();
      finish(repo, onClose);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={<><Icon name="add_circle" size={20} /> Add a local cloned repo</>}
      onClose={onClose}
      className="modal-medium repo-form"
      footer={
        <>
          <button className="btn" onClick={onClose}><Icon name="cancel" size={18} /> Cancel</button>
          <button className="btn btn-primary" disabled={busy || (info !== null && !info.ok)} onClick={submit}>
            <Icon name="find_in_page" size={18} /> Locate
          </button>
        </>
      }
    >
      <FolderField label="Repository folder" value={folder} onChange={setFolder} onPicked={check} />
      {info && (
        <div className={`inspect-box${info.ok ? "" : " bad"}`}>
          {info.ok ? (
            <>
              <Icon name={info.kind === "remote" ? "cloud_done" : "folder_zip"} size={20} />
              <div>
                <strong>{info.kind === "remote" ? "Git repository with a remote" : "Local-only git repository"}</strong>
                <div className="muted small">
                  {info.path}
                  {info.branch && <> · branch <code>{info.branch}</code></>}
                  {info.remote && <> · <code>{info.remote}</code></>}
                </div>
                {info.registered && <div className="muted small">Already in BRAIN2 as “{info.registered.name}” — locating it again updates its nickname and icon.</div>}
              </div>
            </>
          ) : (
            <>
              <Icon name="error" size={20} />
              <div>{info.error}</div>
            </>
          )}
        </div>
      )}
      <IdentityField icon={icon} setIcon={setIcon} name={name} setName={setName} placeholder="Nickname" onEnter={submit} />
      <ErrorBox error={error} />
    </Modal>
  );
}

export function RemoveRepoDialog({ repo, onClose }: { repo: Repo; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const remove = async (deleteFiles: boolean) => {
    setBusy(true);
    try {
      if (deleteFiles && window.brain2?.trashItem) {
        await window.brain2.trashItem(repo.path);
        await api.removeRepo(repo.id, false);
      } else {
        await api.removeRepo(repo.id, deleteFiles);
      }
      const app = useApp.getState();
      if (app.route.module === "repo" && app.route.repoId === repo.id) app.navigate({ module: "repos" });
      await useRepos.getState().load();
      await useTerminals.getState().refresh();
      app.toast(deleteFiles ? `${repo.name} deleted` : `${repo.name} removed from BRAIN2`);
      onClose();
    } catch (e) {
      reportError(e);
      setBusy(false);
    }
  };
  return (
    <Modal
      title={<><Icon name="delete" size={20} /> Remove repo</>}
      onClose={onClose}
      className="modal-medium"
      footer={
        <>
          <button className="btn" onClick={onClose}><Icon name="cancel" size={18} /> Cancel</button>
          <button className="btn" disabled={busy} onClick={() => remove(false)}>Remove from BRAIN2</button>
          <button className="btn btn-danger" disabled={busy || !repo.exists} onClick={() => remove(true)}>
            {window.brain2?.trashItem ? "Move folder to Trash" : "Delete folder"}
          </button>
        </>
      }
    >
      <p>
        Remove <strong>{repo.name}</strong> from this machine?
      </p>
      <p className="muted small">
        “Remove from BRAIN2” only forgets it; the folder stays at <code>{repo.path}</code>.{" "}
        {repo.ahead > 0 || repo.changes > 0 ? (
          <strong className="danger-text">This repo has {repo.ahead ? `${repo.ahead} unpushed commit(s)` : ""}{repo.ahead && repo.changes ? " and " : ""}{repo.changes ? `${repo.changes} uncommitted change(s)` : ""} that would be lost.</strong>
        ) : null}
      </p>
    </Modal>
  );
}
