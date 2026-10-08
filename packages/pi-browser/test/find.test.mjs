// `find` through a real pi-durable Harness on SQLite: a tool shaped like the browser's readers files the whole page,
// asks the host's rankChunks hook, and answers with the chunks that matter. The ranker is a stand-in for the host's
// model (word overlap with the question); every other part is the shipped code.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { findInText } from "../dist/index.js";

const tmp = () => fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "find-"));
const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const words = (text) => new Set(text.toLowerCase().split(/[^a-z0-9$.]+/).filter(Boolean));

/** A shop's accessibility tree: navigation, `n` product cards, a footer. IDs are `0-<n>` and unique. */
function shopTree(n) {
  let id = 1;
  const node = (depth, label) => `${"  ".repeat(depth)}[0-${id++}] ${label}`;
  const lines = [node(0, "RootWebArea: Shop"), node(1, "scrollable, html"), node(2, "body"), node(3, "navigation"), node(4, "link: Home"), node(4, "link: Cart"), node(3, "main")];
  for (let i = 1; i <= n; i += 1) {
    lines.push(node(4, "article"), node(5, `heading: Widget ${i}`), node(5, "paragraph"), node(6, `StaticText: Widget ${i} costs $${i}.99 and ships in ${i} days`), node(5, `button: Add Widget ${i} to cart`));
  }
  lines.push(node(3, "contentinfo"), node(4, "link: Returns policy"));
  return lines.join("\n");
}

const filler = (topic) => `${topic} details. `.repeat(220);
const PAGE = [
  "# Acme Pricing", "", "Acme sells collaboration software.", "",
  "## Team plan", "", `The Team plan costs $29 per user per month. ${filler("Team")}`, "",
  "### Seats", "", `Seats are billed monthly and a seat can be reassigned. ${filler("Seat")}`, "",
  "## Enterprise", "", `Enterprise is quoted per contract. ${filler("Enterprise")}`, "",
  "```sh", "# not a heading", "acme login", "```", "",
  "## Contact", "", "Write to sales@acme.example.",
].join("\n");

const LEAF = ["[0-1] RootWebArea: Doc", `  [0-2] StaticText: ${"intro words ".repeat(300)}NEEDLE the answer is 42 ${"closing words ".repeat(300)}`, "  [0-3] link: Elsewhere"].join("\n");
const DEEP_LEAF = ["[0-1] RootWebArea: Doc", "  [0-2] main", "    [0-3] region: Offers", "      [0-4] link: Deal details", `        [0-5] StaticText: ${"intro words ".repeat(300)}NEEDLE the answer is 42 ${"closing words ".repeat(300)}`].join("\n");
const CHAPTERS = Array.from({ length: 250 }, (_, i) => `# Chapter ${i}\n\n## Part ${i}\n\nText of chapter ${i}.\n`).join("\n");
const SPACING = `# A\n\n\n\nfirst  \n   \n\nsecond\n\n${Array.from({ length: 40 }, (_, i) => `${"word ".repeat(40)}${i}`).join("\n \n\n")}\n\n## B\n\n\nthird\n`;
const SOURCES = { shop: shopTree(120), small: shopTree(2), mega: shopTree(3_000), page: PAGE, leaf: LEAF, deepLeaf: DEEP_LEAF, chapters: CHAPTERS, spacing: SPACING, empty: "" };

/** The chunks a find printed, verbatim: the text between its header lines, less the one line break that joins them. */
const printed = (out) => out.slice(out.indexOf("\n") + 1).split(/^---(?: under: [^\n]*)?\n/m).slice(1).map((t, i, all) => (i < all.length - 1 ? t.slice(0, -1) : t));
/** `source` with each chunk removed in order, or null when a chunk is not found after the one before it. */
function remainder(source, chunks) { let cursor = 0, left = ""; for (const c of chunks) { const at = source.indexOf(c, cursor); if (at < 0) return null; left += source.slice(cursor, at); cursor = at + c.length; } return left + source.slice(cursor); }

/** A host's ranker: how many of the question's words a chunk holds. Records what it was asked. */
function ranker(asked, mode = "overlap") {
  return async (find, chunks) => {
    asked.push({ find, chunks });
    if (mode === "null") return null;
    if (mode === "throw") throw new Error("judge down");
    if (mode === "short") return chunks.slice(1).map(() => 1);
    if (mode === "nan") return chunks.map(() => Number.NaN);
    const wanted = [...words(find)];
    return chunks.map((chunk) => { const held = words(chunk); return wanted.filter((word) => held.has(word)).length; });
  };
}

