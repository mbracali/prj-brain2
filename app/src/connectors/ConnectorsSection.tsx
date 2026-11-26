// Settings → Account connectors: account providers (calendars/email), LLM providers, chat providers.
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { Modal } from "../components/Modal";
import { accountsApi } from "../lib/api";
import { bridge } from "../lib/bridge";
import type { Account, Connectors, ProviderInfo, ProviderKind } from "../lib/calTypes";
import { confirmDialog, promptDialog, reportError, useApp } from "../store";

const GROUPS: { kind: ProviderKind; title: string; description: string; add: string; empty: string }[] = [
  {
    kind: "account",
    title: "Account providers",
    description: "Google, Microsoft and Apple accounts. Calendars use them today; email comes later.",
    add: "Add account",
    empty: "No accounts connected yet.",
  },
  {
    kind: "llm",
    title: "LLM providers",
    description: "Language models for the Echoes module. You can connect them now; BRAIN2 doesn't use them yet.",
    add: "Add LLM provider",
    empty: "No LLM providers connected yet.",
  },
  {
    kind: "chat",
    title: "Chat providers",
    description: "Chat platforms for the Message queues module. You can connect them now; BRAIN2 doesn't use them yet.",
    add: "Add chat account",
    empty: "No chat accounts connected yet.",
  },
];

function connectLabel(p: ProviderInfo): string {
  return p.connect === "oauth" ? "Browser sign-in" : p.connect === "password" ? "CalDAV · app-specific password" :
    p.connect === "cli" ? (p.detected ? `Detected: ${p.detected}` : "Command-line tool — not installed") :
    p.connect === "token" ? "Token" : "API key";
}

const FIELD_LABEL: Record<string, string> = { client_id: "Client ID", client_secret: "Client secret", tenant: "Tenant (optional)" };

export function useConnectors() {
  const [data, setData] = useState<Connectors | null>(null);
  const load = useCallback(() => accountsApi.connectors().then(setData).catch(reportError), []);
  useEffect(() => {
    load();
    const onChange = () => load();
    window.addEventListener("brain2:accounts-changed", onChange);
    return () => window.removeEventListener("brain2:accounts-changed", onChange);
  }, [load]);
  return { data, load };
}

function AccountRow({ account, provider, onChanged }: { account: Account; provider?: ProviderInfo; onChanged: () => void }) {
  return (
    <div className={`connector-account${account.status === "error" ? " has-error" : ""}`}>
      <Icon name={provider?.icon ?? "account_circle"} size={20} className="connector-account-provider" />
      <div className="connector-account-text">
        <strong>
          {account.nickname}
          <span className="muted tiny connector-account-kind">{provider?.name ?? account.provider}</span>
        </strong>
        {account.email && account.email !== account.nickname && <span className="muted small">{account.email}</span>}
        {account.error && <span className="danger-text tiny">{account.error}</span>}
      </div>
      <Icon name={account.status === "error" ? "error" : "check_circle"} size={18} className="connector-account-status" />
      <button
        className="icon-button"
        title="Rename"
        onClick={async () => {
          const nickname = await promptDialog("Account nickname", { value: account.nickname, okLabel: "Save" });
          if (nickname) await accountsApi.renameAccount(account.id, nickname).then(onChanged).catch(reportError);
        }}
      >
        <Icon name="edit" size={17} />
      </button>
      <button
        className="icon-button"
        title="Disconnect"
        onClick={async () => {
          const ok = await confirmDialog(
            "Disconnect account",
            `Disconnect “${account.nickname}”? Its stored credentials are deleted and calendars stop showing its events.`,
            { okLabel: "Disconnect", danger: true },
          );
          if (ok) await accountsApi.removeAccount(account.id).then(onChanged).catch(reportError);
        }}
      >
        <Icon name="link_off" size={17} />
      </button>
    </div>
  );
}

function SetupForm({ provider, onSaved }: { provider: ProviderInfo; onSaved: () => void }) {
  const fields = provider.id === "google" ? ["client_id", "client_secret"] : provider.id === "microsoft" ? ["client_id", "tenant"] : [];
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f, f === "client_secret" ? "" : provider.config[f] ?? ""])),
  );
  const [busy, setBusy] = useState(false);
  return (
    <div className="connector-setup">
      <p className="muted small">{provider.help}</p>
      {fields.map((f) => (
        <label key={f} className="connector-field">
          <span>{FIELD_LABEL[f]}</span>
          <input
            className="input"
            type={f === "client_secret" ? "password" : "text"}
            placeholder={f === "client_secret" && provider.config.client_secret ? "•••••••• (saved — type to replace)" : f === "tenant" ? "common" : ""}
            value={values[f]}
            onChange={(e) => setValues({ ...values, [f]: e.target.value })}
          />
        </label>
      ))}
      <div className="row">
        <button
          className="btn btn-primary btn-small"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const body = { ...values };
            if (!body.client_secret) delete body.client_secret; // keep the saved one
            await accountsApi.configureProvider(provider.id, body).then(onSaved).catch(reportError);
            setBusy(false);
          }}
        >
          Save
        </button>
      </div>
    </div>
  );
}

