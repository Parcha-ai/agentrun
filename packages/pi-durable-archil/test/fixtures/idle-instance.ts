// An instance with nothing to do: `serveUntilDone` over a run whose release is recorded, no app, no work, no server. It
// prints each event and `exit <code>` once the instance is done. Used by test/drain.test.ts.
import { serveUntilDone } from "../../src/cli.ts";
import type { DurableRun } from "../../src/run.ts";

const run = {
  record: { status: "running" },
  async setStatus(status: string) {
    process.stdout.write(`status ${status}\n`);
  },
  async release() {
    process.stdout.write("release\n");
  },
} as unknown as Pick<DurableRun, "setStatus" | "release" | "record">;

process.stdout.write("up\n");
const code = await serveUntilDone(run, undefined, "resume", (event) => process.stdout.write(`${event}\n`));
process.stdout.write(`exit ${code}\n`);
process.exitCode = code;
