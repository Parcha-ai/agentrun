// An app module for `pi-durable-disk run --app` with a door hook: the lifecycle app's Harness options, and a hook whose
// submit starts the "harness child" (`sleep 600`, its own process group), adopts it, writes its pid to
// $PDA_TEST_OUT/child.pid, and takes the input. Used by test/door-cli.test.ts.
//   PDA_DOOR_BUSY   "1": the hook stays busy after it takes the input (default idle)
//   PDA_DOOR_ABORT  "stuck": hook.abort never settles (default it answers "aborted")
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppContext, AppOptions } from "../../src/app.ts";
import { lifecycleApp, newCounters } from "../_lifecycle.ts";

export default async function app(_where: AppContext): Promise<AppOptions> {
  const harness = lifecycleApp(newCounters());
  let busy = false;
  return {
    models: harness.models,
    registry: harness.registry,
    settings: harness.settings,
    root: { agent: harness.agent },
    door: {
      async submit(_input, ctx) {
        const child = spawn("sleep", ["600"], { detached: true, stdio: "ignore" });
        child.unref();
        ctx.adopt(child.pid!);
        writeFileSync(join(process.env.PDA_TEST_OUT!, "child.pid"), String(child.pid));
        busy = process.env.PDA_DOOR_BUSY === "1";
        return { accepted: true };
      },
      abort: () => (process.env.PDA_DOOR_ABORT === "stuck" ? new Promise(() => {}) : Promise.resolve("aborted")),
      busy: () => busy,
    },
  };
}
