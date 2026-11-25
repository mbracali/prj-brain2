// Settings → Account connectors: account providers (calendars/email), LLM providers, chat providers.
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { accountsApi } from "../lib/api";
import { bridge } from "../lib/bridge";
import type { Account, Connectors, ProviderInfo, ProviderKind } from "../lib/calTypes";
import { confirmDialog, promptDialog, reportError, useApp } from "../store";

const GROUPS: { kind: ProviderKind; title: string; description: string }[] = [
  {
    kind: "account",
    title: "Account providers",
    description: "Google, Microsoft and Apple accounts. Calendars use them today; email comes later. Connect as many accounts as you like.",
  },
  { kind: "llm", title: "LLM providers", description: "Language models for the Echoes module. You can connect them now; BRAIN2 doesn't use them yet." },
  { kind: "chat", title: "Chat providers", description: "Chat platforms for the Message queues module. You can connect them now; BRAIN2 doesn't use them yet." },
];

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

function AccountRow({ account, onChanged }: { account: Account; onChanged: () => void }) {
  return (
    <div className={`connector-account${account.status === "error" ? " has-error" : ""}`}>
      <Icon name={account.status === "error" ? "error" : "check_circle"} size={18} className="connector-account-status" />
      <div className="connector-account-text">
        <strong>{account.nickname}</strong>
        {account.email && account.email !== account.nickname && <span className="muted small">{account.email}</span>}
        {account.error && <span className="danger-text tiny">{account.error}</span>}
      </div>
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

function AppleConnect({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
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
        <button className="btn" onClick={() => setOpen(false)}>Cancel</button>
        <button className="btn btn-primary btn-small" disabled={busy || !appleId || !password} onClick={submit}>{busy ? "Checking…" : "Connect"}</button>
      </div>
    </div>
  );
}

function SecretConnect({ provider, onDone }: { provider: ProviderInfo; onDone: () => void }) {
  const [open, setOpen] = useState(false);
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
        <button className="btn" onClick={() => setOpen(false)}>Cancel</button>
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

function ProviderCard({ provider, accounts, onChanged }: { provider: ProviderInfo; accounts: Account[]; onChanged: () => void }) {
  const [setup, setSetup] = useState(provider.needs_setup && !provider.configured);
  return (
    <div className="connector-card">
      <div className="connector-head">
        <Icon name={provider.icon} size={22} />
        <div className="connector-title">
          <strong>{provider.name}</strong>
          <span className="muted tiny">
            {provider.connect === "oauth" ? "Browser sign-in" : provider.connect === "password" ? "CalDAV · app-specific password" :
              provider.connect === "cli" ? (provider.detected ? `Detected: ${provider.detected}` : "Command-line tool") :
              provider.connect === "token" ? "Token" : "API key"}
          </span>
        </div>
        {!provider.usable && <span className="kind-badge">not used yet</span>}
        {provider.needs_setup && (
          <button className="btn btn-small" onClick={() => setSetup(!setup)} title="Your own app credentials">
            <Icon name="key" size={16} /> {provider.configured ? "App credentials" : "Set up"}
          </button>
        )}
      </div>
      {!provider.needs_setup && <p className="muted tiny connector-help">{provider.help}</p>}
      {setup && <SetupForm provider={provider} onSaved={() => (setSetup(false), onChanged())} />}
      {accounts.map((a) => <AccountRow key={a.id} account={a} onChanged={onChanged} />)}
      <div className="connector-actions">
        {provider.connect === "oauth" ? (
          <OAuthConnect provider={provider} onDone={onChanged} />
        ) : provider.connect === "password" ? (
          <AppleConnect onDone={onChanged} />
        ) : (
          <SecretConnect provider={provider} onDone={onChanged} />
        )}
      </div>
    </div>
  );
}

export function ConnectorsSection() {
  const { data, load } = useConnectors();
  if (!data) return <h2>Account connectors</h2>;
  return (
    <>
      <h2>Account connectors</h2>
      <p className="muted small">
        Passwords, tokens and keys are stored in the {data.keychain}, never in BRAIN2's database. BRAIN2 talks to each provider
        directly from your machine; there is no BRAIN2 server in between.
      </p>
      {GROUPS.map((g) => (
        <section key={g.kind} className="connector-group">
          <h3>{g.title}</h3>
          <p className="muted small">{g.description}</p>
          {data.providers
            .filter((p) => p.kind === g.kind)
            .map((p) => (
              <ProviderCard key={p.id} provider={p} accounts={data.accounts.filter((a) => a.provider === p.id)} onChanged={load} />
            ))}
        </section>
      ))}
    </>
  );
}
