import type { RunTrace, RunUsage, TraceSpan } from "@/lib/v2";

// Hand-written traces in the served shape (GET /v2/runs/{id}/trace), for tests and stories: the faux model answers in
// milliseconds and never caches, so a recorded trace shows neither a long call nor a cache read.

/** When the sample run started. Every span is placed by its offset from it, in ms. */
export const TRACE_START = Date.parse("2026-11-17T21:14:02.000Z");
const iso = (ms: number) => new Date(TRACE_START + ms).toISOString();

/** USD per million tokens the sample's requests are priced at: input, cache read, cache write, output. */
const RATE = { input: 3, cache_read: 0.3, cache_write: 3.75, output: 15 };
const usdOf = (tokens: number, rate: number) => Math.round(tokens * rate) / 1e6;

const BLANK = { parent_id: null, agent_label: null, stop_reason: null, tokens: null, usd: null, decision: false, charged: false, not_metered: false, tool_use_id: null, input_preview: null, result_preview: null, result_size_bytes: null } as const;

/** A model request that answered: from `from` to `to`, with its tokens, priced at RATE. */
function request(id: number, from: number, to: number, [input, cache_read, cache_write, output]: [number, number, number, number], more: Partial<TraceSpan> = {}): TraceSpan {
  const usd = Math.round((usdOf(input, RATE.input) + usdOf(cache_read, RATE.cache_read) + usdOf(cache_write, RATE.cache_write) + usdOf(output, RATE.output)) * 1e6) / 1e6;
  return { ...BLANK, id: `m:0:${id}`, kind: "model", name: "claude-sonnet-5-5", started_at: iso(from), ended_at: iso(to), status: "ok", stop_reason: "toolUse", tokens: { input, cache_read, cache_write, output }, usd, ...more };
}
/** A tool call under request `by`: from `from` to `to`, with the head of its arguments and of its result. */
function call(id: string, by: number, name: string, from: number, to: number, input: string, result: string, size: number, more: Partial<TraceSpan> = {}): TraceSpan {
  return { ...BLANK, id: `t:0:${id}`, kind: "tool", parent_id: `m:0:${by}`, name, started_at: iso(from), ended_at: iso(to), status: "ok", tool_use_id: id, input_preview: input, result_preview: result, result_size_bytes: size, ...more };
}

/** A pi run that screens a supplier: seven requests whose input grows and is mostly read from cache, fifteen calls
 *  (three searches at once, a fetch that failed, two shell commands, one charged browser step, one tool with no price),
 *  and a call that waited a minute for a person's approval. */
export const TRACE: RunTrace = {
  run_id: "run_7f3a9c2e",
  model_requests: "priced",
  dropped: 0,
  spans: [
    request(2, 3_400, 8_200, [1_204, 0, 18_420, 412]),
    call("call_01", 2, "skill", 8_400, 8_404, '{"skill":"supplier-screening"}', "Loaded skill supplier-screening: registry, sanctions, directors, adverse media, report format.", 4_198),
    call("call_02", 2, "web_search", 8_500, 12_800, '{"query":"Northwind Freight Ltd company registration","n":6}', "6 results. Top: registry.example/companies/NF-204418", 8_612, { usd: 0.005, charged: true }),
    call("call_03", 2, "web_search", 8_500, 14_600, '{"query":"Northwind Freight sanctions OR enforcement notice","n":6}', "6 results. Top: sanctions.example/notices/2024-117", 6_904, { usd: 0.005, charged: true }),
    call("call_04", 2, "web_search", 8_600, 13_800, '{"query":"Northwind Freight Ltd directors","n":8}', "8 results. Top: tradepress.example/2026/northwind-freight-audit", 9_388, { usd: 0.005, charged: true }),
    request(9, 14_900, 17_800, [2, 19_624, 7_318, 286]),
    call("call_05", 9, "web_fetch", 18_000, 20_200, '{"url":"https://registry.example/companies/NF-204418"}', "Northwind Freight Ltd, registered 2011, active. 14 filings.", 62_140),
    call("call_06", 9, "web_fetch", 18_000, 21_700, '{"url":"https://sanctions.example/notices/2024-117"}', "Enforcement notice 2024-117 names one individual.", 24_630),
    call("call_07", 9, "web_fetch", 18_100, 23_300, '{"url":"https://tradepress.example/2026/northwind-freight-audit"}', "HTTP 403 Forbidden: the site refused an automated fetch.", 366, { status: "failed" }),
    request(16, 23_500, 26_600, [2, 26_944, 21_870, 198]),
    call("call_08", 16, "run", 26_800, 39_200, '{"goto":"https://tradepress.example/2026/northwind-freight-audit"}', "Northwind Freight passes 2026 customs audit ...", 36_240, { usd: 0.0004, charged: true }),
    request(19, 39_400, 45_000, [2, 48_816, 9_240, 734]),
    call("call_09", 19, "bash", 45_200, 54_100, '{"command":"pip install pdfplumber"}', "Successfully installed pdfplumber and 4 dependencies.", 1_410),
    call("call_10", 19, "bash", 54_200, 92_800, '{"command":"python extract_filings.py --company NF-204418"}', "Parsed 14 filings\ndirectors: 2\ncharges: 0", 51_600),
    request(24, 93_000, 99_200, [2, 58_058, 14_502, 1_105], { tokens: { input: 2, cache_read: 58_058, cache_write: 14_502, output: 1_105, reasoning: 320 } }),
    call("call_11", 24, "write", 99_400, 99_412, '{"path":"findings.json"}', "Wrote findings.json", 48),
    call("call_12", 24, "web_search", 99_500, 104_400, '{"query":"Northwind Freight Ltd adverse media 2026","n":8}', "8 results. Nothing newer than the 2024 notice.", 9_920, { usd: 0.005, charged: true }),
    call("call_13", 24, "web_fetch", 99_500, 102_300, '{"url":"https://sanctions.example/notices/2024-117/update"}', "Notice 2024-117 remains in force.", 30_410),
    call("call_14", 24, "mcp:crm/lookup_account", 99_600, 100_900, '{"name":"Northwind Freight Ltd"}', "No account on file.", 212, { not_metered: true }),
    request(33, 104_600, 108_000, [2, 72_562, 11_236, 240]),
    call("call_15", 33, "mcp:mail/send_draft", 108_200, 167_000, '{"to":"compliance@northstar.example","subject":"Review needed: Northwind Freight Ltd"}', "Sent after approval. Message msg_81c2.", 92),
    request(37, 167_200, 225_500, [2, 83_800, 1_912, 6_840], { stop_reason: "toolUse" }),
    call("call_16", 37, "write", 225_600, 225_620, '{"path":"report.md"}', "Wrote report.md", 46),
    request(40, 225_800, 227_900, [2, 85_712, 6_886, 64], { stop_reason: "stop" }),
  ],
};

