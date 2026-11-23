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
import { useEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { api } from "../lib/api";
import { reportError, useWorkspace } from "../store";

interface Node extends SimulationNodeDatum {
  id: string;
  label: string;
  kind: string;
  degree: number;
}
type Link = SimulationLinkDatum<Node>;

function cssVar(name: string, fallback: string) {
  return getComputedStyle(document.body).getPropertyValue(name).trim() || fallback;
}

export function GraphView({ active }: { active: boolean }) {
  const vaultId = useWorkspace((s) => s.vaultId)!;
  const revision = useWorkspace((s) => s.revision);
  const activeFile = useWorkspace((s) => {
    const prev = [...s.tabs].reverse().find((t) => t.type === "file");
    return prev?.path ?? null;
  });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState("");
  const [showUnresolved, setShowUnresolved] = useState(true);
  const [showOrphans, setShowOrphans] = useState(true);
  const state = useRef({
    nodes: [] as Node[],
    links: [] as Link[],
    sim: null as Simulation<Node, Link> | null,
    transform: { x: 0, y: 0, k: 1 },
    hover: null as Node | null,
    drag: null as Node | null,
    pan: null as { x: number; y: number } | null,
    moved: false,
    draw: () => {},
  });

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    api
      .graph(vaultId)
      .then((g) => {
        if (cancelled) return;
        const s = state.current;
        const prev = new Map(s.nodes.map((n) => [n.id, n]));
        const degree = new Map<string, number>();
        for (const e of g.edges) {
          degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
          degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
        }
        let nodes: Node[] = g.nodes.map((n) => {
          const old = prev.get(n.id);
          return { ...n, degree: degree.get(n.id) ?? 0, x: old?.x, y: old?.y, vx: old?.vx, vy: old?.vy };
        });
        if (!showUnresolved) nodes = nodes.filter((n) => n.kind !== "unresolved");
        if (!showOrphans) nodes = nodes.filter((n) => n.degree > 0);
        const ids = new Set(nodes.map((n) => n.id));
        const links: Link[] = g.edges
          .filter((e) => ids.has(e.source) && ids.has(e.target))
          .map((e) => ({ source: e.source, target: e.target }));
        s.sim?.stop();
        s.nodes = nodes;
        s.links = links;
        s.sim = forceSimulation<Node, Link>(nodes)
          .force("link", forceLink<Node, Link>(links).id((d) => d.id).distance(60).strength(0.6))
          .force("charge", forceManyBody().strength(-120))
          .force("center", forceCenter(0, 0))
          .force("x", forceX(0).strength(0.04))
          .force("y", forceY(0).strength(0.04))
          .force("collide", forceCollide<Node>().radius((d) => radius(d) + 4))
          .on("tick", () => s.draw());
      })
      .catch(reportError);
    return () => {
      cancelled = true;
    };
  }, [vaultId, revision, active, showUnresolved, showOrphans]);

  useEffect(
    () => () => {
      state.current.sim?.stop();
    },
    [],
  );

  // Drawing ------------------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current!;
    const s = state.current;
    const ctx = canvas.getContext("2d")!;
    s.draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const { width, height } = canvas.getBoundingClientRect();
      if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
        canvas.width = width * dpr;
        canvas.height = height * dpr;
      }
      const { x, y, k } = s.transform;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.translate(width / 2 + x, height / 2 + y);
      ctx.scale(k, k);
      const text = cssVar("--text-normal", "#ddd");
      const muted = cssVar("--text-faint", "#888");
      const accent = cssVar("--accent", "#7c6cff");
      const line = cssVar("--graph-line", "rgba(128,128,128,0.35)");
      const q = filter.trim().toLowerCase();
      const hover = s.hover;
      const neighbours = new Set<string>();
      if (hover) {
        for (const l of s.links) {
          const a = (l.source as Node).id;
          const b = (l.target as Node).id;
          if (a === hover.id) neighbours.add(b);
          if (b === hover.id) neighbours.add(a);
        }
      }
      ctx.lineWidth = 1 / k;
      for (const l of s.links) {
        const a = l.source as Node;
        const b = l.target as Node;
        const hot = hover && (a.id === hover.id || b.id === hover.id);
        ctx.strokeStyle = hot ? accent : line;
        ctx.globalAlpha = hover && !hot ? 0.25 : 1;
        ctx.beginPath();
        ctx.moveTo(a.x!, a.y!);
        ctx.lineTo(b.x!, b.y!);
        ctx.stroke();
      }
      for (const n of s.nodes) {
        const matches = !q || n.label.toLowerCase().includes(q);
        const dim = (hover && n !== hover && !neighbours.has(n.id)) || !matches;
        ctx.globalAlpha = dim ? 0.2 : 1;
        ctx.fillStyle =
          n === hover || n.id === activeFile ? accent : n.kind === "unresolved" ? muted : n.kind === "markdown" ? text : muted;
        ctx.beginPath();
        ctx.arc(n.x!, n.y!, radius(n), 0, Math.PI * 2);
        ctx.fill();
        if (k > 0.7 || n === hover || neighbours.has(n.id) || (q && matches)) {
          ctx.fillStyle = text;
          ctx.font = `${12 / Math.max(k, 0.7)}px var(--font-interface, sans-serif)`;
          ctx.textAlign = "center";
          ctx.fillText(n.label, n.x!, n.y! + radius(n) + 12 / Math.max(k, 0.7));
        }
      }
      ctx.globalAlpha = 1;
    };
    s.draw();
    const ro = new ResizeObserver(() => s.draw());
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [filter, activeFile]);

  // Interaction --------------------------------------------------------------
  const toWorld = (e: { clientX: number; clientY: number }) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const { x, y, k } = state.current.transform;
    return { x: (e.clientX - rect.left - rect.width / 2 - x) / k, y: (e.clientY - rect.top - rect.height / 2 - y) / k };
  };
  const hit = (e: { clientX: number; clientY: number }) => {
    const p = toWorld(e);
    return state.current.nodes.find((n) => Math.hypot(n.x! - p.x, n.y! - p.y) <= radius(n) + 3) ?? null;
  };

  return (
    <div className="view graph-view" ref={wrapRef}>
      <div className="view-header">
        <div className="view-breadcrumb">
          <span className="crumb current">
            <Icon name="hub" size={18} /> Graph view
          </span>
        </div>
        <div className="graph-controls">
          <input className="input input-small" placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <label className="check">
            <input type="checkbox" checked={showUnresolved} onChange={(e) => setShowUnresolved(e.target.checked)} /> Unresolved
          </label>
          <label className="check">
            <input type="checkbox" checked={showOrphans} onChange={(e) => setShowOrphans(e.target.checked)} /> Orphans
          </label>
        </div>
      </div>
      <canvas
        ref={canvasRef}
        className="graph-canvas"
        onWheel={(e) => {
          const s = state.current;
          const rect = canvasRef.current!.getBoundingClientRect();
          const factor = Math.exp(-e.deltaY * 0.0015);
          const k = Math.min(4, Math.max(0.15, s.transform.k * factor));
          const mx = e.clientX - rect.left - rect.width / 2;
          const my = e.clientY - rect.top - rect.height / 2;
          s.transform = {
            k,
            x: mx - ((mx - s.transform.x) * k) / s.transform.k,
            y: my - ((my - s.transform.y) * k) / s.transform.k,
          };
          s.draw();
        }}
        onMouseDown={(e) => {
          const s = state.current;
          s.moved = false;
          const n = hit(e);
          if (n) {
            s.drag = n;
            s.sim?.alphaTarget(0.3).restart();
          } else {
            s.pan = { x: e.clientX - s.transform.x, y: e.clientY - s.transform.y };
          }
        }}
        onMouseMove={(e) => {
          const s = state.current;
          if (s.drag) {
            s.moved = true;
            const p = toWorld(e);
            s.drag.fx = p.x;
            s.drag.fy = p.y;
          } else if (s.pan) {
            s.moved = true;
            s.transform = { ...s.transform, x: e.clientX - s.pan.x, y: e.clientY - s.pan.y };
            s.draw();
          } else {
            const n = hit(e);
            if (n !== s.hover) {
              s.hover = n;
              canvasRef.current!.style.cursor = n ? "pointer" : "default";
              s.draw();
            }
          }
        }}
        onMouseUp={(e) => {
          const s = state.current;
          if (s.drag) {
            s.drag.fx = null;
            s.drag.fy = null;
            s.sim?.alphaTarget(0);
            if (!s.moved) {
              const n = s.drag;
              if (n.kind !== "unresolved") useWorkspace.getState().openFile(n.id, { newTab: e.metaKey || e.ctrlKey });
            }
          }
          s.drag = null;
          s.pan = null;
        }}
        onMouseLeave={() => {
          const s = state.current;
          s.pan = null;
          if (s.drag) {
            s.drag.fx = null;
            s.drag.fy = null;
            s.drag = null;
          }
        }}
      />
    </div>
  );
}

function radius(n: Node) {
  return 3.5 + Math.sqrt(n.degree) * 1.6;
}
