// Preloaded with --import while the repository's tests run: every import of the DSL's
// public entry point is served by capture-dsl.mjs, which records the workflows passed to
// validateWorkflow, runWorkflow, runWorkflowSlice and dryRunWorkflow. The hooks run in the
// test's own thread: off-thread ones (module.register) made a DSL test file about a third slower.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { REACHED, resolve } from "./capture-hooks.mjs";
registerHooks({ resolve });
// The marker says the hook reached a process of this shard, which a shard whose files validate no workflow would not
// otherwise show (collect.mjs --captures). Its content is never read, so concurrent writers need no rename. A failed write
// leaves no marker, and the collector then fails the shard.
const directory = process.env.LEAN_SWEEP_DIR;
if (directory) {
  const marker = join(directory, REACHED);
  try { if (!existsSync(marker)) { mkdirSync(directory, { recursive: true }); writeFileSync(marker, ""); } } catch { /* see above */ }
}
