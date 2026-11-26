// The server's keyless holds: a keyless provider's limit a run met (rate-limited, out of quota) holds it for the whole
// host, in the server's memory alone, until it lifts or the server restarts. Each new run's Web starts with them (its
// spawn environment carries them: hold data only, never a key), and GET /capabilities says them live on each web tool
// they hold. A keyed provider's hold stays the run's own.
import assert from "node:assert/strict";
import { test } from "node:test";
import { holdingWords } from "@parcha/agentrun-web";
import { activeHolds, ENDLESS_HOLD_MS, forgetHolds, holdsEnv, holdsFromEnv, noteHold, WEB_HOLDS_ENV } from "../dist/web-holds.js";
import { TOOL_PLANE_ENV } from "../dist/tool-plane.js";
import { FAUX_FIRECRAWL_ENV, webOf } from "../dist/web-run.js";
import { webSearchTool } from "../dist/web-search.js";
import { firecrawlServer } from "./fixtures/fake-firecrawl.mjs";
import { FAUX, serve } from "./support.mjs";

const NOW = Date.parse("2026-11-24T12:00:00Z");
const FETCH_HOLD = { provider: "firecrawl-keyless", tool: "fetch", kind: "rate", until: NOW + 90_000 };

/** What the server writes to stderr while `fn` runs. */
function stderrOf(t, fn) {
  const lines = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => (lines.push(String(chunk)), typeof rest.at(-1) === "function" && rest.at(-1)(), true);
  t.after(() => (process.stderr.write = write));
  try { fn(); } finally { process.stderr.write = write; }
  return lines.join("").split("\n").filter(Boolean);
}

test("a keyless hold is kept until it lifts; a later one extends it, an earlier one never shrinks it; a keyed or unknown one is refused", (t) => {
  forgetHolds();
  t.after(forgetHolds);
  assert.deepEqual(noteHold(FETCH_HOLD, NOW), FETCH_HOLD);
  assert.equal(noteHold({ ...FETCH_HOLD, until: NOW + 30_000 }, NOW), undefined, "an earlier end changes nothing");
  assert.deepEqual(activeHolds(NOW), [FETCH_HOLD]);
  const longer = { ...FETCH_HOLD, kind: "quota", until: NOW + 600_000 };
  assert.deepEqual(noteHold(longer, NOW), longer);
  assert.deepEqual(activeHolds(NOW), [longer]);
  assert.deepEqual(activeHolds(NOW + 600_000), [], "lifted at its end");
  for (const bad of [{ ...FETCH_HOLD, provider: "parallel" }, { ...FETCH_HOLD, provider: "nobody" }, { ...FETCH_HOLD, tool: "browse" }, { ...FETCH_HOLD, kind: "sleepy" }, { ...FETCH_HOLD, until: NOW - 1 }, { ...FETCH_HOLD, until: "soon" }, null, "held"]) {
    assert.equal(noteHold(bad, NOW), undefined, JSON.stringify(bad));
  }
  assert.equal(activeHolds(NOW).length, 1);
});

test("a hold with no end named (out of quota for the rest of a run) holds the host for ENDLESS_HOLD_MS", (t) => {
  forgetHolds();
  t.after(forgetHolds);
  const endless = { provider: "exa-keyless", tool: "key", kind: "quota", until: null };
  assert.deepEqual(noteHold(endless, NOW), { ...endless, until: NOW + ENDLESS_HOLD_MS });
  assert.deepEqual(noteHold({ ...endless, until: Number.POSITIVE_INFINITY }, NOW), undefined, "the same, again");
  assert.equal(ENDLESS_HOLD_MS, 60 * 60_000);
  assert.equal(activeHolds(NOW + 59 * 60_000).length, 1, "held at 59 min");
  assert.deepEqual(activeHolds(NOW + 60 * 60_000), [], "gone at 1 h");
});

test("a hold whose end is far off (a Retry-After weeks away) is held only to 25 h from now, noted or read from a run's environment", (t) => {
  forgetHolds();
  t.after(forgetHolds);
  const DAY_PLUS = 25 * 3_600_000;
  const far = { provider: "firecrawl-keyless", tool: "search", kind: "rate", until: NOW + 30 * 24 * 3_600_000 };
  assert.deepEqual(noteHold(far, NOW), { ...far, until: NOW + DAY_PLUS }, "a far end is held only to now + 25 h");
  assert.equal(activeHolds(NOW + DAY_PLUS - 1).length, 1, "held just before 25 h");
  assert.deepEqual(activeHolds(NOW + DAY_PLUS), [], "lifted at 25 h");
  assert.deepEqual(holdsFromEnv({ [WEB_HOLDS_ENV]: JSON.stringify([far]) }, NOW), [{ ...far, until: NOW + DAY_PLUS }], "read from a run's environment, the same bound");
});

