// A place's outcome: how a run ended, in the run's own words. `localPlace` starts the run as an instance on a directory of
// this machine (`pi-durable-disk run --dir`), and when it ends its `exited` carries a `PlaceOutcome`: `complete` when the
// run finished and delivered a record, `failed` for anything else, with the generation, the app's record or its code and
// message, and the models it used. No disk, no key. The app is app.ts, beside this file.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { localPlace } from "@parcha/pi-durable-disk";
import type { PlaceOutcome } from "@parcha/pi-durable-disk";

const base = join(process.cwd(), "place-outcome-run");
rmSync(base, { recursive: true, force: true });
console.log(`the runs are under ${base}`);

const app = fileURLToPath(new URL("./app.ts", import.meta.url));
const ended: Record<string, PlaceOutcome | undefined> = {};
for (const [name, env] of [["delivers", {}], ["gives up", { GIVE_UP: "1" }]] as const) {
  const root = join(base, name.replace(" ", "-"));
  const place = localPlace({ app })({ paths: { id: name.replace(" ", "-"), root, work: join(root, "work"), store: join(root, "store") } });
  const runner = await place.start({ gen: 1, env });
  const exit = await runner.exited; // the instance's exit, and its outcome
  await place.release();
  console.log(`${name}: exit ${exit.exit}, outcome ${JSON.stringify(exit.outcome)}`);
  ended[name] = exit.outcome;
}

const { delivers, "gives up": gaveUp } = ended;
const models = { lead: "faux-1" };
if (
  delivers?.status !== "complete" || delivers.generation !== 1 || JSON.stringify(delivers.record) !== '{"total":42}' || JSON.stringify(delivers.models) !== JSON.stringify(models) ||
  gaveUp?.status !== "failed" || gaveUp.code !== "GAVE_UP" || gaveUp.message !== "no total could be made" || JSON.stringify(gaveUp.models) !== JSON.stringify(models)
) {
  console.error(`not ok: ${JSON.stringify(ended)}`);
  process.exit(1);
}
console.log("ok: two runs, two outcomes: the one that delivered is complete with its record, the one that gave up is failed with its code and message, and both name the models they used");
