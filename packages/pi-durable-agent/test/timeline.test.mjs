import assert from "node:assert/strict";
import { test } from "node:test";
import { CAPS, groupTimeline, registerLabel, renderText, timelineOf, timelineReducer } from "../dist/timeline/index.js";
import { assistant, call, custom, inConv, result, user } from "./timeline-support.mjs";

const GREP_FIELDS = [
  "id", "timestamp", "created_at", "kind", "summary", "agent_label", "tool_name", "tool_use_id", "tool_status",
  "tool_input_preview", "tool_result_preview", "tool_result_size_bytes", "text",
];
const KINDS = new Set([
  "thinking", "text_block", "tool_use", "tool_result", "phase", "subagent_started", "subagent_progress", "subagent_completed",
  "final_answer", "error", "user_message", "waiting", "usage",
]);
const page = (url, title) => `url: ${url}\ntitle: ${title}\nevidence: evidence/x.json\n---\nbody`;
const SESSION = /Opened a live browser session/;
/** The rendered lines, without the cost row and the session-opened row, which most tests are not about. */
const lines = (rows, options) =>
  renderText(groupTimeline(rows.filter((row) => row.kind !== "usage" && !SESSION.test(row.summary ?? ""))), options).split("\n").filter(Boolean);
const text = (rows, options) => lines(rows, options).join("\n");
const groups = (rows) => groupTimeline(rows.filter((row) => row.kind !== "usage"));
const norm = (line) => line.slice(10).replace(/(\S) {2,}/g, "$1 ");
const summaries = (rows) => rows.map((row) => row.summary);

