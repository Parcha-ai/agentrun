// A pi run through the dispatch lists the same non-hand tools main's per-run process binds for the same revision: the web
// tools and each monid endpoint its revision pins, by their wire names (monid:faux/person/enrich is
// monid__faux__person__enrich), beside the hands. Each is wrapped as a HostTool under the adapter loop's one gate. The web
// and monid tools carry no settle gate now: the adapter
// loop books their paid requests on the run's one ledger (bookedIn), as main does, so they run (that booking is proven over
// the loop in runner-paid-call-books.test.mjs). Only a tool with no runner seam yet (learned_workflow, until the {decisions,
// models} seam lands) is listed-but-refused, and its pin is not written on the runner yet, so it is not listed here.
import assert from "node:assert/strict";
import { test } from "node:test";
import { specFor, toolNames } from "./runner-spec-support.mjs";

test("the dispatch lists the web tools and monid by their wire names, beside the hands", async (t) => {
  const monidPin = { "monid:faux/person/enrich": { description: "Enrich a person.", input: { type: "object", properties: {} }, usd: 0.003 } };
  const { spec } = await specFor(t, { body: { tools: ["read", "write", "web_fetch", "web_search", "monid:faux/*"], monidPin } });
  const names = toolNames(spec);
  for (const name of ["web_fetch", "web_search"]) assert.ok(names.includes(name), `lists ${name}: ${JSON.stringify(names)}`);
  // A monid endpoint rides the loop's catalog seam (spec.mcp, as an MCP server's tools do): listed by its wire name, read
  // back to its catalog name for the gate.
  assert.deepEqual(spec.mcp?.tools.map((tool) => tool.name), ["monid__faux__person__enrich"]);
  assert.equal(spec.mcp.catalogOf("monid__faux__person__enrich"), "monid:faux/person/enrich");
  assert.ok(names.includes("read") && names.includes("write"), `lists the hands too: ${JSON.stringify(names)}`);
});

test("a revision with no non-hand tools lists only its hands", async (t) => {
  const { spec } = await specFor(t, { body: { tools: ["read", "write"] } });
  assert.deepEqual(toolNames(spec).filter((name) => name === "web_fetch" || name === "web_search" || name.startsWith("monid")), [], "no non-hand tools");
  assert.equal(spec.mcp, undefined, "no catalog tools");
});
