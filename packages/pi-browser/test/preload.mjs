// scripts/test.mjs imports this into each of the package's test file processes.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";
import { CHROME_SINGLETON, made, processesNaming } from "./fixtures/scratch.mjs";

// Chrome binds its singleton socket under TMPDIR and aborts past 107 bytes, so the root stays short whatever TMPDIR was.
const root = fs.mkdtempSync(path.join(fs.existsSync("/tmp") ? "/tmp" : os.tmpdir(), `pib-${process.pid}-`));
const keeper = spawn(process.execPath, [path.join(import.meta.dirname, "fixtures", "keeper.mjs"), root], { detached: true, stdio: ["pipe", "ignore", "ignore"] });
keeper.unref();
keeper.stdin.unref();
process.env.TMPDIR = root;

after(async () => {
  const alive = () => processesNaming(root).filter((p) => p.pid !== process.pid && p.pid !== keeper.pid);
  // A released Chrome takes a few hundred milliseconds to exit.
  let left = alive();
  for (const end = Date.now() + 5_000; left.length > 0 && Date.now() < end; left = alive()) await new Promise((resolve) => setTimeout(resolve, 100));
  // Once nothing runs: Chrome's singleton socket directories (left on any exit, a clean one included) go, and so does a
  // scratch directory that a teardown outliving its test made again.
  if (left.length === 0) {
    for (const name of fs.readdirSync(root)) if (CHROME_SINGLETON.test(name)) fs.rmSync(path.join(root, name), { recursive: true, force: true });
    for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
  }
  const entries = fs.readdirSync(root, { recursive: true }).slice(0, 40);
  if (entries.length > 0 || left.length > 0) {
    throw new Error(`this file's tests left behind, under ${root}: ${JSON.stringify({ entries, processes: left.map((p) => `${p.pid} ${p.cmd.slice(0, 160)}`) })}`);
  }
});
