// One repository, Azure DevOps style: Files · Commits · Pushes · Branches · Tags · Pull requests.
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import hljs from "highlight.js/lib/common";
import DOMPurify from "dompurify";
import MarkdownIt from "markdown-it";
import { Icon, UserIcon } from "../components/Icon";
import { Spinner } from "../components/Spinner";
import { api } from "../lib/api";
import { bridge } from "../lib/bridge";
import type {
  Blob, Branch, Commit, CommitDetail, PullList, PushEvent, Refs, Repo, RepoTree, Tag,
} from "../lib/repoTypes";
import { type MenuItem, type RepoPage, promptDialog, reportError, useApp } from "../store";
import { useTerminals } from "../terminal/store";
import { GRAPH_COLORS, layoutGraph } from "./graph";
import { RemoveRepoDialog } from "./RepoForms";
import { RepoStatus, showRepoTerminal, syncRepo } from "./ReposHome";
import { useRepos } from "./store";

export const REPO_PAGES: { id: RepoPage; label: string; icon: string }[] = [
  { id: "files", label: "Files", icon: "description" },
  { id: "commits", label: "Commits", icon: "commit" },
  { id: "pushes", label: "Pushes", icon: "cloud_upload" },
  { id: "branches", label: "Branches", icon: "fork_right" },
  { id: "tags", label: "Tags", icon: "sell" },
  { id: "pulls", label: "Pull requests", icon: "merge" },
];

// ---------------------------------------------------------------------------- helpers
function rel(date: string): string {
  if (!date) return "";
  const d = new Date(date);
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return d.toLocaleDateString();
}
const short = (sha: string) => sha.slice(0, 8);
const fmtSize = (n: number | null) =>
  n === null ? "" : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;

function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const version = useRepos((s) => s.version);
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(() => {
    setLoading(true);
    fn()
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, version]);
  useEffect(reload, [reload]);
  return { data, error, loading, reload };
}

/** Run a git action in the repo's terminal (visible to the user), then refresh the views. */
export async function runRepoAction(repo: Repo, action: string, args: Record<string, unknown> = {}, okText?: string) {
  try {
    const term = await api.repoTerminal(repo.id);
    await useTerminals.getState().reveal(term.id);
    const r = await api.repoCommand(repo.id, action, args);
    if (r.code !== 0 && r.code !== undefined) {
      useApp.getState().toast(r.error || "The command failed — see the terminal", "error");
      return false;
    }
    if (okText) useApp.getState().toast(okText);
    return true;
  } catch (e) {
    reportError(e);
    return false;
  } finally {
    useRepos.getState().load().catch(() => undefined);
    useRepos.getState().bump();
  }
}

const md = new MarkdownIt({ html: false, linkify: true });

