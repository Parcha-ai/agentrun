// A tool call's outcome in a run's metrics: counted failed by the one rule its timeline row reads (callFailed), and
// each tool's name where calls are counted (nameOf), from the timeline's label registry.
import assert from "node:assert/strict";
import { test } from "node:test";
import { callFailed, nameOf, registerOutcome, runMetricsOf, timelineOf } from "../dist/timeline/index.js";
import { assistant, call, result, user } from "./timeline-support.mjs";

const usage = (input, output, total = 0.01) => ({ input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { total } });
const answer = (blocks, tokens) => assistant(blocks, 0, { provider: "anthropic", model: "claude-opus-5-5", usage: tokens });

test("a call is counted failed by the rule its row reads: an error, or a result its tool reads as failed, such as a refused fetch", () => {
  const refused = JSON.stringify({ ok: false, url: "http://127.0.0.1/", refused: "refused: 127.0.0.1 is not a public host" });
  const failed = JSON.stringify({ ok: false, url: "https://down.example/", error: "the host did not answer" });
  const fetched = JSON.stringify({ ok: true, url: "https://example.com/", status: 200, title: "Example Domain", text: "Example", links: [] });
  const entries = [
    user("Fetch three pages."),
    answer([call("f1", "web_fetch", { url: "http://127.0.0.1/" }), call("f2", "web_fetch", { url: "https://down.example/" }), call("f3", "web_fetch", { url: "https://example.com/" })], usage(10, 5)),
    result("f1", "web_fetch", refused), result("f2", "web_fetch", failed), result("f3", "web_fetch", fetched),
    answer([{ type: "text", text: "Fetched one." }], usage(20, 3)),
  ];
  assert.deepEqual(runMetricsOf(entries).tools, { web_fetch: { calls: 3, errors: 2 } }, "a refused and a failed fetch are errors, as their rows say");
  const rows = timelineOf(entries, { settled: true }).filter((r) => r.kind === "tool_result").map((r) => r.tool_status);
  assert.deepEqual(rows, ["failed", "failed", "success"], "the same three, row by row");
  assert.deepEqual([callFailed("web_fetch", { text: refused, isError: false }), callFailed("read", { text: refused, isError: false }), callFailed("read", { text: "", isError: true })], [true, false, true], "a tool without an outcome fails only on an error");
});

test("serve's web tools by the same rule: a page followed by a line for the model, and a search that answers {error}, read as failed", () => {
  const skipped = "\nParallel was picked for web_fetch and gave no page (not tried: this run holds no Parallel key); this one was fetched directly.";
  const unfetched = JSON.stringify({ ok: false, url: "https://down.example/", status: 0, error: "the host did not answer", via: "direct", parallel: "not tried: this run holds no Parallel key" }) + skipped;
  const fetched = JSON.stringify({ ok: true, url: "https://example.com/", status: 200, title: "Example Domain", text: "Example", links: [], via: "direct", parallel: "Parallel answered 500" }) + skipped;
  const unsearched = JSON.stringify({ error: "web_search does not run here: no native search for codex yet" });
  const searched = `${JSON.stringify({ provider: "exa-keyless", query: "q", results: [] })}\nCite the URL of each result you rely on.`;
  assert.deepEqual([["web_fetch", unfetched], ["fetch_page", unfetched], ["web_fetch", fetched], ["web_search", unsearched], ["web_search", searched]].map(([tool, text]) => callFailed(tool, { text, isError: false })), [true, true, false, true, false]);
  const entries = [
    user("Search, then fetch."),
    answer([call("s1", "web_search", { query: "q" }), call("s2", "web_search", { query: "q" }), call("w1", "web_fetch", { url: "https://down.example/" })], usage(10, 5)),
    result("s1", "web_search", unsearched), result("s2", "web_search", searched), result("w1", "web_fetch", unfetched),
    answer([{ type: "text", text: "Done." }], usage(20, 3)),
  ];
  assert.deepEqual(runMetricsOf(entries).tools, { web_search: { calls: 2, errors: 1 }, web_fetch: { calls: 1, errors: 1 } });
  assert.deepEqual(timelineOf(entries, { settled: true }).filter((r) => r.kind === "tool_result").map((r) => r.tool_status), ["failed", "success", "failed"], "the rows say the same");
});

test("a result row reads its outcome once, for its summary and its status both: a fetch's outcome parses its whole page", () => {
  const read = [];
  registerOutcome("outcome_once_probe", (result) => {
    read.push(result.text);
    const page = JSON.parse(result.text);
    return page.ok ? { failed: false, text: `fetched ${page.url}` } : { failed: true, text: `refused ${page.url}` };
  });
  const refused = JSON.stringify({ ok: false, url: "http://127.0.0.1/" });
  const fetched = JSON.stringify({ ok: true, url: "https://example.com/", text: "x".repeat(60_000) });
  const entries = [
    user("Fetch two pages."),
    answer([call("p1", "outcome_once_probe", { url: "http://127.0.0.1/" }), call("p2", "outcome_once_probe", { url: "https://example.com/" })], usage(10, 5)),
    result("p1", "outcome_once_probe", refused), result("p2", "outcome_once_probe", fetched),
    answer([{ type: "text", text: "Fetched one." }], usage(20, 3)),
  ];
  const rows = timelineOf(entries, { settled: true }).filter((r) => r.kind === "tool_result");
  assert.deepEqual(rows.map((r) => [r.tool_status, r.summary]), [["failed", "Using tool: outcome_once_probe: refused http://127.0.0.1/"], ["success", "Using tool: outcome_once_probe: fetched https://example.com/"]], "the status and the summary from the same outcome");
  assert.deepEqual(read, [refused, fetched], "each result's outcome read once, by its row");
});

test("a tool's name where calls are counted: its registered one in plain words, else the name it was called by", () => {
  assert.deepEqual(["web_fetch", "fetch_page", "read", "run", "browser_release", "submit"].map(nameOf), ["Fetch web pages", "Fetch web pages", "Read files", "Open or act on a page in the browser", "Release the browser session", "Submit the answer"]);
  assert.equal(nameOf("a_tool_nobody_registered"), "a_tool_nobody_registered");
});