function OAuthConnect({ provider, onDone }: { provider: ProviderInfo; onDone: () => void }) {
  const [waiting, setWaiting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearInterval(timer.current), []);
  const start = async () => {
    setError(null);
    try {
      const flow = await accountsApi.startOAuth(provider.id);
      setWaiting(flow.flow_id);
      await bridge.openExternal(flow.auth_url);
      timer.current = window.setInterval(async () => {
        const st = await accountsApi.oauthStatus(flow.flow_id).catch(() => null);
        if (!st || st.state === "pending") return;
        window.clearInterval(timer.current);
        setWaiting(null);
        if (st.state === "error") setError(st.error ?? "Sign-in failed");
        else {
          useApp.getState().toast(`Connected ${st.account?.email ?? provider.name}`);
          onDone();
        }
      }, 1500);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <>
      {waiting ? (
        <div className="connector-waiting">
          <Icon name="open_in_browser" size={18} className="pulse" /> Finish signing in in your browser…
          <button className="btn btn-small" onClick={() => (window.clearInterval(timer.current), setWaiting(null))}>Cancel</button>
        </div>
      ) : (
        <button className="btn btn-small" disabled={!provider.configured} onClick={start}>
          <Icon name="add_link" size={16} /> Connect {provider.name} account
        </button>
      )}
      {error && <div className="danger-text small">{error}</div>}
    </>
  );
}

function AppleConnect({ onDone, startOpen = false }: { onDone: () => void; startOpen?: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const [appleId, setAppleId] = useState("");
  const [password, setPassword] = useState("");
  const [nickname, setNickname] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!open)
    return (
      <button className="btn btn-small" onClick={() => setOpen(true)}>
        <Icon name="add_link" size={16} /> Connect iCloud account
      </button>
    );
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const acc = await accountsApi.connectApple({ apple_id: appleId, app_password: password, nickname: nickname || undefined });
      useApp.getState().toast(`Connected ${acc.email}`);
      setOpen(false);
      setPassword("");
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="connector-setup">
      <label className="connector-field"><span>Apple ID</span>
        <input className="input" type="email" value={appleId} onChange={(e) => setAppleId(e.target.value)} placeholder="you@icloud.com" />
      </label>
      <label className="connector-field"><span>App-specific password</span>
        <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="xxxx-xxxx-xxxx-xxxx" onKeyDown={(e) => e.key === "Enter" && submit()} />
      </label>
      <label className="connector-field"><span>Nickname (optional)</span>
        <input className="input" value={nickname} onChange={(e) => setNickname(e.target.value)} placeholder="Personal" />
      </label>
      {error && <div className="danger-text small">{error}</div>}
      <div className="row">
        {!startOpen && <button className="btn" onClick={() => setOpen(false)}>Cancel</button>}
        <button className="btn btn-primary btn-small" disabled={busy || !appleId || !password} onClick={submit}>{busy ? "Checking…" : "Connect"}</button>
      </div>
    </div>
  );
}

function SecretConnect({ provider, onDone, startOpen = false }: { provider: ProviderInfo; onDone: () => void; startOpen?: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const [secret, setSecret] = useState("");
  const [nickname, setNickname] = useState("");
  if (provider.connect === "cli") {
    return provider.detected ? (
      <button className="btn btn-small" onClick={() => accountsApi.connectSecret({ provider: provider.id, secret: "", nickname: provider.name }).then(onDone).catch(reportError)}>
        <Icon name="add_link" size={16} /> Use installed CLI
      </button>
    ) : (
      <span className="muted small">Not installed on this machine</span>
    );
  }
  if (!open)
    return (
      <button className="btn btn-small" onClick={() => setOpen(true)}>
        <Icon name="add_link" size={16} /> Add {provider.connect === "token" ? "token" : "API key"}
      </button>
    );
  return (
    <div className="connector-setup">
      <label className="connector-field"><span>{provider.connect === "token" ? "Token" : "API key"}</span>
        <input className="input" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} />
      </label>
      <label className="connector-field"><span>Nickname (optional)</span>
        <input className="input" value={nickname} onChange={(e) => setNickname(e.target.value)} />
      </label>
      <div className="row">
        {!startOpen && <button className="btn" onClick={() => setOpen(false)}>Cancel</button>}
        <button
          className="btn btn-primary btn-small"
          disabled={!secret.trim()}
          onClick={() =>
            accountsApi
              .connectSecret({ provider: provider.id, secret, nickname: nickname || undefined })
              .then(() => (setOpen(false), setSecret(""), onDone()))
              .catch(reportError)
          }
        >
          Save
        </button>
      </div>
    </div>
  );
}

