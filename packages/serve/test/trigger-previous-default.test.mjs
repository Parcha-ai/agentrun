// A source hands its runs their trigger's last completed result only when its adapter opts in (previousResult: true,
// trigger-adapter.ts carriesPrevious): a source that says nothing hands none, so a new source never passes one run's
// answer to the next by default. The shipped sources' own behaviour is trigger-previous-result.test.mjs's.
import assert from "node:assert/strict";
import { test } from "node:test";
import { schedule } from "../dist/trigger-schedule.js";
import { TRIGGER_ADAPTERS } from "../dist/trigger-adapters.js";
import { follow, serve } from "./support.mjs";
import { made } from "./trigger-support.mjs";

/** A test-only clock source, a schedule under another kind: `previousResult` as given, absent when undefined. */
function scheduleAs(id, previousResult) {
  const asSchedule = (source) => ({ ...source, kind: "schedule" });
  const { previousResult: _, ...rest } = schedule;
  return {
    ...rest,
    id,
    label: `${id} trigger`,
    describe: `{kind: "${id}", cron, timezone}`,
    schemas: [],
    sent: undefined,
    ...(previousResult === undefined ? {} : { previousResult }),
    parse: (value, ...args) => {
      const parsed = schedule.parse(asSchedule(value), ...args);
      return parsed && { ...parsed, kind: id };
    },
    wellFormed: (source) => schedule.wellFormed(asSchedule(source)),
    zone: (source) => schedule.zone(asSchedule(source)),
    clock: (source) => schedule.clock(asSchedule(source)),
    problem: (source) => schedule.problem?.(asSchedule(source)),
  };
}

const SCHEMA = { type: "object", additionalProperties: false, required: ["digest"], properties: { digest: { type: "string" } } };
const ANSWER = { digest: "Acme launched Pulse." };
const PREVIOUS = "The result of this trigger's last completed run";

test("a source whose adapter doesn't opt in to previousResult hands its runs no earlier run's result; one that opts in does", { timeout: 120_000 }, async (t) => {
  const silent = scheduleAs("silent");
  const opted = scheduleAs("opted", true);
  assert.equal("previousResult" in silent, false, "the silent source says nothing of previousResult");
  const { api } = await serve(t, { triggerAdapters: [...TRIGGER_ADAPTERS, silent, opted] });
  await made(api, "answerer", { output_schema: SCHEMA });
  const target = { kind: "start_run", agent_id: "answerer", input: { content: `Answer with this json: ${JSON.stringify(ANSWER)}` }, max_cost_usd: 0.5 };
  /** What the second of two by-hand firings of a `kind` trigger was handed: whether its answer quotes a previous block. */
  const secondOf = async (kind) => {
    const trigger = await api("POST", "/triggers", { name: kind, enabled: false, source: { kind, cron: "0 9 * * 1", timezone: "UTC" }, target });
    assert.equal(trigger.status, 201, JSON.stringify(trigger.body));
    let run;
    for (const press of ["one", "two"]) {
      const fired = await api("POST", `/triggers/${trigger.body.id}/fire`, undefined, { "idempotency-key": `${kind}-${press}` });
      assert.equal(fired.status, 202, JSON.stringify(fired.body));
      await follow(api, fired.body.run_id, ["completed"]);
      run = (await api("GET", `/runs/${fired.body.run_id}`)).body;
      assert.deepEqual(run.result.output, ANSWER, `${kind}: its own structured answer`);
    }
    // The faux model quotes what the run was handed after the trigger's first line as "Handed: ...".
    return run.result.final_answer.includes(PREVIOUS);
  };
  assert.deepEqual({ silent: await secondOf("silent"), opted: await secondOf("opted") }, { silent: false, opted: true }, `only the source that opts in hands its second run a "${PREVIOUS}" block`);
});
