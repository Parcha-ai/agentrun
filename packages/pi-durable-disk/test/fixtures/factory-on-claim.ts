// An app whose factory looks at the run's directory and writes in it (as the reference child's starts its recorder):
// with the claim taken first, run.json is already there, `running`, and what it writes lands in the run. It records
// what it saw of run.json into FACTORY_SAW, then its onOpen ends the run.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import type { AppContext, AppOptions } from "../../src/index.ts";

export default function app(where: AppContext): AppOptions {
  const runJson = join(where.root, "run.json");
  const saw = existsSync(runJson) ? String((JSON.parse(readFileSync(runJson, "utf8")) as { status?: unknown }).status) : "absent";
  writeFileSync(process.env.FACTORY_SAW!, saw);
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
