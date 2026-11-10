// A disk per agent in Archil mode (#2261): each agent's runs keep their folders on its own disk, made on its first run
// that uses it (agentrun-<server id>-<agent id>, idempotent by that name), unless the run's launch names another disk (a
// customer's: run-launch.ts archilDisk). The run's mount credential is minted, revoked and reclaimed on that one disk, so
// Archil refuses it on any other: no path logic of ours. Over the fake control plane (archil-control-fake.mjs, a fetch
// with no port), which holds several disks, a per-region limit and the region each disk is in, and says which disk a
// token is accepted on (`accepts`), as Archil decides it. Nothing leaves this process.
import assert from "node:assert/strict";
import { test } from "node:test";
import { adoptServerDisk, agentDiskOf, diskNameOf, loadArchilSettings, saveArchilSettings, serverIdOf, storeAgentDisk, storedAgentDisk } from "../dist/archil-settings.js";
import { archilRoute, createArchilRoutes } from "../dist/archil-routes.js";
import { ApiError } from "../dist/errors.js";
import { launchBody, readLaunchBody } from "../dist/run-launch.js";
import { ArchilClaimRefused, archilClaim } from "../dist/workspace/index.js";
import { limitOf } from "../dist/workspace/archil-disks.js";
import { archilControlFetch } from "./archil-control-fake.mjs";
import { storeOn } from "./store-helpers.mjs";
import { serve } from "./support.mjs";

const API = "fake-archil-account-key-0001";
const REGION = "aws-us-east-1";
const SETTINGS = { region: REGION, s3Url: "https://s3.green.us-east-1.aws.prod.archil.com" };
/** A customer's disk a launch names, in the key's region, and one in another region. */
const CUSTOMER = "dsk-c0570000000000c1";
const ELSEWHERE = "dsk-e15e0000000000e1";

/** The store in Archil mode, and the fake control plane holding `disks` (the customer's, by default). */
async function setup(t, fakeOptions = {}) {
  const { store } = await storeOn(t);
  await saveArchilSettings(store, SETTINGS);
  const control = archilControlFetch({ region: REGION, strict: true, disks: [{ id: CUSTOMER, name: "customer-1" }, { id: ELSEWHERE, name: "customer-eu", region: "aws-eu-west-1" }], ...fakeOptions });
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
  assert.deepEqual(await storedAgentDisk(env.store, "agent-a"), { diskId: a.disk, own: true }, "stored on the agent");
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
  assert.equal(await storedAgentDisk(env.store, "agent-a"), undefined);
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
  assert.equal(await storedAgentDisk(counted.store, "agent-c"), undefined, "no disk stored, none shared");
  const unnumbered = await setup(t, { limit: 1, limitWords: "Disk limit reached for this account" });
  await assert.rejects(claimOf(unnumbered, { agentId: "agent-c" }), (error) => error instanceof ArchilClaimRefused && /your Archil plan's disk limit is reached; upgrade or delete an agent/.test(error.message));
  assert.equal(limitOf("free accounts may have at most 5 disks per region"), 5);
});

