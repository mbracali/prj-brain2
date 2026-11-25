// Markdown (GFM) table model: parse a table block into cells and serialize it back,
// so the live-preview table widget can be edited cell by cell.

export type Align = "left" | "center" | "right" | null;

export interface TableModel {
  indent: string;
  header: string[];
  align: Align[];
  rows: string[][];
}

/** Splits one table row into trimmed cells, honouring escaped pipes (`\|`) and inline code. */
export function parseRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  let code = 0; // length of the open backtick run, 0 = outside code
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && s[i + 1] === "|") {
      cur += "\\|";
      i++;
    } else if (c === "`") {
      let n = 1;
      while (s[i + n] === "`") n++;
      cur += s.slice(i, i + n);
      i += n - 1;
      code = code === 0 ? n : code === n ? 0 : code;
    } else if (c === "|" && code === 0) {
      cells.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

function parseAlign(cell: string): Align {
  const c = cell.trim();
  const l = c.startsWith(":");
  const r = c.endsWith(":");
  return l && r ? "center" : r ? "right" : l ? "left" : null;
}

export function parseTable(src: string): TableModel {
  const lines = src.split("\n").filter((l) => l.trim());
  const indent = /^\s*/.exec(lines[0] ?? "")![0];
  const header = parseRow(lines[0] ?? "");
  const align = parseRow(lines[1] ?? "").map(parseAlign);
  const rows = lines.slice(2).map(parseRow);
  const cols = Math.max(header.length, ...rows.map((r) => r.length));
  const pad = (r: string[]) => [...r, ...Array(Math.max(0, cols - r.length)).fill("")];
  return {
    indent,
    header: pad(header),
    align: [...align, ...Array(Math.max(0, cols - align.length)).fill(null)].slice(0, cols),
    rows: rows.map(pad),
  };
}

/** Escapes characters that would break the table structure. */
export function cleanCell(text: string): string {
  return text.replace(/\r?\n/g, " ").replace(/(^|[^\\])\|/g, "$1\\|").replace(/(^|[^\\])\|/g, "$1\\|");
}

export function serializeTable(m: TableModel): string {
  const cols = m.header.length;
  const width = Array.from({ length: cols }, (_, c) =>
    Math.max(3, m.header[c].length, ...m.rows.map((r) => (r[c] ?? "").length)),
  );
  const line = (cells: string[]) =>
    `${m.indent}| ${cells.map((cell, c) => {
      const pad = width[c] - cell.length;
      if (m.align[c] === "right") return " ".repeat(pad) + cell;
      if (m.align[c] === "center") return " ".repeat(Math.floor(pad / 2)) + cell + " ".repeat(Math.ceil(pad / 2));
      return cell + " ".repeat(pad);
    }).join(" | ")} |`;
  const delim = `${m.indent}| ${m.align
    .map((a, c) => {
      const w = width[c];
      if (a === "center") return `:${"-".repeat(w - 2)}:`;
      if (a === "right") return `${"-".repeat(w - 1)}:`;
      if (a === "left") return `:${"-".repeat(w - 1)}`;
      return "-".repeat(w);
    })
    .join(" | ")} |`;
  return [line(m.header), delim, ...m.rows.map((r) => line(r))].join("\n");
}

export function addRow(m: TableModel, at = m.rows.length): TableModel {
  const rows = [...m.rows];
  rows.splice(at, 0, Array(m.header.length).fill(""));
  return { ...m, rows };
}

export function addColumn(m: TableModel, at = m.header.length): TableModel {
  const ins = <T,>(arr: T[], v: T) => [...arr.slice(0, at), v, ...arr.slice(at)];
  return {
    ...m,
    header: ins(m.header, ""),
    align: ins<Align>(m.align, null),
    rows: m.rows.map((r) => ins(r, "")),
  };
}

export function deleteRow(m: TableModel, at: number): TableModel {
  return { ...m, rows: m.rows.filter((_, i) => i !== at) };
}

export function deleteColumn(m: TableModel, at: number): TableModel {
  if (m.header.length <= 1) return m;
  const del = <T,>(arr: T[]) => arr.filter((_, i) => i !== at);
  return { ...m, header: del(m.header), align: del(m.align), rows: m.rows.map(del) };
}
