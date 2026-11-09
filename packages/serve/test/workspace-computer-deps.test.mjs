// The one composition of a run's computer (serve/src/workspace/computer-deps.ts computerDepsFrom): the kind registry,
// the provider makers (computer-providers.ts, the one place a provider is built), the computer's spec, the mount check
// and each provider key, read from the server's environment first and then the store's sealed rows, as the server reads
// it. The runner and the server both take computerForClaim and its deps from it; a spec builder adds only the claim's own
// (mode, Workspace, seal key), as it does here.
//
// Rule 5: a key goes only into the server-side provider call (the provider's options). The computer it makes carries no
// provider key, no account key and no database or Redis credential, anywhere in its spec (labels included). Each value
// here is planted, distinctive, and searched for in the whole spec. Every provider is a loopback stand-in; the kind
// registry is the agreed fixture (workspace-kinds-fixture.mjs).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { DAYTONA_DEFAULT_SNAPSHOT, providerFor } from "@parcha/agentrun-computer";
import { fakeDocker } from "../../computer/test/fake-docker.mjs";
import { FAUX_VIEW_PATH, fauxComputers } from "../dist/faux-computers.js";
import { putSealedKey } from "../dist/server-keys.js";
import * as workspaceModule from "../dist/workspace/index.js";
import { computerDepsFrom, computerSpecOf, localWorkspace } from "../dist/workspace/index.js";
import { fakeComputer } from "./workspace-fake-computer.mjs";
import { KINDS } from "./workspace-kinds-fixture.mjs";

const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
function scratch() {
  const dir = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-computer-deps-")));
  dirs.push(dir);
  const root = join(dir, "work");
  mkdirSync(root);
  return root;
}

/** Distinctive planted values: none of them may show up in a computer's spec. */
const mark = (what) => `planted-${what}-${randomBytes(12).toString("hex")}`;
const PLANTED = {
  envKey: mark("e2b-env-key"),
  storeKey: mark("e2b-store-key"),
  orgoKey: mark("orgo-store-key"),
  account: mark("archil-account-key"),
  db: mark("db-password"),
  redis: mark("redis-password"),
};
/** The server's environment: E2B's key, which wins over its saved one; the account key; the database and Redis URLs. */
const ENV = {
  E2B_API_KEY: PLANTED.envKey,
  ARCHIL_API_KEY: PLANTED.account,
  DATABASE_URL: `postgres://agentrun:${PLANTED.db}@db.invalid:5432/agentrun`,
  REDIS_URL: `redis://:${PLANTED.redis}@redis.invalid:6379/0`,
  PATH: "/usr/bin:/bin",
};

/** The store's three parts the claim reads: no revision, sealed keys in memory, a ledger in memory. */
function memoryStore() {
  const keys = new Map();
  const ledger = new Map();
  return {
    agents: { revision: async () => undefined },
    sealedKeys: { get: async (name) => keys.get(name), put: async (name, sealed) => void keys.set(name, sealed), remove: async (name) => void keys.delete(name), all: async () => [...keys].map(([name]) => ({ name })) },
    computerLedger: { put: async (p, id, labels, detail) => void ledger.set(`${p}/${id}`, { sessionId: id, labels, detail }), get: async (p, id) => ledger.get(`${p}/${id}`), list: async () => [...ledger.values()], remove: async (p, id) => void ledger.delete(`${p}/${id}`) },
  };
}

/** A desktop provider stand-in in the computer module's shape: create records its spec. */
function fakeDesktop(root, record) {
  const computer = fakeComputer(root);
  return {
    id: "fake",
    version: "0",
    capabilities: () => ({ lifetime: "janitor", maxLifetimeMs: 86_400_000 }),
    check: () => [],
    list: async () => ({ ok: true, value: [] }),
    async create(spec) {
      record.created.push(structuredClone(spec));
      return { ok: true, value: { id: "c1", name: "c1" } };
    },
    connect: async () => ({ ok: true, value: { client: computer.client, hello: { version: "0", os: "linux", kind: "desktop", arch: "amd64", groups: ["screen", "input.pointer", "input.keys"] }, close: async () => {} } }),
    attach: async () => ({ ok: true, value: { id: "c1", name: "c1", spec: { image: "i", user: "1000:1000", network: "none" } } }),
    release: async (ref, how) => (record.released.push([ref.id, how]), { ok: true, value: undefined }),
  };
}

