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
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { DAYTONA_DEFAULT_SNAPSHOT, DEFAULT_DOCKER_IMAGE, PROVIDERS, providerFor } from "@parcha/agentrun-computer";
import { dockerHost } from "./docker-host-fake.mjs";
import { FAUX_VIEW_PATH, fauxComputers } from "../dist/faux-computers.js";
import { DEFAULT_BOX_ALLOW } from "../dist/box-settings.js";
import { putSealedKey } from "../dist/server-keys.js";
import { computerDepsFrom, computerSpecOf, dockerHostAddressesOf, dockerVolumeOf, localWorkspace } from "../dist/workspace/index.js";
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
  // On the computer package's own registry (the composer's default), whose entries carry each provider's default image.
  const { computerForClaim, computerDeps } = computerDepsFrom({ env: ENV, store, sealKey, load });
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
  // A host that keeps its images (none yet) over the computer package's fake docker (run, inspect, exec with the daemon's
  // hello, rm): no Docker is reached. The provider builds the recipe's image there first (docker-host-fake.mjs).
  const host = dockerHost();
  const fake = { ...host.fake, calls: host.calls };
  const path = process.env.PATH;
  process.env.PATH = `${host.dir}:${path}`;
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

/** A sandbox provider stand-in: create records its spec; its computer binds the run's folder (the read-back it gives).
 *  `declared`: more of its capabilities (the networks it makes, its longest lifetime). */
