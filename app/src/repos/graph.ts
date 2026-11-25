// Lane assignment for the commit graph column (like `git log --graph`, one row per commit).
import type { Commit } from "../lib/repoTypes";

export interface GraphRow {
  lane: number;
  color: number;
  /** Lines from this row to the next row: [fromLane, toLane, colorIndex]. */
  down: [number, number, number][];
  /** Lines entering this row from the previous one: [fromLane, toLane, colorIndex]. */
  up: [number, number, number][];
  width: number;
}

export function layoutGraph(commits: Commit[]): GraphRow[] {
  let lanes: (string | null)[] = []; // sha expected in each lane
  const colors: number[] = [];
  let nextColor = 0;
  const rows: GraphRow[] = [];
  let prevDown: [number, number, number][] = [];

  for (const c of commits) {
    let lane = lanes.indexOf(c.sha);
    if (lane === -1) {
      lane = lanes.indexOf(null);
      if (lane === -1) lane = lanes.length;
      lanes[lane] = c.sha;
      colors[lane] = nextColor++;
    }
    const color = colors[lane];
    // Other lanes waiting for this same commit merge into it.
    const merging: number[] = [];
    lanes.forEach((sha, i) => {
      if (sha === c.sha && i !== lane) merging.push(i);
    });
    const before = lanes.slice();
    merging.forEach((i) => (lanes[i] = null));

    const [first, ...rest] = c.parents;
    lanes[lane] = first ?? null;
    const parentLanes: number[] = [];
    for (const p of rest) {
      let pl = lanes.indexOf(p);
      if (pl === -1) {
        pl = lanes.indexOf(null);
        if (pl === -1) pl = lanes.length;
        lanes[pl] = p;
        colors[pl] = nextColor++;
      }
      parentLanes.push(pl);
    }
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();

    const down: [number, number, number][] = [];
    before.forEach((sha, i) => {
      if (sha === null || i === lane || merging.includes(i)) return;
      down.push([i, i, colors[i]]); // pass-through lanes
    });
    if (first) down.push([lane, lane, color]);
    parentLanes.forEach((pl) => down.push([lane, pl, colors[pl]]));
    // Lines arriving from the previous row end at our node (or keep going straight).
    const up: [number, number, number][] = prevDown.map(([, b, col]) => [b, b === lane || merging.includes(b) ? lane : b, col]);

    const width = Math.max(lane + 1, ...down.map((d) => Math.max(d[0], d[1]) + 1), ...up.map((u) => Math.max(u[0], u[1]) + 1));
    rows.push({ lane, color, down, up, width });
    prevDown = down;
  }
  return rows;
}

export const GRAPH_COLORS = ["#4f8ff7", "#e5484d", "#30a46c", "#f5a524", "#8e4ec6", "#00a2c7", "#d6409f", "#978365"];
