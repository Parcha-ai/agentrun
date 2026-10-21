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
  assert.deepEqual(out, { terminated: ["queued-a"], gone: [], left: [] });
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

test("a queued create that never places within the wait is reported as left, by its name, so the stop can say so", async () => {
  const sdk = fake(new Map(), new Map());
  const out = await terminateTargets(sdk, "app", [{ kind: "name", value: "never" }], { waitMs: 80, pollMs: 20 });
  assert.deepEqual(out.left, ["never"]);
  assert.deepEqual(out.terminated, []);
});
