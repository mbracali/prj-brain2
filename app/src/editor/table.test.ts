import { describe, expect, it } from "vitest";
import { addColumn, addRow, cleanCell, parseRow, parseTable, serializeTable } from "./table";

describe("markdown tables", () => {
  it("parses rows with escaped pipes and code", () => {
    expect(parseRow("| a | b \\| c | `x|y` |")).toEqual(["a", "b \\| c", "`x|y`"]);
    expect(parseRow("a|b")).toEqual(["a", "b"]);
  });

  it("round-trips a table, keeping alignment", () => {
    const src = "| Name | Qty | Note |\n|:--|--:|:-:|\n| apple | 3 | ok |\n| kiwi | 12 |";
    const m = parseTable(src);
    expect(m.align).toEqual(["left", "right", "center"]);
    expect(m.rows[1]).toEqual(["kiwi", "12", ""]);
    const out = serializeTable(m);
    expect(out).toBe(
      "| Name  | Qty | Note |\n| :---- | --: | :--: |\n| apple |   3 |  ok  |\n| kiwi  |  12 |      |",
    );
    expect(parseTable(out)).toEqual(m);
  });

  it("adds rows and columns", () => {
    const m = addColumn(addRow(parseTable("| a |\n| --- |")));
    expect(serializeTable(m)).toBe("| a   |     |\n| --- | --- |\n|     |     |");
  });

  it("escapes pipes and newlines typed into a cell", () => {
    expect(cleanCell("a|b\nc")).toBe("a\\|b c");
    expect(cleanCell("a\\|b")).toBe("a\\|b");
  });
});
