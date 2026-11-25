import { useEffect, useState } from "react";
import { openLink } from "../actions";
import { Icon } from "../components/Icon";
import { Resizer } from "../components/Resizer";
import { LocalGraph } from "./GraphView";
import { api } from "../lib/api";
import { dirname, displayName } from "../lib/links";
import type { Backlink, FileInfo, Heading, OutLink } from "../lib/types";
import { useWorkspace } from "../store";

type PanelTab = "backlinks" | "outgoing" | "outline" | "graph" | "info";

export function RightPanel() {
  const [tab, setTab] = useState<PanelTab>("backlinks");
  const vaultId = useWorkspace((s) => s.vaultId)!;
  const active = useWorkspace((s) => s.tabs.find((t) => t.id === s.activeId));
  const file = useWorkspace((s) => (active?.type === "file" ? s.files.find((f) => f.path === active.path) : undefined));
  const revision = useWorkspace((s) => s.revision);
  const path = file?.path ?? null;

  return (
    <aside className="right-panel">
      <Resizer side="right" />
      <div className="panel-tabs">
        {(
          [
            ["backlinks", "link", "Backlinks"],
            ["outgoing", "call_made", "Outgoing links"],
            ["outline", "toc", "Outline"],
            ["graph", "graph_3", "Local graph"],
            ["info", "info", "File info"],
          ] as const
        ).map(([id, icon, label]) => (
          <button key={id} className={`panel-tab${tab === id ? " active" : ""}`} title={label} onClick={() => setTab(id)}>
            <Icon name={icon} size={18} />
          </button>
        ))}
      </div>
      <div className={`panel-body${tab === "graph" ? " panel-graph" : ""}`}>
        {!path ? (
          <div className="empty small">No file open.</div>
        ) : tab === "backlinks" ? (
          <Backlinks vaultId={vaultId} path={path} revision={revision} />
        ) : tab === "outgoing" ? (
          <Outgoing vaultId={vaultId} path={path} revision={revision} />
        ) : tab === "outline" ? (
          <Outline vaultId={vaultId} path={path} revision={revision} />
        ) : tab === "graph" ? (
          <LocalGraph path={path} />
        ) : (
          <Info vaultId={vaultId} path={path} revision={revision} />
        )}
      </div>
    </aside>
  );
}

function useFetch<T>(fn: () => Promise<T>, deps: unknown[]): T | null {
  const [data, setData] = useState<T | null>(null);
  useEffect(() => {
    let alive = true;
    fn()
      .then((d) => alive && setData(d))
      .catch(() => alive && setData(null));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return data;
}

interface P {
  vaultId: string;
  path: string;
  revision: number;
}

function Backlinks({ vaultId, path, revision }: P) {
  const links = useFetch<Backlink[]>(() => api.backlinks(vaultId, path), [vaultId, path, revision]);
  if (!links) return null;
  const groups = new Map<string, Backlink[]>();
  for (const l of links) groups.set(l.path, [...(groups.get(l.path) ?? []), l]);
  return (
    <>
      <div className="panel-section-title">
        Linked mentions <span className="count">{links.length}</span>
      </div>
      {[...groups.entries()].map(([src, items]) => (
        <div key={src} className="backlink-group">
          <button className="backlink-file" onClick={(e) => useWorkspace.getState().openFile(src, { newTab: e.metaKey || e.ctrlKey })}>
            <Icon name="description" size={16} /> {displayName(src)}
            {dirname(src) && <span className="muted tiny"> {dirname(src)}</span>}
          </button>
          {items.map((l, i) => (
            <button key={i} className="backlink-context" onClick={() => useWorkspace.getState().openFile(src, { line: l.line })}>
              {l.context}
            </button>
          ))}
        </div>
      ))}
      {!links.length && <div className="empty small">No backlinks found.</div>}
    </>
  );
}

function Outgoing({ vaultId, path, revision }: P) {
  const links = useFetch<OutLink[]>(() => api.links(vaultId, path), [vaultId, path, revision]);
  if (!links) return null;
  const seen = new Set<string>();
  const unique = links.filter((l) => {
    const k = l.resolved ?? `?${l.target}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return (
    <>
      <div className="panel-section-title">
        Outgoing links <span className="count">{unique.length}</span>
      </div>
      {unique.map((l) => (
        <button
          key={l.resolved ?? l.target}
          className={`outgoing-link${l.resolved ? "" : " is-unresolved"}`}
          onClick={(e) => openLink(l.target, path, e.metaKey || e.ctrlKey)}
          title={l.resolved ? l.resolved : "Not created yet — click to create"}
        >
          <Icon name={l.resolved ? (l.kind === "embed" ? "attachment" : "description") : "add_circle"} size={16} />
          {l.resolved ? displayName(l.resolved) : l.target}
        </button>
      ))}
      {!unique.length && <div className="empty small">No outgoing links.</div>}
    </>
  );
}

function Outline({ vaultId, path, revision }: P) {
  const headings = useFetch<Heading[]>(() => api.outline(vaultId, path), [vaultId, path, revision]);
  if (!headings) return null;
  const min = Math.min(...headings.map((h) => h.level), 6);
  return (
    <>
      {headings.map((h, i) => (
        <button
          key={i}
          className="outline-item"
          style={{ paddingLeft: 10 + (h.level - min) * 14 }}
          onClick={() => useWorkspace.getState().openFile(path, { line: h.line })}
        >
          {h.text}
        </button>
      ))}
      {!headings.length && <div className="empty small">No headings.</div>}
    </>
  );
}

function Info({ vaultId, path, revision }: P) {
  const info = useFetch<FileInfo>(() => api.readFile(vaultId, path), [vaultId, path, revision]);
  if (!info) return null;
  const fm = Object.entries(info.frontmatter ?? {});
  return (
    <div className="file-info">
      <div className="kv">
        <span>Name</span>
        <code>{info.name}</code>
        <span>Folder</span>
        <code>{info.folder || "/"}</code>
        <span>Type</span>
        <code>{info.kind}</code>
        <span>Size</span>
        <code>{formatSize(info.size)}</code>
        <span>Modified</span>
        <code>{new Date(info.mtime * 1000).toLocaleString()}</code>
      </div>
      {info.description && (
        <>
          <div className="panel-section-title">Description</div>
          <p className="small">{info.description}</p>
        </>
      )}
      {!!info.tags?.length && (
        <>
          <div className="panel-section-title">Tags</div>
          <div className="tag-list">
            {info.tags.map((t) => (
              <button
                key={t}
                className="tag"
                onClick={() => useWorkspace.getState().set({ leftOpen: true, leftTab: "search", searchQuery: `tag:${t}` })}
              >
                #{t}
              </button>
            ))}
          </div>
        </>
      )}
      {!!fm.length && (
        <>
          <div className="panel-section-title">Properties</div>
          <div className="kv">
            {fm.map(([k, v]) => (
              <FragmentKV key={k} k={k} v={v} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function FragmentKV({ k, v }: { k: string; v: unknown }) {
  return (
    <>
      <span>{k}</span>
      <code>{typeof v === "string" ? v : JSON.stringify(v)}</code>
    </>
  );
}

function formatSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
