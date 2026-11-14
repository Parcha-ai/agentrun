// Computer failover (resolve-computer.ts start's failover, computer-for-claim.ts releaseAfterFailover, computer-deps.ts
// failoverOrder and computerFailoverWords): a launch that fails transiently on a provider of the server's order goes on
// to the next provider that takes the setting as it is; a refusal of the call, an agent's own computer, and a provider
// outside the order never fail over; whatever the failed provider may have made for the run is deleted once it answers,
// and no later claim's computer is touched. The registry is the computer package's; every launch is a stand-in.
import assert from "node:assert/strict";
import { test } from "node:test";
import { computerFailoverWords, failoverOrder, releaseAfterFailover, resolveComputer } from "../dist/workspace/index.js";
import { KINDS } from "./workspace-kinds-fixture.mjs";

const SAVED = { e2b: { E2B_API_KEY: "ek" }, modal: { MODAL_TOKEN_ID: "mi", MODAL_TOKEN_SECRET: "ms" }, daytona: { DAYTONA_API_KEY: "dk" } };
const transient = (words) => Object.assign(new Error(words), { transient: true });

/** The claim's side: `fails` by provider id (an Error to throw), the order, and every launch and failover recorded. */
function side({ fails = {}, order = ["e2b", "modal"], saved = SAVED } = {}) {
  const launched = [];
  const moves = [];
  return {
    launched,
    moves,
    keysOf: async (id) => saved[id] ?? {},
    answers: async () => false,
    failoverOf: (id) => (order.includes(id) ? order.slice(order.indexOf(id) + 1) : []),
    failedOver: (said) => moves.push({ from: said.from.id, to: said.to.id, reason: said.reason, keys: Object.keys(said.keys) }),
    launch: async (entry, spec) => {
      launched.push(entry.id);
      if (fails[entry.id]) throw fails[entry.id];
      const groups = ["exec", "files", "processes"];
      return { id: `${entry.id}-1`, client: { call: async () => ({ ok: true, value: {} }) }, groups, hello: { protocol: "0.2", version: "0", os: "linux", kind: "linux", arch: "amd64", groups }, readBack: async () => ({ ok: false, error: { code: "not_found", message: "none" } }), release: async () => {}, spec };
    },
  };
}
const RUN = { workspace: { mountSpec: async () => ({ kind: "archil" }) }, check: { readBackOf: () => undefined } };

test("a transient launch failure on a provider of the order starts the run's computer on the next one, and says so with the reason", async () => {
  const claim = side({ fails: { e2b: transient("POST /sandboxes: 503 upstream unavailable") } });
  const resolved = await resolveComputer({ kind: "sandbox", provider: "e2b" }, 2, KINDS, claim);
  const started = await resolved.start(RUN);
  assert.deepEqual(claim.launched, ["e2b", "modal"]);
  assert.equal(started.computer.kind, "sandbox");
  assert.deepEqual(claim.moves, [{ from: "e2b", to: "modal", reason: "E2B could not start a sandbox computer: POST /sandboxes: 503 upstream unavailable", keys: ["E2B_API_KEY"] }]);
});

test("a refusal of the call (no transient mark) fails the run as before, on the first provider alone", async () => {
  const claim = side({ fails: { e2b: new Error("POST /sandboxes: 401 bad key") } });
  const resolved = await resolveComputer({ kind: "sandbox", provider: "e2b" }, 2, KINDS, claim);
  await assert.rejects(resolved.start(RUN), (error) => error.code === "computer_unavailable" && error.message === "E2B could not start a sandbox computer: POST /sandboxes: 401 bad key");
  assert.deepEqual(claim.launched, ["e2b"]);
  assert.deepEqual(claim.moves, []);
});

test("a provider outside the order, the last of it, and an agent's own computer never fail over", async () => {
  const outside = side({ fails: { modal: transient("503") }, order: ["daytona", "e2b"] });
  await assert.rejects((await resolveComputer({ kind: "sandbox", provider: "modal" }, 2, KINDS, outside)).start(RUN), /Modal could not start a sandbox computer: 503$/);
  assert.deepEqual(outside.launched, ["modal"]);
  const last = side({ fails: { modal: transient("503") } });
  await assert.rejects((await resolveComputer({ kind: "sandbox", provider: "modal" }, 2, KINDS, last)).start(RUN), /: 503$/);
  assert.deepEqual(last.launched, ["modal"]);
});

