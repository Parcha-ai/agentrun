// The pipe transport on a local directory: a RunPipe holds the run (03's local claim), two real runners
// (universe-remote.ts as processes) stand in for two machines. A takeover attaches the spare, which resumes from the
// last checkpoint written through the pipe; the replaced runner, frozen and then thawed, lands nothing and leaves; the
// seal drains the writer and releases the pipe, so run.json is sealed paused.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { FencedError, openClaimDir, type AcquireOptions, type Claim, type RunRef } from "@parcha/pi-durable-disk";
import { ModelProxy } from "../../../03-tab-to-cloud/pipe/model-proxy.ts";
import type { Control, Machine, Progress } from "../multiverse.ts";
import { pipePlacement } from "../pipe.ts";

const here = dirname(fileURLToPath(import.meta.url));
/** The runner under test: the source, or a bundle (UNIVERSE_TEST_RUNNER) to check what a box runs. */
const RUNNER = process.env.UNIVERSE_TEST_RUNNER ?? join(here, "..", "universe-remote.ts");

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

/** A claim on a plain directory (03's test/_local.ts): no mount, the barrier a no-op until fenced. */
function localClaim(root: string, opts: AcquireOptions): Claim {
  const runRoot = join(root, "runs", opts.ref.id);
  mkdirSync(runRoot, { recursive: true });
  let fenced: unknown;
  return {
    ref: opts.ref,
    disk: opts.ref.disk,
    root: runRoot,
    work: join(runRoot, "work"),
    store: join(runRoot, "store"),
    reused: false,
    forced: false,
    timings: { mountMs: 0, verifyMs: 0 },
    get fenced() {
      return fenced !== undefined;
    },
    markFenced(cause?: unknown) {
      fenced ??= cause ?? true;
    },
    async barrier() {
      if (fenced !== undefined) throw new FencedError("fenced (local claim)");
      return { ms: 0 };
    },
    async release() {
      return { via: "none" as const };
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(what: string, check: () => T | undefined | null | false, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = check();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

/** A runner process as a machine: its own port, bearer and work directory; its output collected. */
async function machine(root: string, name: string): Promise<{ m: Machine; child: ChildProcess; out: string[]; address: { url: string; bearer: string } }> {
  const port = await freePort();
  const bearer = `bearer-${name}`;
  const tokenFile = join(root, `${name}.token`);
  writeFileSync(tokenFile, bearer);
  const out: string[] = [];
  const child = spawn(process.execPath, [RUNNER, "--port", String(port), "--token-file", tokenFile, "--work", join(root, `work-${name}`)], { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout!.on("data", (d) => out.push(...String(d).split("\n").filter(Boolean)));
  child.stderr!.on("data", (d) => out.push(...String(d).split("\n").filter(Boolean)));
  await until(`${name} listening`, () => out.some((l) => l.includes('"listening"')));
  return { m: { id: name, label: `machine ${name}`, kind: "sandbox", ratePerHour: 0, since: Date.now() }, child, out, address: { url: `ws://127.0.0.1:${port}`, bearer } };
}

test("a takeover over the pipe resumes from the last checkpoint; the replaced runner lands nothing; the seal seals", { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "universes-pipe-"));
  const machines: Awaited<ReturnType<typeof machine>>[] = [];
  try {
    const run: RunRef = { disk: "dsk-local", region: "local", id: "u-pipe" };
    const progressFile = join(root, "runs", run.id, "work", "universe", "progress.json");
    const progress = () => (existsSync(progressFile) ? (JSON.parse(readFileSync(progressFile, "utf8")) as Progress) : null);
    const control = { addUser: async () => ({ identifier: "tok-1", token: "secret" }), removeUser: async () => undefined } as unknown as Control;
    const [a, b] = [await machine(root, "a"), await machine(root, "b")];
    machines.push(a, b);
    const address = new Map([
      [a.m.id, a.address],
      [b.m.id, b.address],
    ]);
    const retired: string[] = [];
    const pipes = pipePlacement({
      control,
      mountRoot: root,
      model: new ModelProxy({ baseUrl: "http://127.0.0.1:9/v1", model: "none", budgetTokens: 1_000 }),
      runner: async (m) => address.get(m.id)!,
      retire: async (m) => void retired.push(m.id),
      acquire: async (opts) => localClaim(root, opts),
      claimDir: (dir) => openClaimDir(dir, { fstype: null }),
    });
    const env = (label: string, switchId: string, planned: boolean) => ({
      UNIVERSE_ID: "u1",
      UNIVERSE_OF: "1",
      UNIVERSE_REWARD: "forward speed",
      UNIVERSE_TOTAL_STEPS: "400",
      UNIVERSE_STEP_MS: "40",
      UNIVERSE_CHECKPOINT_EVERY: "2",
      // Larger than a frame's chunk: every checkpoint goes through the pipe as an upload, then the write-through.
      UNIVERSE_CHECKPOINT_BYTES: String(3 * 1024 * 1024),
      DEMO_ENV_LABEL: label,
      DEMO_SWITCH_ID: switchId,
      DEMO_SWITCH_FROM: "the test",
      DEMO_SWITCH_PLANNED: planned ? "1" : "0",
    });

    const first = await pipes.place(run, a.m, env(a.m.label, "fanout-1", true));
    const onA = await until("a checkpoint from a", () => {
      const p = progress();
      return p && p.host === a.m.label && p.step >= 6 ? p : null;
    });
    assert.equal(onA.generation, 1, "the first attachment is epoch 1");

    // A frozen machine: it holds its socket and its files, and answers nothing.
    a.child.kill("SIGSTOP");
    const lastOfA = progress()!.step;
    const second = await pipes.place(run, b.m, env(b.m.label, "takeover-1", false), first.placed);
    assert.equal(second.revoked, 0, "the claim never moved");
    const onB = await until("a checkpoint from b", () => {
      const p = progress();
      return p && p.host === b.m.label ? p : null;
    });
    assert.ok(onB.step >= lastOfA, `b resumed from a's last checkpoint (${lastOfA}), not from 0 (${onB.step})`);
    assert.equal(onB.generation, 2, "the takeover is epoch 2");
    assert.equal(statSync(join(root, "runs", run.id, "work", "universe", "weights.bin")).size, 3 * 1024 * 1024, "a checkpoint larger than a chunk arrived whole");

    // Thawed, the old runner is told it lost the run; none of its writes lands after b's attachment.
    a.child.kill("SIGCONT");
    await until("a to leave", () => a.child.exitCode !== null || a.out.some((l) => l.includes('"lost"')), 15_000);
    for (let i = 0; i < 10; i++) {
      assert.notEqual(progress()?.host, a.m.label, "a wrote after b took the run");
      await sleep(100);
    }

    await pipes.seal(second.placed);
    const record = JSON.parse(readFileSync(join(root, "runs", run.id, "run.json"), "utf8")) as { status: string; sealedSeq: number | null };
    assert.equal(record.status, "paused");
    assert.notEqual(record.sealedSeq, null, "the release sealed the run");
    assert.deepEqual(retired, ["b"]);
    assert.ok(b.out.some((l) => l.includes('"drained"')), "the seal drained b before releasing");
  } finally {
    for (const m of machines) {
      m.child.kill("SIGCONT");
      m.child.kill("SIGKILL");
    }
    rmSync(root, { recursive: true, force: true });
  }
});
