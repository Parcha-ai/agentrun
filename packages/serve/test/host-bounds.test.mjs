// Every host tool's largest result, held to the host's result bound: HOST_RESULT_MAX_CHARS (@parcha/agentrun-kernel),
// the most characters a result may hold, which each CLI adapter tells its CLI to pass to the model whole (the Claude Agent
// CLI otherwise saves a result past 50,000 characters to a file the model is told to read, which a confined session
// cannot; Codex cuts the middle of one past 10,000 tokens). Each tool's largest result is made here by the tool's own code,
// from inputs past every cap it exports: web_fetch's text at the most max_chars takes (TEXT_CAP), its links (LINKS_CAP,
// LINKS_CHARS), title (TITLE_CAP) and URL (URL_MAX) at theirs, and Parallel's failure said beside it; web_search's
// RESULTS_MAX results with SNIPPET_MAX snippets; monid's answer past CLIP; pi's read and bash past their 2,000 lines or
// 50 KB (host-tools' MAX_LINES and MAX_BYTES, as pi's own descriptions state them), with their notes; write and edit with
// the longest file name; the email tools' searches and threads with every field and text past its cut (email/answer.ts).
// Text that the answer must escape (quotes, backslashes) is used wherever it can grow a result.
// Three-byte text (CJK) is used wherever a result's bytes can grow past its characters. Each largest result is measured
// in characters (the bound; the Claude Agent CLI's estimate, a quarter of a token a character) and as Codex counts it,
// four bytes of UTF-8 a token, against the adapter's tool_output_token_limit. A tool added to the host tools with no
// largest result here fails the test. So does one the Claude Agent adapter would list to its CLI without the bound as its
// `anthropic/maxResultSizeChars`, and one pi's harness would cut (its output limits, HOST_TOOL_OUTPUT).
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import * as kernel from "@parcha/agentrun-kernel";
import * as claude from "@parcha/agentrun-harness-claude";
import * as codex from "@parcha/agentrun-harness-codex";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import * as pages from "@parcha/agentrun-web";
import * as save from "../dist/web-save.js";
import * as hosts from "../dist/host-tools.js";
import { hostToolNames } from "../dist/tool-list.js";
import { CLIP, monidText } from "../dist/monid.js";
import { monidForClaim } from "../dist/runner/monid-run.js";
import { asked, askPerson } from "../dist/tools.js";
import { HOST_TOOL_OUTPUT } from "../dist/runner/adapters/pi.js";
import { localWorkspace } from "../dist/workspace/index.js";
import { bashTool, fileTools, piEnv } from "../dist/workspace/pi-env.js";
import { hostToolsOf } from "./host-tools-of.mjs";
import { LEARNED_CLIP, learnedText, learnedWorkflowTool } from "../dist/learned-workflow.js";
const web = { ...(await import("@parcha/agentrun-web")), ...(await import("../dist/web-fetch.js")), ...(await import("./fixtures/serve-web.mjs")) };
const search = { ...(await import("@parcha/agentrun-web")), ...(await import("../dist/web-search.js")) };
import { emailError, emailText } from "../dist/email/answer.js";
import { emailRegistrations } from "../dist/email/tools.js";
import { calendarError, calendarRegistrations, calendarText } from "../dist/calendar/tools.js";
const PRIVATE_HOST = "10.0.0.1"; // key-gate: denylist an address the guard must refuse

