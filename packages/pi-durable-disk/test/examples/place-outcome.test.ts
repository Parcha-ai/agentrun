// examples/place-outcome: a run that delivers is `complete` with its record, a run that gives up is `failed` with its code
// and message, and both name the models they used. The example's README shows main.ts and app.ts, and this test keeps the
// copies identical.
import { it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertExampleOk, runExample } from "./_run-example.ts";

it("place-outcome: two runs through localPlace end complete and failed, each with its generation, models and record or code", { timeout: 120_000 }, async () => {
  const run = await runExample("place-outcome");
  assertExampleOk(run, /^ok: two runs, two outcomes: the one that delivered is complete with its record, the one that gave up is failed with its code and message, and both name the models they used$/m);
  assert.match(run.stdout, /^delivers: exit 0, outcome \{"status":"complete","generation":1,"code":null,"record":\{"total":42\},"models":\{"lead":"faux-1"\}\}$/m);
  assert.match(run.stdout, /^gives up: exit 0, outcome \{"status":"failed","generation":1,"code":"GAVE_UP","message":"no total could be made","models":\{"lead":"faux-1"\}\}$/m);
});

it("place-outcome's README shows main.ts and app.ts verbatim", () => {
  const dir = new URL("../../examples/place-outcome/", import.meta.url);
  const blocks = [...readFileSync(new URL("README.md", dir), "utf8").matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1]);
  assert.deepEqual(blocks, [readFileSync(new URL("main.ts", dir), "utf8"), readFileSync(new URL("app.ts", dir), "utf8")]);
});