test("a next provider that does not take the setting is passed over in its own words; with none left the first failure stands, with theirs", async () => {
  // Modal's keys are not saved: refused before anything is made.
  const claim = side({ fails: { e2b: transient("GET /sandboxes: 504") }, saved: { e2b: SAVED.e2b } });
  const resolved = await resolveComputer({ kind: "sandbox", provider: "e2b" }, 2, KINDS, claim);
  await assert.rejects(resolved.start(RUN), (error) => error.code === "computer_unavailable" && /^E2B could not start a sandbox computer: GET \/sandboxes: 504; no failover took it: Modal: Modal needs its keys MODAL_TOKEN_ID, MODAL_TOKEN_SECRET saved/.test(error.message));
  assert.deepEqual(claim.launched, ["e2b"]);
  // Daytona takes no Archil mount: a Mode 2 sandbox on it is refused, so it is passed over.
  const daytona = side({ fails: { e2b: transient("504") }, order: ["e2b", "daytona", "modal"] });
  await (await resolveComputer({ kind: "sandbox", provider: "e2b" }, 2, KINDS, daytona)).start(RUN);
  assert.deepEqual(daytona.launched, ["e2b", "modal"]);
});

test("the failover order: a comma list of known providers, two or more, checked at the server's start", () => {
  assert.deepEqual(failoverOrder({}, KINDS), []);
  assert.deepEqual(failoverOrder({ AGENTRUN_COMPUTER_FAILOVER: " daytona , kubernetes,daytona" }, KINDS), ["daytona", "kubernetes"]);
  assert.throws(() => failoverOrder({ AGENTRUN_COMPUTER_FAILOVER: "daytona,k8s" }, KINDS), /names "k8s", which no computer provider is/);
  assert.throws(() => failoverOrder({ AGENTRUN_COMPUTER_FAILOVER: "daytona" }, KINDS), /needs two or more/);
});

test("the timeline's words: the provider left and why, the one gone to; then what became of what the left one made", () => {
  assert.equal(computerFailoverWords({ kind: "sandbox", from: "Daytona", to: "Kubernetes", reason: "Daytona could not start a sandbox computer: GET /api/sandbox: 504." }), "Daytona could not start the sandbox, so it is starting on Kubernetes instead. Daytona said: Daytona could not start a sandbox computer: GET /api/sandbox: 504.");
  assert.equal(computerFailoverWords({ from: "Daytona", released: 0 }), "Daytona answers again: it had made no computer for this run.");
  assert.equal(computerFailoverWords({ from: "Daytona", released: 1 }), "Daytona answers again: the computer it made for this run was deleted.");
  assert.match(computerFailoverWords({ from: "Daytona", failed: "504" }), /could not be deleted \(504\): it ends at its deadline/);
});

test("after a failover the failed provider's computers of this run, this claim's epoch and earlier, are deleted once it answers; a later claim's never", async () => {
  const released = [];
  let lists = 0;
  const provider = {
    list: async (labels) => {
      lists += 1;
      assert.deepEqual(labels, { "agentrun.run": "run-1" });
      if (lists < 3) return { ok: false, error: { code: "vendor", message: "GET /api/sandbox: 504", transient: true } };
      return { ok: true, value: [2, 3, 4].map((epoch) => ({ ref: { id: `c${epoch}`, name: `c${epoch}` }, labels: { "agentrun.run": "run-1", "agentrun.epoch": String(epoch) } })) };
    },
    release: async (ref) => (released.push(ref.id), { ok: true, value: undefined }),
  };
  const pauses = [];
  const done = await releaseAfterFailover(provider, { runId: "run-1", epoch: 3 }, { pauseMs: 10, maxPauseMs: 15, attempts: 5 }, async (ms) => void pauses.push(ms));
  assert.deepEqual(done, { released: 2 });
  assert.deepEqual(released, ["c2", "c3"]);
  assert.deepEqual(pauses, [10, 15]);
  const down = { list: async () => ({ ok: false, error: { code: "timeout", message: "no answer" } }), release: async () => assert.fail("nothing listed") };
  assert.deepEqual(await releaseAfterFailover(down, { runId: "run-1", epoch: 1 }, { pauseMs: 1, maxPauseMs: 1, attempts: 3 }, async () => {}), { failed: "no answer" });
});

