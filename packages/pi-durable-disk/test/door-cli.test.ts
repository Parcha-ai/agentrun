// The door hook through the CLI (`run --dir --app <module> --serve 0`): an app module whose factory returns `door`, a
// submit that reaches the hook in the real instance process, and every way the instance ends (a SIGTERM drain whose
// hook.abort never settles, a fence, a park) leaves none of the harness children the hook adopted alive.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { until } from "./_lifecycle.ts";
import { alive, killQuietly, scratchRoot, waitGone } from "./_run-support.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const APP = fileURLToPath(new URL("./fixtures/door-app.ts", import.meta.url));

/** The instance as its own process group; its stderr log lines as JSON. */
function instance(root: string, out: string, flags: string[], env: Record<string, string>) {
  const child = spawn(process.execPath, [CLI, "run", "--dir", root, "--app", APP, "--serve", "0", ...flags], {
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, PDA_TEST_OUT: out, ...env },
  });
  const events: Record<string, unknown>[] = [];
  let stderr = "";
  createInterface({ input: child.stderr! }).on("line", (line) => {
    stderr += `${line}\n`;
    try {
      events.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // not a log line
    }
  });
  const exited = new Promise<number | null>((resolve) => child.once("close", (code) => resolve(code)));
  const kill = () => {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      // gone
    }
  };
  return { child, events, exited, kill, stderr: () => stderr };
}

/** Start the instance, submit once through its door, and return the harness child the hook started. */
async function started(name: string, flags: string[], env: Record<string, string> = {}) {
  const dir = scratchRoot(name);
  const out = join(dir.root, "out");
  mkdirSync(out);
  const root = join(dir.root, "run");
  const it = instance(root, out, flags, env);
  const running = await until("the instance's serve address", () => it.events.find((e) => e.event === "running"), 30_000);
  const res = await fetch(new URL("/submit", running.serve as string), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestId: "cli-1", content: "hello" }),
  });
  const body = (await res.json()) as { status: string };
  assert.deepEqual([res.status, body.status], [200, "ACCEPTED"], it.stderr());
  const pid = Number(readFileSync(join(out, "child.pid"), "utf8"));
  assert.ok(alive(pid), "the hook's harness child runs");
  return { dir, root, it, pid };
}

describe("the door hook through the CLI", () => {
  it("a submit reaches the app's hook in the instance; SIGTERM with a stuck hook.abort drains, exits 0 and leaves no child", { timeout: 60_000 }, async () => {
    const s = await started("door-cli-term", [], { PDA_DOOR_BUSY: "1", PDA_DOOR_ABORT: "stuck" });
    try {
      process.kill(s.it.child.pid!, "SIGTERM");
      assert.equal(await s.it.exited, 0, s.it.stderr());
      assert.ok(s.it.events.some((e) => e.event === "released"), s.it.stderr());
      assert.ok(await waitGone(s.pid, 2_000), "no harness child outlives the instance");
    } finally {
      s.it.kill();
      killQuietly(s.pid);
      s.dir.remove();
    }
  });

  it("a fence (the lease lost: its heartbeat cannot be written) ends the hook's harness child before the exit 75", { timeout: 60_000, skip: process.getuid?.() === 0 && "root writes through a read-only directory" }, async () => {
    const s = await started("door-cli-fence", ["--heartbeat-ms", "100", "--lease-expiry-ms", "10000", "--lease-margin-ms", "2000"], { PDA_DOOR_BUSY: "1" });
    try {
      chmodSync(s.root, 0o555);
      assert.equal(await s.it.exited, 75, s.it.stderr());
      assert.ok(await waitGone(s.pid, 2_000), "no harness child acts on after the lease is lost");
    } finally {
      chmodSync(s.root, 0o755);
      s.it.kill();
      killQuietly(s.pid);
      s.dir.remove();
    }
  });

  it("a fence with a hook whose abort never settles kills the harness child at once: the lease is gone, so nothing waits on the hook", { timeout: 60_000, skip: process.getuid?.() === 0 && "root writes through a read-only directory" }, async () => {
    const s = await started("door-cli-fence-stuck", ["--heartbeat-ms", "100", "--lease-expiry-ms", "10000", "--lease-margin-ms", "2000"], { PDA_DOOR_BUSY: "1", PDA_DOOR_ABORT: "stuck" });
    try {
      const from = Date.now();
      chmodSync(s.root, 0o555);
      assert.equal(await s.it.exited, 75, s.it.stderr());
      assert.ok(Date.now() - from < 2_000, `the exit waited ${Date.now() - from} ms on the hook's abort`);
      assert.ok(await waitGone(s.pid, 500), "the harness child is gone with the exit");
    } finally {
      chmodSync(s.root, 0o755);
      s.it.kill();
      killQuietly(s.pid);
      s.dir.remove();
    }
  });

  it("a park (an idle run with --serve) ends the idle hook's harness child before the instance exits", { timeout: 60_000 }, async () => {
    const s = await started("door-cli-park", ["--park-threshold", "1s", "--park-idle", "300ms"]);
    try {
      assert.equal(await s.it.exited, 0, s.it.stderr());
      assert.ok(s.it.events.some((e) => e.event === "parked"), s.it.stderr());
      assert.ok(await waitGone(s.pid, 2_000), "no harness child outlives the parked instance");
    } finally {
      s.it.kill();
      killQuietly(s.pid);
      s.dir.remove();
    }
  });
});
