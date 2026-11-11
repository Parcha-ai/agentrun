// A disk per agent in Archil mode (#2261): each agent's runs keep their folders on its own disk, made on its first run
// that uses it (agentrun-<server id>-i-<agent id>, idempotent by that name), unless the run's launch names another disk (a
// customer's: run-launch.ts archilDisk), which is read at Archil at the launch (a 422 before any run is made) and again
// at the claim. The run's mount credential is minted, revoked and reclaimed on that one disk, so Archil refuses it on any
// other: no path logic of ours. There is no server-wide disk and no fallback to one. Over the fake control plane
// (archil-control-fake.mjs, a fetch with no port), which holds several disks, a per-region limit and the region each disk
// is in, and says which disk a token is accepted on (`accepts`), as Archil decides it. Nothing leaves this process.
import assert from "node:assert/strict";
import { test } from "node:test";
import { agentDiskOf, ARCHIL_SETTINGS_KEY, diskNameOf, forgetAgentDisk, loadArchilSettings, saveArchilSettings, serverIdOf, storeAgentDisk } from "../dist/archil-settings.js";
import { archilRoute, createArchilRoutes, liveRunsOnDisk } from "../dist/archil-routes.js";
import { ApiError } from "../dist/errors.js";
import { launchBody, readLaunchBody } from "../dist/run-launch.js";
import { ArchilClaimRefused, archilClaim } from "../dist/workspace/index.js";
import { limitOf } from "../dist/workspace/archil-disks.js";
import { archilControlFetch } from "./archil-control-fake.mjs";
import { storeOn } from "./store-helpers.mjs";
import { serve, withEnv } from "./support.mjs";

const API = "fake-archil-account-key-0001";
const REGION = "aws-us-east-1";
const SETTINGS = { region: REGION, s3Url: "https://s3.green.us-east-1.aws.prod.archil.com" };
/** A customer's disk a launch names, in the key's region, and one in another region. */
const CUSTOMER = "dsk-c0570000000000c1";
const ELSEWHERE = "dsk-e15e0000000000e1";
const MISSING = "dsk-0000000000000bad";
const SEEDED = [{ id: CUSTOMER, name: "customer-1" }, { id: ELSEWHERE, name: "customer-eu", region: "aws-eu-west-1" }];

/** The store in Archil mode, and the fake control plane holding `disks` (the customer's, by default). */
async function setup(t, fakeOptions = {}) {
  const { store } = await storeOn(t);
  await saveArchilSettings(store, SETTINGS);
  const control = archilControlFetch({ region: REGION, strict: true, disks: SEEDED, ...fakeOptions });
  return { store, control };
}

/** A claim of run `runId` of agent `agentId`, epoch `epoch`, with the disk its launch names (if any); the disk the claim
 *  makes is captured, not made. */
async function claimOf({ store, control }, { agentId, runId = `run-${agentId}`, epoch = 1, launch, signal = new AbortController().signal }) {
  const made = [];
  const claim = await archilClaim({
    settings: await loadArchilSettings(store),
    keys: store.sealedKeys,
    sealKey: undefined,
    env: { ARCHIL_API_KEY: API },
    signal,
    makeDisk: (options) => { made.push(options); return { id: options.disk }; },
    mount: { runId, epoch, ttlMs: 3_600_000, baseUrl: control.baseUrl, fetch: control.fetch },
    run: { agentId, ...(launch ? { launch } : {}), store },
  });
  return { claim, disk: made[0].disk };
}

const posts = (control, path) => control.requests.filter((one) => one.method === "POST" && one.path === path);

test("two agents get two disks, each made on its agent's first run and named for the server and the agent; no default token stands", async (t) => {
  const env = await setup(t);
  const a = await claimOf(env, { agentId: "agent-a" });
  const b = await claimOf(env, { agentId: "agent-b" });
  assert.notEqual(a.disk, b.disk, "one disk per agent");
  const server = await serverIdOf(env.store);
  assert.deepEqual([...env.control.disks.values()].filter((disk) => disk.name.startsWith("agentrun-")).map((disk) => disk.name).sort(), [diskNameOf(server, "agent-a"), diskNameOf(server, "agent-b")]);
  assert.deepEqual(await agentDiskOf(env.store, "agent-a"), { diskId: a.disk }, "stored on the agent");
  assert.deepEqual([a.claim.diskKind, b.claim.diskKind], ["agent", "agent"]);
  assert.deepEqual([...env.control.users.values()].filter((user) => user.nickname === "default"), [], "Archil's default token user of each made disk is removed at once");
  // A second run of agent A uses the disk it has: nothing is made.
  const again = await claimOf(env, { agentId: "agent-a", runId: "run-a-2" });
  assert.equal(again.disk, a.disk);
  assert.equal(posts(env.control, "/api/disks").length, 2, "one make per agent");
});

