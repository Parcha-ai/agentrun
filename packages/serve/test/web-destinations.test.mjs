// serve's start line for a run's web tools: one line on the server's log when the run's Web is made (as its web tools
// are bound), naming each tool's order, keyed or keyless, and any hold known then. Never a key, nothing else.
import assert from "node:assert/strict";
import { test } from "node:test";
import { webOf } from "../dist/web-run.js";
import { planeFor, TOOL_PLANE_ENV } from "../dist/tool-plane.js";
import { CANARY } from "./fixtures/faux-parallel.mjs";

/** What the server writes to stderr while `fn` runs. */
function stderrOf(t, fn) {
  const lines = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => (lines.push(String(chunk)), typeof rest.at(-1) === "function" && rest.at(-1)(), true);
  t.after(() => (process.stderr.write = write));
  try { fn(); } finally { process.stderr.write = write; }
  return lines.join("").split("\n").filter(Boolean);
}

test("a run's Web writes one start line naming each tool's order, keyed or keyless, and no key; a second ask writes none", (t) => {
  const env = { [TOOL_PLANE_ENV]: JSON.stringify({ web_search: "parallel", web_fetch: "firecrawl-keyless" }), PARALLEL_API_KEY: CANARY };
  const lines = stderrOf(t, () => (webOf(env), webOf(env)));
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.match(lines[0], /^agentrun-serve: at=\S+ event=web_destinations search="parallel \(keyed\)" fetch="firecrawl-keyless \(keyless\) > direct" classifier=off$/);
  assert.doesNotMatch(lines[0], new RegExp(CANARY));
});

test("on a server holding a Parallel key, a run with no pick (auto) asks Parallel first for both tools, the guarded direct fetch behind its fetch", (t) => {
  const keyed = { PARALLEL_API_KEY: CANARY };
  const plane = planeFor(keyed, { tools: ["web_search", "web_fetch"] }, {});
  const lines = stderrOf(t, () => webOf({ ...keyed, [TOOL_PLANE_ENV]: JSON.stringify(plane) }));
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.match(lines[0], /^agentrun-serve: at=\S+ event=web_destinations search="parallel \(keyed\)" fetch="parallel \(keyed\) > direct" classifier=off$/, "auto on a keyed server: Parallel's extract first, the direct fetch its fallback");
  const keyless = stderrOf(t, () => webOf({ [TOOL_PLANE_ENV]: JSON.stringify(planeFor({}, { tools: ["web_search", "web_fetch"] }, {})) }));
  assert.match(keyless[0], /search="firecrawl-keyless \(keyless\) > exa-keyless \(keyless\)" fetch="firecrawl-keyless \(keyless\) > direct"/, "no key: keyless Firecrawl, as before");
});
