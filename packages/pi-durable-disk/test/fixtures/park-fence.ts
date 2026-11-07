// A run on a local directory whose model fails once with a long retry wait, parked with a 300 ms threshold, where every
// write of its record with the `sleeping` status fails as an I/O error: with the default onFenced it must exit 75
// without releasing. Prints
// `{"submission":<id>}` once the input is admitted.
//   node test/fixtures/park-fence.ts <root>
import { watchParking } from "../../src/park.ts";
import { openDurableRun, RUN_STATUS_TABLE } from "../../src/run.ts";
import { ctx, fakeClaim, localClaimDir } from "../_run-support.ts";
import { lifecycleApp, newCounters } from "../_lifecycle.ts";

const root = process.argv[2]!;
const ref = { disk: "dsk-local", region: "local", id: "park-1" };
const app = lifecycleApp(newCounters(), { retryMs: 1_200 });
const run = await openDurableRun(ref, {
  acquire: async () => fakeClaim(root, ref, { release: async () => void process.stdout.write(`${JSON.stringify({ released: true })}\n`) }),
  claimDir: localClaimDir,
  harness: app,
  decorateStore: (database) =>
    new Proxy(database, {
      get(target, key, receiver) {
        if (key === "run") {
          return (sql: string, ...params: unknown[]) =>
            sql.includes(RUN_STATUS_TABLE) && String(params[0]).includes('"status":"sleeping"')
              ? Promise.reject(Object.assign(new Error("disk I/O error"), { errcode: 10, errstr: "disk I/O error" }))
              : target.run(sql, ...(params as Parameters<typeof target.run>[1][]));
        }
        const value = Reflect.get(target, key, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
});
watchParking(run, { thresholdMs: 300 });
const conversation = await run.harness.root(ctx, { agent: app.agent });
const submission = await conversation.submit({ type: "input", content: "flaky" }, ctx);
process.stdout.write(`${JSON.stringify({ submission: submission.id })}\n`);
