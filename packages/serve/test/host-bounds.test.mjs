// Every host tool's largest result, held to the host's result bound: HOST_RESULT_MAX_CHARS (@parcha/agentrun-kernel),
// the most characters a result may hold, which each CLI adapter tells its CLI to pass to the model whole (the Claude Agent
// CLI otherwise saves a result past 50,000 characters to a file the model is told to read, which a confined session
// cannot; Codex cuts the middle of one past 10,000 tokens). Each tool's largest result is made here by the tool's own code,
// from inputs past every cap it exports: web_fetch's text at the most max_chars takes (TEXT_CAP), its links (LINKS_CAP,
// LINKS_CHARS), title (TITLE_CAP) and URL (URL_MAX) at theirs, and Parallel's failure said beside it; web_search's
// RESULTS_MAX results with SNIPPET_MAX snippets; monid's answer past CLIP; pi's read and bash past their 2,000 lines or
// 50 KB (host-tools' MAX_LINES and MAX_BYTES, as pi's own descriptions state them), with their notes; write and edit with
// the longest file name. Text that the answer must escape (quotes, backslashes) is used wherever it can grow a result.
// Three-byte text (CJK) is used wherever a result's bytes can grow past its characters. Each largest result is measured
// in characters (the bound; the Claude Agent CLI's estimate, a quarter of a token a character) and as Codex counts it,
// four bytes of UTF-8 a token, against the adapter's tool_output_token_limit. A tool added to the host tools with no
// largest result here fails the test. So does one the Claude Agent adapter would list to its CLI without the bound as its
// `anthropic/maxResultSizeChars`.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import * as kernel from "@parcha/agentrun-kernel";
import * as claude from "@parcha/agentrun-harness-claude";
import * as codex from "@parcha/agentrun-harness-codex";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { codingSource, CodingTools } from "../dist/coding-tools.js";
import * as pages from "../dist/fetch-page.js";
import * as background from "../dist/background.js";
import * as hosts from "../dist/host-tools.js";
import { CLIP, monidText } from "../dist/monid.js";
import { LEARNED_CLIP, learnedText, learnedWorkflowTool } from "../dist/learned-workflow.js";
import * as web from "../dist/web-fetch.js";
import * as search from "../dist/web-search.js";

const PUBLIC = "http://public.example/";
const signal = new AbortController().signal;

