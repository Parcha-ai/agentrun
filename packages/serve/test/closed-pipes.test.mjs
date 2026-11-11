// A stdout or stderr its reader closed loses the lines written after, never the process (closed-pipes.ts, which cli.ts
// calls first for every command). A child writes to both after its reader has destroyed them: with the guard it goes on
// and exits on its own; without it, the first write ends it (EPIPE), which is what killed a server whose terminal was
// piped to `head` once its runner wrote a line on stderr.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";

const MODULE = new URL("../dist/closed-pipes.js", import.meta.url).href;

/** A child that writes a line on stderr and on stdout after its reader closed both, then exits 0 if it is still alive. */
async function writesAfterClose(guarded) {
  const script = `
    const { surviveClosedPipes } = await import(${JSON.stringify(MODULE)});
    if (${guarded}) surviveClosedPipes();
    process.stdin.once("data", () => {
      console.error("a runner's line on stderr");
      process.stdout.write("a log line on stdout\\n");
      setTimeout(() => process.exit(0), 300);
    });`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["pipe", "pipe", "pipe"] });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  // The reader goes, as `head -n 1` does once it has its line, and only then does the child write.
  child.stdout.destroy();
  child.stderr.destroy();
  child.stdin.write("go\n");
  return exited;
}

test("with the guard, writes to a stdout and a stderr whose reader closed are lost and the process goes on", async () => {
  assert.deepEqual(await writesAfterClose(true), { code: 0, signal: null });
});

test("without it, the first such write ends the process: what the guard is for", async () => {
  const ended = await writesAfterClose(false);
  assert.notEqual(ended.code, 0, JSON.stringify(ended));
});