function fakeSandbox(root, record, declared = {}) {
  const computer = fakeComputer(root);
  return {
    id: "fake",
    version: "0",
    capabilities: () => ({ lifetime: "janitor", maxLifetimeMs: 86_400_000, ...declared }),
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
 *  run's launch row (runs.launch), as the runner's store does. `boxAllow`: the launch's box_allow. `declared`: more of
 *  the provider's capabilities. `env`: the server's environment. */
async function placeClaim(place, boxAllow, declared = {}, env = ENV) {
  const root = scratch();
  const sealKey = randomBytes(32);
  const store = { ...(await savedKeysStore(sealKey)), runs: { launch: async (runId) => ({ runId, body: { input: { content: "Go." }, title: "t", place, ...(boxAllow === undefined ? {} : { box_allow: boxAllow }) }, sealed: null, createdAt: 0 }) } };
  const record = { created: [], released: [], loaded: [] };
  const load = async (id, options) => (record.loaded.push([id, options]), fakeSandbox(root, record, declared));
  const { computerForClaim, computerDeps } = computerDepsFrom({ env, store, sealKey, kinds: KINDS, load });
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

test("the claim makes a computer's spec from what its provider declares: one that makes only network none, within an hour, gets none and an hour under the server's default list", async () => {
  // The server's default box_allow (AGENTRUN_BOX_ALLOW unset) is a list; a provider declaring network ["none"] and an
  // hour's cap, as E2B's does, is asked for none and that hour, never the list or a day it refuses at create.
  const narrowed = await placeClaim({ mode: "sandbox", box: "docker" }, [...DEFAULT_BOX_ALLOW], { network: ["none"], maxLifetimeMs: 3_600_000 });
  assert.deepEqual([narrowed.record.created[0].network, narrowed.record.created[0].lifetimeMs], ["none", 3_600_000]);
  await narrowed.answer.release();
  // One that makes an allow-list (Docker's declaration) keeps the run's list and the day's bound.
  const listed = await placeClaim({ mode: "sandbox", box: "docker" }, [...DEFAULT_BOX_ALLOW], { network: ["none", "open", "allow"] });
  assert.deepEqual([listed.record.created[0].network, listed.record.created[0].lifetimeMs], [{ allow: [...DEFAULT_BOX_ALLOW] }, 24 * 60 * 60_000]);
  await listed.answer.release();
});

// Daytona's and E2B's own providers (the computer package's, built with a fake key; nothing is called): under the server's
// default list, the spec the composer makes from their declared capabilities is one their own check() takes, where the
// list it made before was refused as network open or an allow-list is ("a remote computer takes network none only").
test("a Daytona or an E2B sandbox under the server's default box_allow asks for network none within its provider's lifetime, and its provider's check takes the spec", async () => {
  const spec = computerSpecOf({});
  for (const id of ["daytona", "e2b"]) {
    const provider = await providerFor(id, { apiKey: "fake-test-key" });
    const { network: networks, maxLifetimeMs } = provider.capabilities();
    const asked = spec(entryOf(id), "sandbox", { boxAllow: [...DEFAULT_BOX_ALLOW], networks, maxLifetimeMs });
    assert.equal(asked.network, "none", id);
    assert.deepEqual(provider.check(asked), [], `${id}'s check takes the spec`);
    const before = { ...asked, network: { allow: [...DEFAULT_BOX_ALLOW] } };
    assert.deepEqual(provider.check(before).map((refusal) => refusal.field), ["network"], `${id} refuses the list`);
    // An explicit none stays none; nothing is widened.
    assert.equal(spec(entryOf(id), "sandbox", { boxAllow: "none", networks, maxLifetimeMs }).network, "none");
  }
});

// A vendor-hosted computer that runs only on the vendor's own network (the cloud phone's provider declares ["open"]) is
// open whatever the run allows, and never refused for the server's list: this server's allow-list can't reach it.
test("a cloud phone under the server's default box_allow, or none, runs on the vendor's own network, and its provider's check takes the spec", async () => {
  const spec = computerSpecOf({});
  const provider = await providerFor("phone-harness", { apiKey: "fake-test-key" });
  const { network: networks, maxLifetimeMs } = provider.capabilities();
  for (const boxAllow of [[...DEFAULT_BOX_ALLOW], "none", undefined]) {
    const asked = spec(entryOf("phone-harness"), "phone", { ...(boxAllow === undefined ? {} : { boxAllow }), networks, maxLifetimeMs });
    assert.equal(asked.network, "open", `box_allow ${JSON.stringify(boxAllow)}`);
    assert.deepEqual(provider.check(asked), [], `the phone's check takes the spec under box_allow ${JSON.stringify(boxAllow)}`);
  }
  assert.deepEqual(provider.check({ ...spec(entryOf("phone-harness"), "phone", { networks, maxLifetimeMs }), network: { allow: [...DEFAULT_BOX_ALLOW] } }).map((one) => one.field), ["network"], "the list the spec asked before is refused");
});

// The computer's spec by kind (computerSpecOf): box_allow is a sandbox's egress list, so a sandbox with none (or "none")
// has no network; a browser, a desktop or a phone with none has its provider's own network ("open": a browser or a
// vendor desktop with no network is a broken kind); an explicit list applies to any kind. Each provider's image for a
// kind is its registry entry's (the computer package's PROVIDERS[].defaultImage); Docker's sandbox is the package's
// recipe, and a Docker desktop has none, so with no image the owner named it is refused in words, never made from the
// sandbox recipe, which has no X server. Any other kind with no default image is refused, naming the provider.
const entryOf = (id) => PROVIDERS.find((one) => one.id === id);
const DOCKER_DESKTOP_WORDS = "A Docker desktop needs an image with an X server; set one for desktops.";

test("box_allow is a sandbox's egress list: a sandbox with none has no network, a browser or a desktop with none has its provider's own, and an explicit list applies to a Docker desktop", () => {
  const named = "example.org/desktop@sha256:" + "a".repeat(64);
  const spec = computerSpecOf({ AGENTRUN_DOCKER_IMAGE: named });
  assert.equal(spec(entryOf("docker"), "sandbox", {}).network, "none", "a sandbox with no box_allow");
  assert.equal(spec(entryOf("docker"), "sandbox", {}).image, named, "Docker's image: the one the owner named");
  assert.equal(computerSpecOf({})(entryOf("docker"), "sandbox", {}).image, DEFAULT_DOCKER_IMAGE, "else the package's recipe");
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

test("each provider's default image comes from the computer package's registry (PROVIDERS[].defaultImage); a Docker desktop with no image the owner named is refused in words", async () => {
  const spec = computerSpecOf({});
  // A value only the registry entry has: the spec reads the entry it is given, no table of serve's own.
  assert.equal(spec({ ...entryOf("daytona"), defaultImage: { sandbox: "registry-only/snapshot-7f3a" } }, "sandbox", {}).image, "registry-only/snapshot-7f3a");
  // Every default the package's registry declares is the image of that provider's computer of that kind.
  const declared = PROVIDERS.flatMap((entry) => Object.entries(entry.defaultImage ?? {}).map(([kind, image]) => [entry.id, kind, image]));
  assert.ok(declared.length >= 8, `the registry declares the vendors' defaults: ${JSON.stringify(declared)}`);
  for (const [id, kind, image] of declared) assert.equal(spec(entryOf(id), kind, {}).image, image, `${id} ${kind}`);
  assert.equal(spec(entryOf("daytona"), "sandbox", {}).image, DAYTONA_DEFAULT_SNAPSHOT);
  assert.equal(entryOf("docker").defaultImage?.desktop, undefined, "the sandbox recipe has no X server: no desktop image of Docker's own");
  assert.throws(() => spec(entryOf("docker"), "desktop", {}), { message: DOCKER_DESKTOP_WORDS });
  // Any other kind with no default image: refused, naming the provider.
  assert.throws(() => spec({ ...entryOf("e2b"), defaultImage: { desktop: "desktop" } }, "sandbox", {}), { code: "computer_unavailable", message: /^E2B has no image for a sandbox computer here/ });
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

// AGENTRUN_DOCKER_HOST_ADDRESSES: the Docker host's own addresses, for a Docker provider that isn't on that host (the
// server in a container). The provider's egress proxy refuses them as the host's; without them it refuses any
// allow-list there. Each entry is an IP address or the setting is refused in words; nothing is ever made up.
test("AGENTRUN_DOCKER_HOST_ADDRESSES is a comma list of IP addresses, each once; unset or empty is none; an entry that is no IP address is refused, named", () => {
  assert.equal(dockerHostAddressesOf({}), undefined);
  assert.equal(dockerHostAddressesOf({ AGENTRUN_DOCKER_HOST_ADDRESSES: "  " }), undefined);
  assert.equal(dockerHostAddressesOf({ AGENTRUN_DOCKER_HOST_ADDRESSES: " , ," }), undefined);
  assert.deepEqual(dockerHostAddressesOf({ AGENTRUN_DOCKER_HOST_ADDRESSES: "172.17.0.1, 192.0.2.10,fd00::1,172.17.0.1" }), ["172.17.0.1", "192.0.2.10", "fd00::1"]);
  for (const bad of ["host.docker.internal", "172.17.0.0/16", "192.0.2.10:2375", "300.1.1.1"]) {
    assert.throws(() => dockerHostAddressesOf({ AGENTRUN_DOCKER_HOST_ADDRESSES: `172.17.0.1,${bad}` }), { message: `AGENTRUN_DOCKER_HOST_ADDRESSES is a comma list of the Docker host's own IP addresses (such as 172.17.0.1): ${JSON.stringify(bad)} is not an IP address` });
  }
});

test("the claim's Docker provider gets the Docker host's addresses as its egress.hostAddresses when the setting names them, and none otherwise", async () => {
  const named = await placeClaim({ mode: "sandbox", box: "docker" }, [...DEFAULT_BOX_ALLOW], {}, { ...ENV, AGENTRUN_DOCKER_HOST_ADDRESSES: "172.17.0.1,fd00::1" });
  const [[id, options]] = named.record.loaded;
  assert.equal(id, "docker");
  assert.deepEqual(options.egress, { hostAddresses: ["172.17.0.1", "fd00::1"] });
  await named.answer.release();
  const unset = await placeClaim({ mode: "sandbox", box: "docker" }, [...DEFAULT_BOX_ALLOW]);
  assert.equal(unset.record.loaded[0][1].egress, undefined, "no addresses are made up");
  await unset.answer.release();
  // The computer package's own Docker provider takes the option as given (its egress options' check), built with no call
  // to Docker.
  const provider = await providerFor("docker", { daemonPath: join(scratch(), "computerd"), user: "1000:1000", egress: options.egress, image: { image: DEFAULT_DOCKER_IMAGE } });
  assert.equal(typeof provider.create, "function");
});

// A server in a container of its Docker's, its data on a named volume (compose.yaml): the Docker provider mounts the run's
// folder and its daemon copy as that volume's subpaths, so the daemon copy goes under the volume's mount, never the
// server's home. On a host, or where no such volume was found, nothing is given.
test("on a named data volume, the Docker provider gets the volume, where it is mounted, and a daemon copy under it; on a host or with no volume, none", () => {
  const compose = dockerVolumeOf({ paths: { at: "/data", volume: "agentrun_agentrun-data" } });
  assert.deepEqual(compose, { volume: { name: "agentrun_agentrun-data", root: "/data" }, daemonCache: "/data/.agentrun/computerd" });
  assert.ok(compose.daemonCache.startsWith(`${compose.volume.root}/`), "the daemon copy is under the volume's mount");
  assert.equal(dockerVolumeOf({ here: true }), undefined);
  assert.equal(dockerVolumeOf({ reason: "no named volume" }), undefined);
});

test("the claim's Docker provider is built with the named data volume where this process's Docker has the data, read once", async () => {
  let read = 0;
  const dockerPaths = async () => (read++, { paths: { at: "/data", volume: "agentrun_agentrun-data" } });
  const root = scratch();
  const sealKey = randomBytes(32);
  const store = await savedKeysStore(sealKey);
  const record = { created: [], released: [], loaded: [] };
  const load = async (id, options) => (record.loaded.push([id, options]), fakeSandbox(root, record));
  const { computerForClaim, computerDeps } = computerDepsFrom({ env: ENV, store, sealKey, kinds: KINDS, load, dockerPaths });
  for (const epoch of [3, 4]) {
    const answer = await computerForClaim({ runId: "run-1", epoch, computer: { kind: "sandbox", provider: "docker" } }, store, { ...computerDeps, mode: 1, workspace: localWorkspace(root), sealKey });
    await answer.release();
  }
  assert.deepEqual(record.loaded.map(([id, options]) => [id, options.volume, options.daemonCache]), [
    ["docker", { name: "agentrun_agentrun-data", root: "/data" }, "/data/.agentrun/computerd"],
    ["docker", { name: "agentrun_agentrun-data", root: "/data" }, "/data/.agentrun/computerd"],
  ]);
  assert.equal(read, 1, "where the Docker has the data is read once");
  // On a host: no volume and no daemon copy's place is given; the provider keeps its own.
  const host = computerDepsFrom({ env: ENV, store, sealKey, kinds: KINDS, load, dockerPaths: async () => ({ here: true }) });
  const answer = await host.computerForClaim({ runId: "run-2", epoch: 1, computer: { kind: "sandbox", provider: "docker" } }, store, { ...host.computerDeps, mode: 1, workspace: localWorkspace(root), sealKey });
  await answer.release();
  assert.deepEqual([record.loaded[2][1].volume, record.loaded[2][1].daemonCache], [undefined, undefined]);
});

// On a named data volume the Docker provider isn't on the Docker host, so its egress proxy needs the host's own
// addresses: the union of the read through the socket and AGENTRUN_DOCKER_HOST_ADDRESSES. A failed read leaves the
// operator's; with neither, none is given (the provider refuses an allow-list there, and the server's start says so).
// On a host no read is made: the provider reads its own interfaces.
test("on a named data volume the Docker provider's host addresses are the read's and the operator's, unioned; a failed read leaves the operator's; on a host nothing is read", async () => {
  const compose = async () => ({ paths: { at: "/data", volume: "agentrun_agentrun-data" } });
  // `runAllow`: the claim's own launch's box_allow (the server's default list unless given); `envAllow`: this process's
  // AGENTRUN_BOX_ALLOW now, which may differ after a restart.
  const claimWith = async ({ dockerPaths, read, named, envAllow, runAllow = [...DEFAULT_BOX_ALLOW] }) => {
    const root = scratch();
    const sealKey = randomBytes(32);
    const store = await savedKeysStore(sealKey);
    const record = { created: [], released: [], loaded: [] };
    let reads = 0;
    const load = async (id, options) => (record.loaded.push([id, options]), fakeSandbox(root, record));
    const env = { ...ENV, ...(named ? { AGENTRUN_DOCKER_HOST_ADDRESSES: named } : {}), ...(envAllow ? { AGENTRUN_BOX_ALLOW: envAllow } : {}) };
    const { computerForClaim, computerDeps } = computerDepsFrom({ env, store, sealKey, kinds: KINDS, load, dockerPaths, hostAddresses: async () => (reads++, read) });
    const answer = await computerForClaim({ runId: "run-1", epoch: 1, computer: { kind: "sandbox", provider: "docker" }, boxAllow: runAllow }, store, { ...computerDeps, mode: 1, workspace: localWorkspace(root), sealKey });
    await answer.release();
    return { egress: record.loaded[0][1].egress, reads };
  };
  assert.deepEqual(await claimWith({ dockerPaths: compose, read: { addresses: ["203.0.113.7", "172.17.0.1"] }, named: "198.51.100.9,203.0.113.7" }), { egress: { hostAddresses: ["203.0.113.7", "172.17.0.1", "198.51.100.9"] }, reads: 1 });
  assert.deepEqual(await claimWith({ dockerPaths: compose, read: { why: "it failed" }, named: "198.51.100.9" }), { egress: { hostAddresses: ["198.51.100.9"] }, reads: 1 });
  assert.deepEqual(await claimWith({ dockerPaths: compose, read: { why: "it failed" } }), { egress: undefined, reads: 1 }, "none made up");
  assert.deepEqual(await claimWith({ dockerPaths: async () => ({ here: true }), read: { addresses: ["203.0.113.7"] } }), { egress: undefined, reads: 0 }, "no read on a host");
  // The read follows the claim's own box_allow, not this process's setting now: a run launched under a list, claimed
  // after a restart under none, still gets the host's addresses for its list; a run launched under none reads nothing,
  // whatever the setting is now, and is given the operator's alone.
  assert.deepEqual(await claimWith({ dockerPaths: compose, read: { addresses: ["203.0.113.7"] }, envAllow: "none" }), { egress: { hostAddresses: ["203.0.113.7"] }, reads: 1 }, "a run's list under a process's none");
  assert.deepEqual(await claimWith({ dockerPaths: compose, read: { addresses: ["203.0.113.7"] }, runAllow: "none" }), { egress: undefined, reads: 0 }, "a run's none under a process's list");
  assert.deepEqual(await claimWith({ dockerPaths: compose, read: { addresses: ["203.0.113.7"] }, named: "198.51.100.9", runAllow: "none" }), { egress: { hostAddresses: ["198.51.100.9"] }, reads: 0 });
});

// The whole of compose's path through the computer package's own Docker provider, over its fake docker (no daemon): a
// server in a container (its host root shows /.dockerenv), its data on a named volume. With the Docker host's addresses
// found, the claim makes the default allow-list's Docker computer: the run's folder, the daemon's directory and the
// egress proxy's code all mount as the volume's subpaths, nothing is bound from this process's paths, and the proxy
// refuses the host's addresses. With none found, the provider refuses the allow-list in its words, and nothing is made.
test("on compose, the default allow-list's Docker computer is made with every mount the data volume's subpath and the proxy refusing the host's addresses; with none found, it is refused", async () => {
  const VOLUME = "agentrun_agentrun-data";
  const { fakeDocker, valuesOf } = await import("../../computer/test/fake-docker.mjs");
  for (const found of [true, false]) {
    const work = scratch();
    const root = dirname(work);
    chmodSync(work, 0o700);
    const hostRoot = join(root, "host-root");
    mkdirSync(hostRoot);
    writeFileSync(join(hostRoot, ".dockerenv"), "");
    let calls = () => [];
    const load = async (id, options) => {
      assert.equal(id, "docker");
      const made = fakeDocker({ daemonCache: options.daemonCache, volume: options.volume, volumeRoots: { [VOLUME]: root }, egressOptions: { ...(options.egress ?? {}), hostRoot } });
      calls = made.calls;
      // The computer's image is the one the owner named (AGENTRUN_DOCKER_IMAGE), on the fake's host: its readiness (the
      // provider's image(), which builds a recipe) is not this test's, so the claim is shown none and takes the name.
      return new Proxy(made.provider, { get: (target, key) => (key === "image" ? undefined : typeof target[key] === "function" ? target[key].bind(target) : target[key]) });
    };
    const sealKey = randomBytes(32);
    const store = await savedKeysStore(sealKey);
    const { computerForClaim, computerDeps } = computerDepsFrom({
      env: { ...ENV, AGENTRUN_DOCKER_IMAGE: "debian:bookworm-slim" }, store, sealKey, kinds: KINDS, load,
      dockerPaths: async () => ({ paths: { at: root, volume: VOLUME } }),
      hostAddresses: async () => (found ? { addresses: ["203.0.113.7"] } : { why: "the read through Docker's socket failed (exit 125: no image)" }),
    });
    const claim = computerForClaim({ runId: "run-1", epoch: 1, computer: { kind: "sandbox", provider: "docker" }, boxAllow: [...DEFAULT_BOX_ALLOW] }, store, { ...computerDeps, mode: 1, workspace: localWorkspace(work), sealKey });
    if (!found) {
      await assert.rejects(claim, { code: "computer_unavailable", message: /this provider runs in a container/ });
      assert.deepEqual(calls().filter((args) => args[0] === "run"), [], "nothing is made");
      continue;
    }
    const answer = await claim;
    assert.equal(answer.computer?.kind, "sandbox");
    const runs = calls().filter((args) => args[0] === "run");
    const mounts = runs.flatMap((args) => valuesOf(args, "--mount"));
    assert.ok(mounts.length >= 4, JSON.stringify(mounts));
    assert.deepEqual(mounts.filter((mount) => !mount.startsWith("type=volume,")), [], "no bind of this process's paths");
    const computer = runs.find((args) => args[args.indexOf("--entrypoint") + 1] === "/opt/agentrun/computerd");
    assert.ok(valuesOf(computer, "--mount").includes(`type=volume,src=${VOLUME},dst=/workspace,volume-subpath=work,volume-nocopy`), JSON.stringify(valuesOf(computer, "--mount")));
    const proxy = runs.find((args) => args[args.indexOf("--entrypoint") + 1] === "node");
    assert.ok(valuesOf(proxy, "--local")[0]?.split(",").includes("203.0.113.7"), `the proxy refuses the host's address: ${JSON.stringify(valuesOf(proxy, "--local"))}`);
    assert.equal(valuesOf(proxy, "--allow")[0], DEFAULT_BOX_ALLOW.join(","));
    await answer.release();
  }
});