test("every host tool's largest result is within the host's result bound, which each CLI is told to pass whole", async (t) => {
  const bound = kernel.HOST_RESULT_MAX_CHARS;
  assert.equal(typeof bound, "number", "the kernel states the host's result bound");
  const dir = await mkdtemp(join(tmpdir(), "host-bounds-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // Each tool's largest results (their texts), measured at the end in characters and in UTF-8 bytes.
  const results = {};
  const keep = (tool, ...texts) => void (results[tool] = [...(results[tool] ?? []), ...texts]);
  const wide = "世"; // three bytes of UTF-8 a character: the most a UTF-16 character takes

  // web_fetch.
  const url = `${PUBLIC}${"p".repeat(pages.URL_MAX - PUBLIC.length)}`;
  const links = Array.from({ length: 4 * pages.LINKS_CAP }, (_, i) => `<a href="https://l.example/${i}?${"\\".repeat(60)}">${i}</a>`).join(" ");
  const html = `<html><head><title>${'"'.repeat(4 * pages.TITLE_CAP)}</title></head><body><p>${'"\\'.repeat(2 * pages.TEXT_CAP)}</p>${links}</body></html>`;
  const failing = web.parallelExtract("not-a-key", async () => { throw new Error("x".repeat(5_000)); });
  const page = await web.webFetch(url, { lookup: async () => ["93.184.216.34"], fetchImpl: async () => new Response(html, { status: 200, headers: { "content-type": "text/html" } }), parallel: failing, maxChars: 10 * pages.TEXT_CAP });
  assert.equal(page.ok, true, JSON.stringify({ ...page, text: undefined }));
  assert.ok(page.parallel && page.truncated, "Parallel's failure is said, and the page goes on");
  assert.ok(JSON.stringify(page.text).length - 2 > pages.TEXT_CAP - 10, "the text at the most max_chars takes");
  assert.ok(page.links.reduce((n, link) => n + JSON.stringify(link).length + 1, 0) > pages.LINKS_CHARS - 200, "the links at theirs");
  const cjk = await web.webFetch(PUBLIC, { lookup: async () => ["93.184.216.34"], fetchImpl: async () => new Response(wide.repeat(4 * pages.TEXT_CAP), { status: 200, headers: { "content-type": "text/plain" } }), maxChars: 10 * pages.TEXT_CAP });
  assert.equal(cjk.chars, pages.TEXT_CAP, "a part of three-byte text at the most max_chars takes");
  // The most bytes in one answer: three-byte text at the most max_chars takes, with the longest title (three-byte too),
  // the most links, the longest URL and Parallel's failure said, together (the part above has none of them).
  const wideHtml = `<html><head><title>${wide.repeat(4 * pages.TITLE_CAP)}</title></head><body><p>${wide.repeat(4 * pages.TEXT_CAP)}</p>${links}</body></html>`;
  const widest = await web.webFetch(url, { lookup: async () => ["93.184.216.34"], fetchImpl: async () => new Response(wideHtml, { status: 200, headers: { "content-type": "text/html" } }), parallel: failing, maxChars: 10 * pages.TEXT_CAP });
  assert.equal(widest.ok, true, JSON.stringify({ ...widest, text: undefined }));
  assert.deepEqual([widest.chars, Buffer.byteLength(widest.text) > 3 * (pages.TEXT_CAP - 10), widest.url.length, Buffer.byteLength(widest.title) > 3 * (pages.TITLE_CAP - 2), Boolean(widest.parallel && widest.truncated)], [pages.TEXT_CAP, true, pages.URL_MAX, true, true], "50,000 three-byte characters, the longest URL, a title of three-byte characters at its cap, Parallel's failure said");
  assert.ok(widest.links.reduce((n, link) => n + JSON.stringify(link).length + 1, 0) > pages.LINKS_CHARS - 200, "the links at theirs, with the text");
  for (const tool of ["web_fetch"]) keep(tool, web.webFetchText(page, tool), web.webFetchText(cjk, tool), web.webFetchText(widest, tool));

  // web_search: every result at its caps; the answer keeps the most relevant that fit.
  const hit = { url: `https://s.example/${'"'.repeat(pages.URL_MAX)}`, title: '"'.repeat(pages.TITLE_CAP), snippet: '"'.repeat(search.SNIPPET_MAX), published: '"'.repeat(200) };
  const found = { provider: "native", query: '"'.repeat(search.QUERY_MAX), results: Array.from({ length: search.RESULTS_MAX }, () => hit), text: '"'.repeat(search.ANSWER_MAX) };
  const wideHit = { url: `https://s.example/${"u".repeat(pages.URL_MAX)}`, title: wide.repeat(pages.TITLE_CAP), snippet: wide.repeat(search.SNIPPET_MAX) };
  keep("web_search", search.searchText(found), search.searchText({ provider: "native", query: wide.repeat(search.QUERY_MAX), results: Array.from({ length: search.RESULTS_MAX }, () => wideHit), text: wide.repeat(search.ANSWER_MAX) }));

  // monid's three: one answer far past CLIP, the whole filed under work/, by the longest run id it files by.
  const work = join(dir, "work");
  await mkdir(work);
  const monid = [await monidText({ runId: "r".repeat(80), output: '"'.repeat(3 * CLIP) }, work, "run"), await monidText({ runId: "w".repeat(80), output: wide.repeat(3 * CLIP) }, work, "run")];
  for (const name of ["monid.discover", "monid.inspect", "monid.run"]) keep(name, ...monid);

  // learned_workflow: a workflow's output far past LEARNED_CLIP, as JSON (quotes escaped), and in three-byte text.
  keep("learned_workflow", learnedText(JSON.stringify({ out: '"'.repeat(3 * LEARNED_CLIP) })), learnedText(JSON.stringify({ out: wide.repeat(3 * LEARNED_CLIP) })));

  // pi's read, write and edit on the runner, and bash in a box, through the host tools' own call: past pi's limits.
  const env = new NodeExecutionEnv({ cwd: work });
  const run = { env: async () => env };
  const name = "n".repeat(240);
  await writeFile(join(work, `${name}.txt`), `${"x".repeat(99)}\n`.repeat(4 * hosts.MAX_BYTES / 100));
  await writeFile(join(work, `${name}.one`), "x".repeat(4 * hosts.MAX_BYTES));
  await writeFile(join(work, `${name}.cjk`), `${wide.repeat(33)}\n`.repeat(4 * hosts.MAX_BYTES / 100));
  const [read, write, edit] = hosts.hostTools(run, ["read", "write", "edit"], ctx, new Map(), CodingTools.tools);
  assert.ok(read.description.includes(`${hosts.MAX_LINES} lines or ${hosts.MAX_BYTES / 1024}KB`), `pi's read is bounded as host-tools says: ${read.description}`);
  const reads = [await read.call({ path: `${name}.txt` }, { callId: "r1", signal }), await read.call({ path: `${name}.one` }, { callId: "r2", signal })];
  assert.ok(reads.every((answer) => !answer.isError && answer.text.length > hosts.MAX_BYTES - 200), `each read at pi's limit: ${reads.map((answer) => `${answer.isError ? "error " : ""}${answer.text.length}: ${answer.text.slice(-200)}`).join("; ")}`);
  const cjkRead = await read.call({ path: `${name}.cjk` }, { callId: "r3", signal });
  assert.ok(!cjkRead.isError && Buffer.byteLength(cjkRead.text) > hosts.MAX_BYTES - 200, "a read of three-byte text at pi's limit");
  keep("read", ...reads.map((answer) => answer.text), cjkRead.text);
  keep("write", (await write.call({ path: `${name}.md`, content: "x".repeat(4 * hosts.MAX_BYTES) }, { callId: "w", signal })).text);
  keep("edit", (await edit.call({ path: `${name}.md`, edits: [{ oldText: "y".repeat(4 * hosts.MAX_BYTES), newText: "z" }] }, { callId: "e", signal })).text);
  const box = codingSource({ mode: "sandbox", box: "docker" }, { env: async () => env });
  const [bash] = hosts.hostTools(run, ["bash"], ctx, new Map(), box.tools);
  assert.ok(bash.description.includes(`${hosts.MAX_LINES} lines or ${hosts.MAX_BYTES / 1024}KB`), `pi's bash is bounded as host-tools says: ${bash.description}`);
  const shell = await bash.call({ command: `head -c ${8 * hosts.MAX_BYTES} /dev/zero | tr '\\0' '"'; echo; exit 3` }, { callId: "b", signal });
  assert.ok(shell.text.length > hosts.MAX_BYTES - 100, "bash's tail at pi's limit");
  keep("bash", shell.text);
  // The background tools (background.ts): a page at BACKGROUND_PAGE_BYTES, of quotes and of three-byte text, and a list
  // at BACKGROUND_LIST_MAX with every command at the 200 bytes a list reads of it. Their trusted state is written where a
  // box's runners leave it, in the box-only directory: here a TMPDIR of the test's own, which the tools' commands get.
  const boxTmp = join(dir, "box-tmp");
  const trusted = join(boxTmp, ".agentrun-background");
  const boxed = new NodeExecutionEnv({ cwd: work });
  const bgEnv = { cwd: work, exec: (command, options, context) => boxed.exec(command, { ...options, env: { ...(options?.env ?? {}), TMPDIR: boxTmp } }, context) };
  const bgBox = codingSource({ mode: "sandbox", box: "docker" }, { env: async () => bgEnv });
  const [start, output, input, signalTool, list] = hosts.hostTools(run, background.BACKGROUND_TOOLS, ctx, new Map(), bgBox.tools);
  const pageBytes = background.BACKGROUND_PAGE_BYTES;
  const trust = async (i, files) => {
    await mkdir(join(trusted, String(i)), { recursive: true });
    for (const [name, text] of Object.entries(files)) await writeFile(join(trusted, String(i), name), text);
  };
  for (const [i, text] of [[1, '"'.repeat(4 * pageBytes)], [2, wide.repeat(4 * pageBytes)]]) {
    await mkdir(join(work, "background", String(i)), { recursive: true });
    await writeFile(join(work, "background", String(i), "output.log"), text);
    await trust(i, { exit: "0\n" });
  }
  const ended = 3 + 2 * background.BACKGROUND_LIST_MAX;
  const longCommand = `"\\${wide.repeat(200)}`;
  for (let i = 3; i < ended; i++) {
    await mkdir(join(work, "background", String(i)), { recursive: true });
    await trust(i, { command: longCommand, exit: "137\n", started: "2026-11-05T00:00:00Z\n" });
  }
  const outputs = [await output.call({ id: "1" }, { callId: "o1", signal }), await output.call({ id: "2", offset: 1 }, { callId: "o2", signal })];
  assert.ok(outputs.every((answer) => !answer.isError && Buffer.byteLength(answer.text) > pageBytes - 10), `each page at its cap: ${outputs.map((answer) => answer.text.slice(0, 200)).join("; ")}`);
  keep("bash_output", ...outputs.map((answer) => answer.text));
  const listing = await list.call({}, { callId: "l", signal });
  assert.equal(listing.text.split("\n").length, 1 + background.BACKGROUND_LIST_MAX + 1, listing.text.slice(0, 300));
  // Each row carries its command's first 200 bytes (as many whole three-byte characters as fit, cut for the line) and
  // its start time: the largest list there is.
  const rows = listing.text.split("\n").slice(1, 1 + background.BACKGROUND_LIST_MAX);
  assert.ok(rows.every((row) => row.includes("started 2026-11-05T00:00:00Z") && row.includes(wide.repeat(20))), rows.slice(0, 2).join("\n"));
  keep("bash_list", listing.text);
  const started = await start.call({ command: `${'"'.repeat(1000)}; sleep 30` }, { callId: "s", signal });
  // The next free id: past every one in work/ and in the box-only directory (this machine's TMPDIR, here).
  const startedId = /^Started background process (\d+) /.exec(started.text)?.[1];
  assert.ok(Number(startedId) >= ended, started.text);
  keep("bash_background", started.text);
  keep("bash_input", (await input.call({ id: "999999999", text: "x" }, { callId: "i", signal })).text, (await input.call({ id: "1", text: '"'.repeat(background.BACKGROUND_INPUT_BYTES + 1) }, { callId: "i2", signal })).text);
  const killed = await signalTool.call({ id: startedId, signal: "KILL" }, { callId: "k", signal });
  assert.match(killed.text, /ended by signal KILL/);
  keep("bash_signal", killed.text, (await signalTool.call({ id: "3", signal: "KILL" }, { callId: "k2", signal })).text);

  // In characters (the bound, and the Claude Agent CLI's checks) and as Codex counts it: four bytes of UTF-8 a token.
  const largest = Object.fromEntries(Object.entries(results).map(([tool, texts]) => [tool, Math.max(...texts.map((text) => text.length))]));
  const codexTokens = Object.fromEntries(Object.entries(results).map(([tool, texts]) => [tool, Math.max(...texts.map((text) => Math.ceil(Buffer.byteLength(text, "utf8") / 4)))]));
  t.diagnostic(`bound ${bound}: ${JSON.stringify(largest)}; as Codex counts them (limit ${codex.CODEX_TOOL_OUTPUT_TOKENS}): ${JSON.stringify(codexTokens)}`);
  assert.deepEqual(Object.keys(largest).sort(), Object.keys(hosts.REPLAY).sort(), "every host tool has its largest result here");
  for (const [tool, size] of Object.entries(largest)) assert.ok(size < bound, `${tool}'s largest result is ${size} characters, not under the bound ${bound}`);
  for (const [tool, tokens] of Object.entries(codexTokens)) assert.ok(tokens <= codex.CODEX_TOOL_OUTPUT_TOKENS, `${tool}'s largest result is ${tokens} tokens as Codex counts them, past its tool_output_token_limit ${codex.CODEX_TOOL_OUTPUT_TOKENS}`);
  for (const [tool, size] of Object.entries(largest)) assert.ok(Math.round(size / 4) + 2 * 1_600 <= claude.MCP_OUTPUT_TOKENS / 2, `${tool}'s largest result, with two images, is past half the Claude Agent CLI's MAX_MCP_OUTPUT_TOKENS ${claude.MCP_OUTPUT_TOKENS}, where it counts exactly`);
  assert.ok(search.SEARCH_MAX_CHARS < bound, "web_search's own budget is under the bound");

  // Every host tool, as the Claude Agent adapter lists it to its CLI (its tool server's tools/list, read by an MCP
  // client), carries the bound as its result size; the CLI takes one up to 500,000.
  // learned_workflow is the run's own tool, given beside the table's when its pin names a learned workflow (app.ts).
  const learned = learnedWorkflowTool({ workflows: [{ name: "answer", description: "Answers a question", workflow: "{}" }], granted: [], env: {}, work, models: { getModel: () => undefined, getModels: () => [], completeSimple: async () => ({}) } });
  const all = hosts.hostTools({ ...run, claim: { work } }, Object.keys(hosts.REPLAY), ctx, new Map(), box.tools, undefined, [learned]);
  assert.deepEqual(all.map((tool) => tool.name).sort(), Object.keys(hosts.REPLAY).map((name) => name.replace(".", "_")).sort(), "every host tool, under its wire name");
  const server = await claude.toolServer("hands", all.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })), async () => ({ content: [] }));
  const [near, far] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(far);
  const client = new Client({ name: "host-bounds", version: "1.0.0" });
  await client.connect(near);
  t.after(() => client.close());
  const { tools: listed } = await client.listTools();
  assert.deepEqual(listed.map((tool) => [tool.name, tool._meta?.[claude.RESULT_SIZE_KEY]]).sort(), all.map((tool) => [tool.name, bound]).sort(), "each listed with the bound as its result size");
  assert.equal(claude.RESULT_SIZE_KEY, "anthropic/maxResultSizeChars");
  assert.ok(bound <= 500_000, "within what the CLI takes as a tool's result size");
});