/** A run's desktop on `provider`, through the composer as the runner wires it and the spec builder calls it. */
async function desktopOn(provider) {
  const root = scratch();
  const store = memoryStore();
  const sealKey = randomBytes(32);
  await putSealedKey(store, sealKey, "E2B_API_KEY", PLANTED.storeKey);
  await putSealedKey(store, sealKey, "ORGO_API_KEY", PLANTED.orgoKey);
  const record = { created: [], released: [], loaded: [] };
  // The provider builder's load (providerFor in production): what the server-side provider call is given.
  const load = async (id, options) => (record.loaded.push([id, structuredClone(options)]), fakeDesktop(root, record));
  const { computerForClaim, computerDeps } = computerDepsFrom({ env: ENV, store, sealKey, kinds: KINDS, load });
  // As the spec builders call it: the composer's deps, then the claim's own.
  const answer = await computerForClaim({ runId: "run-1", epoch: 3, computer: { kind: "desktop", provider } }, store, { ...computerDeps, mode: 1, workspace: localWorkspace(root), sealKey });
  return { answer, record };
}

/** Every planted value found anywhere in `value` (its JSON). */
const plantsIn = (value) => Object.entries(PLANTED).filter(([, planted]) => JSON.stringify(value).includes(planted)).map(([name]) => name);

test("a key named in the server's environment wins over its saved one, and goes only into the provider call: the computer's spec carries no key, account key or database credential", async () => {
  const { answer, record } = await desktopOn("e2b");
  assert.equal(answer.computer?.kind, "desktop");
  assert.deepEqual(record.loaded.map(([id, options]) => [id, options.apiKey]), [["e2b", PLANTED.envKey]], "the provider is built with the environment's key, over the saved one");
  assert.equal(record.created.length, 1);
  const [spec] = record.created;
  assert.deepEqual(plantsIn(spec), [], `no planted value in the computer's spec: ${JSON.stringify(spec)}`);
  assert.deepEqual(spec.labels, { "agentrun.run": "run-1", "agentrun.epoch": "3" }, "its labels are the run's, and only those");
  assert.equal(spec.env, undefined, "no environment is handed to the computer");
  assert.equal(spec.image, "desktop", "E2B's desktop template");
  assert.ok(spec.lifetimeMs > 0, "a deadline");
  await answer.release();
  assert.deepEqual(record.released, [["c1", "delete"]]);
});

test("a key only saved in the store is opened with the server's seal key for the provider call alone: the computer's spec carries none of it", async () => {
  const { answer, record } = await desktopOn("orgo");
  assert.equal(answer.computer?.kind, "desktop");
  assert.deepEqual(record.loaded.map(([id, options]) => [id, options.apiKey]), [["orgo", PLANTED.orgoKey]], "the saved key, opened for the provider");
  const [spec] = record.created;
  assert.deepEqual(plantsIn(spec), [], `no planted value in the computer's spec: ${JSON.stringify(spec)}`);
  assert.deepEqual(spec.labels, { "agentrun.run": "run-1", "agentrun.epoch": "3" });
  assert.equal(spec.image, "linux", "Orgo's base desktop");
  await answer.release();
});

/** A store with saved computer keys (Settings → Computers'), as a server that has some keeps them. */
async function savedKeysStore(sealKey) {
  const store = memoryStore();
  for (const [name, value] of Object.entries({ E2B_API_KEY: PLANTED.storeKey, ORGO_API_KEY: PLANTED.orgoKey, FAUX_SANDBOX_KEY: mark("faux-key") })) await putSealedKey(store, sealKey, name, value);
  return store;
}

