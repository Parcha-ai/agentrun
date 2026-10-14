// examples/no-double-charge runs as a stranger runs it, with no disk and no key: the agent is killed while invoice 2's
// charge is in flight, the run reopens in a second process, the cut charge comes back interrupted and is not sent
// again, and the payment server has one charge per invoice.
import { it } from "node:test";
import assert from "node:assert/strict";
import { assertExampleOk, runExample } from "./_run-example.ts";

it("no-double-charge: the charge cut by the kill comes back interrupted, and every invoice reaches the server once", async () => {
  const run = await runExample("no-double-charge");
  assertExampleOk(run, /^ok: no invoice was charged twice, and the charge cut by the kill came back interrupted, not sent again \(4 invoices, 4 charges at the server, invoice 2 interrupted\)$/m);
  assert.match(run.stdout, /^payment server: charge #2 for invoice 2 received, held with no answer; killing generation 1 \(SIGKILL\)$/m);
  assert.match(run.stdout, /^generation 2 opened the run in .*no-double-charge-run$/m);
  assert.doesNotMatch(run.stdout, /^generation 2: charging invoice [12]$/m, "the second process charges only invoices 3 and 4");
  assert.match(run.stdout, /^ {2}charge-2: interrupted \(/m);
  assert.match(run.stdout, /^ {2}#2 invoice 2, key charge-2, cut$/m);
});
