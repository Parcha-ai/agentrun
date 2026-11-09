// A pi run through the dispatch lists the same non-hand tools main's per-run process binds for the same revision: the web
// tools and monid, by their wire names (as main's registrations name them: monid.run is monid_run), beside the hands. Each
// is wrapped as a HostTool under the adapter loop's one gate. A paid tool is listed but its call is refused in words until
// the paid-call settle lands on the runner (settlePaidCall), so it is never run unbooked.
import assert from "node:assert/strict";
import { test } from "node:test";
import { specFor, toolNames } from "./runner-spec-support.mjs";

test("the dispatch lists the web tools and monid by their wire names, beside the hands", async (t) => {
  const { spec } = await specFor(t, { body: { tools: ["read", "write", "web_fetch", "web_search", "monid.run"] } });
  const names = toolNames(spec);
  for (const name of ["web_fetch", "web_search", "monid_run"]) assert.ok(names.includes(name), `lists ${name}: ${JSON.stringify(names)}`);
  assert.ok(names.includes("read") && names.includes("write"), `lists the hands too: ${JSON.stringify(names)}`);
});

test("a revision with no non-hand tools lists only its hands", async (t) => {
  const { spec } = await specFor(t, { body: { tools: ["read", "write"] } });
  assert.deepEqual(toolNames(spec).filter((name) => name === "web_fetch" || name === "web_search" || name.startsWith("monid")), [], "no non-hand tools");
});

test("a paid tool is listed but its call is refused until the runner settles paid calls", async (t) => {
  const { spec } = await specFor(t, { body: { tools: ["web_search"] } });
  const webSearch = spec.session.tools.find((tool) => tool.name === "web_search");
  assert.ok(webSearch, "web_search is listed");
  const answer = await webSearch.call({ query: "anything" }, { callId: "c1", signal: new AbortController().signal, attempt: 0 });
  assert.equal(answer.isError, true, "its call is an error");
  assert.match(answer.text, /not settled on the runner yet/, `refused in words, not run: ${answer.text}`);
});
