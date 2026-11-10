// A pi run through the dispatch lists the same non-hand tools main's per-run process binds for the same revision: the web
// tools and monid, by their wire names (as main's registrations name them: monid.run is monid_run), beside the hands. Each
// is wrapped as a HostTool under the adapter loop's one gate. The web and monid tools carry no settle gate now: the adapter
// loop books their paid requests on the run's one ledger (bookedIn), as main does, so they run (that booking is proven over
// the loop in runner-paid-call-books.test.mjs). Only a tool with no runner seam yet (learned_workflow, until the {decisions,
// models} seam lands) is listed-but-refused, and its pin is not written on the runner yet, so it is not listed here.
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
