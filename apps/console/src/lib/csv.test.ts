import { describe, expect, it } from "vitest";
import { parseCsv } from "./csv";
import { stopWords } from "./learningBatch";

describe("parseCsv", () => {
  it("reads a header and rows, CRLF or LF, a byte-order mark left off", () => {
    expect(parseCsv("﻿a,b\r\n1,2\n3,4\n")).toEqual({ columns: ["a", "b"], rows: [{ a: "1", b: "2" }, { a: "3", b: "4" }] });
  });
  it("keeps commas, line breaks and doubled quotes inside a quoted cell", () => {
    expect(parseCsv('q,a\n"x, y","say ""hi""\nthere"\n')).toEqual({ columns: ["q", "a"], rows: [{ q: "x, y", a: 'say "hi"\nthere' }] });
  });
  it("skips blank lines", () => {
    expect(parseCsv("a\n\n1\n\n2\n")).toEqual({ columns: ["a"], rows: [{ a: "1" }, { a: "2" }] });
  });
  it("refuses what the server would", () => {
    expect(parseCsv("a,b\n")).toEqual({ error: "The file needs a header line and at least one row." });
    expect(parseCsv("a,,c\n1,2,3")).toEqual({ error: "A column in the header line has no name." });
    expect(parseCsv("a,a\n1,2")).toEqual({ error: "The column a is named twice in the header line." });
    expect(parseCsv("a,b\n1,2\n3")).toEqual({ error: "Row 2 has 1 cells, and the header line has 2." });
  });
  it("refuses a file that ends inside a quoted cell: the rows after it never become one answer", () => {
    expect(parseCsv('q,a\none,"A\ntwo,B')).toEqual({ error: "The file ends inside a quoted cell: a quote is not closed." });
    expect(parseCsv('q,a\none,"A"\n')).toEqual({ columns: ["q", "a"], rows: [{ q: "one", a: "A" }] });
  });
});

describe("stopWords", () => {
  const b = { status: "stopped", stopped: "cap", finished: 3, total: 10 } as const;
  it("says why a batch stopped, and nothing for one that ran to its end", () => {
    expect(stopWords(b)).toMatch(/Stopped after 3 of 10 rows: what is left of the cap/);
    expect(stopWords({ ...b, stopped: "cost_unknown" })).toMatch(/never guessed at/);
    expect(stopWords({ ...b, status: "cancelled" })).toBe("Cancelled after 3 of 10 rows.");
    expect(stopWords({ ...b, status: "completed" } as never)).toBeNull();
  });
});
