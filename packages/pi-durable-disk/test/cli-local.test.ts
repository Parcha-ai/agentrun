// The CLI on a local directory (`run --dir`, `status --dir`): example 01's app, the one a disk's run loads, run with no
// disk and no key, to its end and across a kill -9; and the Archil flags refused beside --dir.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { main } from "../src/cli.ts";
import { currentBootId, procStartTicks } from "../src/hosts/local-host.ts";
import { processTableHooks, type ProcessTable } from "../src/process-table.ts";
import { scratchRoot } from "./_run-support.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const APP = fileURLToPath(new URL("../examples/01-durable-chat/app.ts", import.meta.url));
const MESSAGES = 8;

type Event = Record<string, unknown> & { event?: string };

/**
 * `node cli.ts <args>` as a group of its own, its stdout read as JSON lines (example 01's log); `until` may SIGKILL the group
 * at a line. Resolves on `close`, the group reaped (only a real pid: `kill(-0)` would be this process's own group).
 */
function cli(args: string[], options: { pace?: number; until?: (event: Event) => boolean; timeoutMs?: number; onEvent?: (event: Event) => void } = {}) {
  const child = spawn(process.execPath, [CLI, ...args], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CHAT_PACE_MS: String(options.pace ?? 20) },
  });
  const group = child.pid ?? 0;
  const killGroup = () => {
    if (!(group > 1)) return;
    try {
      process.kill(-group, "SIGKILL");
    } catch {
      // gone
    }
  };
  const events: Event[] = [];
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  createInterface({ input: child.stdout }).on("line", (line) => {
    try {
      const event = JSON.parse(line) as Event;
      events.push(event);
      options.onEvent?.(event);
      if (options.until?.(event)) killGroup();
    } catch {
      // not one of the app's lines
    }
  });
  const timer = setTimeout(killGroup, options.timeoutMs ?? 60_000);
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; events: Event[]; stderr: string }>((resolve) =>
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      killGroup();
      resolve({ code, signal, events, stderr });
    }),
  );
}

/** The transcript's bot lines from the `transcript` event, and how many times each message number was answered. */
function answers(events: Event[]): number[] {
  const lines = (events.find((e) => e.event === "transcript")?.lines as string[] | undefined) ?? [];
  const counts = Array(MESSAGES).fill(0) as number[];
  for (const line of lines) {
    const n = /^bot: Message (\d+) of \d+:/.exec(line)?.[1];
    if (n !== undefined) counts[Number(n) - 1]!++;
  }
  return counts;
}

