// A faux model whose run fails at its first request, in a process that cannot exit until the file EXIT_GATE names
// exists: its SIGTERM holds the process, so a test can start the next run while the failed one still has its place.
import { existsSync } from "node:fs";

process.on("SIGTERM", () => {
  const nap = new Int32Array(new SharedArrayBuffer(4));
  for (let i = 0; process.env.EXIT_GATE && !existsSync(process.env.EXIT_GATE) && i < 1_500; i++) Atomics.wait(nap, 0, 0, 20);
});

export default function reply(_context, faux) {
  return faux.message("", { stopReason: "error", errorMessage: "the provider refused the request" });
}
