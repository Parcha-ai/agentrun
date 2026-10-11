// A stop (SIGTERM) during live mode's startup ends the waits at once and still runs the cleanup: the box can take minutes to be ready, and a
// stop in that time must not leave the servers and the run's tree behind.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const live = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "live.mjs");

test("SIGTERM while live mode is still starting exits cleanly after running its cleanup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "live-stop-"));
  try {
    // A stand-in for the disk's credential wrapper: it runs nothing and says the run's tree is clean, at once.
    const wrapper = join(dir, "with-archil");
    writeFileSync(wrapper, '#!/bin/sh\necho \'{"id":"walks-home","tree":{"objects":0}}\'\n');
    chmodSync(wrapper, 0o755);
    const note = join(dir, "note.txt");
    writeFileSync(note, "a note\n");
    const child = spawn(process.execPath, [live, "--gpu-image", "im-test", "--gpu-note-file", note, "--port", "0"], {
      env: { ...process.env, WITH_ARCHIL: wrapper, TAB_DIR: dir, HOME: dir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    // Live is in its settling wait before it starts any server (the object store settles its deletes for 10 s); the stop comes during it.
    for (const end = Date.now() + 20_000; !out.includes("the run's tree before the take"); await new Promise((r) => setTimeout(r, 50))) {
      if (Date.now() > end) throw new Error(`live never reached its first step: ${out}`);
    }
    const stoppedAt = Date.now();
    child.kill("SIGTERM");
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
    assert.equal(exit.signal, null, `it ran its own shutdown, it was not killed by the signal: ${out}`);
    assert.equal(exit.code, 0, out);
    assert.match(out, /LIVE: stopped while starting/);
    assert.match(out, /the run's tree after live/, "the cleanup ran");
    assert.ok(Date.now() - stoppedAt < 15_000, "the stop did not wait out the ten second settle and the box");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
