// A faux model whose runs answer, in a process that cannot exit while the file EXIT_GATE names is missing: its SIGTERM
// holds the process, so a test can keep an answered run's place held while other requests wait for it.
import { existsSync } from "node:fs";

process.on("SIGTERM", () => {
  const nap = new Int32Array(new SharedArrayBuffer(4));
  for (let i = 0; process.env.EXIT_GATE && !existsSync(process.env.EXIT_GATE) && i < 1_500; i++) Atomics.wait(nap, 0, 0, 20);
});

export default function reply(_context, faux) {
  return faux.message("Done.");
}