describe("the CLI on a local directory", () => {
  it("runs a disk's app with --dir, no disk and no key, to its end; status --dir reads the sealed run", { timeout: 120_000 }, async () => {
    const dir = scratchRoot("cli-local");
    try {
      const root = join(dir.root, "chat");
      const run = await cli(["run", "--dir", root, "--app", APP]);
      assert.equal(run.code, 0, run.stderr);
      assert.ok(run.events.some((e) => e.event === "done" && e.generation === 1), run.stderr);
      assert.deepEqual(answers(run.events), Array(MESSAGES).fill(1), "every message answered once");
      const status = await cli(["status", "--dir", root]);
      assert.equal(status.code, 0, status.stderr);
      const report = status.events.at(-1) as { run: string; dir: string; runJson: { status: string; generation: number; sealedSeq: number | null }; holderStatus: string };
      assert.deepEqual([report.run, report.dir, report.runJson.status, report.runJson.generation, report.holderStatus], ["chat", root, "done", 1, "stopped"]);
      assert.equal(typeof report.runJson.sealedSeq, "number", "released and sealed");
    } finally {
      dir.remove();
    }
  });

  it("a kill -9 in the middle, then the same command again: the run resumes and every message is answered once", { timeout: 120_000 }, async () => {
    const dir = scratchRoot("cli-local-kill");
    try {
      const root = join(dir.root, "chat");
      const first = await cli(["run", "--dir", root, "--app", APP], { pace: 300, until: (e) => e.event === "answered" && e.n === 3 });
      assert.equal(first.signal, "SIGKILL", `the first instance was killed: ${first.code} ${first.stderr}`);
      assert.ok(!first.events.some((e) => e.event === "done"), "it did not finish");
      const killed = await cli(["status", "--dir", root]);
      assert.equal((killed.events.at(-1) as { holderStatus: string }).holderStatus, "stopped", "its lease is still fresh, but its process is gone");
      const second = await cli(["run", "--dir", root, "--app", APP]);
      assert.equal(second.code, 0, second.stderr);
      const open = second.events.find((e) => e.event === "open");
      assert.equal(open?.generation, 2, "the next generation");
      assert.ok(Number(open?.alreadyAnswered) >= 3, `it resumed with the answers already in the store: ${JSON.stringify(open)}`);
      assert.deepEqual(answers(second.events), Array(MESSAGES).fill(1), "every message answered once across both");
    } finally {
      dir.remove();
    }
  });

  it("a second run of the same directory while one holds it exits 76 (held), as on a disk", { timeout: 120_000 }, async () => {
    const dir = scratchRoot("cli-local-held");
    try {
      const root = join(dir.root, "chat");
      let opened!: () => void;
      const open = new Promise<void>((resolve) => (opened = resolve));
      let second: Awaited<ReturnType<typeof cli>> | undefined;
      // The first holds the run (slow messages); once it is open, a second run of the same directory is refused, and the
      // first is killed after it.
      const first = cli(["run", "--dir", root, "--app", APP], {
        pace: 2_000,
        onEvent: (e) => e.event === "open" && opened(),
        until: () => second !== undefined,
      });
      await open;
      const held = await cli(["status", "--dir", root]);
      assert.equal((held.events.at(-1) as { holderStatus: string }).holderStatus, "running", "status --dir sees the live holder");
      second = await cli(["run", "--dir", root, "--app", APP]);
      await first;
      assert.equal(second.code, 76, second.stderr);
      assert.match(second.stderr, /OWNER_LOCK_HELD/);
    } finally {
      dir.remove();
    }
  });

  it("status --dir knows a holder by its pid and start ticks, not its lease, and names the run as recorded", { timeout: 60_000 }, async () => {
    const dir = scratchRoot("cli-local-status");
    const live = spawn("sleep", ["60"], { stdio: "ignore" });
    try {
      const pid = live.pid ?? 0;
      const ticks = procStartTicks(pid)!;
      const runJson = (heartbeatAgoMs: number, startTicks: number) => ({
        run: "orders",
        status: "running",
        generation: 3,
        sealedSeq: null,
        wakeAt: null,
        holder: { driver: "local", host: hostname(), bootId: currentBootId(), pid, since: new Date().toISOString(), startTicks },
        heartbeatAt: new Date(Date.now() - heartbeatAgoMs).toISOString(),
        updatedAt: new Date().toISOString(),
        detail: null,
      });
      const report = async (record: object) => {
        const root = join(dir.root, "chat");
        mkdirSync(root, { recursive: true });
        writeFileSync(join(root, "run.json"), JSON.stringify(record));
        const status = await cli(["status", "--dir", root]);
        return status.events.at(-1) as { run: string; holderStatus: string };
      };
      // A run started with a lease longer than the default, between heartbeats: its holder is still the same process.
      const between = await report(runJson(200_000, ticks));
      assert.deepEqual([between.run, between.holderStatus], ["orders", "running"]);
      // A fresh heartbeat, but the pid now belongs to another process (other start ticks): the holder is gone.
      assert.equal((await report(runJson(0, ticks + 1))).holderStatus, "stopped");
      assert.equal((await report(runJson(0, ticks))).run, "orders", "the run's own id, not the directory's name");
      // --id reaches the record: a run opened with it is reported by it.
      const named = join(dir.root, "named");
      const run = await cli(["run", "--dir", named, "--id", "orders", "--app", APP]);
      assert.equal(run.code, 0, run.stderr);
      assert.equal(JSON.parse(readFileSync(join(named, "run.json"), "utf8")).run, "orders");
    } finally {
      live.kill("SIGKILL");
      dir.remove();
    }
  });

  it("status --dir says unknown, never gone or stopped, when this machine's process table cannot be read", async () => {
    const dir = scratchRoot("cli-local-unreadable");
    const root = join(dir.root, "chat");
    const holder = { driver: "local", host: hostname(), bootId: "boot-1", pid: 4242, since: new Date().toISOString(), startTicks: 77 };
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "run.json"), JSON.stringify({ run: "chat", status: "running", generation: 1, sealedSeq: null, wakeAt: null, holder, heartbeatAt: null, updatedAt: new Date().toISOString(), detail: null }));
    /** A table (as on macOS) whose boot read and listing fail or answer as asked. */
    const table = (boot: string | undefined, listing: "fails" | { start: number } | "gone"): ProcessTable => ({
      walkMs: 500,
      bootId: () => boot,
      snapshot() {
        if (listing === "fails") throw new Error("ps: cannot list processes");
        return { info: (pid) => (pid === 4242 && listing !== "gone" ? { ppid: 1, pgrp: 4242, start: listing.start } : undefined), children: () => [], marked: () => false, commandLine: () => "?" };
      },
    });
    const status = async (with_: ProcessTable) => {
      const out: string[] = [];
      const write = process.stdout.write;
      processTableHooks.table = with_;
      // Only the CLI's own lines: the test runner reports on this process's stdout too (Node 24 does, mid-test).
      process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
        if (typeof chunk === "string" && chunk.startsWith('{"at":')) return out.push(chunk) > 0;
        return (write as (...args: unknown[]) => boolean).call(process.stdout, chunk, ...rest);
      }) as typeof process.stdout.write;
      try {
        assert.equal(await main(["status", "--dir", root]), 0);
      } finally {
        process.stdout.write = write;
        processTableHooks.table = undefined;
      }
      assert.equal(out.length, 1, out.join(""));
      return (JSON.parse(out[0]!) as { holderStatus: string }).holderStatus;
    };
    try {
      assert.equal(await status(table(undefined, { start: 77 })), "unknown", "the boot cannot be read");
      assert.equal(await status(table("boot-1", "fails")), "unknown", "the processes cannot be listed");
      // What a read does tell
      assert.equal(await status(table("boot-1", { start: 77 })), "running");
      assert.equal(await status(table("boot-1", { start: 78 })), "stopped");
      assert.equal(await status(table("boot-1", "gone")), "stopped");
      assert.equal(await status(table("boot-2", "fails")), "gone", "another boot, whatever the listing");
    } finally {
      dir.remove();
    }
  });

  it("the app's factory runs once the claim is held, before this incarnation's run.json, and what it writes under ctx.root is in the run", async () => {
    const dir = scratchRoot("cli-factory");
    try {
      const run = join(dir.root, "run");
      const saw = join(dir.root, "saw");
      const r = spawnSync(process.execPath, [CLI, "run", "--dir", run, "--app", fileURLToPath(new URL("./fixtures/factory-on-claim.ts", import.meta.url))], { env: { ...process.env, FACTORY_SAW: saw }, encoding: "utf8", timeout: 60_000 });
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(JSON.parse(readFileSync(saw, "utf8")), { runJson: "absent", ownerLock: true, work: true }, "the claim was held (owner lock, layout) and nothing of the run published yet");
      assert.equal(readFileSync(join(run, "factory.txt"), "utf8"), "written by the factory\n");
    } finally {
      dir.remove();
    }
  });

  it("refuses --dir beside the Archil flags, with a usage error (exit 2) naming them", async () => {
    const written: string[] = [];
    const write = process.stderr.write;
    process.stderr.write = ((chunk: string) => (written.push(String(chunk)), true)) as typeof process.stderr.write;
    try {
      assert.equal(await main(["run", "--dir", "/tmp/x", "--disk", "dsk-1", "--app", "a.ts"]), 2);
      assert.equal(await main(["run", "--dir", "/tmp/x", "--region", "r", "--mount-root", "/mnt", "--app", "a.ts"]), 2);
      assert.equal(await main(["run", "--dir", "/tmp/x"]), 2, "run --dir needs --app");
      assert.equal(await main(["status", "--dir", "/tmp/x", "--disk", "dsk-1"]), 2);
    } finally {
      process.stderr.write = write;
    }
    assert.match(written.join(""), /--dir is a run on a local directory: it takes no --disk\n/);
    assert.match(written.join(""), /it takes no --region, --mount-root\n/);
  });
});
