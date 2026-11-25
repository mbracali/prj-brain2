// Markdown kanban boards, compatible with the Obsidian Kanban plugin format:
//
//   ---
//   kanban-plugin: board
//   ---
//   ## Lane
//   - [ ] Card text
//   - [x] Done card
//   ***
//   ## Archive
//   - [x] Archived card
//   %% kanban:settings
//   ```
//   {"kanban-plugin":"board"}
//   ```
//   %%

export interface Card {
  id: string;
  text: string;
  checked: boolean;
}

export interface Lane {
  id: string;
  title: string;
  cards: Card[];
  /** Lane marked with **Complete**: cards moved here get checked. */
  complete: boolean;
}

export interface Board {
  frontmatter: string;
  lanes: Lane[];
  archive: Card[];
  settings: string;
}

let seq = 0;
export const uid = () => `k${Date.now().toString(36)}${(seq++).toString(36)}`;

const FM_RE = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;
const SETTINGS_RE = /\n?%% kanban:settings[\s\S]*?%%\s*$/;

export function isKanban(text: string): boolean {
  const fm = FM_RE.exec(text);
  return !!fm && /^kanban-plugin\s*:/m.test(fm[0]);
}

export function parseBoard(text: string): Board {
  const src = text.replace(/\r\n/g, "\n");
  const fm = FM_RE.exec(src);
  const frontmatter = fm ? fm[0].trimEnd() : "---\n\nkanban-plugin: board\n\n---";
  let body = fm ? src.slice(fm[0].length) : src;
  const settingsMatch = SETTINGS_RE.exec(body);
  const settings = settingsMatch ? settingsMatch[0].trim() : "";
  if (settingsMatch) body = body.slice(0, settingsMatch.index);

  const lanes: Lane[] = [];
  const archive: Card[] = [];
  let lane: Lane | null = null;
  let inArchive = false;
  let card: Card | null = null;

  for (const raw of body.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (/^\*{3,}$|^-{3,}$/.test(line.trim()) && !line.startsWith("- ")) {
      inArchive = true;
      card = null;
      continue;
    }
    const heading = /^##\s+(.*)$/.exec(line);
    if (heading) {
      card = null;
      if (inArchive) continue; // "## Archive"
      lane = { id: uid(), title: heading[1].trim(), cards: [], complete: false };
      lanes.push(lane);
      continue;
    }
    const item = /^[-*+]\s+(?:\[([ xX])\]\s?)?(.*)$/.exec(line);
    if (item) {
      card = { id: uid(), checked: !!item[1] && item[1] !== " ", text: brToNewline(item[2]) };
      if (inArchive) archive.push(card);
      else if (lane) lane.cards.push(card);
      else {
        lane = { id: uid(), title: "Untitled", cards: [card], complete: false };
        lanes.push(lane);
      }
      continue;
    }
    if (/^\*\*Complete\*\*$/.test(line.trim()) && lane && !inArchive) {
      lane.complete = true;
      continue;
    }
    if (card && /^(\t| {2,})\S/.test(raw)) {
      card.text += "\n" + raw.replace(/^(\t| {2,4})/, "");
    }
  }
  return { frontmatter, lanes, archive, settings };
}

function brToNewline(s: string) {
  return s.replace(/<br\s*\/?>/gi, "\n");
}

function cardLine(c: Card): string {
  return `- [${c.checked ? "x" : " "}] ${c.text.trim().replace(/\n/g, "<br>")}`;
}

export function serializeBoard(b: Board): string {
  const out: string[] = [b.frontmatter, ""];
  for (const lane of b.lanes) {
    out.push(`## ${lane.title}`, "");
    if (lane.complete) out.push("**Complete**");
    for (const c of lane.cards) out.push(cardLine(c));
    out.push("", "");
  }
  if (b.archive.length) {
    out.push("***", "", "## Archive", "");
    for (const c of b.archive) out.push(cardLine(c));
    out.push("", "");
  }
  out.push(b.settings || '%% kanban:settings\n```\n{"kanban-plugin":"board"}\n```\n%%');
  return out.join("\n").replace(/\n{4,}/g, "\n\n\n") + "\n";
}

export function emptyBoardMarkdown(): string {
  return serializeBoard({
    frontmatter: "---\n\nkanban-plugin: board\n\n---",
    lanes: [
      { id: uid(), title: "To do", cards: [], complete: false },
      { id: uid(), title: "Doing", cards: [], complete: false },
      { id: uid(), title: "Done", cards: [], complete: true },
    ],
    archive: [],
    settings: "",
  });
}