test("a run's spawn environment carries the holds, hold data alone; the run reads them back and refuses anything else", (t) => {
  forgetHolds();
  t.after(forgetHolds);
  assert.deepEqual(holdsEnv(NOW), {}, "none: no variable");
  noteHold(FETCH_HOLD, NOW);
  const env = holdsEnv(NOW);
  assert.deepEqual(Object.keys(env), [WEB_HOLDS_ENV]);
  assert.deepEqual(JSON.parse(env[WEB_HOLDS_ENV]), [FETCH_HOLD]);
  assert.deepEqual(holdsFromEnv(env, NOW), [FETCH_HOLD]);
  assert.deepEqual(holdsFromEnv({ [WEB_HOLDS_ENV]: "not json" }), []);
  assert.deepEqual(holdsFromEnv({ [WEB_HOLDS_ENV]: JSON.stringify([{ ...FETCH_HOLD, provider: "parallel" }, FETCH_HOLD, { ...FETCH_HOLD, key: "x" }]) }, NOW), [FETCH_HOLD], "a keyed one, or one with any other field, is dropped");
  assert.deepEqual(holdsFromEnv({}), []);
});

test("a run's Web starts held: from its spawn environment, and from the server's own holds; its start line says until when", (t) => {
  forgetHolds();
  t.after(forgetHolds);
  const until = Date.now() + 10 * 60_000;
  const words = holdingWords({ kind: "rate", until });
  const plane = { [TOOL_PLANE_ENV]: JSON.stringify({ web_search: "exa-keyless", web_fetch: "firecrawl-keyless" }) };
  const spawned = { ...plane, [WEB_HOLDS_ENV]: JSON.stringify([{ provider: "firecrawl-keyless", tool: "fetch", kind: "rate", until }]) };
  const [line] = stderrOf(t, () => webOf(spawned));
  assert.match(line, new RegExp(`fetch="firecrawl-keyless \\(keyless, ${words}\\) > direct"`), line);
  assert.match(line, /search="exa-keyless \(keyless\)"/, "the search is not held");
  noteHold({ provider: "exa-keyless", tool: "search", kind: "rate", until }, Date.now());
  const [beside] = stderrOf(t, () => webOf({ ...plane }));
  assert.match(beside, new RegExp(`search="exa-keyless \\(keyless, ${words}\\)"`), beside);
});

test("a keyless limit a run meets is the server's hold, and logged; a run after it starts held", async (t) => {
  forgetHolds();
  t.after(forgetHolds);
  const fc = await firecrawlServer(t, () => ({ status: 429, headers: { "retry-after": "120" } }));
  const env = { [TOOL_PLANE_ENV]: JSON.stringify({ web_search: "firecrawl-keyless" }), AGENTRUN_SERVE_FAUX: FAUX, [FAUX_FIRECRAWL_ENV]: fc.url };
  const before = Date.now();
  const lines = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => (lines.push(String(chunk)), typeof rest.at(-1) === "function" && rest.at(-1)(), true);
  t.after(() => (process.stderr.write = write));
  try {
    await webSearchTool(env).execute({ query: "widgets" }, { callId: "call-1" }, {});
  } finally {
    process.stderr.write = write;
  }
  const [hold] = activeHolds();
  assert.deepEqual({ ...hold, until: undefined }, { provider: "firecrawl-keyless", tool: "search", kind: "rate", until: undefined });
  assert.ok(hold.until >= before + 120_000 && hold.until <= Date.now() + 120_000, String(hold.until - before));
  assert.ok(lines.join("").includes("event=web_provider_held provider=firecrawl-keyless tool=search kind=rate"), lines.join(""));
  const next = await webSearchTool({ ...env }).execute({ query: "widgets" }, { callId: "call-1" }, {});
  assert.match(next.output[0].text, /busy|unavailable|rate-limited/i);
  assert.equal(fc.calls("firecrawl_search"), 1, "the run after it is not sent");
});

test("GET /capabilities says each hold on the web tools it holds, live; none, no field", async (t) => {
  forgetHolds();
  t.after(forgetHolds);
  const { api } = await serve(t, { runner: false });
  const toolOf = async (name) => (await api("GET", "/capabilities")).body.tools.find((tool) => tool.name === name);
  const fetchTool = await toolOf("web_fetch");
  assert.ok(Object.values(fetchTool.resolves).includes("firecrawl-keyless"), JSON.stringify(fetchTool.resolves));
  assert.equal(fetchTool.held, undefined);
  const until = Date.now() + 5 * 60_000;
  noteHold({ provider: "firecrawl-keyless", tool: "key", kind: "quota", until }, Date.now());
  const held = { provider: "firecrawl-keyless", tool: "key", kind: "quota", until: new Date(until).toISOString(), words: holdingWords({ kind: "quota", until }) };
  assert.deepEqual((await toolOf("web_fetch")).held, [held]);
  const searchTool = await toolOf("web_search");
  if (Object.values(searchTool.resolves).includes("firecrawl-keyless")) assert.deepEqual(searchTool.held, [held]);
  noteHold({ provider: "firecrawl-keyless", tool: "search", kind: "rate", until: until + 60_000 }, Date.now());
  assert.deepEqual((await toolOf("web_fetch")).held, [held], "a search hold is not the fetch's");
  forgetHolds();
  assert.equal((await toolOf("web_fetch")).held, undefined, "read live, never cached");
});
