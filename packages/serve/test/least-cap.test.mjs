// A run paused at its cap serves the least cap that would send its refused request (`pending.least_cap_usd`): the very
// figure its words name ("Raise the cap to at least $X"), carried from the refusal that wrote them, so the
// number and the words never drift. The same on a paid call's refusal, which carries it for its pause (paid-pause).
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { REQUEST_STARTED } from "../dist/timeline/index.js";
import { KEY } from "./fixtures/faux-monid.mjs";
import { agent, follow, serve, withEnv } from "./support.mjs";
import { fauxTable } from "./fixtures/faux-table.mjs";

/** The tests' faux model priced on output only, $100 a million: a request's least (1,024 tokens) is $0.1024. */
const OUTPUT_PRICED = new URL("./fixtures/faux-output-priced.mjs", import.meta.url).pathname;
const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
const SETTLED = ["input_required", "completed", "failed", "cancelled"];
/** The cap a refusal's words name: "Raise the cap to at least $X", whatever words end the sentence. */
const named = (text) => Number(/Raise the cap to at least \$(\d+\.\d\d)\b/.exec(text ?? "")?.[1]);

// Under the faux harness claude-agent and codex run one path (harness-app.ts's guard), so codex stands for both.
for (const harness of ["pi", "codex"]) {
  test(`${harness}: a run paused at its cap serves least_cap_usd, the cap its words name as the least that sends the refused request`, { timeout: 90_000 }, async (t) => {
    const { api } = await serve(t, { faux: OUTPUT_PRICED, ...(harness === "pi" ? {} : { harnessTable: fauxTable(FAUX_HARNESS) }) });
    const id = `least-${harness}`;
    assert.equal((await api("POST", "/agents", agent(id, harness === "pi" ? {} : { harness }))).status, 201);
    const { run_id } = (await api("POST", `/agents/${id}/runs`, { input: { content: "Write one.md" }, max_cost_usd: 0.05 })).body;
    await follow(api, run_id, SETTLED);
    const { pending } = (await api("GET", `/runs/${run_id}`)).body;
    assert.equal(pending?.kind, "budget", JSON.stringify(pending));
    assert.ok(named(pending.said) > 0.05, pending.said);
    assert.equal(pending.least_cap_usd, named(pending.said), JSON.stringify(pending));
  });
}

// A paid call's refusal for room pauses the run at its next request (paid-pause.test.mjs): that pause serves the figure
// too, the cap its words name. pi and claude-agent, each through the run's ledger.
const FAUX_MONID = new URL("./fixtures/faux-monid.mjs", import.meta.url).pathname;
for (const harness of ["pi", "claude-agent"]) {
  test(`${harness}: a run paused at a paid call's refusal serves least_cap_usd, the cap its words name`, { timeout: 90_000 }, async (t) => {
    withEnv(t, { MONID_API_KEY: KEY });
    const { api } = await serve(t, { fauxMonid: FAUX_MONID, ...(harness === "pi" ? {} : { harnessTable: fauxTable(FAUX_HARNESS) }) });
    const ask = "Run monid's /person/enrich, called again after a raise.";
    const id = `least-paid-${harness}`;
    assert.equal((await api("POST", "/agents", agent(id, { ...(harness === "pi" ? {} : { harness, instructions: ask }), tools: ["monid.run"], tool_settings: { "monid.run": { permission: "allow" } } }))).status, 201);
    const { run_id } = (await api("POST", `/agents/${id}/runs`, { input: { content: ask }, max_cost_usd: 0.5 })).body;
    await follow(api, run_id, SETTLED);
    const { pending } = (await api("GET", `/runs/${run_id}`)).body;
    assert.deepEqual([pending?.kind, pending?.needs_usd], ["budget", 1], JSON.stringify(pending));
    assert.ok(named(pending.said) > 0.5, pending.said);
    assert.equal(pending.least_cap_usd, named(pending.said), JSON.stringify(pending));
  });
}
