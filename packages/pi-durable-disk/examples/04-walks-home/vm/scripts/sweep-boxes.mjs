// The stop's sweep of a run's GPU boxes by label, through pi-transport: destroy every running box labelled pda-run=<run> and pda-role=gpu, then list again until none is left (a destroyed sandbox can read
// running for about 30 s on Modal, so the default wait is 60 s). Needs Modal's token in the environment (the with-modal wrapper); nothing is printed of it.
//   node scripts/sweep-boxes.mjs --run <run id> [--app pda-demo-d4] [--wait-s 60] [--check]
// The last line reads `sweep-boxes: found N running (pda-run=<run>), destroyed M, left K`; exit 1 only if K is above 0 (the ids are printed). `--check` prints what it would do and calls nothing.
import { parseArgs } from "node:util";
import { modalBoxes } from "@parcha/pi-transport/box/modal";
import { sweepBoxes } from "../sweep-boxes.ts";

const { values } = parseArgs({ options: { run: { type: "string" }, app: { type: "string", default: "pda-demo-d4" }, "wait-s": { type: "string", default: "60" }, check: { type: "boolean", default: false } } });
if (!values.run) throw new Error("--run <run id> is required");
if (values.check) {
  console.log(`sweep-boxes: would list running boxes with pda-run=${values.run} and pda-role=gpu in app ${values.app}, destroy each through pi-transport, and list again for up to ${values["wait-s"]} s`);
  process.exit(0);
}
const { ModalClient } = await import("modal");
const provider = modalBoxes(new ModalClient(), { appName: values.app });
const out = await sweepBoxes(provider, values.run, { waitMs: Number(values["wait-s"]) * 1000 });
if (out.left > 0) console.log(`still listed as running: ${out.leftIds.join(", ")}`);
console.log(`sweep-boxes: found ${out.found} running (pda-run=${values.run}), destroyed ${out.destroyed}, left ${out.left}`);
process.exit(out.left > 0 ? 1 : 0);
