// The backstop a real-chrome test relies on when it makes its Chrome profile root with the shared scratch: the directory
// is registered in `made` so the runner's preload sweeps it even if the test's own teardown threw (a process outliving
// its bounded wait), and its removal is scheduled LAST, after every other cleanup, killing a process still naming the
// directory before it removes it. A profile root made with a bare mkdtemp has neither: it is not in `made`, and a
// teardown that throws leaves it under the runner's temp directory — the leak the preload reports as
// "left behind ... files-chrome-*". These guard the contract the browser_files fix now depends on, with no real Chrome.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import test from "node:test";
import { killNaming, made, processesNaming, scratch } from "./fixtures/scratch.mjs";

/** A detached process that names `dir` (through its environment) until killed, as a Chrome slow to exit would. */
function holder(dir) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { env: { ...process.env, HOLD_DIR: dir }, detached: true, stdio: "ignore" });
  child.unref();
  return child;
}
const named = (dir) => processesNaming(dir).filter((p) => p.pid !== process.pid);
const settle = async (ok, ms = 3000) => { for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 20))) if (ok()) return true; return ok(); };

test("the shared scratch registers its dir for the preload backstop and its removal kills a process still naming it, then removes it", async (t) => {
  const dir = await scratch(t, "files-chrome-shared-");
  assert.ok(made.has(dir), "the shared scratch registers the dir in `made`, so the preload backstops it");
  const child = holder(dir);
  assert.ok(await settle(() => named(dir).some((p) => p.pid === child.pid)), "a process names the dir, as a Chrome left up would");
  // The removeLast hook's work, driven here: kill whatever names the dir (rounds), then remove it. Nothing is left.
  for (let round = 0; round < 40 && killNaming(dir, [process.pid]).length > 0; round += 1) await new Promise((r) => setTimeout(r, 50));
  assert.ok(await settle(() => named(dir).length === 0), "the process naming the dir is killed");
  await fs.promises.rm(dir, { recursive: true, force: true });
  assert.ok(!fs.existsSync(dir), "the dir is removed, no leak");
});