/** "Add account" flow: pick a provider of the group, then connect it. */
function AddAccountDialog({
  kind,
  title,
  providers,
  onClose,
  onChanged,
}: {
  kind: ProviderKind;
  title: string;
  providers: ProviderInfo[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [pickedId, setPickedId] = useState<string | null>(providers.length === 1 ? providers[0].id : null);
  const picked = providers.find((p) => p.id === pickedId) ?? null;
  const [setup, setSetup] = useState(false);
  const done = () => {
    onChanged();
    onClose();
  };
  return (
    <Modal
      title={
        <>
          {picked && providers.length > 1 && (
            <button className="icon-button" title="Choose another provider" onClick={() => (setPickedId(null), setSetup(false))}>
              <Icon name="arrow_back" size={18} />
            </button>
          )}
          <Icon name={picked?.icon ?? (kind === "llm" ? "neurology" : kind === "chat" ? "forum" : "add_link")} size={20} />
          {picked ? `Connect ${picked.name}` : title}
        </>
      }
      onClose={onClose}
      className="modal-medium add-account-dialog"
    >
      {!picked ? (
        <>
          <p className="muted small">Choose a provider. You can add several accounts of the same provider — each one is listed separately.</p>
          <div className="provider-grid">
            {providers.map((p) => (
              <button key={p.id} className="provider-choice" onClick={() => (setPickedId(p.id), setSetup(p.needs_setup && !p.configured))}>
                <Icon name={p.icon} size={24} />
                <span className="provider-choice-text">
                  <strong>{p.name}</strong>
                  <span className="muted tiny">{connectLabel(p)}</span>
                </span>
                {!p.usable && <span className="kind-badge">not used yet</span>}
              </button>
            ))}
          </div>
        </>
      ) : (
        <div className="connector-flow">
          {!picked.needs_setup && <p className="muted small">{picked.help}</p>}
          {picked.needs_setup && (setup || !picked.configured) ? (
            <SetupForm provider={picked} onSaved={() => (setSetup(false), onChanged())} />
          ) : (
            picked.needs_setup && (
              <button className="link-button small" onClick={() => setSetup(true)}>
                <Icon name="key" size={16} /> Your {picked.name} app credentials
              </button>
            )
          )}
          {(!picked.needs_setup || (picked.configured && !setup)) && (
            <div className="connector-actions">
              {picked.connect === "oauth" ? (
                <OAuthConnect provider={picked} onDone={done} />
              ) : picked.connect === "password" ? (
                <AppleConnect onDone={done} startOpen />
              ) : (
                <SecretConnect provider={picked} onDone={done} startOpen />
              )}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

export function ConnectorsSection() {
  const { data, load } = useConnectors();
  const [adding, setAdding] = useState<ProviderKind | null>(null);
  if (!data) return <h2>Account connectors</h2>;
  const byId = Object.fromEntries(data.providers.map((p) => [p.id, p]));
  const group = GROUPS.find((g) => g.kind === adding);
  return (
    <>
      <h2>Account connectors</h2>
      <p className="muted small">
        Passwords, tokens and keys are stored in the {data.keychain}, never in BRAIN2's database. BRAIN2 talks to each provider
        directly from your machine; there is no BRAIN2 server in between.
      </p>
      {GROUPS.map((g) => {
        const accounts = data.accounts.filter((a) => (byId[a.provider]?.kind ?? a.kind) === g.kind);
        return (
          <section key={g.kind} className="connector-group">
            <div className="connector-group-head">
              <h3>{g.title}</h3>
              <button className="btn btn-small" onClick={() => setAdding(g.kind)}>
                <Icon name="add" size={16} /> {g.add}
              </button>
            </div>
            <p className="muted small">{g.description}</p>
            <div className="connector-card">
              {accounts.length ? (
                accounts.map((a) => <AccountRow key={a.id} account={a} provider={byId[a.provider]} onChanged={load} />)
              ) : (
                <div className="connector-empty muted small">{g.empty}</div>
              )}
            </div>
          </section>
        );
      })}
      {group && (
        <AddAccountDialog
          kind={group.kind}
          title={group.add}
          providers={data.providers.filter((p) => p.kind === group.kind)}
          onClose={() => setAdding(null)}
          onChanged={load}
        />
      )}
    </>
  );
}
