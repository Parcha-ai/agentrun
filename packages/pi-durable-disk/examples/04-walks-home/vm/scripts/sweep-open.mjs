// The stop's last step: terminate by name (or id) every sandbox the ledger still has open, then say what is left. A create Modal queued when the stop began is only a name until it places;
// this keeps asking for it, for a bounded time, and terminates it when it appears. Needs Modal's token in the environment (the with-modal wrapper) and the ledger file the 03 server wrote (--ledger).
//   node scripts/sweep-open.mjs --ledger <file> [--app <modal app name>] [--wait-s 120]
// The last line reads `sweep-open: terminated N, already gone M, not running R, left K`. `not running` are names under which Modal has no RUNNING sandbox (it ended, or a create is still queued: nothing to terminate);
// `left` is a sandbox that was found and would not terminate: money still running, exit 1, names printed.
import { parseArgs } from "node:util";
import { Ledger } from "../../../03-tab-to-cloud/pipe/control.ts";
import { openTargets, terminateTargets } from "../sweep-open.ts";

const { values } = parseArgs({ options: { ledger: { type: "string" }, app: { type: "string", default: "pda-demo" }, "wait-s": { type: "string", default: "120" } } });
if (!values.ledger) throw new Error("--ledger <file> is required");
const { ModalClient } = await import("modal");
const sdk = new ModalClient();
const ledger = new Ledger(values.ledger);
const targets = openTargets(ledger.openRows());
console.log(`sweep-open: ${targets.length} sandbox(es) open in the ledger`);
const out = await terminateTargets(sdk, values.app, targets, {
  waitMs: Number(values["wait-s"]) * 1000,
  log: (event, data) => console.log(JSON.stringify({ event, ...data })),
  onGone: (t, how) => ledger.close("modal-sandbox", t.value, how === "terminated" ? "terminated by the stop's sweep" : "already gone at the stop's sweep"),
});
if (out.left.length > 0) console.log(`found running and not removable: ${out.left.join(", ")}`);
if (out.notRunning.length > 0) console.log(`no running sandbox by this name (ended, or a create still queued): ${out.notRunning.join(", ")}`);
console.log(`sweep-open: terminated ${out.terminated.length}, already gone ${out.gone.length}, not running ${out.notRunning.length}, left ${out.left.length}`);
process.exit(out.left.length > 0 ? 1 : 0);