test("at the claim: a provider's list that answers 504 before its create fails the claim over, tells the timeline, and lets the failed provider's computers go once it answers", async () => {
  const { randomBytes } = await import("node:crypto");
  const { mkdtempSync, realpathSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { readBackOf } = await import("@parcha/agentrun-computer");
  const { putSealedKey } = await import("../dist/server-keys.js");
  const { computerForClaim, localWorkspace } = await import("../dist/workspace/index.js");
  const { fakeComputer } = await import("./workspace-fake-computer.mjs");
  const root = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-failover-")));
  const keys = new Map();
  const store = {
    agents: { revision: async () => undefined },
    sealedKeys: { get: async (name) => keys.get(name), put: async (name, sealed) => void keys.set(name, sealed), remove: async () => {}, all: async () => [] },
    computerLedger: { put: async () => {}, get: async () => undefined, list: async () => [], remove: async () => {} },
  };
  const sealKey = randomBytes(32);
  for (const [name, value] of Object.entries({ ...SAVED.e2b, ...SAVED.modal })) await putSealedKey(store, sealKey, name, value);
  let e2bLists = 0;
  const made = [];
  const provider = (id) => () => {
    const computer = fakeComputer(root);
    return {
      id,
      version: "0",
      capabilities: () => ({ lifetime: "janitor", maxLifetimeMs: 86_400_000 }),
      check: () => [],
      async list() {
        // E2B's API is down for the claim's first list (its release of an older claim's computer) and back for the cleanup.
        if (id === "e2b" && ++e2bLists === 1) return { ok: false, error: { code: "vendor", vendor: "e2b", message: "GET /sandboxes: 504", transient: true } };
        return { ok: true, value: [] };
      },
      async create() {
        made.push(id);
        return { ok: true, value: { id: `${id}-c1`, name: `${id}-c1` } };
      },
      async connect() {
        return { ok: true, value: { client: computer.client, hello: { version: "0", os: "linux", kind: "linux", arch: "amd64", groups: ["exec", "files", "processes"] }, close: async () => {} } };
      },
      async attach() {
        const read = await computer.readBack();
        return { ok: true, value: { id: `${id}-c1`, name: `${id}-c1`, spec: { image: "i", user: "1000:1000", network: "none", ...(read.ok ? { mount: read.value } : {}) } } };
      },
      async release() {
        return { ok: true, value: undefined };
      },
    };
  };
  const said = [];
  const answer = await computerForClaim({ runId: "run-1", epoch: 2, computer: { kind: "sandbox", provider: "e2b" } }, store, {
    mode: 2, kinds: KINDS, sealKey, providers: { e2b: provider("e2b"), modal: provider("modal") }, spec: () => ({ image: "i", lifetimeMs: 60_000, network: "none" }),
    workspace: localWorkspace(root), check: { readBackOf, epoch: 2 }, failover: ["e2b", "modal"], onFailover: (one) => said.push(one), failoverCleanup: { pauseMs: 1, maxPauseMs: 1, attempts: 3 },
  });
  assert.deepEqual(made, ["modal"], "nothing was made on E2B; the run's computer is Modal's");
  await new Promise((done) => setTimeout(done, 50));
  assert.deepEqual(said, [
    { kind: "sandbox", from: "E2B", to: "Modal", reason: "E2B could not start a sandbox computer: could not list run \"run-1\"'s computers: GET /sandboxes: 504" },
    { from: "E2B", released: 0 },
  ]);
  await answer.release();
});