test("agent A's run token is minted on A's disk and refused on B's disk and on any other", async (t) => {
  const env = await setup(t);
  const b = await claimOf(env, { agentId: "agent-b" });
  const a = await claimOf(env, { agentId: "agent-a" });
  const token = await a.claim.token();
  assert.deepEqual(posts(env.control, `/api/disks/${a.disk}/users`).map((one) => one.body.nickname), ["agentrun:run-agent-a:1"], "minted on A's disk");
  assert.equal(env.control.accepts(a.disk, token), true, "A's disk takes it");
  assert.equal(env.control.accepts(b.disk, token), false, "B's disk refuses it");
  assert.equal(env.control.accepts(CUSTOMER, token), false, "any other disk refuses it");
  await a.claim.revoke();
  assert.equal(env.control.accepts(a.disk, token), false, "revoked on A's disk");
});

test("a launch's disk wins over the agent's: the token is minted there, and the agent's disk is neither made nor used", async (t) => {
  const env = await setup(t);
  const run = await claimOf(env, { agentId: "agent-a", launch: { diskId: CUSTOMER, kind: "launch" } });
  assert.deepEqual([run.disk, run.claim.diskKind], [CUSTOMER, "launch"]);
  const token = await run.claim.token();
  assert.equal(env.control.accepts(CUSTOMER, token), true);
  assert.equal(posts(env.control, "/api/disks").length, 0, "an agent whose runs name a disk has none made");
  assert.equal(await agentDiskOf(env.store, "agent-a"), undefined);
  // An agent with its own disk: a launch's still wins.
  const own = await claimOf(env, { agentId: "agent-b" });
  const named = await claimOf(env, { agentId: "agent-b", runId: "run-b-2", launch: { diskId: CUSTOMER, kind: "launch" } });
  assert.notEqual(own.disk, CUSTOMER);
  assert.equal(named.disk, CUSTOMER);
});

