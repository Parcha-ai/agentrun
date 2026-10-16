// An app whose factory looks at the run's directory and writes in it (as the reference child's starts its recorder):
// with the claim taken first, the directory is the run's (its owner lock taken, work/ made) and what it writes lands in
// the run, while this incarnation's run.json is not written yet. It records what it saw into FACTORY_SAW, then its
// onOpen ends the run.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import type { AppContext, AppOptions } from "../../src/index.ts";

export default function app(where: AppContext): AppOptions {
  const runJson = join(where.root, "run.json");
  const saw = {
    runJson: existsSync(runJson) ? String((JSON.parse(readFileSync(runJson, "utf8")) as { status?: unknown }).status) : "absent",
    ownerLock: existsSync(join(where.root, "owner.lock")),
    work: existsSync(where.work),
  };
  writeFileSync(process.env.FACTORY_SAW!, JSON.stringify(saw));
  writeFileSync(join(where.root, "factory.txt"), "written by the factory\n");
  return {
    models: createModels(),
    registry: createRegistry(),
    async onOpen(run) {
      await run.setStatus("done", {});
      await run.release();
      process.exit(0);
    },
  };
}
