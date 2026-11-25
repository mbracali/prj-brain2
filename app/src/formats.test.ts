import LZString from "lz-string";
import { describe, expect, it } from "vitest";
import { parseDrawing, serializeDrawing } from "./excalidraw/format";
import { emptyBoardMarkdown, isKanban, parseBoard, serializeBoard } from "./kanban/format";

const OBSIDIAN_BOARD = `---

kanban-plugin: board

---

## To do

- [ ] Write [[spec]] #work
- [ ] Multi<br>line

## Done

**Complete**
- [x] Ship it


***

## Archive

- [x] Old card

%% kanban:settings
\`\`\`
{"kanban-plugin":"board","list-collapse":[false]}
\`\`\`
%%`;

describe("kanban", () => {
  it("parses the Obsidian Kanban format", () => {
    expect(isKanban(OBSIDIAN_BOARD)).toBe(true);
    const b = parseBoard(OBSIDIAN_BOARD);
    expect(b.lanes.map((l) => l.title)).toEqual(["To do", "Done"]);
    expect(b.lanes[0].cards.map((c) => c.text)).toEqual(["Write [[spec]] #work", "Multi\nline"]);
    expect(b.lanes[1].complete).toBe(true);
    expect(b.lanes[1].cards[0].checked).toBe(true);
    expect(b.archive.map((c) => c.text)).toEqual(["Old card"]);
    expect(b.settings).toContain("list-collapse");
  });
  it("round-trips", () => {
    const once = serializeBoard(parseBoard(OBSIDIAN_BOARD));
    expect(serializeBoard(parseBoard(once))).toBe(once);
    expect(once).toContain("- [ ] Multi<br>line");
    expect(isKanban(emptyBoardMarkdown())).toBe(true);
    expect(parseBoard(emptyBoardMarkdown()).lanes).toHaveLength(3);
  });
  it("ignores normal notes", () => {
    expect(isKanban("# Note\n- [ ] task")).toBe(false);
  });
});

describe("excalidraw", () => {
  const scene = { type: "excalidraw", version: 2, elements: [{ id: "abc12345xyz", type: "text", text: "Hello" }], appState: {} };
  it("reads compressed Obsidian drawings with embedded files", () => {
    const md = `---\nexcalidraw-plugin: parsed\n---\n# Excalidraw Data\n## Text Elements\nHello ^abc12345\n\n## Embedded Files\n0123456789abcdef0123456789abcdef01234567: [[pic.png]]\n\n%%\n## Drawing\n\`\`\`compressed-json\n${LZString.compressToBase64(JSON.stringify(scene))}\n\`\`\`\n%%`;
    const d = parseDrawing("a.excalidraw.md", md);
    expect(d.scene.elements[0].text).toBe("Hello");
    expect(d.embedded).toEqual({ "0123456789abcdef0123456789abcdef01234567": "pic.png" });
  });
  it("writes markdown drawings that read back", () => {
    const text = serializeDrawing("a.excalidraw.md", JSON.stringify(scene), scene as never, { f1aaaaaaaaaaaaaaaaaaaaaa: "x.png" }, "");
    expect(text).toContain("Hello ^abc12345");
    const d = parseDrawing("a.excalidraw.md", text);
    expect(d.scene.elements).toHaveLength(1);
    expect(d.embedded).toEqual({ f1aaaaaaaaaaaaaaaaaaaaaa: "x.png" });
  });
  it("reads plain .excalidraw", () => {
    expect(parseDrawing("a.excalidraw", JSON.stringify(scene)).scene.elements).toHaveLength(1);
  });
});
