// The instance's life after open (`serveUntilDone`): SIGTERM drains and releases, and the drain decides the exit code.
// The app's work rejects while the drain closes the Harness under it; that rejection must not end the instance before
// the release (and its unmount) is done: where the FUSE daemon dies with the instance (a container), an exit in the middle
// of the release leaves the run's delegation orphaned.
import { test } from "node:test";
import assert from "node:assert/strict";
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
