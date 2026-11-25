// Synthetic session files of the line sources, each split where its reader carries a request across the cursor. Every
// id, path and word here is made up.
const at = (i) => new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString();
const S = "00000000-0000-4000-8000-000000000001";
const base = (i) => ({ sessionId: S, cwd: "/work/fixture", timestamp: at(i), isSidechain: false, version: "2.0.0" });
const cUser = (uuid, text, i) => ({ ...base(i), type: "user", uuid, message: { role: "user", content: text } });
const aUsage = (input, output) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
const cAns = (uuid, msg, req, usage, i, block = { type: "text", text: "Done." }) => ({ ...base(i), type: "assistant", uuid, requestId: req, message: { id: msg, role: "assistant", model: "claude-fixture-1", content: [block], ...(usage ? { usage } : {}) } });
const xMeta = { type: "session_meta", timestamp: at(0), payload: { id: "thread-1", cwd: "/work/fixture", model_provider: "openai" } };
const xCtx = (i) => ({ type: "turn_context", timestamp: at(i), payload: { model: "gpt-fixture", effort: "high", cwd: "/work/fixture" } });
const xUser = (text, i) => ({ type: "response_item", timestamp: at(i), payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
const xAns = (text, i) => ({ type: "response_item", timestamp: at(i), payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } });
const xCall = (id, i) => ({ type: "response_item", timestamp: at(i), payload: { type: "function_call", name: "shell", arguments: "{}", call_id: id } });
const xOut = (id, i) => ({ type: "response_item", timestamp: at(i), payload: { type: "function_call_output", call_id: id, output: "ok" } });
const oUsage = (input, cached, output) => ({ input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output });
const xTok = (last, total, i) => ({ type: "event_msg", timestamp: at(i), payload: { type: "token_count", info: { last_token_usage: last, total_token_usage: total } } });
const pMeta = { type: "session", id: "pi-1", cwd: "/work/fixture", timestamp: at(0) };
const pUser = (text, i) => ({ type: "message", timestamp: at(i), message: { role: "user", content: text, timestamp: Date.parse(at(i)) } });
const pAns = (i, input, output) => ({ type: "message", timestamp: at(i), message: { role: "assistant", content: [{ type: "text", text: "ok" }], model: "fixture-1", provider: "openai", usage: { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output }, timestamp: Date.parse(at(i)) } });
export const CASES = [
  // Codex: an answer open, its usage after the cursor.
  { name: "codex-open", source: "codex", file: ".codex/sessions/2026/01/01/rollout-2026-01-01T00-00-00-a.jsonl", one: [xMeta, xCtx(1), xUser("Q.", 2), xAns("A.", 3)], two: [xTok(oUsage(100, 60, 7), oUsage(100, 60, 7), 4), xAns("B.", 5), xTok(oUsage(10, 0, 2), oUsage(110, 60, 9), 6)] },
  // Codex: a call's result read before the cursor, its request's usage after it (unpaid, no longer open).
  { name: "codex-unpaid", source: "codex", file: ".codex/sessions/2026/01/01/rollout-2026-01-01T00-00-00-b.jsonl", one: [xMeta, xCtx(1), xUser("Q.", 2), xCall("c1", 3), xOut("c1", 4)], two: [xTok(oUsage(50, 0, 5), oUsage(50, 0, 5), 5), xAns("Done.", 6), xTok(oUsage(20, 10, 3), oUsage(70, 10, 8), 7)] },
  // Codex: a call open across the cursor, more output items of the same request after it.
  { name: "codex-open-call", source: "codex", file: ".codex/sessions/2026/01/01/rollout-2026-01-01T00-00-00-c.jsonl", one: [xMeta, xCtx(1), xUser("Q.", 2), xCall("c1", 3)], two: [xAns("And text.", 4), xTok(oUsage(40, 0, 4), oUsage(40, 0, 4), 5), xOut("c1", 6)] },
  // Claude Code: a request's first line before the cursor, its last (usage) after.
  { name: "claude-split", source: "claude-code", file: `.claude/projects/-work-fixture/${S}.jsonl`, one: [cUser("u1", "Q.", 0), cAns("a1", "msg_1", "req_1", aUsage(1, 1), 1, { type: "thinking", thinking: "" })], two: [cAns("a2", "msg_1", "req_1", aUsage(5, 9), 2), cUser("u2", "Again.", 3), cAns("a3", "msg_2", "req_2", aUsage(2, 3), 4)] },
  // pi: a plain split.
  { name: "pi-split", source: "pi", file: ".pi/agent/sessions/--work-fixture--/2026-01-01T00-00-00_pi-1.jsonl", one: [pMeta, pUser("Q.", 1), pAns(2, 3, 4)], two: [pUser("Again.", 3), pAns(4, 5, 6)] },
];
export const MODES = [{ turns: true }, { turns: false }, { turns: false, totals: true }];
export const jsonl = (records) => records.map((r) => `${JSON.stringify(r)}\n`).join("");

/** What a test compares of a read: whether it resumed, each request's key, usage, model, text and calls, and a totals
 *  read's counts. */
export function summary(result) {
  const s = result.sessions[0];
  const c = s.counts;
  return {
    resumed: result.resumed,
    requests: s.requests.map(({ key, usage, model, text, calls }) => ({ key, usage, model, text, calls: calls?.length })),
    counts: c ? { n: c.n, models: c.models, model: Array.from(c.model.subarray(0, c.n)), values: Array.from(c.values.subarray(0, c.n * 7)), has: Array.from(c.has.subarray(0, c.n)) } : undefined,
  };
}
