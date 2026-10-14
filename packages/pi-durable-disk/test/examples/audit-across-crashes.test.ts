// examples/audit-across-crashes: a run killed twice, and the account of each generation read from the store alone.
import { it } from "node:test";
import assert from "node:assert/strict";
import { assertExampleOk, runExample } from "./_run-example.ts";

it("audit-across-crashes: two kills, three generations, and the account from the store says which calls were cut and who settled them", { timeout: 120_000 }, async () => {
  const run = await runExample("audit-across-crashes");
  assertExampleOk(run, /^ok: the store alone shows three generations, two calls cut mid-flight, each settled as interrupted by the next generation and never run again$/m);
  const lines = run.stdout.trimEnd().split("\n");
  // The account is what the store held at each resume, per generation: its questions, calls, results and answers, and the
  // call it was killed with in flight. The cut call is settled, as interrupted, by the next generation, which answers.
  const account = lines.slice(lines.indexOf("generation 1:"), -1);
  assert.deepEqual(account, [
    "generation 1:",
    "  question: Tell me about tides",
    "  called lookup as lookup-1",
    "  lookup-1 returned: notes on tides",
    "  answered: Generation 1: notes on tides.",
    "  question: Tell me about granite",
    "  called lookup as lookup-2",
    "  killed with lookup-2 in flight",
    "generation 2:",
    "  lookup-2 settled as interrupted, never run again",
    "  answered: Generation 2: the lookup was cut by a crash, so I will not guess.",
    "  question: Tell me about monsoons",
    "  called lookup as lookup-3",
    "  lookup-3 returned: notes on monsoons",
    "  answered: Generation 2: notes on monsoons.",
    "  question: Tell me about lichen",
    "  called lookup as lookup-4",
    "  killed with lookup-4 in flight",
    "generation 3:",
    "  lookup-4 settled as interrupted, never run again",
    "  answered: Generation 3: the lookup was cut by a crash, so I will not guess.",
    "  question: Tell me about basalt",
    "  called lookup as lookup-5",
    "  lookup-5 returned: notes on basalt",
    "  answered: Generation 3: notes on basalt.",
    "  question: Tell me about glaciers",
    "  called lookup as lookup-6",
    "  lookup-6 returned: notes on glaciers",
    "  answered: Generation 3: notes on glaciers.",
  ]);
});
