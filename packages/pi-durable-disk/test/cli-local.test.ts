// The CLI on a local directory (`run --dir`, `status --dir`): example 01's app, the one a disk's run loads, run with no
// disk and no key, to its end and across a kill -9; and the Archil flags refused beside --dir.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { main } from "../src/cli.ts";
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
      second = await cli(["run", "--dir", root, "--app", APP]);
      await first;
      assert.equal(second.code, 76, second.stderr);
      assert.match(second.stderr, /OWNER_LOCK_HELD/);
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
