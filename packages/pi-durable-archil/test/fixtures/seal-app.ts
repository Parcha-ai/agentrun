// An app module for `pi-durable-archil run --app` in the live suite: plays an instance that cannot go on with its store
// and that no restart can fix. It marks the run failed with the code, releases (seal, unmount) and exits: 65 for a store
// behind its seal (STORE_BEHIND_SEAL), 70 for a store head it cannot read (STORE_HEAD_UNREADABLE). $PDA_TEST_EXIT picks.
import type { AppOptions } from "../../src/app.ts";
import { scriptedHarness } from "../_run-support.ts";

export default async function app(): Promise<AppOptions> {
  const scripted = scriptedHarness();
  const exit = Number(process.env.PDA_TEST_EXIT ?? "65");
  const detail: Record<string, string | number> = exit === 70 ? { code: "STORE_HEAD_UNREADABLE" } : { code: "STORE_BEHIND_SEAL", sealedSeq: 812, head: 811 };
  return {
    models: scripted.models,
    registry: scripted.registry,
    async onOpen(run) {
      await run.setStatus("failed", detail);
      await run.release();
      process.exit(exit);
    },
  };
}
