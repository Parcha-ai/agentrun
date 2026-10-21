// A stop must terminate what the ledger still has open: a queued create is only a NAME until Modal places it, and a placed one runs (and bills) until its TTL.
import assert from "node:assert/strict";
import { test } from "node:test";
import { openTargets, terminateTargets, type SweepSdk } from "../sweep-open.ts";

class Box {
  exit: number | null = null;
  tries = 0;
  readonly sandboxId: string;
  readonly failTerminate: number;
  constructor(sandboxId: string, failTerminate = 0) {
    this.sandboxId = sandboxId;
    this.failTerminate = failTerminate;
  }
  async poll() { return this.exit; }
  async terminate() { this.tries += 1; if (this.tries <= this.failTerminate) throw new Error("modal is having a moment"); this.exit = 137; }
}

function fake(boxes: Map<string, Box>, byName: Map<string, () => Box | undefined>): SweepSdk {
  return {
    apps: { fromName: async (n) => ({ appId: n }) },
    sandboxes: {
      fromId: async (id) => boxes.get(id) ?? Promise.reject(new Error(`no sandbox ${id}`)),
      fromName: async (_app, name) => byName.get(name)?.() ?? Promise.reject(new Error(`no sandbox named ${name}`)),
    },
  };
}

test("the open rows of a ledger: a Modal id is looked up by id, anything else is a queued create's name; closed rows and other kinds are left alone", () => {
  const rows = [
    { kind: "modal-sandbox", id: "sb-1" },
    { kind: "modal-sandbox", id: "pda-demo-gpu3-queued" },
    { kind: "modal-sandbox", id: "sb-2", closed: "2026-10-21T00:00:00Z" },
    { kind: "token-user", id: "tok-1" },
    { kind: "modal-sandbox", id: "sb-1" },
  ];
  assert.deepEqual(openTargets(rows), [{ kind: "id", value: "sb-1" }, { kind: "name", value: "pda-demo-gpu3-queued" }]);
});

test("a create that is still queued when the stop begins is terminated by its name as soon as Modal places it", async () => {
  const placed = new Box("sb-9");
  let asked = 0;
  const sdk = fake(new Map(), new Map([["queued-a", () => (++asked >= 3 ? placed : undefined)]]));
  const closed: string[] = [];
  const out = await terminateTargets(sdk, "app", [{ kind: "name", value: "queued-a" }], { waitMs: 2_000, pollMs: 10, onGone: (t) => void closed.push(t.value) });
  assert.deepEqual(out, { terminated: ["queued-a"], gone: [], notRunning: [], left: [] });
  assert.equal(placed.exit, 137, "it was terminated, not left to its TTL");
  assert.ok(asked >= 3, "it was asked for again until it appeared");
  assert.deepEqual(closed, ["queued-a"], "its ledger row is closed");
});

test("a running sandbox is terminated by its id, one that already ended or that Modal no longer knows is just closed, and a removal that fails once is tried again", async () => {
  const running = new Box("sb-1");
  const ended = new Box("sb-2"); ended.exit = 0;
  const flaky = new Box("sb-3", 1);
  const sdk = fake(new Map([["sb-1", running], ["sb-2", ended], ["sb-3", flaky]]), new Map());
  const out = await terminateTargets(sdk, "app", ["sb-1", "sb-2", "sb-3", "sb-4"].map((value) => ({ kind: "id" as const, value })), { waitMs: 2_000, pollMs: 10 });
  assert.deepEqual(out.terminated.sort(), ["sb-1", "sb-3"]);
  assert.deepEqual(out.gone.sort(), ["sb-2", "sb-4"]);
  assert.deepEqual(out.left, []);
  assert.equal(flaky.tries, 2);
});

test("a name Modal has no RUNNING sandbox under (a terminated one, or a create still queued) is reported as not running, never as left: only a sandbox that was found and would not terminate is left", async () => {
  const sdk = fake(new Map(), new Map());
  const out = await terminateTargets(sdk, "app", [{ kind: "name", value: "terminated-or-queued" }], { waitMs: 80, pollMs: 20 });
  assert.deepEqual(out, { terminated: [], gone: [], notRunning: ["terminated-or-queued"], left: [] });
});

test("a running sandbox that will not terminate within the wait is left, by its name", async () => {
  const stuck = new Box("sb-5", 1_000);
  const sdk = fake(new Map(), new Map([["stuck", () => stuck]]));
  const out = await terminateTargets(sdk, "app", [{ kind: "name", value: "stuck" }], { waitMs: 80, pollMs: 20 });
  assert.deepEqual(out, { terminated: [], gone: [], notRunning: [], left: ["stuck"] });
});

test("scripts/sweep-open.mjs loads (its imports resolve) and, over a ledger with nothing open, terminates nothing and exits 0", async () => {
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const dir = mkdtempSync(join(tmpdir(), "sweep-open-"));
  try {
    const script = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "sweep-open.mjs");
    const run = spawnSync(process.execPath, [script, "--ledger", join(dir, "ledger.json"), "--wait-s", "1"], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME, MODAL_TOKEN_ID: "ak-test", MODAL_TOKEN_SECRET: "as-test" } });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /0 sandbox\(es\) open in the ledger/);
    assert.match(run.stdout, /terminated 0, already gone 0, not running 0, left 0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
