// Child of the real-fault test: run under a file-size limit (SIGXFSZ ignored), so the kernel fails a write with EFBIG
// and node:sqlite reports SQLITE_IOERR_WRITE. Prints one JSON line describing what the facade did.
import { openArchilStore, StoreFencedError } from "../../src/store.ts";
import { entryCommitter, ctx } from "../_support.ts";

/** The error's class and the result codes it carries, directly or as aggregate members. */
const describe = (error: unknown): unknown => ({
  name: (error as Error | undefined)?.constructor?.name,
  errcode: (error as { errcode?: number } | undefined)?.errcode,
  members: error instanceof AggregateError ? error.errors.map(describe) : undefined,
});

const [file, profile] = process.argv.slice(2) as [string, "exclusive" | "shared"];
let fencedCallbacks = 0;
const store = await openArchilStore(file, profile, { onFenced: () => void fencedCallbacks++ });
const writer = entryCommitter(store.storage, 2000);
await writer.setup();

const outcome: Record<string, unknown> = { committed: 0 };
for (let n = 0; n < 5000 && outcome.firstError === undefined; n++) {
  try {
    await writer.commit(n);
    outcome.committed = n + 1;
  } catch (error) {
    outcome.firstError = {
      typed: error instanceof StoreFencedError,
      name: (error as Error).name,
      errcode: (error as StoreFencedError).errcode,
      cause: describe((error as Error).cause),
    };
  }
}
outcome.fenced = store.database.fenced;
outcome.callbacks = fencedCallbacks;
try {
  await store.storage.commit([], ctx);
  outcome.laterCall = "resolved";
} catch (error) {
  outcome.laterCall = { typed: error instanceof StoreFencedError, same: error === store.database.fencedBy };
}
process.stdout.write(`${JSON.stringify(outcome)}\n`);
process.exit(0);
