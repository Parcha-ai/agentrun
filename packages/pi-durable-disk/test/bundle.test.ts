// The watchdog bundled into an app with esbuild (one file, the app's): its worker runs the source the module carries,
// not the app's bundle, and still kills a command past the lease deadline while the app's main thread is blocked.
// Needs an esbuild binary: PDA_ESBUILD=<path>, or `esbuild` resolvable from this package; skipped otherwise.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { alive, killQuietly, scratchRoot } from "./_run-support.ts";

function esbuildBinary(): string | undefined {
  if (process.env.PDA_ESBUILD) return process.env.PDA_ESBUILD;
  try {
    const bin = join(createRequire(import.meta.url).resolve("esbuild/package.json"), "..", "bin", "esbuild");
    return existsSync(bin) ? bin : undefined;
  } catch {
    return undefined;
  }
}

const ESBUILD = esbuildBinary();

describe("the watchdog in an app bundle", { skip: ESBUILD ? false : "no esbuild: set PDA_ESBUILD to an esbuild binary" }, () => {
  it("starts its worker from its own source, not the app, and kills a command past the deadline while the app is blocked", { timeout: 60_000 }, async () => {
    const dir = scratchRoot("bundle");
    let pid = 0;
    try {
      const bundle = join(dir.root, "app.mjs");
      const built = spawnSync(ESBUILD!, ["test/fixtures/bundle-consumer.ts", "--bundle", "--platform=node", "--format=esm", `--outfile=${bundle}`], { encoding: "utf8" });
      assert.equal(built.status, 0, built.stderr);
      const limitMs = 1_000;
      const marks = join(dir.root, "marks.jsonl");
      const app = spawn(process.execPath, [bundle, String(limitMs), marks], { stdio: ["ignore", "pipe", "inherit"] });
      const events: Array<Record<string, number>> = [];
      const exited = new Promise<number | null>((resolve) => app.once("exit", (code) => resolve(code)));
      const lines = createInterface({ input: app.stdout! });
      lines.on("line", (line) => events.push(JSON.parse(line)));
      while (!events.some((e) => e.pid !== undefined)) await new Promise((resolve) => setTimeout(resolve, 5));
      const { pid: commandPid, deadline } = events.find((e) => e.pid !== undefined)!;
      pid = commandPid!;
      while (alive(pid) && Date.now() < deadline! + 10_000) await new Promise((resolve) => setTimeout(resolve, 5));
      const killedAt = Date.now();
      assert.equal(alive(pid), false, "the command died");
      assert.ok(killedAt >= deadline! && killedAt < deadline! + 1_000, `killed ${killedAt - deadline!} ms past the deadline`);
      assert.equal(app.exitCode, null, "the app's main thread was still blocked");
      assert.equal(await exited, 0);
      const loaded = readFileSync(marks, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { loaded: number });
      assert.deepEqual(loaded, [{ loaded: 0 }], "the worker never ran the app's code");
      const result = events.find((e) => e.killed !== undefined)!;
      assert.ok(result.killed! >= 1 && result.lapsedAfterMs! > limitMs, JSON.stringify(result));
    } finally {
      killQuietly(pid);
      dir.remove();
    }
  });
});