test("the composer builds a working claim on a docker box: the real Docker provider over a fake docker first on PATH gives a kinded sandbox, and its release ends it", async (t) => {
  // The computer package's fake docker (it answers run, inspect, exec with the daemon's hello, rm): no Docker is reached.
  const fake = fakeDocker();
  const path = process.env.PATH;
  process.env.PATH = `${dirname(fake.program)}:${path}`;
  t.after(() => { process.env.PATH = path; });
  const root = scratch();
  const sealKey = randomBytes(32);
  const store = await savedKeysStore(sealKey);
  // The production builder (providerFor), told only where the fake daemon file and its cache are; docker is the one on PATH.
  const load = (id, options) => providerFor(id, { ...options, daemonPath: fake.daemonPath, daemonCache: fake.cache });
  const { computerForClaim, computerDeps } = computerDepsFrom({ env: ENV, store, sealKey, load });
  const answer = await computerForClaim({ runId: "run-1", epoch: 3, computer: { kind: "sandbox", provider: "docker" } }, store, { ...computerDeps, mode: 1, workspace: localWorkspace(root), sealKey });
  assert.equal(answer.computer?.kind, "sandbox", "a kinded RunComputer");
  const run = fake.calls().find((args) => args[0] === "run");
  assert.ok(run, `docker run was called: ${JSON.stringify(fake.calls())}`);
  assert.deepEqual(plantsIn(run), [], "no planted value on docker run's command line");
  assert.ok(run.includes("agentrun.run=run-1") || run.some((arg) => arg.includes("agentrun.run=run-1")), "made under the run's labels");
  await answer.release();
  assert.ok(fake.calls().some((args) => args[0] === "rm"), "its release removes the container");
});

test("the composer builds a working claim on the faux box: a faux desktop is a kinded RunComputer, and its release ends it", async () => {
  const root = scratch();
  const sealKey = randomBytes(32);
  const store = await savedKeysStore(sealKey);
  const faux = fauxComputers({ viewerBase: "http://127.0.0.1:9" });
  const { computerForClaim, computerDeps } = computerDepsFrom({ env: {}, store, sealKey, faux });
  const answer = await computerForClaim({ runId: "run-1", epoch: 3, computer: { kind: "desktop", provider: "faux-desktop" } }, store, { ...computerDeps, mode: 1, workspace: localWorkspace(root), sealKey });
  assert.equal(answer.computer?.kind, "desktop", "a kinded RunComputer");
  const page = `${FAUX_VIEW_PATH}/faux-desktop-1/view`;
  assert.ok(faux.viewPage(page), "the faux desktop is live");
  await answer.release();
  assert.equal(faux.viewPage(page), undefined, "its release ended it");
});

/** A sandbox provider stand-in: create records its spec; its computer binds the run's folder (the read-back it gives). */
function fakeSandbox(root, record) {
  const computer = fakeComputer(root);
  return {
    id: "fake",
    version: "0",
    capabilities: () => ({ lifetime: "janitor", maxLifetimeMs: 86_400_000 }),
    check: () => [],
    list: async () => ({ ok: true, value: [] }),
    async create(spec) {
      record.created.push(structuredClone(spec));
      return { ok: true, value: { id: "c1", name: "c1" } };
    },
    connect: async () => ({ ok: true, value: { client: computer.client, hello: { version: "0", os: "linux", kind: "linux", arch: "amd64", groups: ["exec", "files", "processes"] }, close: async () => {} } }),
    async attach() {
      const read = await computer.readBack();
      return { ok: true, value: { id: "c1", name: "c1", spec: { image: "i", user: "1000:1000", network: "none", ...(read.ok ? { mount: read.value } : {}) } } };
    },
    release: async (ref, how) => (record.released.push([ref.id, how]), { ok: true, value: undefined }),
  };
}