test("every row carries Grep's 13 fields, a known kind, an ISO time and Grep's caps", () => {
  const long = "x".repeat(5000);
  const rows = timelineOf([
    user(long, 0),
    assistant([{ type: "thinking", thinking: long }, { type: "text", text: long }, call("c1", "bash", { command: long })], 1),
    result("c1", "bash", long, 2),
  ]);
  for (const row of rows) {
    for (const field of GREP_FIELDS) assert.ok(field in row, `${row.id} lacks ${field}`);
    assert.ok(KINDS.has(row.kind));
    assert.match(row.timestamp, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    assert.equal(row.created_at, row.timestamp);
    assert.ok((row.summary ?? "").length <= CAPS.summary);
    assert.ok((row.tool_input_preview ?? "").length <= CAPS.preview);
    assert.ok((row.tool_result_preview ?? "").length <= CAPS.preview);
    assert.ok((row.text ?? "").length <= CAPS.text);
    assert.ok(row.tool_status === null || row.tool_status === "success" || row.tool_status === "failed");
  }
  assert.equal(rows.find((row) => row.kind === "tool_result").tool_result_size_bytes, 5000);
});

test("thinking collapses to its first sentence and keeps the full text", () => {
  const [row] = timelineOf([assistant([{ type: "thinking", thinking: "The portal needs a sign-in. I have a saved connection for it." }, call("c", "read", { path: "a.md" })])]);
  assert.equal(row.kind, "thinking");
  assert.equal(row.summary, "Thinking: The portal needs a sign-in.");
  assert.equal(row.text, "The portal needs a sign-in. I have a saved connection for it.");
});

test("prose before calls is a text_block; a final stop answer is the final_answer", () => {
  const rows = timelineOf([assistant([{ type: "text", text: "Opening the portal." }, call("c", "read", { path: "a" })]), result("c", "read", "x"), assistant([{ type: "text", text: "Done.\nMore." }])]);
  assert.deepEqual(rows.filter((r) => /text|final/.test(r.kind)).map((r) => [r.kind, r.summary]), [["text_block", "Opening the portal."], ["final_answer", "Done."]]);
});

test("a round of three browser_read folds to one line and shows its failure", () => {
  const rows = timelineOf([
    assistant([call("a", "browser_read"), call("b", "browser_read"), call("c", "browser_read")], 0),
    result("c", "browser_read", page("https://b.example/billing/invoices", "Invoices"), 3),
    result("a", "browser_read", page("https://a.example/billing", "Billing"), 1),
    result("b", "browser_read", '{"ok":false,"message":"the page says \\"Session expired\\""}', 2, { isError: true }),
  ]);
  const calls = groupTimeline(rows).find((g) => g.type === "calls");
  assert.deepEqual(calls.calls.map((c) => [c.use.tool_use_id, c.result.tool_use_id]), [["a", "a"], ["b", "b"], ["c", "c"]]);
  const out = lines(rows);
  assert.equal(out.length, 2);
  assert.match(out[0], /^\d\d:\d\d:\d\d  Read 3 pages: a\.example\/billing, b\.example\/billing\/invoices +2 ok, 1 failed$/);
  assert.equal(out[1], `${" ".repeat(12)}Read the page failed: the page says "Session expired"`);
  assert.equal(text(rows, { fold: false }).split("\n").filter((line) => /ok$/.test(line)).length, 2);
});

test("a round of different tools has a header and one line per call", () => {
  const rows = timelineOf([
    assistant([call("a", "run", { code: "await page.click('#go')" }), call("b", "screenshot")], 0),
    result("a", "run", "ok", 1, { details: { sent: [{ method: "GET", url: "https://portal.example/billing?token=abc", held: null }] } }),
    result("b", "screenshot", "url: https://portal.example/billing", 1),
  ]);
  const out = lines(rows);
  assert.match(out[0], /Ran 2 tools$/);
  assert.match(out[1], /^ {12}Acted on the page \(1 request sent: GET portal\.example\/billing\) +ok$/);
  assert.match(out[2], /^ {12}Took a screenshot +ok$/);
});

test("rounds of one call of one tool fold across rounds; thinking, a row or a failure ends the fold", () => {
  const bash = (id, t) => [assistant([call(id, "bash", { command: `ls ${id}` })], t), result(id, "bash", "ok", t)];
  const folded = timelineOf([...bash("a", 0), ...bash("b", 1), ...bash("c", 2)]);
  assert.equal(groups(folded).length, 1);
  assert.match(text(folded), /^\d\d:\d\d:\d\d  Ran 3 commands +3 ok$/);

  const thought = timelineOf([...bash("a", 0), assistant([{ type: "thinking", thinking: "Changing course." }, call("b", "bash", { command: "ls b" })], 1), result("b", "bash", "ok", 1)]);
  assert.equal(groups(thought).filter((g) => g.type === "calls").length, 2);

  const failing = timelineOf([...bash("a", 0), assistant([call("b", "bash", { command: "x" })], 1), result("b", "bash", "no", 1, { isError: true }), ...bash("c", 2)]);
  assert.equal(groups(failing).filter((g) => g.type === "calls").length, 3);

  const waiting = timelineOf([...bash("a", 0), custom("agent.handover", { state: "waiting" }), ...bash("b", 1)]);
  assert.equal(groups(waiting).filter((g) => g.type === "calls").length, 2);
});

test("retries are never deduped", () => {
  const attempt = (id, t, isError) => [assistant([call(id, "web_fetch", { url: "https://x.example/a?q=1" })], t), result(id, "web_fetch", isError ? "boom" : "fine", t, { isError })];
  const rows = timelineOf([...attempt("a", 0, true), ...attempt("b", 1, true), ...attempt("c", 2, false)]);
  assert.equal(text(rows).split("\n").filter((line) => /Fetched x\.example\/a +(ok|failed)$/.test(line)).length, 3);
  assert.equal(rows.filter((row) => row.kind === "tool_use").length, 3);
});

test("a result closes its call by id, whatever its order", () => {
  const rows = timelineOf([
    assistant([call("a", "read", { path: "one.md" }), call("b", "read", { path: "two.md" })], 0),
    result("b", "read", "two", 1),
    result("a", "read", "one", 2),
  ]);
  const [group] = groupTimeline(rows);
  assert.deepEqual(group.calls.map((c) => [c.use.tool_use_id, c.result.tool_use_id]), [["a", "a"], ["b", "b"]]);
  assert.match(text(rows), /Read 2 files: one\.md, two\.md +2 ok$/);
});

test("a nested call sits under its parent, and its result closes it", () => {
  const reducer = timelineReducer({ conversationId: 1 });
  reducer.apply([{ type: "message_end", entry: assistant([call("p", "codemode", { code: "..." })], 0) }]);
  reducer.apply([
    { type: "tool_execution_start", toolCallId: "p/1", toolName: "read", args: { path: "a.md" }, parentToolCallId: "p", parentTaskId: 5 },
    { type: "tool_execution_end", toolCallId: "p/1", toolName: "read", parentToolCallId: "p", result: { taskId: 6, isError: false, structuredOutput: "hello", diagnostics: [] } },
    { type: "tool_execution_start", toolCallId: "p/2", toolName: "read", args: { path: "b.md" }, parentToolCallId: "p", parentTaskId: 5 },
    { type: "tool_execution_end", toolCallId: "p/2", toolName: "read", parentToolCallId: "p", result: { taskId: 7, isError: true, diagnostics: [{ severity: "error", message: "no such file" }] } },
    { type: "tool_execution_end", toolCallId: "p", toolName: "codemode", entry: result("p", "codemode", "done", 3) },
  ]);
  const rows = reducer.rows();
  const inner = rows.filter((row) => row.parent_tool_use_id === "p");
  assert.deepEqual(inner.map((row) => [row.kind, row.tool_use_id]), [["tool_use", "p/1"], ["tool_result", "p/1"], ["tool_use", "p/2"], ["tool_result", "p/2"]]);
  const [group] = groupTimeline(rows);
  assert.equal(group.calls.length, 1);
  assert.equal(group.calls[0].inner[0].calls.length, 2);
  assert.deepEqual(text(rows).split("\n").map(norm), [
    "Ran a script ok",
    "  Read 2 files: a.md, b.md 1 ok, 1 failed",
    "    Read b.md failed: no such file",
  ]);
});

test("a subagent's rows sit under the call that spawned it", () => {
  const rows = timelineOf([
    user("Find the invoice", 0),
    assistant([call("sub", "subagent", { task: "Find the invoice\nin the portal" })], 1),
    inConv(assistant([call("k1", "read", { path: "inv.md" })], 2), 2),
    inConv(result("k1", "read", "INV-1", 3), 2),
    result("sub", "subagent", "found INV-1", 4, { details: { conversationId: 2 } }),
  ]);
  assert.equal(rows.find((row) => row.tool_use_id === "k1" && row.kind === "tool_use").parent_tool_use_id, "sub");
  assert.deepEqual(rows.filter((row) => row.kind.startsWith("subagent_")).map((row) => row.summary), ["Subagent: Find the invoice", "Subagent done: found INV-1"]);
  const groups = groupTimeline(rows);
  assert.deepEqual(groups.map((g) => g.type), ["row", "calls", "row"]);
  assert.deepEqual(lines(rows).map(norm), [
    "You: Find the invoice",
    "Using tool: subagent ok",
    "  Subagent: Find the invoice",
    "  Read inv.md ok",
    "  Subagent done: found INV-1",
  ]);
});

test("a user message, a steer after a tool round, a custom input kind with an author", () => {
  const rows = timelineOf([
    user("Check the build", 0),
    assistant([call("a", "bash", { command: "make" })], 1),
    result("a", "bash", "ok", 2),
    user("Use pnpm", 3),
    custom("chat.mention", { author: "ann" }, { model: [{ role: "user", content: "ann: can you check?\nthanks", timestamp: Date.UTC(2026, 9, 15, 20, 15) }] }),
  ]);
  assert.deepEqual(rows.filter((r) => r.kind === "user_message").map((r) => r.summary), ["You: Check the build", "You (steer): Use pnpm", "ann: ann: can you check?"]);
});

test("a failed model request is an error row; an aborted partial is nothing", () => {
  const rows = timelineOf([
    assistant([], 0, { stopReason: "error", errorMessage: "529 overloaded\nretry later" }),
    assistant([{ type: "text", text: "cut off" }], 1, { stopReason: "aborted" }),
  ]);
  assert.deepEqual(rows.map((r) => [r.kind, r.summary]), [["error", "Model request failed: 529 overloaded"], ["usage", "Cost so far: $0.0200 over 2 model requests"]]);
});

test("a reset, a compaction and a changed prompt are phase rows; the first system entry is not", () => {
  const system = () => ({ kind: "pi.system", id: undefined, conversationId: 1, model: [{ role: "system", content: "" }] });
  const rows = timelineOf([
    system(),
    custom("pi.reset", undefined, { model: [{ role: "user", content: "Handoff: the invoice is INV-1." }] }),
    custom("pi.compaction", undefined, { model: [{ role: "user", content: "Summary of the work." }] }),
    system(),
  ]);
  assert.deepEqual(rows.map((r) => [r.summary, r.text]), [["Context reset", "Handoff: the invoice is INV-1."], ["Summarized older context", "Summary of the work."], ["Tools changed", null]]);
});

test("cost: a sum, and unknown when any answer carries none, never $0", () => {
  const known = timelineOf([assistant([{ type: "text", text: "a" }], 0)]).at(-1);
  assert.equal(known.summary, "Cost so far: $0.0100 over 1 model request");
  assert.deepEqual(known.usage, { usd: 0.01, requests: 1 });
  const unknown = timelineOf([assistant([{ type: "text", text: "a" }], 0), assistant([{ type: "text", text: "b" }], 1, { usage: undefined })]).at(-1);
  assert.equal(unknown.summary, "Cost so far: unknown over 2 model requests");
  assert.equal(unknown.usage.usd, null);
});

test("an unknown entry kind and an unknown event are skipped, never thrown on", () => {
  const entries = [custom("app.note", { text: "opened a file" }), { kind: "x" }, { nope: 1 }, user("hi", 0)];
  assert.deepEqual(summaries(timelineOf(entries)), ["You: hi"]);
  const reducer = timelineReducer();
  reducer.apply([{ type: "future_event", x: 1 }, { type: "entry_appended", entry: entries[0] }, { type: "entry_appended", entry: 7 }, { type: "message_end", entry: entries[3] }]);
  assert.deepEqual(summaries(reducer.rows()), ["You: hi"]);
});

test("a tool result that asks the person to sign in is a waiting row", () => {
  const rows = timelineOf([
    assistant([call("s", "request_sign_in", { reason: "Sign in to the supplier portal" })], 0),
    result("s", "request_sign_in", "Waiting for the person.", 1),
  ]);
  assert.deepEqual(rows.filter((r) => r.kind === "waiting").map((r) => r.summary), ["Waiting for you: Sign in to the supplier portal"]);
  assert.match(text(rows), /Asked you to sign in +ok\n.{8}  Waiting for you: Sign in to the supplier portal$/);
});

test("a hand-over entry gives waiting, then the person's answer, and keeps only a session tag", () => {
  const rows = timelineOf([
    custom("agent.handover", { state: "waiting", reason: "sign in on the live browser", session: "ar-ref-12-1" }),
    custom("agent.handover", { state: "done", session: "ar-ref-12-1" }),
    custom("agent.handover", { state: "declined", session: "https://live.example/view?token=abc" }),
  ]);
  assert.deepEqual(rows.map((r) => [r.kind, r.summary, r.session]), [
    ["waiting", "Waiting for you: sign in on the live browser", "ar-ref-12-1"],
    ["user_message", "You signed in", "ar-ref-12-1"],
    ["user_message", "You declined to sign in", undefined],
  ]);
});

test("no row holds a live-view URL, a context id or a cookie, whatever a session change carries", () => {
  const secrets = ["browserbase.com/devtools", "LIVETOKEN123", "ctx_secret_abc", "SECRETCOOKIE", "wss://connect"];
  const liveView = "https://www.browserbase.com/devtools-fullscreen/inspector.html?wss=connect.browserbase.com/debug/bbs-1/devtools/page/LIVETOKEN123&token=LIVETOKEN123";
  const sessionData = { state: "live", liveViewUrl: liveView, contextId: "ctx_secret_abc", cookies: [{ name: "sid", value: "SECRETCOOKIE" }], url: liveView };
  const entries = [
    user("Log in", 0),
    custom("browser.session", sessionData),
    custom("agent.handover", { state: "waiting", reason: "sign in", session: liveView }),
    assistant([call("r", "browser_relaunch", { verified: true })], 1),
    result("r", "browser_relaunch", '{"ok":true,"session":"bbs-1","verified":true}', 2),
    assistant([call("b", "browser_release")], 3),
    result("b", "browser_release", '{"ok":true,"released":true,"session_id":"bbs-1"}', 4),
  ];
  const reducer = timelineReducer({ conversationId: 1 });
  reducer.apply([{ type: "snapshot", entries: entries.slice(0, 3), nestedTools: [], inbox: [], agent: { model: { provider: "p", modelId: "m" } } }]);
  reducer.apply([
    { type: "entry_appended", entry: entries[1] },
    { type: "tool_execution_update", toolCallId: "r", toolName: "browser_relaunch", details: sessionData },
    { type: "agent_changed", agent: { model: { provider: "p", modelId: "m2" } } },
    ...entries.slice(3).map((entry) => ({ type: "message_end", entry })),
  ]);
  for (const rows of [timelineOf(entries), reducer.rows()]) {
    const all = JSON.stringify(rows);
    for (const secret of secrets) assert.ok(!all.includes(secret), `a row holds ${secret}`);
    assert.ok(rows.some((r) => r.summary === "Released the browser session"));
  }
});

test("the stream: a partial is a live row, and the committed entry replaces it", () => {
  const reducer = timelineReducer({ conversationId: 1 });
  reducer.apply([{ type: "message_start", message: { role: "assistant", content: [] } }]);
  const first = reducer.apply([{ type: "message_update", usage: {}, changes: [
    { type: "thinking_start", contentIndex: 0, block: { type: "thinking", thinking: "" } },
    { type: "thinking_delta", contentIndex: 0, delta: "Checking the page. " },
    { type: "text_start", contentIndex: 1, block: { type: "text", text: "" } },
    { type: "text_delta", contentIndex: 1, delta: "Opening" },
  ] }]);
  assert.deepEqual(first.rows.map((r) => [r.id, r.summary]), [["1:live:thinking", "Thinking: Checking the page."], ["1:live:text_block", "Opening"]]);
  const more = reducer.apply([{ type: "message_update", usage: {}, changes: [{ type: "text_delta", contentIndex: 1, delta: " the portal." }] }]);
  assert.equal(more.rows.length, 1);
  assert.equal(more.rows[0].seq, first.rows[1].seq);
  assert.equal(more.rows[0].text, "Opening the portal.");
  const done = reducer.apply([{ type: "message_end", entry: assistant([{ type: "thinking", thinking: "Checking the page. " }, { type: "text", text: "Opening the portal." }, call("c", "read", { path: "a" })], 0) }]);
  assert.deepEqual(done.drop.sort(), ["1:live:text_block", "1:live:thinking"]);
  assert.ok(done.rows.some((r) => r.kind === "thinking" && !r.id.includes("live")));
  assert.ok(!reducer.rows().some((r) => r.id.includes("live")));
});

test("a call that ended with no entry is interrupted; so is one still open when the run ends", () => {
  const reducer = timelineReducer({ conversationId: 1 });
  reducer.apply([
    { type: "message_end", entry: assistant([call("a", "bash", { command: "sleep 9" }), call("b", "read", { path: "x" })], 0) },
    { type: "tool_execution_end", toolCallId: "a", toolName: "bash" },
  ]);
  assert.deepEqual(lines(reducer.rows()).map(norm), ["Ran 2 tools", "  Ran `sleep 9` interrupted", "  Read x running"]);
  reducer.apply([{ type: "run_end", inputs: [] }]);
  assert.deepEqual(lines(reducer.rows()).map(norm), ["Ran 2 tools", "  Ran `sleep 9` interrupted", "  Read x interrupted", "Run finished"]);
  const stored = timelineOf([assistant([call("a", "read", { path: "x" })], 0)], { settled: true });
  assert.match(text(stored), /Read x +interrupted/);
  assert.match(text(timelineOf([assistant([call("a", "read", { path: "x" })], 0)])), /Read x +running/);
});

test("waits: a retry, a poll and a queue are live rows that clear", () => {
  const reducer = timelineReducer({ conversationId: 1, now: () => 1_000 });
  const rows = (events) => summaries(reducer.apply(events).rows);
  assert.deepEqual(rows([{ type: "auto_retry_start", attempt: 2, at: 9_000, errorMessage: "rate limited\nretry" }]), ["Retrying in 8 s (attempt 2): rate limited"]);
  assert.deepEqual(rows([{ type: "inbox_update", items: [{}, {}] }]), ["2 messages queued"]);
  assert.deepEqual(rows([{ type: "deferred_poll", pollAt: 4_000 }]), ["Waiting for the model provider (next check in 3 s)"]);
  assert.deepEqual(reducer.apply([{ type: "auto_retry_end", attempt: 2 }, { type: "inbox_update", items: [] }]).drop.sort(), ["1:waiting:queue", "1:waiting:retry"]);
  assert.deepEqual(summaries(reducer.rows()), ["Waiting for the model provider (next check in 3 s)"]);
});

test("compaction, a failed task and a changed model are phase and error rows", () => {
  const reducer = timelineReducer({ conversationId: 1 });
  reducer.apply([{ type: "snapshot", entries: [], agent: { model: { provider: "p", modelId: "m1" } } }]);
  const start = reducer.apply([{ type: "compaction_start", taskId: 4, reason: "threshold", blocking: false }]);
  assert.deepEqual(summaries(start.rows), ["Summarizing older context"]);
  const end = reducer.apply([{ type: "compaction_end", taskId: 4, reason: "threshold", error: "provider down" }, { type: "task_failed", taskId: 9, kind: "tool", message: "boom" }, { type: "agent_changed", agent: { model: { provider: "p", modelId: "m2" } } }]);
  assert.deepEqual(end.drop, ["1:compaction:4"]);
  assert.deepEqual(summaries(end.rows), ["Compaction failed: provider down", "Task failed: boom", "Model changed to p/m2"]);
});

test("a snapshot rebuilds from its entries and drops what it no longer holds", () => {
  const entries = [user("one", 0), assistant([{ type: "text", text: "two" }], 1)];
  const reducer = timelineReducer();
  reducer.apply(entries.map((entry) => ({ type: "message_end", entry })));
  const before = reducer.rows().map((r) => r.id);
  const out = reducer.apply([{ type: "snapshot", entries: entries.slice(0, 1) }]);
  assert.deepEqual(out.rows.map((r) => r.summary), ["You: one"]);
  assert.deepEqual(out.drop.sort(), before.filter((id) => id !== out.rows[0].id).sort());
});

test("a host labels its own tools; agent_label names the conversation", () => {
  registerLabel("ati_search", (args) => `Searched for ${args.query}`, { many: (n) => `Searched ${n} times`, subject: (input) => input ?? undefined });
  const rows = timelineOf([
    assistant([call("a", "ati_search", { query: "acme ltd" }), call("b", "ati_search", { query: "acme plc" }), call("c", "custom_tool", {})], 0),
    result("a", "ati_search", "x", 1), result("b", "ati_search", "y", 1), result("c", "custom_tool", "z", 1),
  ], { agentLabel: (conv) => `agent ${conv}`, labels: { custom_tool: () => "Did the custom thing" } });
  assert.ok(rows.every((r) => r.agent_label === "agent 1"));
  assert.deepEqual(lines(rows).map(norm), ["Ran 3 tools", "  Searched 2 times: acme ltd, acme plc 2 ok", "  Did the custom thing ok"]);
  assert.equal(timelineOf([assistant([call("a", "mystery")], 0)])[0].summary, "Using tool: mystery");
});

test("a snapshot taken mid-run shows its partial answer, its wait, its queue and its nested calls", () => {
  const reducer = timelineReducer({ conversationId: 1, now: () => 0 });
  const out = reducer.apply([{
    type: "snapshot",
    entries: [assistant([call("p", "codemode", { code: "..." })], 0)],
    generation: { attempt: 2, message: { role: "assistant", content: [{ type: "text", text: "Working on it" }] }, retry: { at: 5_000, error: "overloaded" } },
    inbox: [{ id: 1, mode: "followUp" }],
    nestedTools: [{ callId: "p/1", parentCallId: "p", parentTaskId: 3, taskId: 4, name: "read", status: "running", arguments: { path: "a.md" } }],
    agent: {},
  }]);
  assert.deepEqual(summaries(out.rows).sort(), ["Cost so far: $0.0100 over 1 model request", "Retrying in 5 s: overloaded", "1 message queued", "Working on it", "Read a.md", "Ran a script"].sort());
  assert.equal(out.rows.find((row) => row.tool_use_id === "p/1").parent_tool_use_id, "p");
});

test("previews keep a URL's origin, path and query keys; values, fragment and userinfo go", () => {
  const FETCHED = "see (https://y.example/p?sig=SECRET4&n=2#top). Also a=b&c=d stays.";
  const rows = timelineOf([
    assistant([
      call("a", "web_fetch", { url: "https://user:pw@x.example/a/b?token=SECRET1&q=acme&q=more#frag-secret" }),
      call("b", "run", { code: 'await page.goto("https://x.example/login?session=SECRET2&next=/home")' }),
      call("c", "bash", { command: "curl -s 'http://localhost:8080/v1?key=SECRET3' | head" }),
    ], 0),
    result("a", "web_fetch", FETCHED, 1),
    result("b", "run", "url: https://x.example/home?code=SECRET5", 1),
    result("c", "bash", '{"message":"refused https://z.example/e?auth=SECRET6 by the server"}', 1, { isError: true }),
  ]);
  const byId = (id) => rows.find((row) => row.tool_use_id === id && row.kind === "tool_use");
  assert.equal(byId("a").tool_input_preview, "https://x.example/a/b?token=\u2026&q=\u2026");
  assert.equal(byId("b").tool_input_preview, 'await page.goto("https://x.example/login?session=\u2026&next=\u2026")');
  assert.equal(byId("c").tool_input_preview, "curl -s 'http://localhost:8080/v1?key=\u2026' | head");
  const results = rows.filter((row) => row.kind === "tool_result");
  assert.equal(results[0].tool_result_preview, "see (https://y.example/p?sig=\u2026&n=\u2026). Also a=b&c=d stays.");
  assert.equal(results[0].tool_result_size_bytes, FETCHED.length);
  assert.equal(results[1].tool_result_preview, "url: https://x.example/home?code=\u2026");
  assert.equal(results[2].summary, "Ran `curl -s 'http://localhost:8080/v1?key=\u2026' | head` failed: refused https://z.example/e?auth=\u2026 by the server");
  const all = JSON.stringify(rows.filter((row) => row.kind !== "user_message"));
  for (const secret of ["SECRET1", "SECRET2", "SECRET3", "SECRET4", "SECRET5", "SECRET6", "frag-secret", "user:pw"]) assert.ok(!all.includes(secret), `a row holds ${secret}`);
});

test("a nested call's result is scrubbed too", () => {
  const reducer = timelineReducer({ conversationId: 1 });
  reducer.apply([
    { type: "message_end", entry: assistant([call("p", "codemode", {})], 0) },
    { type: "tool_execution_start", toolCallId: "p/1", toolName: "web_fetch", args: { url: "https://x.example/a?token=SECRET7" }, parentToolCallId: "p" },
    { type: "tool_execution_end", toolCallId: "p/1", toolName: "web_fetch", parentToolCallId: "p", result: { taskId: 2, isError: false, structuredOutput: "https://x.example/b?sig=SECRET8", diagnostics: [] } },
  ]);
  const all = JSON.stringify(reducer.rows());
  assert.ok(!all.includes("SECRET7") && !all.includes("SECRET8"));
  assert.ok(all.includes("https://x.example/b?sig=\u2026"));
});

test("a saved file's phase row carries its path", () => {
  const rows = timelineOf([
    assistant([call("w", "write", { path: "invoices/summary.md", content: "x" }), call("d", "browser_downloads")], 0),
    result("w", "write", "wrote 1 line", 1),
    result("d", "browser_downloads", JSON.stringify({ fetched: [{ name: "INV-1.pdf", path: "downloads/INV-1.pdf", sizeBytes: 9, sha256: "00" }], already_fetched: [], skipped: [] }), 2),
  ]);
  const saved = rows.filter((row) => row.kind === "phase" && row.path !== undefined);
  assert.deepEqual(saved.map((row) => [row.summary, row.path]), [["Saved invoices/summary.md", "invoices/summary.md"], ["Saved downloads/INV-1.pdf", "downloads/INV-1.pdf"]]);
  assert.ok(rows.filter((row) => row.kind !== "phase" || !row.summary.startsWith("Saved")).every((row) => !("path" in row)));
});
