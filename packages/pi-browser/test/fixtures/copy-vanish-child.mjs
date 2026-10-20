// Two ways to make a file vanish while copyProfile handles it, counting the errors that reach the process as uncaught exceptions (an orphan stream whose error event
// nobody listens for ends here as one). Prints one JSON line.
//   stress <rounds> <files>: copies a directory of many files while every one of them is removed as the copy starts.
//   controlled: removes ONE file the copy has listed, at the moment the copy asks for its mode (stat): the window the stress run only sometimes reaches.
import fs from "node:fs";
import fsp from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";

const uncaught = [];
process.on("uncaughtException", (error) => { uncaught.push(`${error?.code ?? error?.name}: ${String(error?.message ?? error).replace(/\/[^\s'"]+/g, "<path>")}`); });
process.on("unhandledRejection", (error) => { uncaught.push(`rejection ${error?.code ?? error?.name}`); });
const mode = process.argv[2] ?? "stress";
const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cv-"));

if (mode === "controlled") {
  // The file named `victim` is deleted synchronously inside the stat call that copyProfile makes for it, before anything else can run: whatever the copy has
  // created for that file by then (a read stream whose open is still queued) finds it gone.
  const real = createRequire(import.meta.url)("node:fs/promises");
  const originalStat = real.stat;
  real.stat = (target, ...rest) => { if (path.basename(String(target)) === "victim") fs.rmSync(target, { force: true }); return originalStat(target, ...rest); };
  syncBuiltinESMExports();
}
const { copyProfile } = await import("../../dist/providers/cdp.js");

let failed = null;
let result;
try {
  if (mode === "controlled") {
    const from = path.join(root, "from");
    await fsp.mkdir(from, { recursive: true });
    await Promise.all(["a", "victim", "z"].map((name) => fsp.writeFile(path.join(from, name), `content of ${name}`)));
    try { await copyProfile(from, path.join(root, "to")); } catch (error) { failed = `${error?.code ?? error?.name}`; }
    await new Promise((resolve) => setTimeout(resolve, 100));
    const copied = (await fsp.readdir(path.join(root, "to")).catch(() => [])).sort();
    result = { mode, copied, copyFailed: failed };
  } else {
    const rounds = Number(process.argv[3] ?? 12);
    const files = Number(process.argv[4] ?? 1500);
    for (let round = 0; round < rounds; round += 1) {
      const from = path.join(root, `from${round}`);
      await fsp.mkdir(from, { recursive: true });
      const names = Array.from({ length: files }, (_, i) => path.join(from, `file${i}`));
      await Promise.all(names.map((file, i) => fsp.writeFile(file, `content ${i}`)));
      await fsp.writeFile(path.join(from, "kept"), "stays");
      const copied = copyProfile(from, path.join(root, `to${round}`));
      await Promise.all(names.map((file) => fsp.rm(file, { force: true })));
      try { await copied; } catch (error) { failed = `${error?.code ?? error?.name}`; }
      // An orphan stream's failed open arrives a little later than the copy returns.
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    result = { mode, rounds, files, copyFailed: failed };
  }
} finally {
  await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
}
console.log(JSON.stringify({ ...result, uncaught: uncaught.length, sample: uncaught.slice(0, 2) }));