/** A claim as the runner's spec builders make one (its run, epoch, revision and place), over a store that also has the
 *  run's launch row (runs.launch), as the runner's store does. `boxAllow`: the launch's box_allow. */
async function placeClaim(place, boxAllow) {
  const root = scratch();
  const sealKey = randomBytes(32);
  const store = { ...(await savedKeysStore(sealKey)), runs: { launch: async (runId) => ({ runId, body: { input: { content: "Go." }, title: "t", place, ...(boxAllow === undefined ? {} : { box_allow: boxAllow }) }, sealed: null, createdAt: 0 }) } };
  const record = { created: [], released: [], loaded: [] };
  const load = async (id, options) => (record.loaded.push([id, options]), fakeSandbox(root, record));
  const { computerForClaim, computerDeps } = computerDepsFrom({ env: ENV, store, sealKey, kinds: KINDS, load });
  const answer = await computerForClaim({ runId: "run-1", epoch: 3, revisionId: "rev-1", place }, store, { ...computerDeps, mode: 1, workspace: localWorkspace(root), sealKey });
  return { answer, record };
}

// What the runner's stopgap (harness-loops.ts sandboxComputerForClaim) gives, the composer gives: none for a runner place,
// and for a sandbox place a Docker computer reaching what the run's launch allows (box_allow), no network otherwise.
test("for a runner place the composer's claim makes no computer", async () => {
  const { answer, record } = await placeClaim({ mode: "runner" });
  assert.equal(answer.computer, undefined);
  assert.deepEqual(record.loaded, [], "no provider built");
  await answer.release();
});

test("for a sandbox place the composer's claim makes a Docker computer that reaches what the run's launch allows, and none without an allow-list", async () => {
  const allowed = await placeClaim({ mode: "sandbox", box: "docker" }, ["example.com", "api.example.org"]);
  assert.equal(allowed.answer.computer?.kind, "sandbox");
  assert.deepEqual(allowed.record.loaded.map(([id]) => id), ["docker"]);
  assert.deepEqual(allowed.record.created[0].network, { allow: ["example.com", "api.example.org"] }, "the launch's box_allow is the computer's allow-list");
  await allowed.answer.release();
  for (const boxAllow of [undefined, "none"]) {
    const closed = await placeClaim({ mode: "sandbox", box: "docker" }, boxAllow);
    assert.equal(closed.record.created[0].network, "none", `box_allow ${JSON.stringify(boxAllow)}: no network`);
    await closed.answer.release();
  }
});

// The computer's spec by kind (computerSpecOf): box_allow is a sandbox's egress list, so a sandbox with none (or "none")
// has no network; a browser, a desktop or a phone with none has its provider's own network ("open": a browser or a
// vendor desktop with no network is a broken kind); an explicit list applies to any kind. Each provider's image for a
// kind is one exported table (DEFAULT_IMAGE); a Docker desktop has none of its own, so with no image the owner named it
// is refused in words, never made from the sandbox recipe, which has no X server.
const entryOf = (id) => KINDS.PROVIDERS.find((one) => one.id === id);
const DEFAULT_IMAGE = workspaceModule.DEFAULT_IMAGE ?? {};
const DOCKER_DESKTOP_WORDS = "A Docker desktop needs an image with an X server; set one for desktops.";

