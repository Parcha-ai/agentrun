// The instance's life after open (`serveUntilDone`): SIGTERM drains and releases, and the drain decides the exit code.
// The app's work rejects while the drain closes the Harness under it; that rejection must not end the instance before
// the release (and its unmount) is done: where the FUSE daemon dies with the instance (a container), an exit in the middle
// of the release leaves the run's delegation orphaned.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { serveUntilDone } from "../src/cli.ts";
import { FencedError } from "../src/errors.ts";
import type { DurableRun } from "../src/run.ts";

function fakeRun(releaseMs: number) {
  const steps: string[] = [];
  let closed: () => void = () => {};
  const harnessClosed = new Promise<void>((resolve) => (closed = resolve));
  const run = {
    record: { status: "running" },
    async setStatus(status: string) {
      steps.push(`status ${status}`);
    },
    async release() {
      steps.push("close");
      closed();
      await new Promise((r) => setTimeout(r, releaseMs));
      steps.push("unmounted");
    },
  };
  return { run: run as unknown as Pick<DurableRun, "setStatus" | "release" | "record">, steps, harnessClosed };
}

/** A run as the real one behaves once released: `releasing` is true, a second release is a no-op, and the Harness is closed under a status write. */
function releasedRun() {
  const steps: string[] = [];
  let released = false;
  const run = {
    record: { status: "running" },
    get releasing() {
      return released;
    },
    async setStatus(status: string) {
      if (released) throw new Error("Session is closed");
      steps.push(`status ${status}`);
    },
    async release() {
      if (released) return;
      steps.push("release");
      released = true;
    },
  };
  return { run: run as unknown as Pick<DurableRun, "setStatus" | "release" | "record">, steps };
}
const within = <T>(promise: Promise<T>, ms: number, what: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([promise, new Promise<never>((_, reject) => void (timer = setTimeout(() => reject(new Error(`${what}: not settled in ${ms} ms`)), ms)))]).finally(() => clearTimeout(timer));
};

test("an app that releases the run in onOpen and returns ends the instance: exit 0 at once, the release done once", async () => {
  const { run, steps } = releasedRun();
  const events: string[] = [];
  const signals = new EventEmitter();
  const exit = serveUntilDone(run, async (opened) => void (await opened.release()), "resume", (e) => events.push(e), signals);
  // A failing run of this test must not leave the instance's keep-alive timer holding the test process: stop it.
  exit.catch(() => {});
  try {
    assert.equal(await within(exit, 2_000, "an instance whose run was released by its app"), 0);
  } finally {
    signals.emit("SIGTERM");
  }
  assert.deepEqual(steps, ["release"], "no second release, no status written to the closed session");
  assert.deepEqual(events, ["released"]);
});

test("a stop after the app released the run is a clean exit 0: no wake written to the closed session, no failure", async () => {
  const { run, steps } = releasedRun();
  const signals = new EventEmitter();
  const events: string[] = [];
  const exit = serveUntilDone(run, async (opened) => { await opened.release(); await new Promise(() => {}); }, "resume", (e) => events.push(e), signals);
  await new Promise((r) => setTimeout(r, 50));
  signals.emit("SIGTERM");
  try {
    assert.equal(await within(exit, 2_000, "a stop after a release"), 0);
  } finally {
    signals.emit("SIGINT");
  }
  assert.deepEqual(steps, ["release"]);
  assert.deepEqual(events, ["draining", "released"], "not `release failed`");
});

test("a drain is not cut short by the app's work rejecting when the Harness closes under it", async () => {
  const { run, steps, harnessClosed } = fakeRun(200);
  const signals = new EventEmitter();
  const events: string[] = [];
  // The app's loop: commits until the Harness is closed, then its next commit rejects.
  const onOpen = async () => {
    await harnessClosed;
    throw new Error("Session is closed");
  };
  const exit = serveUntilDone(run, onOpen, "resume", (e) => events.push(e), signals);
  signals.emit("SIGTERM");
  assert.equal(await exit, 0);
  assert.deepEqual(steps, ["status sleeping", "close", "unmounted"], "the release ran to its end");
  assert.deepEqual(events, ["draining", "released"], "no app failure was reported");
});

test("without a drain, an app whose onOpen rejects fails the instance (exit 1); a failed release decides the drain's code", async () => {
  const signals = new EventEmitter();
  const failing = serveUntilDone(fakeRun(0).run, async () => Promise.reject(new Error("boom")), "resume", () => {}, signals);
  assert.equal(await failing, 1);
  const { run } = fakeRun(0);
  (run as { release(): Promise<void> }).release = async () => {
    throw new FencedError("revoked");
  };
  const drained = serveUntilDone(run, () => new Promise(() => {}), "pause", () => {}, signals);
  signals.emit("SIGINT");
  assert.equal(await drained, 75);
});

test("an instance with nothing to do stays up until it is stopped: serveUntilDone holds the event loop until it settles", async () => {
  // A process of its own: idle, no server, nothing running (the run's own timers are unref'd). It must neither exit by
  // itself nor skip the release.
  const child = spawn(process.execPath, [new URL("./fixtures/idle-instance.ts", import.meta.url).pathname], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_NO_WARNINGS: "1" } });
  let out = "";
  child.stdout!.setEncoding("utf8").on("data", (c: string) => void (out += c));
  const ended = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  for (const t0 = Date.now(); !out.includes("up\n") && Date.now() - t0 < 10_000; ) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 1_000));
  assert.equal(child.exitCode, null, `still up a second later (output: ${JSON.stringify(out)})`);
  child.kill("SIGTERM");
  assert.equal(await ended, 0);
  assert.deepEqual(out.trim().split("\n"), ["up", "draining", "status sleeping", "release", "released", "exit 0"]);
});