async function run(calls, rank) {
  const dir = tmp();
  const filed = [];
  const extension = defineExtension({
    name: "finder",
    tools: [defineTool({
      name: "find_page",
      description: "Find something in a page.",
      parameters: { type: "object", additionalProperties: false, required: ["source", "kind", "find"], properties: { source: { type: "string" }, kind: { type: "string" }, find: { type: "string" }, shownChunks: { type: "number" }, shownChars: { type: "number" } } },
      replay: "safe",
      execute: async (args) => {
        const source = SOURCES[args.source];
        const file = path.join(dir, `${filed.length + 1}.md`);
        fs.writeFileSync(file, source);
        filed.push({ file, source });
        const result = await findInText(source, args.find, { kind: args.kind, rank, filedAt: path.basename(file), ...(args.shownChunks ? { shownChunks: args.shownChunks } : {}), ...(args.shownChars ? { shownChars: args.shownChars } : {}) });
        return { content: [{ type: "text", text: result.text }], details: { applied: result.applied, chunks: result.chunks, shown: result.shown, ids: result.ids } };
      },
    })],
  });
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  faux.setResponses(Array.from({ length: calls.length + 4 }, () => (context) => {
    const call = calls[context.messages.filter((m) => m.role === "assistant").length];
    return call ? fauxAssistantMessage([fauxToolCall("find_page", call)], { stopReason: "toolUse" }) : fauxAssistantMessage([fauxText("done")], { stopReason: "stop" });
  }));
  const models = createModels(); models.setProvider(faux.provider);
  const registry = createRegistry(); registry.install(extension);
  const harness = await Harness.open(await openNodeSqliteStorage(path.join(dir, "run.sqlite")), { models, registry }, ctx);
  try {
    const root = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
    await (await root.submit({ type: "input", content: "go", requestId: "go-1" }, ctx)).wait(ctx);
    const page = await root.entries({}, 200, undefined, ctx);
    const results = [...page.items].reverse().flatMap((e) => (e.kind === "pi.tool-result" ? [{ text: e.model[0].content.map((c) => c.text).join(""), details: e.model[0].details }] : []));
    return { results, filed };
  } finally { await harness.close(ctx); }
}

test("a snapshot find returns the card that answers, IDs verbatim, in document order, and says what it left out", async () => {
  const asked = [];
  const { results, filed } = await run([{ source: "shop", kind: "tree", find: "Widget 77 price", shownChunks: 2 }], ranker(asked));
  const [{ text, details }] = results;
  assert.equal(asked.length, 1, "one ranking request for the whole tree");
  assert.equal(asked[0].find, "Widget 77 price");
  assert.equal(asked[0].chunks.length, details.chunks);
  assert.ok(details.chunks > 4 && details.chunks <= 200);
  assert.match(text, new RegExp(`^find "Widget 77 price": 2 of ${details.chunks} chunks shown, ${details.chunks - 2} left out; the whole snapshot is filed at 1\\.md\\. Ask a narrower find`));
  assert.match(text, /StaticText: Widget 77 costs \$77\.99 and ships in 77 days/);
  assert.match(text, /button: Add Widget 77 to cart/);
  const sourceLines = new Set(filed[0].source.split("\n"));
  const shown = text.split("\n").slice(1).filter((line) => !line.startsWith("---"));
  assert.ok(shown.every((line) => sourceLines.has(line)), "every line shown is a line of the snapshot, unedited");
  assert.deepEqual(shown.map((line) => filed[0].source.split("\n").indexOf(line)), shown.map((line) => filed[0].source.split("\n").indexOf(line)).sort((a, b) => a - b), "document order");
  assert.deepEqual(details.shown, [...details.shown].sort((a, b) => a - b));
  assert.ok(details.ids.every((id) => filed[0].source.includes(`[${id}]`)) && details.ids.length > 0);
  assert.ok(text.length < filed[0].source.length / 5, `${text.length} characters shown of ${filed[0].source.length}`);
  assert.match(text, /--- under: .*main/, "a chunk names where it sits");
});