const PUBLIC = "http://public.example/";
/** The background tools: the computer's, run by the kernel's registry (workspace/run-tools.ts), not by a host tool here. */
const BACKGROUND = ["bash_background", "bash_output", "bash_input", "bash_signal", "bash_list"];
/** Every tool a host runs here (tool-list.ts replay) but the background tools. */
const HOSTED = hostToolNames().filter((name) => !BACKGROUND.includes(name));
const signal = new AbortController().signal;
/** A monid endpoint: a host tool of the run's, made from its revision's pin, no table tool. */
const MONID_ENDPOINT = "monid:faux/person/enrich";

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

  // web_search: the objective, every query and every result at their caps; the answer keeps the most relevant that fit.
  const hit = { url: `https://s.example/${'"'.repeat(pages.URL_MAX)}`, title: '"'.repeat(pages.TITLE_CAP), snippet: '"'.repeat(search.SNIPPET_MAX), published: '"'.repeat(200) };
  const found = { provider: "native", objective: '"'.repeat(search.OBJECTIVE_MAX), queries: Array.from({ length: search.QUERIES_MAX }, () => '"'.repeat(search.QUERY_MAX)), results: Array.from({ length: search.RESULTS_MAX }, () => hit), text: '"'.repeat(search.ANSWER_MAX) };
  const wideHit = { url: `https://s.example/${"u".repeat(pages.URL_MAX)}`, title: wide.repeat(pages.TITLE_CAP), snippet: wide.repeat(search.SNIPPET_MAX) };
  keep("web_search", search.searchText(found), search.searchText({ provider: "native", objective: wide.repeat(search.OBJECTIVE_MAX), queries: Array.from({ length: search.QUERIES_MAX }, () => wide.repeat(search.QUERY_MAX)), results: Array.from({ length: search.RESULTS_MAX }, () => wideHit), text: wide.repeat(search.ANSWER_MAX) }));

  // The email tools: a search's most messages and a thread's, every field past its cut, in quotes, in three-byte text and in
  // control characters (six characters of JSON each); a draft's and a send's answers; an error's words.
  const mailOf = (fill, i) => ({ message_id: `<${fill.repeat(5_000)}${i}@x>`, from: fill.repeat(5_000), from_name: fill.repeat(5_000), to: Array.from({ length: 500 }, () => fill.repeat(400)), cc: Array.from({ length: 500 }, () => fill.repeat(400)), subject: fill.repeat(20_000), date: fill.repeat(500), in_reply_to: fill.repeat(5_000), references: Array.from({ length: 500 }, () => fill.repeat(2_000)), attachments: Array.from({ length: 500 }, () => ({ name: fill.repeat(2_000), size: 1, type: fill.repeat(2_000) })) });
  const fills = ['"', wide, "\u0001"];
  const bare = (i) => ({ message_id: `<m${i}@x>`, from: "a@example.com", to: ["b@example.com"], subject: "s", date: "2026-06-01T00:00:00.000Z", in_reply_to: null, references: [], attachments: [] });
  const mails = [
    ...fills.map((fill) => emailText({ messages: Array.from({ length: 50 }, (_, i) => ({ ...mailOf(fill, i), snippet: fill.repeat(5_000), unread: true })) })),
    ...fills.map((fill) => emailText({ messages: Array.from({ length: 20 }, (_, i) => ({ ...mailOf(fill, i), text: fill.repeat(300_000) })) })),
    ...fills.map((fill) => emailText({ messages: Array.from({ length: 20 }, (_, i) => ({ ...bare(i), text: fill.repeat(i % 2 ? 300_000 : 1_000) })) })),
    ...fills.map((fill) => emailText({ messages: [{ ...bare(0), text: fill.repeat(2_000_000) }] })),
    ...fills.map((fill) => emailText({ saved: true, mailbox: fill.repeat(50_000), message_id: fill.repeat(50_000) })),
    ...fills.map((fill) => emailText({ sent: true, message_id: fill.repeat(50_000), note: fill.repeat(50_000) })),
    ...fills.map((fill) => emailText({ filed: true, message_id: fill.repeat(50_000), to: fill.repeat(50_000), archived: true, subject: fill.repeat(50_000) })),
    ...fills.map((fill) => emailError(`email_read: ${fill.repeat(50_000)}`)),
  ];
  const thread = JSON.parse(mails[2 * fills.length]);
  assert.ok(thread.messages.length === 20 && thread.messages.filter((m) => m.text.length === 1_000).length === 10, "a thread's short texts kept whole, its long ones sharing what is left");
  assert.ok(JSON.parse(mails[0]).omitted > 0, "a search's messages that do not fit are counted");
  for (const tool of ["email_search", "email_read", "email_draft", "email_send", "email_file"]) keep(tool, ...mails);

  // calendar_events: a window's most events (200), every field at or past its cut, in quotes, in three-byte text and in
  // control characters; its own fields far past theirs; an error's words.
  const person = (fill) => ({ name: fill.repeat(200), email: fill.repeat(320) });
  const eventOf = (fill) => ({ title: fill.repeat(300), start: "2026-11-02T09:30:00-05:00", end: "2026-11-02T10:00:00-05:00", all_day: false, location: fill.repeat(300), description: fill.repeat(500), status: "confirmed", recurring: true, organizer: person(fill), attendees: Array.from({ length: 25 }, () => person(fill)), attendees_omitted: 1_000 });
  const calendars = [
    ...fills.map((fill) => calendarText({ calendar: fill.repeat(50_000), time_zone: fill.repeat(1_000), from: fill.repeat(1_000), to: fill.repeat(1_000), events: Array.from({ length: 200 }, () => eventOf(fill)), truncated: false })),
    ...fills.map((fill) => calendarError(`calendar_events: ${fill.repeat(50_000)}`)),
  ];
  const widestCalendar = JSON.parse(calendars[0]);
  assert.ok(widestCalendar.truncated === true && widestCalendar.events.length > 0 && widestCalendar.events.length < 200, "the events that do not fit are dropped from the end, and the answer says truncated");
  keep("calendar_events", ...calendars);

  // web_save: its answers made by its own code from inputs past every cap: a URL at URL_MAX, a path at PATH_MAX_CHARS
  // (and one past it), a redirect to a URL far past URL_MAX, a declared type and a failure's words far past theirs, each in
  // quotes and in three-byte text.
  const saves = [];
  await mkdir(join(dir, "save-work"));
  const saveWork = localWorkspace(join(dir, "save-work"));
  for (const fill of ['"', wide]) {
    const longUrl = `https://cdn.example/${fill.repeat(pages.URL_MAX - 20)}`;
    // A path of PATH_MAX_CHARS characters ending in `ext`, its folders each under the disk's 255 bytes a name.
    const pathOf = (ext, n = save.PATH_MAX_CHARS) => {
      const part = fill.repeat(fill === wide ? 80 : 200);
      let at = "media";
      while (at.length + 1 + part.length + ext.length < n) at += `/${part}`;
      return `${at}/${fill.repeat(n - at.length - 1 - ext.length)}${ext}`;
    };
    const longPath = pathOf(".png");
    assert.equal(longPath.length, save.PATH_MAX_CHARS);
    const far = `https://cdn.example/${fill.repeat(10 * pages.URL_MAX)}`;
    const network = {
      lookup: async (host) => (host === "cdn.example" ? ["93.184.216.34"] : [PRIVATE_HOST]),
      fetchImpl: async (url) => {
        if (url.pathname.startsWith("/r/private")) return new Response(null, { status: 302, headers: { location: `https://${"a".repeat(60)}.${"b".repeat(60)}.example/${fill.repeat(10 * pages.URL_MAX)}` } });
        if (url.pathname.startsWith("/r/")) return new Response(null, { status: 302, headers: { location: far } });
        if (url.pathname.startsWith("/typed")) return new Response("x", { status: 200, headers: { "content-type": `text/${"x".repeat(100_000)}` } });
        if (url.pathname.startsWith("/fail")) throw new TypeError(fill.repeat(100_000));
        return new Response(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), { status: 200, headers: { "content-type": "image/png" } });
      },
    };
    const answers = [
      await save.webSave({ url: longUrl, path: longPath }, saveWork, network),
      await save.webSave({ url: longUrl, path: pathOf(".png", save.PATH_MAX_CHARS + 1) }, saveWork, network),
      await save.webSave({ url: `https://cdn.example/r/${fill.repeat(pages.URL_MAX - 30)}`, path: pathOf(".png") }, saveWork, network),
      await save.webSave({ url: `https://cdn.example/r/private${fill.repeat(pages.URL_MAX - 40)}`, path: longPath }, saveWork, network),
      await save.webSave({ url: `https://cdn.example/typed${fill.repeat(pages.URL_MAX - 30)}`, path: pathOf(".txt") }, saveWork, network),
      await save.webSave({ url: `https://cdn.example/fail${fill.repeat(pages.URL_MAX - 30)}`, path: longPath }, saveWork, network),
    ];
    assert.deepEqual(answers.map((answer) => answer.ok), [true, false, false, false, false, false], JSON.stringify(answers.map((answer) => answer.error ?? answer.refused ?? answer.path?.length)));
    saves.push(...answers.map(save.savedText));
  }
  keep("web_save", ...saves);

  // A monid endpoint (one host tool per pinned endpoint, runner/monid-run.ts): one answer far past CLIP, the whole filed
  // under work/, by the longest run id it files by.
  const work = join(dir, "work");
  await mkdir(work);
  const ws = localWorkspace(work);
  const monid = [await monidText({ runId: "r".repeat(80), output: '"'.repeat(3 * CLIP) }, ws, "faux"), await monidText({ runId: "w".repeat(80), output: wide.repeat(3 * CLIP) }, ws, "faux")];
  assert.ok(monid.every((text) => text.includes("the whole answer is in the run's files at evidence/monid/")), "filed through the run's Workspace");
  keep(MONID_ENDPOINT, ...monid);

  // ask_person: a question far past the 500 characters its answer keeps, in quotes and in three-byte text.
  keep("ask_person", asked('"'.repeat(20_000)), asked(wide.repeat(20_000)));

  // learned_workflow: a workflow's output far past LEARNED_CLIP, as JSON (quotes escaped), and in three-byte text.
  keep("learned_workflow", learnedText(JSON.stringify({ out: '"'.repeat(3 * LEARNED_CLIP) })), learnedText(JSON.stringify({ out: wide.repeat(3 * LEARNED_CLIP) })));

  // pi's read, write, edit and bash on the run's Workspace (workspace/pi-env.ts), through the host tools' own call: past
  // pi's limits.
  const env = piEnv(ws, { cwd: work, env: { PATH: "/usr/local/bin:/usr/bin:/bin" }, defaultTimeoutS: 120 });
  const run = { env: async () => env };
  const name = "n".repeat(240);
  await writeFile(join(work, `${name}.txt`), `${"x".repeat(99)}\n`.repeat(4 * hosts.MAX_BYTES / 100));
  await writeFile(join(work, `${name}.one`), "x".repeat(4 * hosts.MAX_BYTES));
  await writeFile(join(work, `${name}.cjk`), `${wide.repeat(33)}\n`.repeat(4 * hosts.MAX_BYTES / 100));
  const [read, write, edit] = hostToolsOf(run, ["read", "write", "edit"], ctx, new Map(), fileTools());
  assert.ok(read.description.includes(`${hosts.MAX_LINES} lines or ${hosts.MAX_BYTES / 1024}KB`), `pi's read is bounded as host-tools says: ${read.description}`);
  const reads = [await read.call({ path: `${name}.txt` }, { callId: "r1", signal }), await read.call({ path: `${name}.one` }, { callId: "r2", signal })];
  assert.ok(reads.every((answer) => !answer.isError && answer.text.length > hosts.MAX_BYTES - 200), `each read at pi's limit: ${reads.map((answer) => `${answer.isError ? "error " : ""}${answer.text.length}: ${answer.text.slice(-200)}`).join("; ")}`);
  const cjkRead = await read.call({ path: `${name}.cjk` }, { callId: "r3", signal });
  assert.ok(!cjkRead.isError && Buffer.byteLength(cjkRead.text) > hosts.MAX_BYTES - 200, "a read of three-byte text at pi's limit");
  keep("read", ...reads.map((answer) => answer.text), cjkRead.text);
  keep("write", (await write.call({ path: `${name}.md`, content: "x".repeat(4 * hosts.MAX_BYTES) }, { callId: "w", signal })).text);
  keep("edit", (await edit.call({ path: `${name}.md`, edits: [{ oldText: "y".repeat(4 * hosts.MAX_BYTES), newText: "z" }] }, { callId: "e", signal })).text);
  const [bash] = hostToolsOf(run, ["bash"], ctx, new Map(), [bashTool()]);
  assert.ok(bash.description.includes(`${hosts.MAX_LINES} lines or ${hosts.MAX_BYTES / 1024}KB`), `pi's bash is bounded as host-tools says: ${bash.description}`);
  const shell = await bash.call({ command: `head -c ${8 * hosts.MAX_BYTES} /dev/zero | tr '\\0' '"'; echo; exit 3` }, { callId: "b", signal });
  assert.ok(shell.text.length > hosts.MAX_BYTES - 100, "bash's tail at pi's limit");
  keep("bash", shell.text);
  // In characters (the bound, and the Claude Agent CLI's checks) and as Codex counts it: four bytes of UTF-8 a token.
  const largest = Object.fromEntries(Object.entries(results).map(([tool, texts]) => [tool, Math.max(...texts.map((text) => text.length))]));
  const codexTokens = Object.fromEntries(Object.entries(results).map(([tool, texts]) => [tool, Math.max(...texts.map((text) => Math.ceil(Buffer.byteLength(text, "utf8") / 4)))]));
  t.diagnostic(`bound ${bound}: ${JSON.stringify(largest)}; as Codex counts them (limit ${codex.CODEX_TOOL_OUTPUT_TOKENS}): ${JSON.stringify(codexTokens)}`);
  // The background tools are the computer's, run by the kernel's registry (workspace/run-tools.ts): the kernel holds
  // their bounds. Every other host tool has its largest result here.
  assert.deepEqual(Object.keys(largest).sort(), [...HOSTED, MONID_ENDPOINT].sort(), "every host tool but the computer's background tools, and a monid endpoint, has its largest result here");
  for (const [tool, size] of Object.entries(largest)) assert.ok(size < bound, `${tool}'s largest result is ${size} characters, not under the bound ${bound}`);
  for (const [tool, tokens] of Object.entries(codexTokens)) assert.ok(tokens <= codex.CODEX_TOOL_OUTPUT_TOKENS, `${tool}'s largest result is ${tokens} tokens as Codex counts them, past its tool_output_token_limit ${codex.CODEX_TOOL_OUTPUT_TOKENS}`);
  for (const [tool, size] of Object.entries(largest)) assert.ok(Math.round(size / 4) + 2 * 1_600 <= claude.MCP_OUTPUT_TOKENS / 2, `${tool}'s largest result, with two images, is past half the Claude Agent CLI's MAX_MCP_OUTPUT_TOKENS ${claude.MCP_OUTPUT_TOKENS}, where it counts exactly`);
  assert.ok(search.SEARCH_MAX_CHARS < bound, "web_search's own budget is under the bound");
  // pi's harness is told the bound too (runner/adapters/pi.ts HOST_TOOL_OUTPUT), so each largest result reaches the model
  // whole; pi's own default (50 KB or 2,000 lines, its head kept) would cut a read at its limit before its last line,
  // the one that says how to go on.
  for (const [tool, texts] of Object.entries(results)) for (const text of texts) assert.ok(Buffer.byteLength(text, "utf8") <= HOST_TOOL_OUTPUT.maxBytes && text.split("\n").length <= HOST_TOOL_OUTPUT.maxLines, `${tool}'s largest result passes pi's harness whole`);
  assert.ok(Math.max(...results.read.map((text) => Buffer.byteLength(text, "utf8"))) > 50 * 1024, "a read at pi's limit, with its note, is past pi's own default");

  // Every host tool, as the Claude Agent adapter lists it to its CLI (its tool server's tools/list, read by an MCP
  // client), carries the bound as its result size; the CLI takes one up to 500,000.
  // learned_workflow is the run's own tool, given beside the table's when its pin names a learned workflow.
  const learned = learnedWorkflowTool({ workflows: [{ name: "answer", description: "Answers a question", workflow: "{}" }], granted: [], env: {}, work, models: { getModel: () => undefined, getModels: () => [], completeSimple: async () => ({}) }, policy: () => "allow", denyFrom: () => "default" });
  const registrations = [...fileTools(), bashTool(), web.webFetchTool(process.env), search.webSearchTool(process.env), save.webSaveTool(() => saveWork, () => ({})), learned, askPerson, ...emailRegistrations({}), ...calendarRegistrations({})];
  const endpoints = monidForClaim({ [MONID_ENDPOINT]: { description: "Enrich a person.", input: { type: "object", properties: {} }, usd: 0.003 } }, {}, () => ws).tools;
  const all = [...hostToolsOf(run, HOSTED, ctx, new Map(), registrations), ...endpoints];
  assert.deepEqual(all.map((tool) => tool.name).sort(), [...HOSTED, "monid__faux__person__enrich"].sort(), "every host tool, and a monid endpoint, under its wire name");
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
