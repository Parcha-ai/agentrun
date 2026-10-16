// The app test/place.test.ts runs through `localPlace` (`run --dir --app`). Each incarnation writes `work/gen-<n>` with
// what its order said (PLACE_ORDER). Generation 1 starts a `sleep` in its own process group, writes its pid, and waits
// to be killed. A later one (or the first, with PLACE_FINISH) prints its outcome line, unless PLACE_SILENT, records
// `done` with the same record in its detail, and exits 0.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import type { AppContext, AppOptions } from "../../src/index.ts";

export default function app(where: AppContext): AppOptions {
  return {
    models: createModels(),
    registry: createRegistry(),
    async onOpen(run) {
      const order = process.env.PLACE_ORDER ?? "";
      writeFileSync(join(where.work, `gen-${run.generation}`), order);
      if (run.generation === 1 && !process.env.PLACE_FINISH) {
        const sleeper = spawn("sleep", ["300"], { stdio: "ignore" });
        writeFileSync(join(where.work, "sleeper.pid"), String(sleeper.pid));
        await new Promise(() => {});
      }
      const record = { order };
      if (!process.env.PLACE_SILENT) process.stdout.write(`${JSON.stringify({ outcome: { status: "complete", generation: run.generation, record } })}\n`);
      await run.setStatus("done", { record });
      await run.release();
      process.exit(0);
    },
  };
}
