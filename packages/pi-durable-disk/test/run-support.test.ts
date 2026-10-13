// The tests' own helpers. killQuietly runs in cleanups where the pid may never have been learned (a test that failed early
// still holds its `let pid = 0`): it must signal one real process or nothing, never a process group.
import { it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { killQuietly } from "./_run-support.ts";

it("killQuietly signals only a real pid: 0 (this process's whole group), -1 (every process the user may signal), NaN and fractions are refused", () => {
  const sent: [number, string | number | undefined][] = [];
  const real = process.kill;
  process.kill = ((pid: number, signal?: string | number) => {
    sent.push([pid, signal]);
    return true;
  }) as typeof process.kill;
  try {
    for (const pid of [0, -0, -1, -12345, Number.NaN, 1.5, Number.POSITIVE_INFINITY]) killQuietly(pid);
    killQuietly(4_000_000);
  } finally {
    process.kill = real;
  }
  assert.deepEqual(sent, [[4_000_000, "SIGKILL"]]);
});

it("a cleanup that never learned its pid leaves its own process group alone", { timeout: 20_000 }, async () => {
  // a child leading a group of its own calls killQuietly(0), as a failed test's finally does: on a helper that passes 0 to
  // process.kill the child kills its own group, itself, before it can say anything
  const helper = new URL("./_run-support.ts", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `import { killQuietly } from ${JSON.stringify(helper)}; killQuietly(0); process.stdout.write("still here");`], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout!.on("data", (chunk: Buffer) => void (out += String(chunk)));
  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => child.on("close", (c, s) => resolve([c, s])));
  assert.deepEqual({ code, signal, out }, { code: 0, signal: null, out: "still here" });
});
