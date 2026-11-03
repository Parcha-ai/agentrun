// The faux harness (faux-harness.mjs's script), with a start as slow as a real harness's on a relaunch: once the run's
// directory holds `slow-start`, loading this module, which the run's make() does before the reopen books and writes its
// cut requests (harness-app.ts onOpen), takes 2 s, asynchronously, as claude-agent's adapter does while it checks its CLI.
// The run's door serves meanwhile, so serve follows it, idle, when the reopen's entries land.
import { existsSync } from "node:fs";
import { join } from "node:path";

export { script } from "./faux-harness.mjs";

const at = process.argv.indexOf("--dir");
const dir = at < 0 ? undefined : process.argv[at + 1];
if (dir && existsSync(join(dir, "slow-start"))) await new Promise((resolve) => setTimeout(resolve, 2_000));
