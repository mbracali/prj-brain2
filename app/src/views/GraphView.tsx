import {
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
} from "d3-force";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { api } from "../lib/api";
import type { GraphData } from "../lib/types";
import { reportError, useWorkspace } from "../store";

// ============================================================================ options
export interface GraphGroup {
  query: string;
  color: string;
}

export interface GraphOptions {
  search: string;
  showTags: boolean;
  showAttachments: boolean;
  existingOnly: boolean;
  showOrphans: boolean;
  groups: GraphGroup[];
  arrows: boolean;
  textFade: number; // zoom level above which labels show
  nodeSize: number;
  linkThickness: number;
  centerForce: number;
  repelForce: number;
  linkForce: number;
  linkDistance: number;
}

export const DEFAULT_GRAPH: GraphOptions = {
  search: "",
  showTags: false,
  showAttachments: false,
  existingOnly: false,
  showOrphans: true,
  groups: [],
  arrows: false,
  textFade: 0.7,
  nodeSize: 1,
  linkThickness: 1,
  centerForce: 0.5,
  repelForce: 10,
  linkForce: 1,
  linkDistance: 250,
};

const STORE_KEY = "brain2.graph";

function loadOptions(key: string, base: GraphOptions): GraphOptions {
  try {
    return { ...base, ...JSON.parse(localStorage.getItem(key) ?? "{}") };
  } catch {
    return base;
  }
}

function saveOptions(key: string, o: GraphOptions) {
  try {
    localStorage.setItem(key, JSON.stringify(o));
  } catch {
    /* storage unavailable */
  }
}

/** Query language shared by search and color groups: `tag:x`, `path:x`, `file:x`, or plain text. */
function matcher(query: string): ((n: GNode) => boolean) | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const terms = q.split(/\s+/);
  return (n) =>
    terms.every((t) => {
      if (t.startsWith("tag:") || t.startsWith("#")) {
        const tag = t.replace(/^tag:/, "").replace(/^#/, "");
        return n.kind === "tag" ? n.label.toLowerCase() === `#${tag}` : (n.tags ?? []).some((x) => x.toLowerCase() === tag || x.toLowerCase().startsWith(`${tag}/`));
      }
      if (t.startsWith("path:")) return n.id.toLowerCase().includes(t.slice(5));
      if (t.startsWith("file:")) return n.label.toLowerCase().includes(t.slice(5));
      return n.label.toLowerCase().includes(t) || n.id.toLowerCase().includes(t);
    });
}

// ============================================================================ canvas
interface GNode extends SimulationNodeDatum {
  id: string;
  label: string;
  kind: string;
  tags?: string[];
  degree: number;
}
type GLink = SimulationLinkDatum<GNode>;

function cssVar(name: string, fallback: string) {
  return getComputedStyle(document.body).getPropertyValue(name).trim() || fallback;
}

export function filterGraph(data: GraphData, o: GraphOptions): GraphData {
  let nodes = data.nodes.filter((n) => {
    if (n.kind === "tag") return o.showTags;
    if (n.kind === "unresolved") return !o.existingOnly;
    if (n.kind !== "markdown" && n.kind !== "excalidraw") return o.showAttachments;
    return true;
  });
  let ids = new Set(nodes.map((n) => n.id));
  const edges = data.edges.filter((e) => ids.has(e.source) && ids.has(e.target));
  if (!o.showOrphans) {
    const linked = new Set(edges.flatMap((e) => [e.source, e.target]));
    nodes = nodes.filter((n) => linked.has(n.id));
    ids = new Set(nodes.map((n) => n.id));
  }
  return { nodes, edges: edges.filter((e) => ids.has(e.source) && ids.has(e.target)) };
}

