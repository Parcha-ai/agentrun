// examples/planned-move runs only with the keys it needs (an Archil scratch disk and Daytona) on a machine set up as a
// host; without them it skips. With them, the run moves from this machine to a Daytona box at step 2, with nothing
// revoked and nothing interrupted.
import { it } from "node:test";
import { assertExampleOk, runExample } from "./_run-example.ts";

const LIVE = process.env.PDA_LIVE === "1" && Boolean(process.env.ARCHIL_API_KEY && process.env.PDA_LIVE_DISK && process.env.DAYTONA_API_KEY);

it("planned-move: the run moves from host-a to a Daytona box at step 2, with no revoke and no interrupted call", { skip: !LIVE, timeout: 20 * 60_000 }, async () => {
  const run = await runExample("planned-move", { timeoutMs: 19 * 60_000, args: process.env.PDA_MOVE_PACKAGE ? ["--package", process.env.PDA_MOVE_PACKAGE] : [] });
  assertExampleOk(run, /^ok: the run moved from host-a to a Daytona box at step 2, with no revoke and no interrupted call \(/m);
});