test("when the find keeps every chunk, each line is shown once, in order, or is an ancestor named in a chunk's path", async () => {
  const { results, filed } = await run([{ source: "shop", kind: "tree", find: "anything", shownChunks: 1_000, shownChars: 10_000_000 }], ranker([]));
  const all = results[0].text.split("\n").slice(1);
  const shown = all.filter((line) => !line.startsWith("---"));
  const paths = all.filter((line) => line.startsWith("--- under:")).join("\n");
  const source = filed[0].source.split("\n");
  assert.deepEqual(shown, source.filter((line) => shown.includes(line)), "source order, no repeats");
  assert.equal(new Set(shown).size, shown.length);
  const ancestors = source.filter((line) => !shown.includes(line));
  assert.ok(ancestors.length > 0 && ancestors.every((line) => paths.includes(line.trim())), "a line left out of every chunk is an ancestor, named in a path with its ID");
  assert.match(results[0].text, /: \d+ of \d+ chunks shown, 0 left out\./);
});

test("a small tree is one chunk, shown whole", async () => {
  const { results, filed } = await run([{ source: "small", kind: "tree", find: "cart" }], ranker([]));
  assert.match(results[0].text, /^find "cart": 1 of 1 chunks shown, 0 left out\./);
  assert.ok(results[0].text.endsWith(filed[0].source));
});