test("a launch's disk in another region, or none of that id, refuses the run in words naming the region", async (t) => {
  const env = await setup(t);
  await assert.rejects(claimOf(env, { agentId: "agent-a", launch: { diskId: ELSEWHERE, kind: "launch" } }), (error) => error instanceof ArchilClaimRefused && error.message === `The disk ${ELSEWHERE} is in region aws-eu-west-1, and this server's Archil key is for region ${REGION}: name a disk in ${REGION}.`);
  await assert.rejects(claimOf(env, { agentId: "agent-a", launch: { diskId: "dsk-0000000000000bad", kind: "launch" } }), (error) => error instanceof ArchilClaimRefused && error.message.includes(`no disk dsk-0000000000000bad in region ${REGION}`));
  assert.equal(posts(env.control, "/api/disks/dsk-e15e0000000000e1/users").length, 0, "nothing minted");
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

test("removing an agent's disk deletes its own at Archil, only once it is archived with no live run; a launch's disk and the old shared one are never deleted", async (t) => {
  const env = await setup(t);
  const routes = createArchilRoutes({ store: env.store, sealKey: Buffer.alloc(32), env: { ARCHIL_API_KEY: API }, control: { baseUrl: env.control.baseUrl, fetch: env.control.fetch } });
  const own = await claimOf(env, { agentId: "agent-a" });
  await claimOf(env, { agentId: "agent-a", runId: "run-customer", launch: { diskId: CUSTOMER, kind: "launch" } });
  const call = (name, agent) => archilRoute(routes, name, { agent });
  assert.deepEqual(await call("getAgentArchil", { id: "agent-a", archived: false, live: 0 }), { on: true, archil_disk: { disk_id: own.disk, own: true } });
  assert.ok(!JSON.stringify(await call("getAgentArchil", { id: "agent-a", archived: false, live: 0 })).includes(API), "never a key");
  await assert.rejects(call("deleteAgentArchil", { id: "agent-a", archived: false, live: 0 }), (error) => error instanceof ApiError && error.code === "precondition_failed" && /archive it first/.test(error.message));
  await assert.rejects(call("deleteAgentArchil", { id: "agent-a", archived: true, live: 1 }), (error) => error instanceof ApiError && error.code === "precondition_failed" && /live run/.test(error.message));
  assert.ok(env.control.disks.has(own.disk), "nothing removed on a refusal");
  const removed = await call("deleteAgentArchil", { id: "agent-a", archived: true, live: 0 });
  assert.deepEqual(removed, { on: true, archil_disk: null, removed: { disk_id: own.disk, deleted_at_archil: true } });
  assert.equal(env.control.disks.has(own.disk), false, "its own disk deleted at Archil");
  assert.equal(env.control.disks.has(CUSTOMER), true, "the customer's disk its run named is left alone");
  assert.deepEqual(env.control.requests.filter((one) => one.method === "DELETE" && /^\/api\/disks\/[^/]+$/.test(one.path)).map((one) => one.path), [`/api/disks/${own.disk}`]);
  // The old server-wide disk an agent was given at the cutover: forgotten, never deleted.
  await storeAgentDisk(env.store, "agent-old", { diskId: CUSTOMER, own: false });
  assert.deepEqual((await call("deleteAgentArchil", { id: "agent-old", archived: true, live: 0 })).removed, { disk_id: CUSTOMER, deleted_at_archil: false });
  assert.equal(env.control.disks.has(CUSTOMER), true);
});

test("the cutover: a row still naming the old server-wide disk gives it to every agent with none, then drops it; an agent made after has its own", async (t) => {
  const { store } = await storeOn(t);
  const OLD = "dsk-0000000000000001";
  await saveArchilSettings(store, { ...SETTINGS, diskId: OLD });
  assert.deepEqual(await agentDiskOf(store, "agent-new"), { diskId: OLD, own: false }, "before the start adopts it, every agent reads it");
  await storeAgentDisk(store, "agent-mine", { diskId: "dsk-000000000000aaaa", own: true });
  assert.deepEqual(await adoptServerDisk(store, ["agent-1", "agent-2", "agent-mine"]), ["agent-1", "agent-2"]);
  assert.deepEqual(await storedAgentDisk(store, "agent-1"), { diskId: OLD, own: false });
  assert.deepEqual(await storedAgentDisk(store, "agent-mine"), { diskId: "dsk-000000000000aaaa", own: true }, "an agent with its own keeps it");
  assert.deepEqual(await loadArchilSettings(store), SETTINGS, "the row no longer names a disk");
  assert.equal(await agentDiskOf(store, "agent-3"), undefined, "an agent made after has none until its first run makes it");
  assert.deepEqual(await adoptServerDisk(store, ["agent-3"]), [], "once only");
});

test("the launch names a disk on POST /runs (inline) and POST /agents/{id}/runs; its record keeps it, or the agent's, and Mode 1 refuses it", { timeout: 120_000 }, async (t) => {
  const { api, store } = await serve(t, { runner: false });
  const inline = (extra = {}) => ({ external: { source: "grep", kind: "expert", id: "7", version: 1 }, definition: { name: "Expert 7", instructions: "Answer.", skills: [], tools: [] }, input: { content: "Hi" }, ...extra });
  const off = await api("POST", "/runs", inline({ archil_disk: { disk_id: CUSTOMER } }));
  assert.deepEqual([off.status, off.body.error?.fields?.[0]?.field], [422, "archil_disk"], JSON.stringify(off.body));
  await saveArchilSettings(store, SETTINGS);
  const recordOf = async (runId) => readLaunchBody((await store.runs.launch(runId)).body).archilDisk;
  const named = await api("POST", "/runs", inline({ archil_disk: { disk_id: CUSTOMER } }));
  assert.equal(named.status, 202, JSON.stringify(named.body));
  assert.deepEqual(await recordOf(named.body.run_id), { diskId: CUSTOMER, kind: "launch" }, "the inline launch carries the customer's disk");
  const agentId = named.body.agent_id;
  const plain = await api("POST", `/agents/${agentId}/runs`, { input: { content: "Hi" } });
  assert.equal(plain.status, 202, JSON.stringify(plain.body));
  assert.equal(await recordOf(plain.body.run_id), undefined, "no disk yet: the claim makes the agent's");
  await storeAgentDisk(store, agentId, { diskId: "dsk-000000000000aaaa", own: true });
  const later = await api("POST", `/agents/${agentId}/runs`, { input: { content: "Hi" } });
  assert.deepEqual(await recordOf(later.body.run_id), { diskId: "dsk-000000000000aaaa", kind: "agent" }, "the agent's disk, kept as the agent's");
  for (const bad of [{ disk_id: "nope" }, { disk_id: CUSTOMER, region: "aws-eu-west-1" }, { disk_id: CUSTOMER, key: API }]) {
    const refused = await api("POST", `/agents/${agentId}/runs`, { input: { content: "Hi" }, archil_disk: bad });
    assert.equal(refused.status, 422, JSON.stringify(bad));
  }
  const view = await api("GET", `/agents/${agentId}/archil`);
  assert.deepEqual([view.status, view.body], [200, { on: true, archil_disk: { disk_id: "dsk-000000000000aaaa", own: true } }]);
});