test("box_allow is a sandbox's egress list: a sandbox with none has no network, a browser or a desktop with none has its provider's own, and an explicit list applies to a Docker desktop", () => {
  const named = "example.org/desktop@sha256:" + "a".repeat(64);
  const spec = computerSpecOf({ AGENTRUN_DOCKER_IMAGE: named });
  assert.equal(spec(entryOf("docker"), "sandbox", {}).network, "none", "a sandbox with no box_allow");
  assert.equal(spec(entryOf("docker"), "sandbox", {}).image, named, "Docker's image: the one the owner named");
  assert.equal(computerSpecOf({})(entryOf("docker"), "sandbox", {}).image, DEFAULT_IMAGE.docker.sandbox, "else the package's recipe");
  assert.equal(spec(entryOf("docker"), "sandbox", {}).lifetimeMs, 24 * 60 * 60_000, "the leak bound: a day");
  assert.deepEqual(spec(entryOf("docker"), "sandbox", { boxAllow: ["api.example.com"] }).network, { allow: ["api.example.com"] }, "a sandbox's allow-list");
  assert.equal(spec(entryOf("docker"), "sandbox", { boxAllow: "none" }).network, "none");
  assert.equal(spec(entryOf("browserbase"), "browser", {}).network, "open", "a browser with no box_allow: its provider's own network");
  assert.equal(spec(entryOf("kernel"), "browser", {}).network, "open");
  assert.equal(spec(entryOf("e2b"), "desktop", {}).network, "open", "a vendor desktop with no box_allow");
  assert.equal(spec(entryOf("phone-harness"), "phone", {}).network, "open");
  assert.deepEqual(spec(entryOf("docker"), "desktop", { boxAllow: ["example.com"] }).network, { allow: ["example.com"] }, "an explicit list applies to a Docker desktop");
  assert.equal(spec(entryOf("e2b"), "desktop", { boxAllow: "none" }).network, "none", "an explicit none applies to any kind");
});

test("each provider's image for a kind is one exported table; a Docker desktop with no image the owner named is refused in words", async () => {
  assert.equal(DEFAULT_IMAGE.daytona.sandbox, DAYTONA_DEFAULT_SNAPSHOT);
  assert.equal(DEFAULT_IMAGE.docker.desktop, undefined, "the sandbox recipe has no X server: no desktop image of Docker's own");
  const spec = computerSpecOf({});
  assert.equal(spec(entryOf("daytona"), "sandbox", {}).image, DAYTONA_DEFAULT_SNAPSHOT);
  assert.equal(spec(entryOf("e2b"), "desktop", {}).image, DEFAULT_IMAGE.e2b.desktop);
  assert.throws(() => spec(entryOf("docker"), "desktop", {}), { message: DOCKER_DESKTOP_WORDS });
  assert.equal(computerSpecOf({ AGENTRUN_DOCKER_IMAGE: "example.org/x@sha256:" + "b".repeat(64) })(entryOf("docker"), "desktop", {}).image, "example.org/x@sha256:" + "b".repeat(64), "the image the owner named");
  // Through the claim: refused before anything is made, computer_unavailable in those words.
  const root = scratch();
  const sealKey = randomBytes(32);
  const store = await savedKeysStore(sealKey);
  const record = { created: [], released: [], loaded: [] };
  const { computerForClaim, computerDeps } = computerDepsFrom({ env: {}, store, sealKey, kinds: KINDS, load: async (id, options) => (record.loaded.push(id), fakeDesktop(root, record)) });
  await assert.rejects(
    computerForClaim({ runId: "run-1", epoch: 3, computer: { kind: "desktop", provider: "docker" } }, store, { ...computerDeps, mode: 1, workspace: localWorkspace(root), sealKey }),
    (error) => error.code === "computer_unavailable" && error.message.includes(DOCKER_DESKTOP_WORDS),
  );
  assert.deepEqual(record.created, [], "nothing was made");
});

test("the composer builds every provider through the one provider builder, and gives the claim the mount check", async () => {
  const store = memoryStore();
  const { computerDeps } = computerDepsFrom({ env: {}, store, sealKey: undefined, kinds: KINDS, load: async () => { throw new Error("not built here"); } });
  assert.equal(computerDeps.kinds, KINDS);
  for (const id of ["docker", "daytona", "modal", "e2b", "orgo", "phone-harness", "browserbase", "kernel"]) assert.equal(typeof computerDeps.providers[id], "function", `${id} is built by the provider builder`);
  assert.equal(typeof computerDeps.check?.readBackOf, "function", "the mount check the claim's attach runs");
  assert.equal(typeof computerDeps.spec, "function");
});
