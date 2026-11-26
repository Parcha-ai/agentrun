// Preloaded into the parent-watch shim (node --import): its spawn returns only once the file named by
// SPAWN_HELD_UNTIL exists. The shim's child runs meanwhile, so a test can signal the shim in the moment after it started
// its child and before its next line runs, as a loaded machine can leave it.
import { existsSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';

const childProcess = createRequire(import.meta.url)('node:child_process');
const spawn = childProcess.spawn;
const gate = process.env.SPAWN_HELD_UNTIL;
const tick = new Int32Array(new SharedArrayBuffer(4));
childProcess.spawn = (...args) => {
  const child = spawn(...args);
  // Synchronous, as the shim's own lines after spawn are: nothing of the shim runs until the gate opens. A hold that
  // runs out leaves <gate>.expired, so a test can tell its signal came after the hold rather than during it.
  for (const end = Date.now() + 25_000; gate && !existsSync(gate); Atomics.wait(tick, 0, 0, 10)) {
    if (Date.now() >= end) { writeFileSync(`${gate}.expired`, ''); break; }
  }
  return child;
};
syncBuiltinESMExports();