function Readme({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(md.render(text)), [text]);
  return (
    <div
      className="markdown-rendered repo-readme"
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest("a");
        if (a && /^https?:/.test(a.getAttribute("href") ?? "")) {
          e.preventDefault();
          bridge.openExternal(a.getAttribute("href")!);
        }
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function ErrorNote({ error }: { error: string | null }) {
  return error ? <div className="form-warning"><Icon name="error" size={18} /><pre>{error}</pre></div> : null;
}

function RefPicker({ repo, value, onChange }: { repo: Repo; value: string; onChange: (v: string) => void }) {
  const { data } = useLoad<Refs>(() => api.refs(repo.id), [repo.id]);
  return (
    <label className="ref-picker" title="Branch or tag">
      <Icon name="fork_right" size={16} />
      <select className="select select-small" value={value} onChange={(e) => onChange(e.target.value)}>
        {!data && <option value={value}>{value}</option>}
        {data && (
          <>
            <optgroup label="Branches">
              {data.local.map((b) => <option key={b} value={b}>{b}{b === data.current ? " (current)" : ""}</option>)}
            </optgroup>
            {data.remote.length > 0 && (
              <optgroup label="Remote branches">
                {data.remote.map((b) => <option key={b} value={b}>{b}</option>)}
              </optgroup>
            )}
            {data.tags.length > 0 && (
              <optgroup label="Tags">
                {data.tags.map((t) => <option key={t} value={t}>{t}</option>)}
              </optgroup>
            )}
            {value && !data.local.includes(value) && !data.remote.includes(value) && !data.tags.includes(value) && (
              <option value={value}>{value}</option>
            )}
          </>
        )}
      </select>
    </label>
  );
}

// ---------------------------------------------------------------------------- sidebar
export function RepoSidebar({ repoId, page }: { repoId: string; page: RepoPage }) {
  const repo = useRepos((s) => s.repos.find((r) => r.id === repoId));
  const navigate = useApp((s) => s.navigate);
  return (
    <div className="sidebar-body repo-sidebar">
      <button className="back-link" onClick={() => navigate({ module: "repos" })}>
        <Icon name="arrow_back" size={18} /> Back to repos
      </button>
      <div className="repo-sidebar-title" title={repo?.path}>
        <UserIcon value={repo?.icon} fallback="account_tree" size={20} />
        <span>{repo?.name ?? "Repository"}</span>
      </div>
      {repo?.branch && (
        <div className="repo-sidebar-branch muted small">
          <Icon name="fork_right" size={14} /> {repo.branch}
          {repo.ahead > 0 && <span> ↑{repo.ahead}</span>}
          {repo.behind > 0 && <span> ↓{repo.behind}</span>}
        </div>
      )}
      <nav className="module-list repo-nav">
        {REPO_PAGES.map((p) => (
          <button
            key={p.id}
            className={`module-item${page === p.id ? " active" : ""}`}
            onClick={() => navigate({ module: "repo", repoId, page: p.id })}
          >
            <Icon name={p.icon} size={19} />
            <span className="module-label">{p.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

// ---------------------------------------------------------------------------- view
export function RepoView({ repoId, page, arg }: { repoId: string; page: RepoPage; arg?: string }) {
  const repos = useRepos((s) => s.repos);
  const loaded = useRepos((s) => s.loaded);
  const repo = repos.find((r) => r.id === repoId);
  const [syncing, setSyncing] = useState(false);
  const [removing, setRemoving] = useState(false);

  useEffect(() => {
    if (!loaded) useRepos.getState().load().catch(reportError);
  }, [loaded]);
  useEffect(() => {
    if (repo) showRepoTerminal(repo).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoId, !!repo]);

  if (!repo) return loaded ? <div className="page center muted">Repository not found.</div> : <Spinner />;
  const meta = REPO_PAGES.find((p) => p.id === page)!;

  return (
    <div className="page repo-view">
      <header className="repo-view-header">
        <h1>
          <Icon name={meta.icon} size={22} /> {meta.label}
        </h1>
        <RepoStatus repo={repo} />
        <span className="spacer" />
        {repo.web_url && (
          <button className="btn btn-small" onClick={() => bridge.openExternal(repo.web_url!)}>
            <Icon name="open_in_new" size={16} /> Web
          </button>
        )}
        <button className="btn btn-small" onClick={() => bridge.reveal(repo.path)}>
          <Icon name="folder_data" size={16} /> Open location
        </button>
        <button
          className="btn btn-small"
          disabled={!repo.remote || syncing}
          onClick={async () => {
            setSyncing(true);
            await syncRepo(repo);
            setSyncing(false);
          }}
        >
          <Icon name="directory_sync" size={16} className={syncing ? "spin" : ""} /> Sync
        </button>
        <button className="icon-button" title="Remove repo" onClick={() => setRemoving(true)}>
          <Icon name="delete" size={18} />
        </button>
      </header>
      <div className="repo-view-body">
        {!repo.is_git ? (
          <div className="empty">This folder is not a git repository any more ({repo.path}).</div>
        ) : page === "files" ? (
          <FilesPage repo={repo} initialPath={arg} />
        ) : page === "commits" ? (
          <CommitsPage repo={repo} initialSha={arg} />
        ) : page === "pushes" ? (
          <PushesPage repo={repo} />
        ) : page === "branches" ? (
          <BranchesPage repo={repo} />
        ) : page === "tags" ? (
          <TagsPage repo={repo} />
        ) : (
          <PullsPage repo={repo} />
        )}
      </div>
      {removing && <RemoveRepoDialog repo={repo} onClose={() => setRemoving(false)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------- files
function FilesPage({ repo, initialPath }: { repo: Repo; initialPath?: string }) {
  const [ref, setRef] = useState(repo.branch ?? "HEAD");
  const [path, setPathRaw] = useState(initialPath ?? "");
  const [file, setFileRaw] = useState<string | null>(null);
  const [history, setHistory] = useState<{ path: string; file: string | null }[]>([]);
  // Every navigation remembers where we were, so "Back" can return there.
  const go = (nextPath: string, nextFile: string | null) => {
    if (nextPath === path && nextFile === file) return;
    setHistory((h) => [...h, { path, file }]);
    setPathRaw(nextPath);
    setFileRaw(nextFile);
  };
  const setPath = (p: string) => go(p, null);
  const setFile = (f: string | null) => go(f ? f.split("/").slice(0, -1).join("/") : path, f);
  const back = () => {
    const prev = history[history.length - 1];
    if (!prev) return;
    setHistory((h) => h.slice(0, -1));
    setPathRaw(prev.path);
    setFileRaw(prev.file);
  };
  const [tab, setTab] = useState<"contents" | "history">("contents");
  const tree = useLoad<RepoTree>(() => api.repoTree(repo.id, ref, path), [repo.id, ref, path]);
  const blob = useLoad<Blob | null>(() => (file ? api.blob(repo.id, ref, file) : Promise.resolve(null)), [repo.id, ref, file]);
  const readme = useLoad<Blob | null>(
    () => (tree.data?.readme && !file ? api.blob(repo.id, ref, tree.data.readme) : Promise.resolve(null)),
    [repo.id, ref, tree.data?.readme, file],
  );

  const crumbs = (file ?? path).split("/").filter(Boolean);
  const goto = (i: number) => setPath(crumbs.slice(0, i + 1).join("/"));

  return (
    <div className="repo-files">
      <div className="repo-subbar">
        <button className="btn btn-small" disabled={!history.length} title="Back" onClick={back}>
          <Icon name="arrow_back" size={16} /> Back
        </button>
        <RefPicker repo={repo} value={ref} onChange={(v) => (setRef(v), setFileRaw(null))} />
        <div className="repo-crumbs">
          <button onClick={() => setPath("")}>
            <Icon name="home" size={16} /> {repo.name}
          </button>
          {crumbs.map((c, i) => (
            <span key={i}>
              <span className="crumb-sep">/</span>
              <button onClick={() => (i === crumbs.length - 1 && file ? undefined : goto(i))}>{c}</button>
            </span>
          ))}
        </div>
        {file && (
          <div className="segmented small">
            <button className={tab === "contents" ? "active" : ""} onClick={() => setTab("contents")}>Contents</button>
            <button className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>History</button>
          </div>
        )}
      </div>
      {file ? (
        tab === "contents" ? (
          <FileContents blob={blob.data} loading={blob.loading} error={blob.error} />
        ) : (
          <CommitsPage repo={repo} fixedRef={ref} fixedPath={file} />
        )
      ) : (
        <>
          <ErrorNote error={tree.error} />
          {tree.loading && !tree.data && <Spinner />}
          {tree.data?.empty && <div className="empty">This branch has no commits yet.</div>}
          {tree.data && !tree.data.empty && (
            <table className="repo-table">
              <thead>
                <tr><th>Name</th><th>Last change</th><th>Commit</th></tr>
              </thead>
              <tbody>
                {path && (
                  <tr className="clickable" onClick={() => setPath(path.split("/").slice(0, -1).join("/"))}>
                    <td><Icon name="drive_folder_upload" size={18} /> ..</td><td /><td />
                  </tr>
                )}
                {tree.data.entries.map((e) => (
                  <tr
                    key={e.path}
                    className="clickable"
                    onClick={() => (e.type === "tree" ? setPath(e.path) : e.type === "blob" ? (setFile(e.path), setTab("contents")) : undefined)}
                  >
                    <td className="name-cell">
                      <Icon name={e.type === "tree" ? "folder" : e.type === "commit" ? "link" : "draft"} size={18} fill={e.type === "tree"} />
                      {e.name}
                      {e.type === "blob" && <span className="muted tiny"> {fmtSize(e.size)}</span>}
                    </td>
                    <td className="muted">{e.last ? rel(e.last.date) : ""}</td>
                    <td className="muted ellipsis" title={e.last?.subject}>
                      {e.last && <><code>{short(e.last.sha)}</code> {e.last.subject}</>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {readme.data?.content && (
            <section className="readme-card">
              <div className="readme-title"><Icon name="menu_book" size={18} /> {tree.data?.readme}</div>
              <Readme text={readme.data.content} />
            </section>
          )}
        </>
      )}
    </div>
  );
}

function FileContents({ blob, loading, error }: { blob: Blob | null; loading: boolean; error: string | null }) {
  const [rendered, setRendered] = useState(true);
  const html = useMemo(() => {
    if (!blob?.content) return "";
    const ext = blob.path.split(".").pop()?.toLowerCase() ?? "";
    const lang = hljs.getLanguage(ext) ? ext : undefined;
    try {
      return lang ? hljs.highlight(blob.content, { language: lang }).value : hljs.highlightAuto(blob.content.slice(0, 200_000)).value;
    } catch {
      return blob.content.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
    }
  }, [blob]);
  if (error) return <ErrorNote error={error} />;
  if (loading || !blob) return <Spinner />;
  if (blob.binary) return <div className="empty">Binary file ({fmtSize(blob.size)}).</div>;
  const isMd = /\.(md|markdown)$/i.test(blob.path);
  const lines = html.split("\n");
  return (
    <div className="file-contents">
      {isMd && (
        <div className="file-contents-bar">
          <div className="segmented small">
            <button className={rendered ? "active" : ""} onClick={() => setRendered(true)}>Preview</button>
            <button className={!rendered ? "active" : ""} onClick={() => setRendered(false)}>Source</button>
          </div>
        </div>
      )}
      {blob.truncated && <div className="muted small">Showing the first 2 MB.</div>}
      {isMd && rendered ? (
        <Readme text={blob.content ?? ""} />
      ) : (
        <pre className="code-view hljs">
          {lines.map((l, i) => (
            <div key={i} className="code-line">
              <span className="code-ln">{i + 1}</span>
              <span dangerouslySetInnerHTML={{ __html: l || " " }} />
            </div>
          ))}
        </pre>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------- commits
function GraphCell({ row, max }: { row: ReturnType<typeof layoutGraph>[number]; max: number }) {
  const W = 14;
  const H = 36;
  const x = (l: number) => 8 + l * W;
  const color = (c: number) => GRAPH_COLORS[c % GRAPH_COLORS.length];
  return (
    <svg width={8 + max * W} height={H} className="graph-cell">
      {row.up.map(([a, b, c], i) => (
        <path key={`u${i}`} d={`M${x(a)} 0 C${x(a)} ${H / 4} ${x(b)} ${H / 4} ${x(b)} ${H / 2}`} stroke={color(c)} fill="none" strokeWidth={2} />
      ))}
      {row.down.map(([a, b, c], i) => (
        <path key={`d${i}`} d={`M${x(a)} ${H / 2} C${x(a)} ${(H * 3) / 4} ${x(b)} ${(H * 3) / 4} ${x(b)} ${H}`} stroke={color(c)} fill="none" strokeWidth={2} />
      ))}
      <circle cx={x(row.lane)} cy={H / 2} r={4.5} fill={color(row.color)} stroke="var(--bg-primary)" strokeWidth={2} />
    </svg>
  );
}

function CommitsPage({ repo, fixedRef, fixedPath, initialSha }: { repo: Repo; fixedRef?: string; fixedPath?: string; initialSha?: string }) {
  const [ref, setRef] = useState(fixedRef ?? repo.branch ?? "HEAD");
  const [all, setAll] = useState(false);
  const [author, setAuthor] = useState("");
  const [query, setQuery] = useState("");
  const [applied, setApplied] = useState({ author: "", query: "" });
  const [items, setItems] = useState<Commit[]>([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(initialSha ?? null);
  const version = useRepos((s) => s.version);

  const load = useCallback(
    async (skip: number) => {
      setLoading(true);
      try {
        const r = await api.commits(repo.id, {
          ref: all ? undefined : ref, all, path: fixedPath, author: applied.author || undefined, q: applied.query || undefined,
          skip, limit: 100,
        });
        setItems((prev) => (skip ? [...prev, ...r.commits] : r.commits));
        setMore(r.more);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [repo.id, ref, all, fixedPath, applied],
  );
  useEffect(() => {
    load(0);
  }, [load, version]);

  const graph = useMemo(() => (applied.author || applied.query || fixedPath ? null : layoutGraph(items)), [items, applied, fixedPath]);
  const maxLanes = graph ? Math.min(12, Math.max(1, ...graph.map((g) => g.width))) : 0;

  if (selected) return <CommitDetailView repo={repo} sha={selected} onBack={() => setSelected(null)} />;

  return (
    <div className="repo-commits">
      {!fixedPath && (
        <div className="repo-subbar">
          {!all && <RefPicker repo={repo} value={ref} onChange={setRef} />}
          <label className="check"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> All branches</label>
          <span className="spacer" />
          <input className="input input-small" placeholder="Author" value={author} onChange={(e) => setAuthor(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && setApplied({ author, query })} />
          <input className="input input-small" placeholder="Search messages" value={query} onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && setApplied({ author, query })} />
          <button className="btn btn-small" onClick={() => setApplied({ author, query })}><Icon name="filter_list" size={16} /> Filter</button>
        </div>
      )}
      <ErrorNote error={error} />
      <table className="repo-table commits-table">
        <thead>
          <tr>
            {graph && <th className="graph-col">Graph</th>}
            <th>Commit</th><th>Id</th><th>Author</th><th>Authored</th>
          </tr>
        </thead>
        <tbody>
          {items.map((c, i) => (
            <tr key={c.sha} className="clickable" onClick={() => setSelected(c.sha)}>
              {graph && <td className="graph-col"><GraphCell row={graph[i]} max={maxLanes} /></td>}
              <td className="ellipsis commit-subject" title={c.subject}>
                {c.refs.map((r) => (
                  <span key={r} className={`ref-badge${r.startsWith("tag:") ? " tag" : r.includes("HEAD") ? " head" : r.includes("/") ? " remote" : ""}`}>
                    {r.replace(/^tag: /, "").replace(/^HEAD -> /, "")}
                  </span>
                ))}
                {c.subject}
              </td>
              <td><code>{short(c.sha)}</code></td>
              <td className="ellipsis">{c.author}</td>
              <td className="muted" title={new Date(c.date).toLocaleString()}>{rel(c.date)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {loading && <Spinner />}
      {!loading && !items.length && !error && <div className="empty">No commits.</div>}
      {more && !loading && (
        <div className="center-row"><button className="btn" onClick={() => load(items.length)}>Load more</button></div>
      )}
    </div>
  );
}

function DiffView({ patch }: { patch: string }) {
  const files = useMemo(() => {
    const out: { name: string; lines: string[] }[] = [];
    for (const line of patch.split("\n")) {
      if (line.startsWith("diff --git ")) {
        const m = / b\/(.*)$/.exec(line);
        out.push({ name: m ? m[1] : line, lines: [] });
      } else if (out.length) out[out.length - 1].lines.push(line);
    }
    return out;
  }, [patch]);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  return (
    <div className="diff">
      {files.map((f) => {
        const collapsed = open[f.name] === false || (open[f.name] === undefined && f.lines.length > 800);
        return (
          <section key={f.name} className="diff-file" id={`diff-${f.name}`}>
            <button className="diff-file-head" onClick={() => setOpen({ ...open, [f.name]: collapsed })}>
              <Icon name={collapsed ? "chevron_right" : "expand_more"} size={18} /> {f.name}
            </button>
            {!collapsed && (
              <pre className="diff-body">
                {f.lines
                  .filter((l) => !/^(index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|rename (from|to))/.test(l))
                  .map((l, i) => (
                    <div key={i} className={l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : l.startsWith("@@") ? "hunk" : ""}>
                      {l || " "}
                    </div>
                  ))}
              </pre>
            )}
          </section>
        );
      })}
    </div>
  );
}

function CommitDetailView({ repo, sha, onBack }: { repo: Repo; sha: string; onBack: () => void }) {
  const { data, error, loading } = useLoad<CommitDetail>(() => api.commit(repo.id, sha), [repo.id, sha]);
  const [subject, ...body] = (data?.message ?? "").split("\n");
  return (
    <div className="commit-detail">
      <button className="back-link" onClick={onBack}><Icon name="arrow_back" size={18} /> Commits</button>
      <ErrorNote error={error} />
      {loading && <Spinner />}
      {data && (
        <>
          <h2 className="commit-title">{subject}</h2>
          {body.join("\n").trim() && <pre className="commit-body">{body.join("\n").trim()}</pre>}
          <div className="commit-meta muted small">
            <span><Icon name="person" size={15} /> {data.author} &lt;{data.email}&gt;</span>
            <span title={data.date}>{new Date(data.date).toLocaleString()}</span>
            <span>Commit <code>{short(data.sha)}</code></span>
            {data.parents.length > 0 && <span>Parent{data.parents.length > 1 ? "s" : ""} {data.parents.map((p) => <code key={p}>{short(p)} </code>)}</span>}
            {repo.web_url && repo.provider === "github" && (
              <button className="link-button" onClick={() => bridge.openExternal(`${repo.web_url}/commit/${data.sha}`)}>Open on the web</button>
            )}
          </div>
          <div className="commit-files">
            <div className="panel-section-title">{data.files.length} file{data.files.length === 1 ? "" : "s"} changed</div>
            {data.files.map((f) => (
              <button key={f.path} className="commit-file" onClick={() => document.getElementById(`diff-${f.path}`)?.scrollIntoView({ behavior: "smooth" })}>
                <span className="ellipsis">{f.path}</span>
                <span className="add-count">+{f.added ?? "bin"}</span>
                <span className="del-count">−{f.deleted ?? "bin"}</span>
              </button>
            ))}
          </div>
          <DiffView patch={data.patch} />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------- pushes
function PushesPage({ repo }: { repo: Repo }) {
  const { data, error, loading } = useLoad<PushEvent[]>(() => api.pushes(repo.id), [repo.id]);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div>
      <p className="muted small page-note">
        Updates of the remote branches seen by this clone: your pushes, and the work of others that arrived with a fetch or pull.
      </p>
      <ErrorNote error={error} />
      {loading && !data && <Spinner />}
      {data && !data.length && <div className="empty">No pushes recorded yet. Sync or push to see them here.</div>}
      {data && data.length > 0 && (
        <table className="repo-table">
          <thead><tr><th>Pushed by</th><th>Branch</th><th>Commits</th><th>Kind</th><th>Date</th></tr></thead>
          <tbody>
            {data.map((p) => {
              const id = `${p.ref}@${p.sha}@${p.date}`;
              return (
                <Fragment key={id}>
                  <tr className="clickable" onClick={() => setOpen(open === id ? null : id)}>
                    <td><Icon name="person" size={16} /> {p.by}</td>
                    <td><span className="ref-badge remote">{p.ref}</span></td>
                    <td className="ellipsis">
                      {p.commits.length ? `${p.commits.length}${p.commits.length >= 20 ? "+" : ""} · ${p.commits[0].subject}` : <code>{short(p.sha)}</code>}
                    </td>
                    <td>
                      <span className={`kind-badge ${p.kind}`}>{p.kind === "push" ? "Pushed" : p.kind === "fetch" ? "Fetched" : "Updated"}</span>
                      {p.forced && <span className="kind-badge forced">forced</span>}
                    </td>
                    <td className="muted" title={new Date(p.date).toLocaleString()}>{rel(p.date)}</td>
                  </tr>
                  {open === id && (
                    <tr key={`${id}-x`} className="expanded-row">
                      <td colSpan={5}>
                        {p.commits.map((c) => (
                          <div key={c.sha} className="push-commit"><code>{short(c.sha)}</code> {c.subject} <span className="muted">— {c.author}</span></div>
                        ))}
                        <div className="muted tiny">{p.message}</div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------- branches
function BranchesPage({ repo }: { repo: Repo }) {
  const { data, error, loading, reload } = useLoad(() => api.branches(repo.id), [repo.id]);
  const [tab, setTab] = useState<"mine" | "all" | "stale">("all");
  const [filter, setFilter] = useState("");
  const showMenu = useApp((s) => s.showMenu);
  const navigate = useApp((s) => s.navigate);

  const list = (data?.branches ?? []).filter((b) => {
    if (filter && !b.name.toLowerCase().includes(filter.toLowerCase())) return false;
    if (tab === "mine") return b.mine && !b.remote;
    if (tab === "stale") return Date.now() - new Date(b.date).getTime() > 90 * 86400_000;
    return true;
  });

  const newBranch = async (from?: string) => {
    const name = await promptDialog(`New branch${from ? ` from ${from}` : ""}`, { label: "Branch name", okLabel: "Create branch" });
    if (name) await runRepoAction(repo, "branch-create", { name: name.trim(), from: from || undefined }, `Switched to ${name}`);
  };

  const menu = (b: Branch): MenuItem[] => [
    ...(!b.remote && !b.current ? [{ label: "Checkout", icon: "login", action: () => runRepoAction(repo, "checkout", { branch: b.name }) }] : []),
    ...(b.remote ? [{ label: "Checkout as local branch", icon: "login", action: () => runRepoAction(repo, "checkout-remote", { branch: b.name }) }] : []),
    { label: "New branch from here…", icon: "add", action: () => newBranch(b.name) },
    { label: "View commits", icon: "commit", action: () => navigate({ module: "repo", repoId: repo.id, page: "commits" }) },
    ...(!b.remote && !b.upstream && repo.remote ? [{ label: "Publish branch", icon: "cloud_upload", action: () => runRepoAction(repo, "push-branch", { name: b.name }) }] : []),
    ...(repo.provider === "github" && !b.default
      ? [{ label: "New pull request", icon: "merge", action: () => runRepoAction(repo, "pr-create", { head: b.name.replace(/^[^/]+\//, ""), base: data?.default }) }]
      : []),
    { separator: true },
    ...(!b.remote && !b.current && !b.default
      ? [{ label: "Delete branch", icon: "delete", danger: true, action: () => runRepoAction(repo, "branch-delete", { name: b.name }).then((ok) => ok || undefined) }]
      : []),
    ...(b.remote && !b.default ? [{ label: "Delete remote branch", icon: "delete", danger: true, action: () => runRepoAction(repo, "branch-delete-remote", { name: b.name }) }] : []),
  ];

  return (
    <div>
      <div className="repo-subbar">
        <div className="segmented small">
          {(["mine", "all", "stale"] as const).map((t) => (
            <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>{t === "mine" ? "Mine" : t === "all" ? "All" : "Stale"}</button>
          ))}
        </div>
        <span className="spacer" />
        <input className="input input-small" placeholder="Search branch name" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button className="btn btn-small" onClick={() => newBranch()}><Icon name="add" size={16} /> New branch</button>
        <button className="icon-button" title="Refresh" onClick={reload}><Icon name="refresh" size={18} /></button>
      </div>
      <ErrorNote error={error} />
      {loading && !data && <Spinner />}
      {data && (
        <table className="repo-table">
          <thead>
            <tr><th>Branch</th><th>Commit</th><th>Author</th><th>Authored</th><th title={`Compared with ${data.default}`}>Behind | Ahead</th><th>Upstream</th><th /></tr>
          </thead>
          <tbody>
            {list.map((b) => (
              <tr key={(b.remote ? "r:" : "l:") + b.name} onContextMenu={(e) => (e.preventDefault(), showMenu(e, menu(b)))}>
                <td className="name-cell">
                  <Icon name={b.remote ? "cloud" : "fork_right"} size={17} />
                  <span className={b.current ? "strong" : ""}>{b.name}</span>
                  {b.default && <span className="ref-badge">default</span>}
                  {b.current && <span className="ref-badge head">current</span>}
                </td>
                <td title={b.subject}><code>{short(b.sha)}</code></td>
                <td className="ellipsis">{b.author}</td>
                <td className="muted">{rel(b.date)}</td>
                <td>
                  {b.default ? <span className="muted">—</span> : (
                    <span className="ahead-behind">
                      <span className="behind" style={{ width: Math.min(60, b.behind * 3) }} />
                      <span className="nums">{b.behind} | {b.ahead}</span>
                      <span className="ahead" style={{ width: Math.min(60, b.ahead * 3) }} />
                    </span>
                  )}
                </td>
                <td className="muted small">{b.upstream ? `${b.upstream}${b.track ? ` (${b.track})` : ""}` : b.remote ? "" : "not published"}</td>
                <td className="row-actions">
                  <button className="icon-button" title="More actions" onClick={(e) => showMenu(e, menu(b))}><Icon name="more_horiz" size={18} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------- tags
function TagsPage({ repo }: { repo: Repo }) {
  const { data, error, loading, reload } = useLoad<Tag[]>(() => api.repoTags(repo.id), [repo.id]);
  const showMenu = useApp((s) => s.showMenu);
  const newTag = async () => {
    const name = await promptDialog("New tag", { label: "Tag name (on the current commit)", okLabel: "Next" });
    if (!name) return;
    const message = await promptDialog("Tag description", { label: "Message (leave empty for a lightweight tag)", value: "", okLabel: "Create tag" });
    if (message === null) return;
    await runRepoAction(repo, "tag-create", { name: name.trim(), message }, `Tag ${name} created`);
  };
  const menu = (t: Tag): MenuItem[] => [
    ...(repo.remote ? [{ label: "Push tag", icon: "cloud_upload", action: () => runRepoAction(repo, "tag-push", { name: t.name }, `Pushed ${t.name}`) }] : []),
    { label: "New branch from tag…", icon: "add", action: async () => {
      const name = await promptDialog(`New branch from ${t.name}`, { label: "Branch name", okLabel: "Create branch" });
      if (name) runRepoAction(repo, "branch-create", { name: name.trim(), from: t.name });
    } },
    { separator: true },
    { label: "Delete local tag", icon: "delete", danger: true, action: () => runRepoAction(repo, "tag-delete", { name: t.name }) },
  ];
  return (
    <div>
      <div className="repo-subbar">
        <span className="spacer" />
        <button className="btn btn-small" onClick={newTag}><Icon name="add" size={16} /> New tag</button>
        <button className="icon-button" title="Refresh" onClick={reload}><Icon name="refresh" size={18} /></button>
      </div>
      <ErrorNote error={error} />
      {loading && !data && <Spinner />}
      {data && !data.length && <div className="empty">No tags yet.</div>}
      {data && data.length > 0 && (
        <table className="repo-table">
          <thead><tr><th>Tag</th><th>Commit</th><th>Tagger</th><th>Created</th><th>Message</th><th /></tr></thead>
          <tbody>
            {data.map((t) => (
              <tr key={t.name} onContextMenu={(e) => (e.preventDefault(), showMenu(e, menu(t)))}>
                <td className="name-cell"><Icon name="sell" size={17} /> {t.name}{t.annotated ? "" : <span className="muted tiny"> lightweight</span>}</td>
                <td><code>{short(t.commit)}</code></td>
                <td>{t.tagger}</td>
                <td className="muted">{rel(t.date)}</td>
                <td className="ellipsis muted">{t.message}</td>
                <td className="row-actions"><button className="icon-button" onClick={(e) => showMenu(e, menu(t))}><Icon name="more_horiz" size={18} /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------- pull requests
function PullsPage({ repo }: { repo: Repo }) {
  const [tab, setTab] = useState<"mine" | "open" | "merged" | "closed">("open");
  const state = tab === "mine" ? "open" : tab;
  const { data, error, loading, reload } = useLoad<PullList>(() => api.pulls(repo.id, state), [repo.id, state]);
  const items = (data?.items ?? []).filter((p) => tab !== "mine" || (data?.me && p.author.login === data.me));
  const showMenu = useApp((s) => s.showMenu);
  return (
    <div>
      <div className="repo-subbar">
        <div className="segmented small">
          {([["mine", "Mine"], ["open", "Active"], ["merged", "Completed"], ["closed", "Abandoned"]] as const).map(([id, label]) => (
            <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>{label}</button>
          ))}
        </div>
        <span className="spacer" />
        {data?.supported && (
          <button className="btn btn-small" onClick={() => runRepoAction(repo, "pr-create", { head: repo.branch ?? undefined })}>
            <Icon name="add" size={16} /> New pull request
          </button>
        )}
        <button className="icon-button" title="Refresh" onClick={reload}><Icon name="refresh" size={18} /></button>
      </div>
      <ErrorNote error={error || data?.error || null} />
      {loading && !data && <Spinner label="Asking GitHub (gh) for pull requests…" />}
      {data && !data.supported && (
        <div className="empty">
          <Icon name="merge" size={40} />
          <div>{data.reason}</div>
          {data.web_url && (
            <button className="btn" onClick={() => bridge.openExternal(data.web_url!)}><Icon name="open_in_new" size={16} /> Open the repository on the web</button>
          )}
        </div>
      )}
      {data?.supported && !items.length && !loading && <div className="empty">No pull requests here.</div>}
      {items.length > 0 && (
        <div className="pr-list">
          {items.map((p) => (
            <div
              key={p.number}
              className="pr-row"
              onClick={() => bridge.openExternal(p.url)}
              onContextMenu={(e) => {
                e.preventDefault();
                showMenu(e, [
                  { label: "Open in browser", icon: "open_in_new", action: () => bridge.openExternal(p.url) },
                  { label: "Checkout this pull request", icon: "login", action: () => runRepoAction(repo, "pr-checkout", { number: p.number }) },
                ]);
              }}
            >
              <Icon name={p.state === "MERGED" ? "merge" : p.state === "CLOSED" ? "block" : "call_split"} size={20} className={`pr-icon ${p.state.toLowerCase()}`} />
              <div className="pr-main">
                <div className="pr-title">
                  {p.title}
                  {p.isDraft && <span className="kind-badge">draft</span>}
                  {p.reviewDecision === "APPROVED" && <span className="kind-badge push">approved</span>}
                  {p.reviewDecision === "CHANGES_REQUESTED" && <span className="kind-badge forced">changes requested</span>}
                  {p.labels.map((l) => <span key={l.name} className="pr-label" style={{ borderColor: `#${l.color}` }}>{l.name}</span>)}
                </div>
                <div className="muted small">
                  #{p.number} · {p.author.login} · created {rel(p.createdAt)} ·{" "}
                  <span className="ref-badge">{p.headRefName}</span> → <span className="ref-badge">{p.baseRefName}</span>
                </div>
              </div>
              <button
                className="icon-button"
                title="Checkout"
                onClick={(e) => {
                  e.stopPropagation();
                  runRepoAction(repo, "pr-checkout", { number: p.number });
                }}
              >
                <Icon name="login" size={18} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
