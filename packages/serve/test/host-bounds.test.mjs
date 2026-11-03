// Every host tool's largest result, held to the host's result bound: HOST_RESULT_MAX_CHARS (@parcha/agentrun-kernel),
// the most characters a result may hold, which each CLI adapter tells its CLI to pass to the model whole (the Claude Agent
// CLI otherwise saves a result past 50,000 characters to a file the model is told to read, which a confined session
// cannot; Codex cuts the middle of one past 10,000 tokens). Each tool's largest result is made here by the tool's own code,
// from inputs past every cap it exports: web_fetch's text at the most max_chars takes (TEXT_CAP), its links (LINKS_CAP,
// LINKS_CHARS), title (TITLE_CAP) and URL (URL_MAX) at theirs, and Parallel's failure said beside it; web_search's
// RESULTS_MAX results with SNIPPET_MAX snippets; monid's answer past CLIP; pi's read and bash past their 2,000 lines or
// 50 KB (host-tools' MAX_LINES and MAX_BYTES, as pi's own descriptions state them), with their notes; write and edit with
// the longest file name. Text that the answer must escape (quotes, backslashes) is used wherever it can grow a result.
// A tool added to the host tools with no largest result here fails the test.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import * as kernel from "@parcha/agentrun-kernel";
import { codingSource, CodingTools } from "../dist/coding-tools.js";
import * as pages from "../dist/fetch-page.js";
import * as hosts from "../dist/host-tools.js";
import { CLIP, monidText } from "../dist/monid.js";
import * as web from "../dist/web-fetch.js";
import * as search from "../dist/web-search.js";

const PUBLIC = "http://public.example/";
const signal = new AbortController().signal;

test("every host tool's largest result is within the host's result bound, which each CLI is told to pass whole", async (t) => {
  const bound = kernel.HOST_RESULT_MAX_CHARS;
  assert.equal(typeof bound, "number", "the kernel states the host's result bound");
  const dir = await mkdtemp(join(tmpdir(), "host-bounds-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const largest = {};

  // web_fetch, and fetch_page, its legacy name (the longer one, in the line that says where the page goes on).
  const url = `${PUBLIC}${"p".repeat(pages.URL_MAX - PUBLIC.length)}`;
  const links = Array.from({ length: 4 * pages.LINKS_CAP }, (_, i) => `<a href="https://l.example/${i}?${"\\".repeat(60)}">${i}</a>`).join(" ");
  const html = `<html><head><title>${'"'.repeat(4 * pages.TITLE_CAP)}</title></head><body><p>${'"\\'.repeat(2 * pages.TEXT_CAP)}</p>${links}</body></html>`;
  const failing = web.parallelExtract("not-a-key", async () => { throw new Error("x".repeat(5_000)); });
  const page = await web.webFetch(url, { lookup: async () => ["93.184.216.34"], fetchImpl: async () => new Response(html, { status: 200, headers: { "content-type": "text/html" } }), parallel: failing, maxChars: 10 * pages.TEXT_CAP });
  assert.equal(page.ok, true, JSON.stringify({ ...page, text: undefined }));
  assert.ok(page.parallel && page.truncated, "Parallel's failure is said, and the page goes on");
  assert.ok(JSON.stringify(page.text).length - 2 > pages.TEXT_CAP - 10, "the text at the most max_chars takes");
  assert.ok(page.links.reduce((n, link) => n + JSON.stringify(link).length + 1, 0) > pages.LINKS_CHARS - 200, "the links at theirs");
  largest.web_fetch = web.webFetchText(page, "web_fetch").length;
  largest.fetch_page = web.webFetchText(page, "fetch_page").length;

  // web_search: every result at its caps; the answer keeps the most relevant that fit.
  const hit = { url: `https://s.example/${'"'.repeat(pages.URL_MAX)}`, title: '"'.repeat(pages.TITLE_CAP), snippet: '"'.repeat(search.SNIPPET_MAX), published: '"'.repeat(200) };
  const found = { provider: "native", query: '"'.repeat(search.QUERY_MAX), results: Array.from({ length: search.RESULTS_MAX }, () => hit), text: '"'.repeat(search.ANSWER_MAX) };
  largest.web_search = search.searchText(found).length;

  // monid's three: one answer far past CLIP, the whole filed under work/, by the longest run id it files by.
  const work = join(dir, "work");
  await mkdir(work);
  const monid = (await monidText({ runId: "r".repeat(80), output: '"'.repeat(3 * CLIP) }, work, "run")).length;
  for (const name of ["monid.discover", "monid.inspect", "monid.run"]) largest[name] = monid;

  // pi's read, write and edit on the runner, and bash in a box, through the host tools' own call: past pi's limits.
  const env = new NodeExecutionEnv({ cwd: work });
  const run = { env: async () => env };
  const name = "n".repeat(240);
  await writeFile(join(work, `${name}.txt`), `${"x".repeat(99)}\n`.repeat(4 * hosts.MAX_BYTES / 100));
  await writeFile(join(work, `${name}.one`), "x".repeat(4 * hosts.MAX_BYTES));
  const [read, write, edit] = hosts.hostTools(run, ["read", "write", "edit"], ctx, new Map(), CodingTools.tools);
  assert.ok(read.description.includes(`${hosts.MAX_LINES} lines or ${hosts.MAX_BYTES / 1024}KB`), `pi's read is bounded as host-tools says: ${read.description}`);
  const reads = [await read.call({ path: `${name}.txt` }, { callId: "r1", signal }), await read.call({ path: `${name}.one` }, { callId: "r2", signal })];
  assert.ok(reads.every((answer) => !answer.isError && answer.text.length > hosts.MAX_BYTES - 200), `each read at pi's limit: ${reads.map((answer) => `${answer.isError ? "error " : ""}${answer.text.length}: ${answer.text.slice(-200)}`).join("; ")}`);
  largest.read = Math.max(...reads.map((answer) => answer.text.length));
  largest.write = (await write.call({ path: `${name}.md`, content: "x".repeat(4 * hosts.MAX_BYTES) }, { callId: "w", signal })).text.length;
  largest.edit = (await edit.call({ path: `${name}.md`, edits: [{ oldText: "y".repeat(4 * hosts.MAX_BYTES), newText: "z" }] }, { callId: "e", signal })).text.length;
  const box = codingSource({ mode: "sandbox", box: "docker" }, { env: async () => env });
  const [bash] = hosts.hostTools(run, ["bash"], ctx, new Map(), box.tools);
  assert.ok(bash.description.includes(`${hosts.MAX_LINES} lines or ${hosts.MAX_BYTES / 1024}KB`), `pi's bash is bounded as host-tools says: ${bash.description}`);
  const shell = await bash.call({ command: `head -c ${8 * hosts.MAX_BYTES} /dev/zero | tr '\\0' '"'; echo; exit 3` }, { callId: "b", signal });
  assert.ok(shell.text.length > hosts.MAX_BYTES - 100, "bash's tail at pi's limit");
  largest.bash = shell.text.length;

  t.diagnostic(`bound ${bound}: ${JSON.stringify(largest)}`);
  assert.deepEqual(Object.keys(largest).sort(), Object.keys(hosts.REPLAY).sort(), "every host tool has its largest result here");
  for (const [tool, size] of Object.entries(largest)) assert.ok(size <= bound, `${tool}'s largest result is ${size} characters, past the bound ${bound}`);
});