test("a page find returns the section under its heading with its path; a # in a code fence is no heading", async () => {
  const asked = [];
  const { results, filed } = await run([{ source: "page", kind: "page", find: "how are seats billed", shownChunks: 2 }], ranker(asked));
  const [{ text }] = results;
  assert.match(text, /^find "how are seats billed": \d+ of \d+ chunks shown, \d+ left out; the whole page is filed at 1\.md\./);
  assert.match(text, /--- under: Acme Pricing > Team plan\n### Seats\n\nSeats are billed monthly/);
  assert.ok(asked[0].chunks.every((chunk) => !chunk.includes("> not a heading")), "no chunk is placed under the fenced line");
  assert.ok(asked[0].chunks.some((chunk) => chunk.includes("```sh\n# not a heading\nacme login\n```")), "the fenced block stays whole inside its section");
  assert.ok(asked[0].chunks.every((chunk) => chunk.length < 2_100));
  assert.equal(sha(fs.readFileSync(filed[0].file, "utf8")), sha(PAGE), "the whole page is filed whatever find shows");
});

test("a huge tree is chunked coarser until one ranking request can carry it", async () => {
  const asked = [];
  const { results } = await run([{ source: "mega", kind: "tree", find: "Widget 2999 costs" }], ranker(asked));
  assert.equal(asked.length, 1);
  assert.ok(asked[0].chunks.length <= 200, `${asked[0].chunks.length} chunks in one request`);
  assert.match(results[0].text, /StaticText: Widget 2999 costs \$2999\.99/);
});

test("without a usable ranker the whole text is returned and the line says find was not applied", async () => {
  for (const [label, rank, why] of [["no hook", undefined, /this host has no ranker/], ["null", ranker([], "null"), /gave no answer/], ["throws", ranker([], "throw"), /gave no answer/], ["short", ranker([], "short"), /did not match the chunks/], ["NaN", ranker([], "nan"), /did not match the chunks/]]) {
    const { results, filed } = await run([{ source: "shop", kind: "tree", find: "cart" }], rank);
    assert.match(results[0].text, new RegExp(`^find "cart" was not applied: [^\\n]*${why.source}\\. The whole snapshot follows\\.\\n`), label);
    assert.ok(results[0].text.endsWith(filed[0].source), `${label}: the whole snapshot follows`);
    assert.equal(results[0].details.applied, false);
  }
  const { results } = await run([{ source: "empty", kind: "page", find: "x" }], ranker([]));
  assert.match(results[0].text, /was not applied: there is nothing to search/);
});

test("when the find keeps every page chunk, nothing is lost, repeated or reordered", async () => {
  const { results } = await run([{ source: "page", kind: "page", find: "anything", shownChunks: 1_000, shownChars: 10_000_000 }], ranker([]));
  const body = results[0].text.split("\n").slice(1).filter((line) => !line.startsWith("---")).join("\n");
  assert.equal(body.replace(/\s+/g, ""), PAGE.replace(/\s+/g, ""));
});

test("the chunks shown keep document order even when the best one sits after the runner-up", async () => {
  const later = async (_find, chunks) => chunks.map((chunk) => (chunk.includes("Widget 90 costs") ? 2 : chunk.includes("Widget 20 costs") ? 1 : 0));
  const { results } = await run([{ source: "shop", kind: "tree", find: "Widget 90 and Widget 20", shownChunks: 2 }], later);
  const text = results[0].text;
  const [early, late] = [text.indexOf("Widget 20 costs"), text.indexOf("Widget 90 costs")];
  assert.ok(early > 0 && late > early, "the page's earlier chunk is read first, though the later one ranked higher");
});

test("a leaf node longer than a chunk is split into searchable pieces, so an answer near its end is found", async () => {
  const asked = [];
  const { results } = await run([{ source: "leaf", kind: "tree", find: "needle answer 42", shownChunks: 1 }], ranker(asked));
  assert.ok(asked[0].chunks.length >= 3, `${asked[0].chunks.length} chunks for one long leaf`);
  assert.ok(asked[0].chunks.every((c) => c.length < 2_300), "each ranked piece is a chunk of text and its heading");
  assert.match(results[0].text, /NEEDLE the answer is 42/, "the piece holding the answer is the one shown");
  assert.ok(results[0].details.ids.includes("0-2"), "the piece carries the node's ID");
  assert.match(results[0].text, /--- under: [^\n]*\[0-2\] StaticText: intro words/, "its heading names the leaf with its ID, so the model can act on it");
  const all = await run([{ source: "leaf", kind: "tree", find: "anything", shownChunks: 1_000, shownChars: 10_000_000 }], ranker([]));
  assert.match((remainder(LEAF, printed(all.results[0].text)) ?? "no").replace("[0-1] RootWebArea: Doc", ""), /^\n*$/, "pieces joined are the leaf, nothing cut (the root line is named in their path)");
});

test("a page with more chunks than one ranking request carries is ranked in several requests", async () => {
  const asked = [];
  const { results } = await run([{ source: "chapters", kind: "page", find: "Text of chapter 137", shownChunks: 1 }], ranker(asked));
  assert.ok(results[0].details.chunks > 200, `${results[0].details.chunks} chunks`);
  assert.ok(asked.length >= 2 && asked.every((a) => a.chunks.length <= 200), `requests of ${asked.map((a) => a.chunks.length)}`);
  assert.equal(asked.reduce((n, a) => n + a.chunks.length, 0), results[0].details.chunks, "every chunk was ranked once");
  assert.equal(results[0].details.applied, true);
  assert.match(results[0].text, /Text of chapter 137\./);
  for (const chapter of [3, 249]) {
    const first = await run([{ source: "chapters", kind: "page", find: `Text of chapter ${chapter}`, shownChunks: 1 }], ranker([]));
    assert.match(first.results[0].text, new RegExp(`Text of chapter ${chapter}\\.`), `chapter ${chapter}, in the first or the last request, still wins over the other requests' chunks`);
  }
});

test("page chunks keep the page's own spacing: each is a verbatim slice, in order, and only line breaks lie between", async () => {
  const { results } = await run([{ source: "spacing", kind: "page", find: "anything", shownChunks: 1_000, shownChars: 10_000_000 }], ranker([]));
  const chunks = printed(results[0].text);
  assert.ok(chunks.length > 2, `${chunks.length} chunks`);
  const left = remainder(SPACING, chunks);
  assert.ok(left !== null, "every chunk is a slice of the filed page, in order");
  assert.match(left, /^\n*$/, `what lies between chunks is only line breaks, not ${JSON.stringify(left.slice(0, 40))}`);
  assert.ok(chunks.some((c) => c.includes("first  \n   \n\nsecond")), "spaces on a blank line and a blank run survive");
  assert.ok(chunks.some((c) => c.includes("\n \n\n")), "a split section keeps its separators too");
});

test("a split leaf under four ancestors keeps every ancestor in its heading beside its own ID", async () => {
  const { results } = await run([{ source: "deepLeaf", kind: "tree", find: "needle answer 42", shownChunks: 1 }], ranker([]));
  const heading = results[0].text.split("\n").find((line) => line.startsWith("--- under:")) ?? "";
  assert.match(results[0].text, /NEEDLE the answer is 42/);
  for (const id of ["[0-1] RootWebArea", "[0-2] main", "[0-3] region", "[0-4] link: Deal details", "[0-5] StaticText"]) assert.ok(heading.includes(id), `${id} is in the heading: ${heading.slice(0, 160)}`);
});
