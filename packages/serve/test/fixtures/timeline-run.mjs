// One run's stored entries and how /v2 serves their timeline, for the timeline fixtures a client tests against
// (timeline-action-rows.json, checked by timeline-fixtures.test.mjs). The run is pi's on a Claude model, since
// ask_person is pi's only: a thinking block, a read of a file nothing wrote (missing), three reads in one answer (a
// folded group), a web search and a read of one of its pages, a write refused outside the workspace (failed), a write to an absolute path under the workspace, a
// question the person answers, a write a stop cut off (interrupted) and the one after it, then the answer. `live` is
// the same run while its write is out (running).

export const RUN_ID = "01a1b000-0000-7000-8000-00000000a001";
export const WORK = `/data/runs/${RUN_ID}/work`;
export const STARTED_AT = "2026-11-03T18:00:00.000Z";
export const ENDED_AT = "2026-11-03T18:00:41.000Z";
const start = Date.parse(STARTED_AT);

let next = 1;
const at = (s) => ({ timestamp: start + s * 1000 });
const usage = (input, output, usd) => ({ input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usd } });
const user = (text, s) => ({ kind: "pi.user", id: next++, conversationId: 1, model: [{ role: "user", content: text, ...at(s) }] });
const assistant = (blocks, s, cost) => ({
  kind: "pi.assistant", id: next++, conversationId: 1,
  model: [{ role: "assistant", content: blocks, api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet-5-5", usage: cost, stopReason: blocks.some((b) => b.type === "toolCall") ? "toolUse" : "stop", ...at(s) }],
});
const call = (id, name, args) => ({ type: "toolCall", id, name, arguments: args });
const result = (id, name, text, s, isError = false, details = undefined) => ({
  kind: "pi.tool-result", id: next++, conversationId: 1,
  model: [{ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError, ...(details ? { details } : {}), ...at(s) }],
});
const SEARCH = {
  provider: "exa-keyless", query: "invoice currency when none is stated",
  results: [
    { url: "https://www.gov.uk/guidance/invoicing", title: "Invoicing and taking payment", snippet: "An invoice must show the currency of the amounts it bills." },
    { url: "https://en.wikipedia.org/wiki/Invoice", title: "Invoice", snippet: "An invoice is a commercial document issued by a seller to a buyer." },
    { url: "https://stripe.com/resources/more/invoice-requirements", title: "Invoice requirements", snippet: "What every invoice should include." },
  ],
};
const PAGE = { ok: true, url: "https://www.gov.uk/guidance/invoicing", status: 200, title: "Invoicing and taking payment", text: "An invoice must show… ".repeat(400), links: [], via: "direct" };

const QUESTION = "The invoices carry no currency. Which currency should the totals use?";
const SUMMARY = "# Invoices\n\n- INV-1: consulting 2,400.00\n- INV-2: travel 310.00\n- INV-3: licences 1,150.00\n";
const TOTALS = "Total: 3,860.00 EUR\n";

/** The entries up to the write that is still out, when the run is live. */
const head = [
  user("Summarize the invoices in invoices/ into summary.md, with totals.", 0),
  assistant([{ type: "thinking", thinking: "The folder may have project notes. I will check for them before reading the invoices." }, { type: "text", text: "Checking for project notes first." }, call("toolu_r1", "read", { path: "AGENTS.md" })], 2, usage(1800, 60, 0.0063)),
  result("toolu_r1", "read", `ENOENT: no such file or directory, access '${WORK}/AGENTS.md'`, 3, true),
  assistant([call("toolu_r2", "read", { path: "invoices/inv-1.md" }), call("toolu_r3", "read", { path: "invoices/inv-2.md" }), call("toolu_r4", "read", { path: "invoices/inv-3.md" })], 5, usage(1950, 90, 0.0072)),
  result("toolu_r2", "read", "INV-1\nconsulting 2,400.00", 6),
  result("toolu_r3", "read", "INV-2\ntravel 310.00", 6),
  result("toolu_r4", "read", "INV-3\nlicences 1,150.00", 6),
  assistant([call("toolu_s1", "web_search", { query: SEARCH.query })], 7, usage(2050, 40, 0.0066)),
  result("toolu_s1", "web_search", `${JSON.stringify(SEARCH)}\nCite the URL of each result you rely on.`, 8, false, SEARCH),
  assistant([call("toolu_f1", "web_fetch", { url: PAGE.url })], 8, usage(2200, 40, 0.0070)),
  result("toolu_f1", "web_fetch", JSON.stringify(PAGE), 9, false, PAGE),
  assistant([call("toolu_w1", "write", { path: "../summary.md", content: SUMMARY })], 9, usage(2300, 140, 0.0090)),
  result("toolu_w1", "write", "../summary.md: outside the workspace", 9, true),
  assistant([call("toolu_w2", "write", { path: `${WORK}/summary.md`, content: SUMMARY })], 12, usage(2450, 140, 0.0094)),
];
/** The rest of the run, from the write's result to the answer. */
const tail = [
  result("toolu_w2", "write", `Successfully wrote ${SUMMARY.length} bytes to ${WORK}/summary.md`, 13),
  assistant([call("toolu_a1", "ask_person", { question: QUESTION })], 15, usage(2600, 50, 0.0085)),
  result("toolu_a1", "ask_person", `Asked the person: ${QUESTION}. Waiting for their answer.`, 15),
  user("EUR", 30),
  assistant([call("toolu_w3", "write", { path: "totals.md", content: TOTALS })], 33, usage(2700, 40, 0.0087)),
  assistant([call("toolu_w4", "write", { path: "totals.md", content: TOTALS })], 37, usage(2750, 40, 0.0088)),
  result("toolu_w4", "write", `Successfully wrote ${TOTALS.length} bytes to totals.md`, 38),
  assistant([{ type: "text", text: "Wrote summary.md and totals.md, with the totals in EUR." }], 40, usage(2800, 30, 0.0086)),
];

export const liveEntries = head;
export const entries = [...head, ...tail];

const QUIET = /:run:(start|end)$/;

/** A fixed change clock, so the recording never moves. */
const clock = () => {
  let counter = 1793300000000000;
  return { base: counter, next: () => ++counter, get current() { return counter; } };
};

/** The rows /v2 serves for `rows` (what a run's store or its live events give): serve's own pass (ask_person's
 *  question, the run's start and end left out), then the row log that numbers them, as GET /runs/{id}/timeline's page
 *  from the start, with the envelope that run's status gives. */
export function recording({ rows, withAsks, RowLog, status, usd }) {
  const changes = clock();
  const log = new RowLog(changes);
  log.sync(withAsks(rows.filter((row) => !QUIET.test(row.id))));
  const final = status === "completed";
  return {
    request: { method: "GET", path: `/v2/runs/${RUN_ID}/timeline` },
    status: 200,
    headers: { "content-type": "application/json" },
    body: {
      run_id: RUN_ID, status, state: final ? "idle" : "working", reset: true, drop: [], rows: log.rows(), next_after: changes.current,
      unchanged: false, has_more: false, final, cost: { usd, basis: "estimate", charge_state: null, cap_usd: null }, poll_after_ms: final ? 0 : 1000,
    },
  };
}

/** Both recordings, from the timeline module `timeline` (timelineOf, timelineReducer) and serve's `withAsks` and
 *  `RowLog`: the run that completed, read from its store as serve reads it, and the same run live while its write is
 *  out. `options` says what this server's store read hands the timeline. */
export function recordings({ timeline, withAsks, RowLog, options = (settled) => (settled ? { settled: true, workDir: WORK, run: { startedAt: STARTED_AT, endedAt: ENDED_AT } } : { workDir: WORK }) }) {
  const stored = timeline.timelineOf(entries, options(true));
  const reducer = timeline.timelineReducer(options(false));
  reducer.apply([{ type: "snapshot", entries: liveEntries }, { type: "run_start", inputs: [] }]);
  const live = reducer.rows();
  const usd = (rows) => rows.findLast((row) => row.kind === "usage")?.usage?.usd ?? null;
  return {
    completed: recording({ rows: stored, withAsks, RowLog, status: "completed", usd: usd(stored) }),
    working: recording({ rows: live, withAsks, RowLog, status: "working", usd: null }),
  };
}
