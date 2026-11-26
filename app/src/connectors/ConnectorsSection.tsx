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
      {provider.builtin && (
        <p className="muted small">Optional. Leave the Client ID empty to use BRAIN2's built-in sign-in.</p>
      )}
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

function OAuthConnect({
  provider,
  onDone,
  email,
  autoStart = false,
}: {
  provider: ProviderInfo;
  onDone: () => void;
  /** Open the provider's sign-in straight on this account. */
  email?: string;
  autoStart?: boolean;
}) {
  const [waiting, setWaiting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const started = useRef(false);
  useEffect(() => () => window.clearInterval(timer.current), []);
  useEffect(() => {
    if (autoStart && provider.configured && !started.current) {
      started.current = true;
      start();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart, provider.configured]);
  const start = async () => {
    setError(null);
    try {
      const flow = await accountsApi.startOAuth(provider.id, undefined, email);
      setWaiting(flow.flow_id);
      await bridge.openExternal(flow.auth_url);
      timer.current = window.setInterval(async () => {
        const st = await accountsApi.oauthStatus(flow.flow_id).catch(() => null);
        if (!st || st.state === "pending") return;
        window.clearInterval(timer.current);
        setWaiting(null);
        if (st.state === "error") setError(st.error ?? "Sign-in failed");
        else {
          useApp.getState().toast(st.note ?? `Connected ${st.account?.email ?? provider.name}`);
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
        <button className="btn btn-primary btn-small" disabled={!provider.configured} onClick={start}>
          <Icon name="login" size={16} /> {email ? `Sign in as ${email}` : `Connect ${provider.name} account`}
        </button>
      )}
      {error && <div className="danger-text small">{error}</div>}
    </>
  );
}

function AppleConnect({ onDone, startOpen = false, email = "" }: { onDone: () => void; startOpen?: boolean; email?: string }) {
  const [open, setOpen] = useState(startOpen);
  const [appleId, setAppleId] = useState(email);
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

/** "Add account" first step: type an email, BRAIN2 finds the provider (Google, Microsoft, iCloud). */
function EmailStart({ onFound }: { onFound: (provider: string | null, email: string) => void }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const go = async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      const d = await accountsApi.detect(email.trim());
      onFound(d.provider, d.email);
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="email-start">
      <label className="connector-field">
        <span>Email address</span>
        <input
          className="input"
          type="email"
          autoFocus
          placeholder="you@gmail.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && go()}
        />
      </label>
      <button className="btn btn-primary" disabled={!valid || busy} onClick={go}>
        {busy ? "Checking…" : "Continue"}
      </button>
    </div>
  );
}

/** "Add account" flow: type an email (account providers) or pick a provider, then connect it. */
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
  const [email, setEmail] = useState<string | undefined>(undefined);
  const [unknown, setUnknown] = useState<string | null>(null);
  const emailFirst = kind === "account";
  const onFound = (provider: string | null, address: string) => {
    const p = providers.find((x) => x.id === provider);
    if (!p) {
      setUnknown(address);
      return;
    }
    setUnknown(null);
    setEmail(address);
    setPickedId(p.id);
    setSetup(p.needs_setup && !p.configured);
  };
  const done = () => {
    onChanged();
    onClose();
  };
  return (
    <Modal
      title={
        <>
          {picked && providers.length > 1 && (
            <button className="icon-button" title="Back" onClick={() => (setPickedId(null), setSetup(false), setEmail(undefined))}>
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
          {emailFirst && (
            <>
              <p className="muted small">Type the email of the account you want to connect. You can add as many accounts as you like.</p>
              <EmailStart onFound={onFound} />
              {unknown && (
                <p className="small warning-text">
                  BRAIN2 couldn't tell who hosts {unknown}. Choose the provider below.
                </p>
              )}
              <div className="email-start-or muted tiny">or choose a provider</div>
            </>
          )}
          {!emailFirst && (
            <p className="muted small">Choose a provider. You can add several accounts of the same provider — each one is listed separately.</p>
          )}
          <div className="provider-grid">
            {providers.map((p) => (
              <button
                key={p.id}
                className="provider-choice"
                onClick={() => (setPickedId(p.id), setSetup(p.needs_setup && !p.configured), setEmail(unknown ?? undefined))}
              >
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
          {picked.connect === "oauth" && picked.configured && !setup && (
            <p className="muted small">
              {email ? "Your browser opens Google's sign-in page for this account. " : "Your browser opens the sign-in page. "}
              Approve access there, then come back to BRAIN2. BRAIN2 never sees your password.
            </p>
          )}
          {(!picked.needs_setup || (picked.configured && !setup)) && (
            <div className="connector-actions">
              {picked.connect === "oauth" ? (
                <OAuthConnect provider={picked} onDone={done} email={email} autoStart={!!email} />
              ) : picked.connect === "password" ? (
                <AppleConnect onDone={done} startOpen email={email} />
              ) : (
                <SecretConnect provider={picked} onDone={done} startOpen />
              )}
            </div>
          )}
          {picked.needs_setup && (setup || !picked.configured) ? (
            <SetupForm provider={picked} onSaved={() => (setSetup(false), onChanged())} />
          ) : (
            picked.needs_setup && (
              <button className="link-button small" onClick={() => setSetup(true)}>
                <Icon name="key" size={16} />{" "}
                {picked.builtin && !picked.own_app ? `Advanced: use your own ${picked.name} app` : `Your ${picked.name} app credentials`}
              </button>
            )
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