/** Neighbourhood of `center` up to `depth` links away (local graph). */
export function localGraph(data: GraphData, center: string, depth: number): GraphData {
  const adj = new Map<string, Set<string>>();
  for (const e of data.edges) {
    if (!adj.has(e.source)) adj.set(e.source, new Set());
    if (!adj.has(e.target)) adj.set(e.target, new Set());
    adj.get(e.source)!.add(e.target);
    adj.get(e.target)!.add(e.source);
  }
  const keep = new Set([center]);
  let frontier = [center];
  for (let d = 0; d < depth; d++) {
    const next: string[] = [];
    for (const id of frontier) for (const n of adj.get(id) ?? []) if (!keep.has(n)) (keep.add(n), next.push(n));
    frontier = next;
  }
  return {
    nodes: data.nodes.filter((n) => keep.has(n.id)),
    edges: data.edges.filter((e) => keep.has(e.source) && keep.has(e.target)),
  };
}

export function GraphCanvas({ data, options, activePath, compact }: {
  data: GraphData;
  options: GraphOptions;
  activePath: string | null;
  compact?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const opts = useRef(options);
  opts.current = options;
  const s = useRef({
    nodes: [] as GNode[],
    links: [] as GLink[],
    sim: null as Simulation<GNode, GLink> | null,
    t: { x: 0, y: 0, k: compact ? 0.9 : 1 },
    hover: null as GNode | null,
    drag: null as GNode | null,
    pan: null as { x: number; y: number } | null,
    moved: false,
    signature: "",
    draw: () => {},
  }).current;

  const radius = (n: GNode) => (n.kind === "tag" ? 3 : 3.5) * opts.current.nodeSize + Math.sqrt(n.degree) * 1.5 * opts.current.nodeSize;

  // (Re)build the simulation when the graph changes; keep positions of known nodes.
  // Identical data (e.g. a refetch after saving a note that didn't change links) must not
  // re-heat the simulation, otherwise the graph visibly "pulses" on every autosave.
  useEffect(() => {
    const signature =
      data.nodes.map((n) => `${n.id}\u0001${n.label}\u0001${n.kind}\u0001${(n.tags ?? []).join(",")}`).join("\u0002") +
      "\u0003" +
      data.edges.map((e) => `${e.source}\u0001${e.target}`).join("\u0002");
    if (signature === s.signature && s.sim) return;
    s.signature = signature;
    const prev = new Map(s.nodes.map((n) => [n.id, n]));
    const known = data.nodes.filter((n) => prev.has(n.id)).length;
    const degree = new Map<string, number>();
    for (const e of data.edges) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    }
    s.nodes = data.nodes.map((n) => {
      const old = prev.get(n.id);
      return { ...n, degree: degree.get(n.id) ?? 0, x: old?.x, y: old?.y, vx: old?.vx, vy: old?.vy };
    });
    s.links = data.edges.map((e) => ({ source: e.source, target: e.target }));
    s.sim?.stop();
    s.sim = forceSimulation<GNode, GLink>(s.nodes)
      .force("link", forceLink<GNode, GLink>(s.links).id((d) => d.id))
      .force("charge", forceManyBody())
      .force("center", forceCenter(0, 0))
      .force("x", forceX(0))
      .force("y", forceY(0))
      .force("collide", forceCollide<GNode>().radius((d) => radius(d) + 3))
      .on("tick", () => s.draw());
    // Mostly-known graph: a gentle nudge is enough; new graph: full layout.
    applyForces(known > 0 && known >= data.nodes.length * 0.8 ? 0.15 : 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  useEffect(
    () => () => {
      s.sim?.stop();
      s.sim = null;
      s.signature = "";
    },
    [s],
  );

  const applyForces = (heat = 0.5) => {
    const sim = s.sim;
    if (!sim) return;
    const o = opts.current;
    (sim.force("link") as ReturnType<typeof forceLink<GNode, GLink>>)
      .distance(30 + o.linkDistance / 5)
      .strength(Math.max(0.01, o.linkForce));
    (sim.force("charge") as ReturnType<typeof forceManyBody>).strength(-(o.repelForce * 15));
    (sim.force("x") as ReturnType<typeof forceX>).strength(o.centerForce * 0.1);
    (sim.force("y") as ReturnType<typeof forceY>).strength(o.centerForce * 0.1);
    sim.alphaTarget(0).alpha(Math.max(sim.alpha(), heat)).restart();
  };

  const firstForces = useRef(true);
  useEffect(() => {
    // The data effect already laid out the graph on mount; only re-heat on real option changes.
    if (firstForces.current) {
      firstForces.current = false;
      return;
    }
    applyForces(0.5);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.centerForce, options.repelForce, options.linkForce, options.linkDistance, options.nodeSize]);

  // Drawing ---------------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    s.draw = () => {
      const o = opts.current;
      const dpr = window.devicePixelRatio || 1;
      const { width, height } = canvas.getBoundingClientRect();
      if (!width || !height) return;
      if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
      }
      const { x, y, k } = s.t;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.translate(width / 2 + x, height / 2 + y);
      ctx.scale(k, k);
      const text = cssVar("--text-normal", "#ddd");
      const muted = cssVar("--text-faint", "#888");
      const accent = cssVar("--accent", "#7c6cff");
      const line = cssVar("--graph-line", "rgba(128,128,128,0.35)");
      const tagColor = cssVar("--tag-text", accent);
      const search = matcher(o.search);
      const groups = o.groups.map((g) => ({ m: matcher(g.query), color: g.color })).filter((g) => g.m);
      const hover = s.hover;
      const near = new Set<string>();
      if (hover) {
        for (const l of s.links) {
          const a = (l.source as GNode).id;
          const b = (l.target as GNode).id;
          if (a === hover.id) near.add(b);
          if (b === hover.id) near.add(a);
        }
      }
      // links
      ctx.lineWidth = (o.linkThickness * 1) / k;
      for (const l of s.links) {
        const a = l.source as GNode;
        const b = l.target as GNode;
        const hot = hover && (a.id === hover.id || b.id === hover.id);
        ctx.strokeStyle = hot ? accent : line;
        ctx.fillStyle = hot ? accent : line;
        ctx.globalAlpha = hover && !hot ? 0.2 : 1;
        ctx.beginPath();
        ctx.moveTo(a.x!, a.y!);
        ctx.lineTo(b.x!, b.y!);
        ctx.stroke();
        if (o.arrows) {
          const ang = Math.atan2(b.y! - a.y!, b.x! - a.x!);
          const r = radius(b) + 2;
          const tx = b.x! - Math.cos(ang) * r;
          const ty = b.y! - Math.sin(ang) * r;
          const size = 5 / Math.max(k, 0.5);
          ctx.beginPath();
          ctx.moveTo(tx, ty);
          ctx.lineTo(tx - size * Math.cos(ang - 0.45), ty - size * Math.sin(ang - 0.45));
          ctx.lineTo(tx - size * Math.cos(ang + 0.45), ty - size * Math.sin(ang + 0.45));
          ctx.fill();
        }
      }
      // nodes
      for (const n of s.nodes) {
        const matches = !search || search(n);
        const dim = (hover && n !== hover && !near.has(n.id)) || !matches;
        ctx.globalAlpha = dim ? 0.15 : 1;
        const group = groups.find((g) => g.m!(n));
        ctx.fillStyle =
          n === hover || n.id === activePath
            ? accent
            : group
              ? group.color
              : n.kind === "tag"
                ? tagColor
                : n.kind === "unresolved"
                  ? muted
                  : n.kind === "markdown" || n.kind === "excalidraw"
                    ? text
                    : muted;
        ctx.beginPath();
        ctx.arc(n.x!, n.y!, radius(n), 0, Math.PI * 2);
        ctx.fill();
      }
      // Labels fade in with zoom. Below the threshold only the hovered node shows its name;
      // neighbours / active / search matches appear a bit earlier than the rest, but never from far away.
      const fade = Math.max(0, Math.min(1, (k - o.textFade) / 0.3));
      const nearFade = Math.max(0, Math.min(1, (k - o.textFade * 0.6) / 0.3));
      ctx.textAlign = "center";
      ctx.font = `${12 / Math.max(k, 0.6)}px ${cssVar("--font-interface", "sans-serif")}`;
      for (const n of s.nodes) {
        const emphasised = n === hover || near.has(n.id) || n.id === activePath || (search && search(n));
        const alpha = n === hover ? 1 : emphasised ? Math.max(fade, nearFade) : fade;
        if (alpha <= 0.02) continue;
        ctx.globalAlpha = hover && !emphasised ? Math.min(alpha, 0.2) : alpha;
        ctx.fillStyle = text;
        if (n === hover) continue; // drawn last, on top, at a readable size
        ctx.fillText(n.label, n.x!, n.y! + radius(n) + 12 / Math.max(k, 0.6));
      }
      if (hover) {
        // The hovered name is always readable on screen, whatever the zoom.
        const size = 13 / k;
        ctx.globalAlpha = 1;
        ctx.font = `600 ${size}px ${cssVar("--font-interface", "sans-serif")}`;
        ctx.fillStyle = text;
        ctx.fillText(hover.label, hover.x!, hover.y! + radius(hover) + size * 1.1);
      }
      ctx.globalAlpha = 1;
    };
    s.draw();
    const ro = new ResizeObserver(() => s.draw());
    ro.observe(canvas);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => s.draw(), [options, activePath, s]);

  // Interaction -----------------------------------------------------------
  const toWorld = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left - r.width / 2 - s.t.x) / s.t.k, y: (e.clientY - r.top - r.height / 2 - s.t.y) / s.t.k };
  };
  const hit = (e: { clientX: number; clientY: number }) => {
    const p = toWorld(e);
    return s.nodes.find((n) => Math.hypot(n.x! - p.x, n.y! - p.y) <= radius(n) + 3) ?? null;
  };

  return (
    <canvas
      ref={canvasRef}
      className="graph-canvas"
      onWheel={(e) => {
        const r = canvasRef.current!.getBoundingClientRect();
        const k = Math.min(5, Math.max(0.1, s.t.k * Math.exp(-e.deltaY * 0.0015)));
        const mx = e.clientX - r.left - r.width / 2;
        const my = e.clientY - r.top - r.height / 2;
        s.t = { k, x: mx - ((mx - s.t.x) * k) / s.t.k, y: my - ((my - s.t.y) * k) / s.t.k };
        s.draw();
      }}
      onMouseDown={(e) => {
        s.moved = false;
        const n = hit(e);
        if (n) {
          s.drag = n;
        } else s.pan = { x: e.clientX - s.t.x, y: e.clientY - s.t.y };
      }}
      onMouseMove={(e) => {
        if (s.drag) {
          if (!s.moved) s.sim?.alphaTarget(0.3).restart();
          s.moved = true;
          const p = toWorld(e);
          s.drag.fx = p.x;
          s.drag.fy = p.y;
        } else if (s.pan) {
          s.moved = true;
          s.t = { ...s.t, x: e.clientX - s.pan.x, y: e.clientY - s.pan.y };
          s.draw();
        } else {
          const n = hit(e);
          if (n !== s.hover) {
            s.hover = n;
            canvasRef.current!.style.cursor = n ? "pointer" : "grab";
            s.draw();
          }
        }
      }}
      onMouseUp={(e) => {
        if (s.drag) {
          s.drag.fx = null;
          s.drag.fy = null;
          s.sim?.alphaTarget(0);
          if (!s.moved) {
            const n = s.drag;
            const ws = useWorkspace.getState();
            if (n.kind === "tag") ws.set({ leftOpen: true, leftTab: "search", searchQuery: `tag:${n.label.slice(1)}` });
            else if (n.kind !== "unresolved") ws.openFile(n.id, { newTab: e.metaKey || e.ctrlKey });
          }
        }
        s.drag = null;
        s.pan = null;
      }}
      onMouseLeave={() => {
        s.pan = null;
        if (s.drag) {
          s.drag.fx = null;
          s.drag.fy = null;
          s.drag = null;
          s.sim?.alphaTarget(0);
        }
        if (s.hover) {
          s.hover = null;
          s.draw();
        }
      }}
    />
  );
}

