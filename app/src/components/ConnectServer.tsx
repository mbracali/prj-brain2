// First screen of the Android app: which BRAIN2 server to use.
// The phone can't run the BRAIN2 backend itself; it connects to `brain2 serve` running on your computer or server.
import { useState } from "react";
import { saveServer, savedServer } from "../lib/bridge";
import { BrandIcon } from "./BrandIcon";
import { Icon } from "./Icon";

/** Accepts "192.168.1.20:8765", "http://host:8765/?token=abc" or a full URL; returns base URL + token. */
export function parseServerInput(input: string, token: string): { baseUrl: string; token: string } | null {
  let text = input.trim();
  if (!text) return null;
  if (!/^https?:\/\//i.test(text)) text = `http://${text}`;
  try {
    const url = new URL(text);
    const fromUrl = url.searchParams.get("token") ?? "";
    return { baseUrl: `${url.protocol}//${url.host}`, token: token.trim() || fromUrl };
  } catch {
    return null;
  }
}

export function ConnectServer({ error }: { error?: string }) {
  const previous = savedServer();
  const [address, setAddress] = useState(previous?.baseUrl ?? "");
  const [token, setToken] = useState(previous?.token ?? "");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(error ?? null);

  const connect = async () => {
    const server = parseServerInput(address, token);
    if (!server) return setProblem("Enter the address of your BRAIN2 server, e.g. 192.168.1.20:8765");
    setBusy(true);
    setProblem(null);
    try {
      const health = await fetch(`${server.baseUrl}/api/health`);
      if (!health.ok) throw new Error(`The server answered ${health.status}`);
      const check = await fetch(`${server.baseUrl}/api/vaults`, {
        headers: server.token ? { Authorization: `Bearer ${server.token}` } : {},
      });
      if (check.status === 401) throw new Error("The token is missing or wrong.");
      if (!check.ok) throw new Error(`The server answered ${check.status}`);
      saveServer(server);
      location.reload();
    } catch (e) {
      setProblem(e instanceof Error && e.message !== "Failed to fetch" ? e.message : "Can't reach that address from this phone.");
      setBusy(false);
    }
  };

  return (
    <div className="connect-server">
      <div className="connect-server-card">
        <BrandIcon size={64} />
        <h1>Connect to BRAIN2</h1>
        <p className="muted small">
          Your notes, repos and calendars live on your computer. Start BRAIN2 there in server mode and connect this phone to it:
        </p>
        <pre className="connect-server-cmd">brain2 serve --host 0.0.0.0 --port 8765</pre>
        <p className="muted tiny">It prints an address with a token — paste it below (or type the address and the token).</p>
        <label className="connector-field">
          <span>Server address</span>
          <input className="input" inputMode="url" autoCapitalize="off" autoCorrect="off" value={address}
            placeholder="192.168.1.20:8765" onChange={(e) => setAddress(e.target.value)} />
        </label>
        <label className="connector-field">
          <span>Token</span>
          <input className="input" type="password" autoCapitalize="off" value={token} onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && connect()} />
        </label>
        {problem && <div className="danger-text small">{problem}</div>}
        <button className="btn btn-primary btn-large" disabled={busy} onClick={connect}>
          <Icon name="link" size={18} /> {busy ? "Connecting…" : "Connect"}
        </button>
        <p className="muted tiny">Only connect over a network you trust (your home Wi-Fi or a VPN such as Tailscale).</p>
      </div>
    </div>
  );
}
