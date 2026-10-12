// remote-local's teardown: a remote host a start is still spawning is never left running. A test's server stops its run
// and closes the cloud host while the run's move is still starting the remote host; under load that start can resume after
// both and spawn a host nobody stops, which keeps the test's process alive (the request-file test, held open for minutes).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { REMOTE_LOCAL, remoteLocalHost } from "../pipe/remote-local.ts";
import type { RunRef } from "@parcha/pi-durable-disk";
import type { Invite } from "../pipe/server.ts";

/** Each test's remote hosts make their directories under its own TMPDIR, so what is left running can be found (and killed). */
async function withTmp<T>(use: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "pda-rl-test-"));
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = dir;
  try {
    return await use(dir);
  } finally {
    if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved;
    spawnSync("pkill", ["-KILL", "-f", dir]); // never leave one behind, even when an assertion failed
    rmSync(dir, { recursive: true, force: true });
  }
}
const running = (dir: string) => spawnSync("pgrep", ["-f", dir]).stdout.toString().trim() !== "";
const ref = (id: string) => ({ id }) as unknown as RunRef;
const invite = (run: string): Invite => ({ t: "invite", run, token: "x", tab: "t" });
const timers = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;

describe("remote-local: a start that teardown overtakes", () => {
  it("a host closed while a start is on its way: the start fails and no remote host is left running", async () => {
    await withTmp(async (dir) => {
      const host = remoteLocalHost();
      const start = host.startRemote!(ref("r1"), REMOTE_LOCAL.id, invite("r1"));
      await host.close!(); // before the start has spawned its host
      const outcome = await start.then((s) => { s.socket.close(); return "started"; }, (e: Error) => e.message);
      assert.match(outcome, /closed/, "a closed host does not start a remote host");
      assert.equal(running(dir), false, "no remote host is left running");
    });
  });

  it("a stop that arrives while a start is on its way: the start fails and no remote host is left running", async () => {
    await withTmp(async (dir) => {
      const host = remoteLocalHost();
      const start = host.startRemote!(ref("r2"), REMOTE_LOCAL.id, invite("r2"));
      await host.stopRemote!(ref("r2")); // the run was stopped before its host came up
      const outcome = await start.then((s) => { s.socket.close(); return "started"; }, (e: Error) => e.message);
      assert.match(outcome, /stopped/, "a stopped run's host is not started");
      assert.equal(running(dir), false, "no remote host is left running");
      await host.close!();
    });
  });

  it("a start the server gives up on (its signal aborts) fails, and no remote host is left running", async () => {
    await withTmp(async (dir) => {
      const host = remoteLocalHost();
      const giveUp = new AbortController();
      const start = host.startRemote!(ref("r4"), REMOTE_LOCAL.id, invite("r4"), giveUp.signal);
      giveUp.abort();
      const outcome = await start.then((s) => { s.socket.close(); return "started"; }, (e: Error) => e.message);
      assert.match(outcome, /given up/, "an aborted start does not hand over a remote host");
      assert.equal(running(dir), false, "no remote host is left running");
      await host.close!();
    });
  });

  it("a start whose host is stopped before it listens leaves no timer behind", async () => {
    await withTmp(async (dir) => {
      // a child that stays up and never listens, so only its exit can end the start's wait for it
      const script = join(dir, "never-listens.mjs");
      writeFileSync(script, "setInterval(() => {}, 1000);\n");
      const host = remoteLocalHost({ script });
      const before = timers();
      let settled = false;
      const start = host.startRemote!(ref("r3"), REMOTE_LOCAL.id, invite("r3"));
      start.then(() => (settled = true), () => (settled = true));
      while (!running(dir)) await new Promise((r) => setTimeout(r, 20));
      assert.equal(settled, false, "the start is still waiting for its host to listen");
      assert.equal(timers(), before + 1, "the start's 30 s listening deadline is armed");
      await host.stopRemote!(ref("r3"));
      await start.then((s) => s.socket.close(), () => undefined);
      assert.equal(timers(), before, "the start's 30 s listening deadline is cleared, not left to hold the process open");
      await host.close!();
    });
  });
});
