// The sudo stand-in's script (fixtures/sudo-stand-in.mjs) as concurrent fakes write it: never seen cut short. Box commands
// of two fakes, or two execs of one, set it up at once; each must find a whole script or none.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { scratch } from "./support.mjs";

const STAND_IN = new URL("./fixtures/sudo-stand-in.mjs", import.meta.url).href;

test("two writers setting up the stand-in at once: a reader finds its script whole or absent, never cut short, and it ends whole", async (t) => {
  const dir = await scratch(t);
  const script = join(dir, "sudo-bin", "sudo");
  // Each writer sets the stand-in up 300 times, as each box command of a fake does.
  const writer = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", `const { sudoStandIn } = await import(${JSON.stringify(STAND_IN)}); for (let i = 0; i < 300; i++) sudoStandIn(${JSON.stringify(dir)});`], { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`writer exited ${code}`))));
  });
  const writing = Promise.all([writer(), writer()]);
  let done = false;
  void writing.finally(() => (done = true));
  const seen = new Set();
  while (!done) {
    if (existsSync(script)) seen.add(readFileSync(script, "utf8").length);
    await new Promise((resolve) => setImmediate(resolve));
  }
  await writing;
  const whole = readFileSync(script, "utf8");
  assert.match(whole, /^#!\/bin\/sh\nprintf '%s\\n' "\$\*" >> '.*sudo\.calls'\nexit 97\n$/);
  assert.deepEqual([...seen].filter((length) => length !== whole.length), [], "no read found it cut short");
});