// ============================================================================ data hook
export function useGraphData(withTags: boolean, withAttachments: boolean) {
  const vaultId = useWorkspace((s) => s.vaultId)!;
  const revision = useWorkspace((s) => s.revision);
  const [data, setData] = useState<GraphData>({ nodes: [], edges: [] });
  useEffect(() => {
    let alive = true;
    api
      .graph(vaultId, { tags: withTags, attachments: withAttachments, unresolved: true })
      .then((g) => alive && setData(g))
      .catch(reportError);
    return () => {
      alive = false;
    };
  }, [vaultId, revision, withTags, withAttachments]);
  return data;
}

// ============================================================================ settings panel
function Section({ title, children, open: initial = true }: { title: string; children: ReactNode; open?: boolean }) {
  const [open, setOpen] = useState(initial);
  return (
    <div className="graph-section">
      <button className="graph-section-title" onClick={() => setOpen(!open)}>
        <Icon name={open ? "expand_more" : "chevron_right"} size={16} /> {title}
      </button>
      {open && <div className="graph-section-body">{children}</div>}
    </div>
  );
}

function Slider({ label, value, min, max, step, onChange }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void }) {
  return (
    <label className="graph-slider">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

function Check({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="graph-check">
      <span>{label}</span>
      <button className={`toggle small${value ? " on" : ""}`} role="switch" aria-checked={value} onClick={() => onChange(!value)}>
        <span />
      </button>
    </label>
  );
}

const GROUP_COLORS = ["#e5484d", "#f5a524", "#30a46c", "#0091ff", "#8e4ec6", "#e93d82", "#12a594"];

export function GraphSettings({ o, set, local }: { o: GraphOptions; set: (p: Partial<GraphOptions>) => void; local?: { depth: number; setDepth: (d: number) => void } }) {
  return (
    <div className="graph-settings">
      <Section title="Filters">
        <input className="input input-small" placeholder="Search files… (tag:, path:, file:)" value={o.search} onChange={(e) => set({ search: e.target.value })} />
        {local && <Slider label={`Depth: ${local.depth}`} value={local.depth} min={1} max={5} step={1} onChange={local.setDepth} />}
        <Check label="Tags" value={o.showTags} onChange={(v) => set({ showTags: v })} />
        <Check label="Attachments" value={o.showAttachments} onChange={(v) => set({ showAttachments: v })} />
        <Check label="Existing files only" value={o.existingOnly} onChange={(v) => set({ existingOnly: v })} />
        <Check label="Orphans" value={o.showOrphans} onChange={(v) => set({ showOrphans: v })} />
      </Section>
      <Section title="Groups" open={o.groups.length > 0}>
        {o.groups.map((g, i) => (
          <div className="graph-group" key={i}>
            <input
              type="color"
              className="color-input small"
              value={g.color}
              onChange={(e) => set({ groups: o.groups.map((x, j) => (j === i ? { ...x, color: e.target.value } : x)) })}
            />
            <input
              className="input input-small"
              placeholder="tag:project, path:Work…"
              value={g.query}
              onChange={(e) => set({ groups: o.groups.map((x, j) => (j === i ? { ...x, query: e.target.value } : x)) })}
            />
            <button className="icon-button" onClick={() => set({ groups: o.groups.filter((_, j) => j !== i) })}>
              <Icon name="close" size={16} />
            </button>
          </div>
        ))}
        <button
          className="btn btn-small"
          onClick={() => set({ groups: [...o.groups, { query: "", color: GROUP_COLORS[o.groups.length % GROUP_COLORS.length] }] })}
        >
          New group
        </button>
      </Section>
      <Section title="Display" open={false}>
        <Check label="Arrows" value={o.arrows} onChange={(v) => set({ arrows: v })} />
        <Slider label="Text fade threshold" value={o.textFade} min={0.1} max={3} step={0.05} onChange={(v) => set({ textFade: v })} />
        <Slider label="Node size" value={o.nodeSize} min={0.3} max={3} step={0.1} onChange={(v) => set({ nodeSize: v })} />
        <Slider label="Link thickness" value={o.linkThickness} min={0.2} max={4} step={0.1} onChange={(v) => set({ linkThickness: v })} />
      </Section>
      <Section title="Forces" open={false}>
        <Slider label="Center force" value={o.centerForce} min={0} max={1} step={0.02} onChange={(v) => set({ centerForce: v })} />
        <Slider label="Repel force" value={o.repelForce} min={0} max={20} step={0.5} onChange={(v) => set({ repelForce: v })} />
        <Slider label="Link force" value={o.linkForce} min={0} max={1} step={0.02} onChange={(v) => set({ linkForce: v })} />
        <Slider label="Link distance" value={o.linkDistance} min={30} max={500} step={10} onChange={(v) => set({ linkDistance: v })} />
      </Section>
      <button className="btn btn-small" onClick={() => set({ ...DEFAULT_GRAPH, groups: o.groups })}>
        Restore defaults
      </button>
    </div>
  );
}

// ============================================================================ views
export function GraphView({ active }: { active: boolean }) {
  const [o, setO] = useState(() => loadOptions(STORE_KEY, DEFAULT_GRAPH));
  const [panel, setPanel] = useState(true);
  const set = (p: Partial<GraphOptions>) =>
    setO((prev) => {
      const next = { ...prev, ...p };
      saveOptions(STORE_KEY, next);
      return next;
    });
  const raw = useGraphData(o.showTags, o.showAttachments);
  const data = useMemo(() => filterGraph(raw, o), [raw, o.showTags, o.showAttachments, o.existingOnly, o.showOrphans]); // eslint-disable-line react-hooks/exhaustive-deps
  const activeFile = useWorkspace((s) => [...s.tabs].reverse().find((t) => t.type === "file")?.path ?? null);

  return (
    <div className="view graph-view">
      <div className="view-header">
        <div className="view-breadcrumb">
          <span className="crumb current">
            <Icon name="graph_3" size={18} /> Graph view
          </span>
        </div>
        <div className="view-actions">
          <span className="muted tiny">
            {data.nodes.length} nodes · {data.edges.length} links
          </span>
          <button className={`icon-button${panel ? " active" : ""}`} title="Graph settings" onClick={() => setPanel(!panel)}>
            <Icon name="tune" size={18} />
          </button>
        </div>
      </div>
      <div className="graph-body">
        {active && <GraphCanvas data={data} options={o} activePath={activeFile} />}
        {panel && <GraphSettings o={o} set={set} />}
      </div>
    </div>
  );
}

/** Right-sidebar local graph around the active note. */
export function LocalGraph({ path }: { path: string }) {
  const [o, setO] = useState(() => loadOptions(`${STORE_KEY}.local`, { ...DEFAULT_GRAPH, textFade: 0.2 }));
  const [depth, setDepth] = useState(() => {
    try {
      return Math.min(5, Math.max(1, Number(localStorage.getItem(`${STORE_KEY}.depth`)) || 1));
    } catch {
      return 1;
    }
  });
  const [panel, setPanel] = useState(false);
  const set = (p: Partial<GraphOptions>) =>
    setO((prev) => {
      const next = { ...prev, ...p };
      saveOptions(`${STORE_KEY}.local`, next);
      return next;
    });
  const raw = useGraphData(o.showTags, o.showAttachments);
  const data = useMemo(() => filterGraph(localGraph(raw, path, depth), { ...o, showOrphans: true }), [raw, path, depth, o.showTags, o.showAttachments, o.existingOnly]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="local-graph">
      <div className="local-graph-bar">
        <span className="muted tiny">{data.nodes.length} notes</span>
        <button className="icon-button" title="Local graph settings" onClick={() => setPanel(!panel)}>
          <Icon name="tune" size={16} />
        </button>
      </div>
      <div className="graph-body">
        <GraphCanvas data={data} options={o} activePath={path} compact />
        {panel && (
          <GraphSettings
            o={o}
            set={set}
            local={{
              depth,
              setDepth: (d) => {
                setDepth(d);
                try {
                  localStorage.setItem(`${STORE_KEY}.depth`, String(d));
                } catch {
                  /* ignore */
                }
              },
            }}
          />
        )}
      </div>
    </div>
  );
}