test("the plan's disk limit refuses the run in words, with Archil's number or without one; nothing is shared instead", async (t) => {
  // The region holds the customer's disk; a limit of 2 takes one agent's disk more.
  const counted = await setup(t, { limit: 2 });
  await claimOf(counted, { agentId: "agent-a" });
  await assert.rejects(claimOf(counted, { agentId: "agent-c" }), (error) => error instanceof ArchilClaimRefused && error.message === "This agent's Archil disk can't be made: your Archil plan allows 2 disks; upgrade or delete an agent.");
  assert.equal(await agentDiskOf(counted.store, "agent-c"), undefined, "no disk stored, none shared");
  const unnumbered = await setup(t, { limit: 1, limitWords: "Disk limit reached for this account" });
  await assert.rejects(claimOf(unnumbered, { agentId: "agent-c" }), (error) => error instanceof ArchilClaimRefused && /your Archil plan's disk limit is reached; upgrade or delete an agent/.test(error.message));
  assert.equal(limitOf("free accounts may have at most 5 disks per region"), 5);
});

test("the claim's backstop: a launch's disk in another region, or one removed since the launch, refuses the run in words naming the region", async (t) => {
  const env = await setup(t);
  await assert.rejects(claimOf(env, { agentId: "agent-a", launch: { diskId: ELSEWHERE, kind: "launch" } }), (error) => error instanceof ArchilClaimRefused && error.message === `The disk ${ELSEWHERE} is in region aws-eu-west-1, and this server's Archil key is for region ${REGION}: name a disk in ${REGION}.`);
  await assert.rejects(claimOf(env, { agentId: "agent-a", launch: { diskId: MISSING, kind: "launch" } }), (error) => error instanceof ArchilClaimRefused && error.message.includes(`no disk ${MISSING} in region ${REGION}`));
  assert.equal(posts(env.control, `/api/disks/${ELSEWHERE}/users`).length, 0, "nothing minted");
});

test("a restart keeps the run's disk: its launch record names it, and the reclaim and revoke act on it", async (t) => {
  const env = await setup(t);
  // The launch record as the server writes it and a runner reads it back.
  const record = readLaunchBody(launchBody({ input: {}, title: "t", place: { mode: "runner" }, archilDisk: { diskId: CUSTOMER, kind: "launch" } }));
  assert.deepEqual(record.archilDisk, { diskId: CUSTOMER, kind: "launch" });
  const first = await claimOf(env, { agentId: "agent-a", runId: "run-r", epoch: 1, launch: record.archilDisk });
  const old = await first.claim.token();
  // The runner dies: epoch 1 is neither revoked nor released. A new runner claims epoch 2 from the same record.
  const second = await claimOf(env, { agentId: "agent-a", runId: "run-r", epoch: 2, launch: record.archilDisk });
  assert.equal(second.disk, CUSTOMER, "the same disk after the restart");
  const fresh = await second.claim.token();
  assert.equal(env.control.accepts(CUSTOMER, old), false, "the reclaim removed epoch 1's token on that disk");
  assert.equal(env.control.accepts(CUSTOMER, fresh), true);
  await second.claim.revoke();
  assert.deepEqual([...env.control.users.values()].filter((user) => user.disk === CUSTOMER), [], "revoked on that disk");
  assert.ok(env.control.requests.filter((one) => one.method === "DELETE").every((one) => one.path.startsWith(`/api/disks/${CUSTOMER}/`)), "every remove went to the run's disk");
});

test("making an agent's disk is idempotent: two first runs at once, a 200 for the name, or a 409 resolved by listing it", async (t) => {
  const env = await setup(t);
  const [one, two] = await Promise.all([claimOf(env, { agentId: "agent-a", runId: "r1" }), claimOf(env, { agentId: "agent-a", runId: "r2" })]);
  assert.equal(one.disk, two.disk, "one disk");
  assert.equal([...env.control.disks.values()].filter((disk) => disk.name.startsWith("agentrun-")).length, 1);
  // The agent's stored disk forgotten (a store restored from before): the make answers the one of its name.
  await env.store.settings.remove("archil.agent.agent-a");
  const again = await claimOf(env, { agentId: "agent-a", runId: "r3" });
  assert.equal(again.disk, one.disk, "Archil's 200 names the disk already there");
  // Archil's 409 (the name is there with another configuration): found by its name.
  let conflicts = 0;
  const conflicted = await setup(t, { answer: ({ method, path }) => (method === "POST" && path === "/api/disks" && conflicts++ === 1 ? { status: 409, body: { success: false, error: "disk exists with different configuration" } } : undefined) });
  const first = await claimOf(conflicted, { agentId: "agent-a" });
  await conflicted.store.settings.remove("archil.agent.agent-a");
  const resolved = await claimOf(conflicted, { agentId: "agent-a", runId: "r9" });
  assert.equal(resolved.disk, first.disk);
  assert.ok(conflicted.control.requests.some((one) => one.method === "GET" && one.path === "/api/disks" && one.query.name), "listed by its name");
});

/** An agent as the dispatch hands it to an agent's Archil route, with `live` runs on any disk asked about. */
const agentOf = (id, { archived = false, external = false, live = 0 } = {}) => ({ id, archived, external, liveOn: async () => live });

test("removing an agent's disk deletes it at Archil, only once the agent is archived with no live run on it; a launch's disk is never touched", async (t) => {
  const env = await setup(t);
  const routes = createArchilRoutes({ store: env.store, sealKey: Buffer.alloc(32), env: { ARCHIL_API_KEY: API }, control: { baseUrl: env.control.baseUrl, fetch: env.control.fetch } });
  const own = await claimOf(env, { agentId: "agent-a" });
  await claimOf(env, { agentId: "agent-a", runId: "run-customer", launch: { diskId: CUSTOMER, kind: "launch" } });
  const call = (name, agent) => archilRoute(routes, name, { agent });
  assert.deepEqual(await call("getAgentArchil", agentOf("agent-a")), { on: true, archil_disk: { disk_id: own.disk } });
  assert.ok(!JSON.stringify(await call("getAgentArchil", agentOf("agent-a"))).includes(API), "never a key");
  await assert.rejects(call("deleteAgentArchil", agentOf("agent-a")), (error) => error instanceof ApiError && error.code === "precondition_failed" && /archive it first/.test(error.message));
  const asked = [];
  const busy = { ...agentOf("agent-a", { archived: true }), liveOn: async (disk) => (asked.push(disk), 1) };
  await assert.rejects(call("deleteAgentArchil", busy), (error) => error instanceof ApiError && error.code === "precondition_failed" && /1 live run is on the agent agent-a's disk/.test(error.message));
  assert.deepEqual(asked, [own.disk], "the live runs counted are those on its disk");
  assert.ok(env.control.disks.has(own.disk), "nothing removed on a refusal");
  const removed = await call("deleteAgentArchil", agentOf("agent-a", { archived: true }));
  assert.deepEqual(removed, { on: true, archil_disk: null, removed: { disk_id: own.disk } });
  assert.equal(env.control.disks.has(own.disk), false, "its disk deleted at Archil");
  assert.equal(env.control.disks.has(CUSTOMER), true, "the customer's disk its run named is left alone");
  assert.deepEqual(env.control.requests.filter((one) => one.method === "DELETE" && /^\/api\/disks\/[^/]+$/.test(one.path)).map((one) => one.path), [`/api/disks/${own.disk}`]);
});

test("an agent its source manages (an inline run's, never archived here) has its disk removed with no archive, once no live run is on it", async (t) => {
  const env = await setup(t);
  const routes = createArchilRoutes({ store: env.store, sealKey: Buffer.alloc(32), env: { ARCHIL_API_KEY: API }, control: { baseUrl: env.control.baseUrl, fetch: env.control.fetch } });
  const own = await claimOf(env, { agentId: "agent-inline" });
  const call = (agent) => archilRoute(routes, "deleteAgentArchil", { agent });
  await assert.rejects(call(agentOf("agent-inline", { external: true, live: 2 })), (error) => error instanceof ApiError && error.code === "precondition_failed" && /2 live runs are on/.test(error.message));
  assert.ok(env.control.disks.has(own.disk));
  assert.deepEqual(await call(agentOf("agent-inline", { external: true })), { on: true, archil_disk: null, removed: { disk_id: own.disk } });
  assert.equal(env.control.disks.has(own.disk), false);
});

test("the live runs on an agent's disk are any agent's: a run whose launch names the disk, a run of the agent whose launch names none, and a run whose launch can't be read", async () => {
  const DISK = "dsk-a000000000000001";
  const runs = [
    { id: "b-names-a", agentId: "agent-b", state: "running", disk: { diskId: DISK, kind: "launch" } },
    { id: "a-plain", agentId: "agent-a", state: "queued" },
    { id: "a-own", agentId: "agent-a", state: "parked", disk: { diskId: DISK, kind: "agent" } },
    { id: "b-plain", agentId: "agent-b", state: "running" },
    { id: "c-other", agentId: "agent-c", state: "running", disk: { diskId: CUSTOMER, kind: "launch" } },
    { id: "a-elsewhere", agentId: "agent-a", state: "running", disk: { diskId: CUSTOMER, kind: "launch" } },
    { id: "unreadable", agentId: "agent-c", state: "running", unreadable: true },
    { id: "b-ended", agentId: "agent-b", state: "ended", disk: { diskId: DISK, kind: "launch" } },
  ];
  const store = {
    list: async ({ state }) => runs.filter((run) => run.state === state),
    launch: async (id) => {
      const run = runs.find((one) => one.id === id);
      if (run.unreadable) throw new Error("no launch");
      return { runId: id, body: launchBody({ input: {}, title: "t", place: { mode: "runner" }, ...(run.disk ? { archilDisk: run.disk } : {}) }) };
    },
  };
  assert.equal(await liveRunsOnDisk(store, "agent-a", DISK), 4, "b-names-a, a-plain, a-own and unreadable");
});

test("a disk found there already (Archil's 200 or 409) loses a default token an earlier make failed to remove; a run's token on it stays", async (t) => {
  let failOnce = true;
  const env = await setup(t, { answer: ({ method, path }) => (method === "DELETE" && /\/users\/token$/.test(path) && failOnce ? ((failOnce = false), { status: 500, body: { success: false, error: "try again" } }) : undefined) });
  await assert.rejects(claimOf(env, { agentId: "agent-a" }), (error) => error instanceof ArchilClaimRefused && /default token/.test(error.message));
  assert.equal([...env.control.users.values()].filter((user) => user.nickname === "default").length, 1, "the failed removal left it");
  assert.equal(await agentDiskOf(env.store, "agent-a"), undefined, "no disk stored");
  // A run's token on that disk (a run of another first claim), which is the run's to revoke.
  const made = [...env.control.disks.values()].find((disk) => disk.name.startsWith("agentrun-"));
  env.control.users.set("run-token", { type: "token", token: "run-held", identifier: "run-token", nickname: "agentrun:run-x:1", disk: made.id });
  const again = await claimOf(env, { agentId: "agent-a", runId: "run-a-2" });
  assert.equal(again.disk, made.id, "Archil's 200 names it");
  assert.deepEqual([...env.control.users.values()].filter((user) => user.disk === made.id).map((user) => user.nickname), ["agentrun:run-x:1"], "the default token is gone, the run's stays");
});

test("disk names: an id Archil takes is i-<id>, any other h-<its safe characters>-<24 hex>; no id's name is another's", () => {
  const server = "0123456789ab";
  assert.equal(diskNameOf(server, "agent-a"), "agentrun-0123456789ab-i-agent-a");
  const dotted = diskNameOf(server, "a.b");
  assert.match(dotted, /^agentrun-0123456789ab-h-a_b-[0-9a-f]{24}$/);
  const lookalike = dotted.slice("agentrun-0123456789ab-".length);
  assert.notEqual(diskNameOf(server, lookalike), dotted, "an id spelled as another's hashed part names another disk");
  assert.notEqual(diskNameOf(server, "a_b"), dotted);
  const long = "x".repeat(47);
  assert.match(diskNameOf(server, long), /^agentrun-0123456789ab-h-x{21}-[0-9a-f]{24}$/);
  assert.equal(diskNameOf(server, "x".repeat(46)), `agentrun-0123456789ab-i-${"x".repeat(46)}`);
  for (const id of ["agent-a", "a.b", long]) assert.ok(diskNameOf(server, id).length - "agentrun-0123456789ab-".length <= 48, id);
});

test("no migration: an old row's server-wide diskId is dropped, and an existing agent gets its own disk on its first run, as a new one does", async (t) => {
  const env = await setup(t);
  const OLD = "dsk-0000000000000001";
  await env.store.settings.put(ARCHIL_SETTINGS_KEY, { ...SETTINGS, diskId: OLD });
  assert.deepEqual(await loadArchilSettings(env.store), SETTINGS, "the old disk is no setting");
  assert.equal(await agentDiskOf(env.store, "agent-old"), undefined, "no agent is given it");
  const run = await claimOf(env, { agentId: "agent-old" });
  assert.notEqual(run.disk, OLD, "its own disk, made now");
  assert.ok(!env.control.requests.some((one) => one.path.includes(OLD)), "nothing asked of the old disk");
});

test("the launch names a disk on POST /runs (inline) and POST /agents/{id}/runs: read at Archil first, kept in its record; a missing or other-region disk, or Mode 1, is a 422 with no run made", { timeout: 120_000 }, async (t) => {
  withEnv(t, { ARCHIL_API_KEY: API });
  const control = archilControlFetch({ region: REGION, strict: true, disks: SEEDED });
  const { api, store } = await serve(t, { runner: false, archilControl: { baseUrl: control.baseUrl, fetch: control.fetch } });
  const inline = (extra = {}) => ({ external: { source: "grep", kind: "expert", id: "7", version: 1 }, definition: { name: "Expert 7", instructions: "Answer.", skills: [], tools: [] }, input: { content: "Hi" }, ...extra });
  const runs = async () => (await store.runs.list({})).length;
  const off = await api("POST", "/runs", inline({ archil_disk: { disk_id: CUSTOMER } }));
  assert.deepEqual([off.status, off.body.error?.fields?.[0]?.field], [422, "archil_disk"], JSON.stringify(off.body));
  await saveArchilSettings(store, SETTINGS);
  // Refused at the launch, before any run is made, in the claim's words.
  for (const [disk, words] of [[MISSING, `Archil has no disk ${MISSING} in region ${REGION}`], [ELSEWHERE, `The disk ${ELSEWHERE} is in region aws-eu-west-1, and this server's Archil key is for region ${REGION}`]]) {
    const refused = await api("POST", "/runs", inline({ archil_disk: { disk_id: disk } }));
    assert.equal(refused.status, 422, JSON.stringify(refused.body));
    assert.equal(refused.body.error.fields[0].field, "archil_disk.disk_id");
    assert.ok(refused.body.error.fields[0].message.startsWith(words), refused.body.error.fields[0].message);
    assert.ok(!JSON.stringify(refused.body).includes(API), "never the key");
  }
  assert.equal(await runs(), 0, "no run made");
  const recordOf = async (runId) => readLaunchBody((await store.runs.launch(runId)).body).archilDisk;
  const named = await api("POST", "/runs", inline({ archil_disk: { disk_id: CUSTOMER } }));
  assert.equal(named.status, 202, JSON.stringify(named.body));
  assert.deepEqual(await recordOf(named.body.run_id), { diskId: CUSTOMER, kind: "launch" }, "the inline launch carries the customer's disk");
  assert.deepEqual(control.requests.filter((one) => one.method === "GET").map((one) => one.path), [`/api/disks/${MISSING}`, `/api/disks/${ELSEWHERE}`, `/api/disks/${CUSTOMER}`], "one read of the disk per launch that names one");
  const agentId = named.body.agent_id;
  const refusedAgentRun = await api("POST", `/agents/${agentId}/runs`, { input: { content: "Hi" }, archil_disk: { disk_id: MISSING } });
  assert.equal(refusedAgentRun.status, 422, JSON.stringify(refusedAgentRun.body));
  assert.equal(await runs(), 1, "still the one run");
  const plain = await api("POST", `/agents/${agentId}/runs`, { input: { content: "Hi" } });
  assert.equal(plain.status, 202, JSON.stringify(plain.body));
  assert.equal(await recordOf(plain.body.run_id), undefined, "no disk yet: the claim makes the agent's");
  await storeAgentDisk(store, agentId, { diskId: "dsk-000000000000aaaa" });
  const later = await api("POST", `/agents/${agentId}/runs`, { input: { content: "Hi" } });
  assert.deepEqual(await recordOf(later.body.run_id), { diskId: "dsk-000000000000aaaa", kind: "agent" }, "the agent's disk, kept as the agent's");
  for (const bad of [{ disk_id: "nope" }, { disk_id: "acme/customer-1" }, { disk_id: CUSTOMER, region: "aws-eu-west-1" }, { disk_id: CUSTOMER, key: API }]) {
    const refused = await api("POST", `/agents/${agentId}/runs`, { input: { content: "Hi" }, archil_disk: bad });
    assert.equal(refused.status, 422, JSON.stringify(bad));
  }
  const view = await api("GET", `/agents/${agentId}/archil`);
  assert.deepEqual([view.status, view.body], [200, { on: true, archil_disk: { disk_id: "dsk-000000000000aaaa" } }]);
  // While the agent's disk is being removed, no run of it starts on that disk; one naming a customer's disk still does.
  await storeAgentDisk(store, agentId, { diskId: "dsk-000000000000aaaa", removing: true });
  const before = await runs();
  const removing = await api("POST", `/agents/${agentId}/runs`, { input: { content: "Hi" } });
  assert.equal(removing.status, 409, JSON.stringify(removing.body));
  assert.equal(removing.body.error.code, "agent_not_runnable");
  assert.match(removing.body.error.message, /disk dsk-000000000000aaaa is being removed/);
  assert.equal(await runs(), before, "no run made");
  const customer = await api("POST", `/agents/${agentId}/runs`, { input: { content: "Hi" }, archil_disk: { disk_id: CUSTOMER } });
  assert.equal(customer.status, 202, JSON.stringify(customer.body));
});

test("a removal marks the disk removing before it counts the live runs, and a refusal gives the disk back; a claim never mounts an agent's disk being removed or removed", async (t) => {
  const env = await setup(t);
  const routes = createArchilRoutes({ store: env.store, sealKey: Buffer.alloc(32), env: { ARCHIL_API_KEY: API }, control: { baseUrl: env.control.baseUrl, fetch: env.control.fetch } });
  const own = await claimOf(env, { agentId: "agent-a" });
  const seen = [];
  const counting = { ...agentOf("agent-a", { archived: true }), liveOn: async () => (seen.push(await agentDiskOf(env.store, "agent-a")), 1) };
  await assert.rejects(archilRoute(routes, "deleteAgentArchil", { agent: counting }), (error) => error instanceof ApiError && error.code === "precondition_failed");
  assert.deepEqual(seen, [{ diskId: own.disk, removing: true }], "marked removing while the runs are counted");
  assert.deepEqual(await agentDiskOf(env.store, "agent-a"), { diskId: own.disk }, "the refusal gives it back");

  // A removal under way (or one whose server stopped mid-way): a claim of a run whose launch recorded the agent's disk,
  // or of one that recorded none, is refused.
  await storeAgentDisk(env.store, "agent-a", { diskId: own.disk, removing: true });
  await assert.rejects(claimOf(env, { agentId: "agent-a", runId: "run-recorded", launch: { diskId: own.disk, kind: "agent" } }), (error) => error instanceof ArchilClaimRefused && /was its agent's, and it is being removed/.test(error.message));
  await assert.rejects(claimOf(env, { agentId: "agent-a", runId: "run-plain" }), (error) => error instanceof ArchilClaimRefused && /is being removed/.test(error.message));
  // The removal called again finishes it. A run whose launch recorded the disk is then refused; one that recorded none
  // makes a new disk.
  assert.deepEqual(await archilRoute(routes, "deleteAgentArchil", { agent: agentOf("agent-a", { archived: true }) }), { on: true, archil_disk: null, removed: { disk_id: own.disk } });
  await assert.rejects(claimOf(env, { agentId: "agent-a", runId: "run-late", launch: { diskId: own.disk, kind: "agent" } }), (error) => error instanceof ArchilClaimRefused && /has been removed/.test(error.message));
  assert.equal(posts(env.control, `/api/disks/${own.disk}/users`).length, 0, "nothing minted on it");
  const fresh = await claimOf(env, { agentId: "agent-a", runId: "run-new" });
  assert.notEqual(fresh.disk, own.disk, "a new disk");
});

test("one agent's disk removals are taken in turn, and each touches the stored row only while it names its own disk: a disk stored since is never forgotten or overwritten", async (t) => {
  const env = await setup(t);
  const routes = createArchilRoutes({ store: env.store, sealKey: Buffer.alloc(32), env: { ARCHIL_API_KEY: API }, control: { baseUrl: env.control.baseUrl, fetch: env.control.fetch } });
  const own = await claimOf(env, { agentId: "agent-a" });
  const NEWER = "dsk-000000000000beef";
  // Two removals at once: the second counts nothing until the first is done.
  let release;
  const gate = new Promise((done) => { release = done; });
  const counted = [];
  const first = archilRoute(routes, "deleteAgentArchil", { agent: { ...agentOf("agent-a", { archived: true }), liveOn: async (disk) => (counted.push(`first ${disk}`), await gate, 0) } });
  const second = archilRoute(routes, "deleteAgentArchil", { agent: { ...agentOf("agent-a", { archived: true }), liveOn: async (disk) => (counted.push(`second ${disk}`), 0) } });
  await new Promise((done) => setTimeout(done, 20));
  assert.deepEqual(counted, [`first ${own.disk}`], "the second waits for the first");
  release();
  assert.deepEqual((await first).removed, { disk_id: own.disk });
  assert.deepEqual(await second, { on: true, archil_disk: null, removed: null }, "the second finds the disk gone, and nothing to remove");
  assert.deepEqual(counted, [`first ${own.disk}`]);

  // A disk stored while a removal ran (a run's, after the old row went): the removal's refusal does not put its own back.
  const again = await claimOf(env, { agentId: "agent-a", runId: "run-2" });
  const replacing = { ...agentOf("agent-a", { archived: true }), liveOn: async () => (await storeAgentDisk(env.store, "agent-a", { diskId: NEWER }), 1) };
  await assert.rejects(archilRoute(routes, "deleteAgentArchil", { agent: replacing }), (error) => error instanceof ApiError && error.code === "precondition_failed");
  assert.deepEqual(await agentDiskOf(env.store, "agent-a"), { diskId: NEWER }, "the newer disk kept, not overwritten");
  assert.ok(env.control.disks.has(again.disk), "nothing deleted on the refusal");
  // forgetAgentDisk forgets only the disk it names.
  await forgetAgentDisk(env.store, "agent-a", again.disk);
  assert.deepEqual(await agentDiskOf(env.store, "agent-a"), { diskId: NEWER });
  await forgetAgentDisk(env.store, "agent-a", NEWER);
  assert.equal(await agentDiskOf(env.store, "agent-a"), undefined);
});
