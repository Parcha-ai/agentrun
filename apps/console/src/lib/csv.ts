// A CSV file as rows, in the page (the server takes rows, never a file): RFC 4180's quoting (a quoted cell holds commas,
// line breaks and a doubled quote), CRLF or LF, a byte-order mark left off, blank lines skipped.

export type Csv = { columns: string[]; rows: Record<string, string>[] } | { error: string };

/** The cells of `text`, line by line; null when the file ends inside a quoted cell (a quote never closed would make every
 *  row after it one cell). */
function cells(text: string): string[][] | null {
  const lines: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((x) => x.trim() !== "")) lines.push(row);
      row = [];
    } else cell += c;
  }
  if (quoted) return null;
  row.push(cell);
  if (row.some((x) => x.trim() !== "")) lines.push(row);
  return lines;
}

/** `text` as a header and its rows, or why it is not one: a quote not closed, no rows, a header with an empty or repeated name, a row with a
 *  different count of cells than the header. */
export function parseCsv(text: string): Csv {
  const lines = cells(text);
  if (!lines) return { error: "The file ends inside a quoted cell: a quote is not closed." };
  const header = lines.shift()?.map((x) => x.trim());
  if (!header || !lines.length) return { error: "The file needs a header line and at least one row." };
  if (header.some((h) => h === "")) return { error: "A column in the header line has no name." };
  const dup = header.find((h, i) => header.indexOf(h) !== i);
  if (dup !== undefined) return { error: `The column ${dup} is named twice in the header line.` };
  const bad = lines.findIndex((l) => l.length !== header.length);
  if (bad >= 0) return { error: `Row ${bad + 1} has ${lines[bad]!.length} cells, and the header line has ${header.length}.` };
  return { columns: header, rows: lines.map((l) => Object.fromEntries(header.map((h, i) => [h, l[i]!]))) };
}