/** The sample run's cost: its requests' costs and its calls' charges. */
export const TRACE_USD = Math.round(TRACE.spans.reduce((sum, span) => sum + (span.usd ?? 0), 0) * 1e6) / 1e6;
/** A moment just after the sample run ended, for a story's clock. */
export const TRACE_END = TRACE_START + 228_000;

/** The same run while it goes: its fifth request has answered, one of its calls runs and one waits for a person. */
export const TRACE_LIVE: RunTrace = {
  ...TRACE,
  spans: [
    ...TRACE.spans.slice(0, 15),
    call("call_11", 24, "write", 99_400, 99_412, '{"path":"findings.json"}', "Wrote findings.json", 48),
    { ...call("call_12", 24, "web_search", 99_500, 0, '{"query":"Northwind Freight Ltd adverse media 2026","n":8}', "", 0), ended_at: null, status: "running", result_preview: null, result_size_bytes: null },
    { ...call("call_15", 24, "mcp:mail/send_draft", 99_600, 0, '{"to":"compliance@northstar.example"}', "", 0), ended_at: null, status: "waiting", result_preview: null, result_size_bytes: null },
  ],
};
/** A moment in the live sample: 12 s after its last request answered. */
export const TRACE_LIVE_NOW = TRACE_START + 111_000;

/** A CLI harness's run: its record keeps no model request, so the trace is its tool calls, none under a request. */
export const TRACE_CLI: RunTrace = {
  run_id: "run_51c0d7aa",
  model_requests: "not_recorded",
  dropped: 0,
  spans: [
    { ...call("toolu_01", 0, "Bash", 1_200, 1_950, '{"command":"ls -la"}', "total 24\nREADME.md\nsrc", 412), parent_id: null },
    { ...call("toolu_02", 0, "Read", 2_400, 2_430, '{"file_path":"README.md"}', "# Invoice checker", 2_048), parent_id: null },
    { ...call("toolu_03", 0, "Bash", 3_100, 9_800, '{"command":"npm test"}', "1 failing: totals.test.js", 6_120, { status: "failed" }), parent_id: null },
    { ...call("toolu_04", 0, "Edit", 11_000, 11_020, '{"file_path":"src/totals.js"}', "Edited src/totals.js", 64), parent_id: null },
    { ...call("toolu_05", 0, "Bash", 11_600, 17_900, '{"command":"npm test"}', "12 passing", 5_876), parent_id: null },
  ],
};

/** The CLI harness's run's cost line by line (GET /v2/runs/{id}/usage), as the server booked it: its model's tokens
 *  (sent through a gateway, so no provider is named), the calls one vendor charged for (two more ran with no price set),
 *  and its browser time, whose charge is not known yet beyond what is. */
export const USAGE_CLI: RunUsage = {
  run_id: "run_51c0d7aa",
  ended_at: new Date(TRACE_END).toISOString(),
  currency: "USD",
  total: { usd: null, so_far_usd: 0.4379, unpriced: 1 },
  lines: [
    { meter: "tokens", model: "claude-sonnet-5-5", provider: null, charged_by: null, quantity: 184_220, unit: "token", basis: "reported", attempt: 1, billable: true, usd: 0.4125, requests: 12, tokens: { input: 1_840, output: 6_120, cache_read: 160_400, cache_write: 15_860 } },
    { meter: "tools", model: null, provider: "monid", charged_by: "monid", quantity: 3, unit: "call", basis: "estimate", attempt: 1, billable: true, usd: 0.015, not_metered_calls: 2 },
    { meter: "browser_time", model: null, provider: "browserbase", charged_by: null, quantity: 312, unit: "second", basis: "estimate", attempt: 1, billable: true, usd: null, so_far_usd: 0.0104, unpriced: 1 },
  ],
  browser_sessions: [],
  computer_intervals: [],
  infra_usd: 0,
  reason: null,
};
