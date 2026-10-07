// Holds a run's owner lock in a separate process until killed. Prints `held` once it has the lock, or exits 76. The
// handle is dropped and, under --expose-gc, collected before `held`: the lock must outlive its handle.
//   node --expose-gc test/fixtures/hold-owner-lock.ts <root>
import { exitCodeFor } from "../../src/errors.ts";
import { takeOwnerLock } from "../../src/run.ts";

try {
  takeOwnerLock(process.argv[2]!);
} catch (error) {
  process.stdout.write(`refused ${(error as { code?: string }).code}\n`);
  process.exit(exitCodeFor(error));
}
(globalThis as { gc?: () => void }).gc?.();
process.stdout.write("held\n");
setInterval(() => {}, 60_000);
