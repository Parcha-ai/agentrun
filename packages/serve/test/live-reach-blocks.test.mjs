// Runners that are replicas of one deployment (pods of one Kubernetes deployment, a platform's instances) have no host
// name the server resolves, and a new address at each start. AGENTRUN_RUNNER_LIVE_HOST and AGENTRUN_RUNNER_HOSTS take an
// IPv4 block for them: the runner answers at its own address in the block, and the server dials any IPv4 address in it,
// and nothing outside it.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { dialHost, ipv4BlockOf, ipv4Of, liveReachOf, reachForRun, RunnerLiveRefused, runnerLiveOf } from "../dist/live-reach.js";
import { checkRunnerEnv } from "../dist/runner/runner-check.js";

/** A test seal key, no real one. */
const KEY = randomBytes(32);

/** A machine's interfaces as node:os lists them: loopback, the pod's own address, and whatever else `more` adds. */
const interfacesOf = (...more) => () => ({
  lo: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: true, cidr: "127.0.0.1/8" }],
  eth0: [
    { address: "10.32.46.210", netmask: "255.255.255.0", family: "IPv4", mac: "02:00:00:00:00:01", internal: false, cidr: "10.32.46.210/24" },
    { address: "fe80::1", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", mac: "02:00:00:00:00:01", internal: false, cidr: "fe80::1/64", scopeid: 2 },
  ],
  ...Object.fromEntries(more.map((address, i) => [`eth${i + 1}`, [{ address, netmask: "255.255.255.0", family: "IPv4", mac: "02:00:00:00:00:02", internal: false, cidr: `${address}/24` }]])),
});

test("an IPv4 block reads only as its network address and a prefix from /8 to /32", () => {
  assert.deepEqual(ipv4BlockOf("10.32.0.0/14"), { base: ipv4Of("10.32.0.0"), bits: 14 });
  assert.deepEqual(ipv4BlockOf("10.32.46.210/32"), { base: ipv4Of("10.32.46.210"), bits: 32 });
  for (const not of ["10.33.0.0/14", "10.0.0.0/7", "0.0.0.0/0", "10.32.0.0/33", "10.32.0.0", "10.32.0/14", "010.32.0.0/14", "10.32.0.0/014", "256.0.0.0/8", "runner-1", "10.32.0.0/14/1", " 10.32.0.0/14"]) {
    assert.equal(ipv4BlockOf(not), undefined, not);
  }
  assert.equal(ipv4Of("10.32.46.210"), (10 << 24 >>> 0) + (32 << 16) + (46 << 8) + 210);
  assert.equal(ipv4Of("10.32.46.2100"), undefined);
});

test("the server dials an address in one of its runners' blocks, and no address outside them, nor a name", () => {
  const reach = liveReachOf({ AGENTRUN_RUNNER_HOSTS: "runner-1, 10.32.0.0/14,not a host,10.33.0.0/14" }, KEY);
  assert.equal(reach.blocks.length, 1, "a block that is not its network address is left out, as a host that is no host is");
  assert.equal(dialHost("10.32.46.210", reach), "10.32.46.210");
  assert.equal(dialHost("10.35.255.255", reach), "10.35.255.255");
  assert.equal(dialHost("10.36.0.1", reach), undefined, "past the block's end");
  assert.equal(dialHost("10.31.255.255", reach), undefined, "before its start");
  assert.equal(dialHost("runner-1", reach), "runner-1", "the hosts it names still dial");
  assert.equal(dialHost("runner-2", reach), undefined);
  assert.equal(dialHost("10.32.0.0/14", reach), undefined, "a row naming the block itself is no host");
  assert.equal(dialHost(undefined, reach), "127.0.0.1", "loopback, as before");
  assert.equal(dialHost("10.32.46.210", undefined), undefined, "no reach: nothing off loopback");
  assert.equal(dialHost("10.32.46.210", liveReachOf({}, KEY)), undefined, "no runners' hosts: nothing off loopback");
  // A run's reach keeps the blocks under the run's own key.
  const run = reachForRun(reach, "run-1");
  assert.equal(dialHost("10.32.46.210", run), "10.32.46.210");
  assert.notDeepEqual(run.key, reach.key);
});

test("a runner given a block answers at its own one address in it, and listens there", () => {
  const live = runnerLiveOf({ AGENTRUN_RUNNER_LIVE_HOST: "10.32.0.0/14" }, KEY, interfacesOf());
  assert.equal(live.host, "10.32.46.210");
  assert.equal(live.bind, "10.32.46.210");
  const bound = runnerLiveOf({ AGENTRUN_RUNNER_LIVE_HOST: "10.32.0.0/14", AGENTRUN_RUNNER_LIVE_BIND: "0.0.0.0" }, KEY, interfacesOf());
  assert.equal(bound.host, "10.32.46.210");
  assert.equal(bound.bind, "0.0.0.0");
  // A name or an address is taken as given, as before, and the interfaces are never read.
  const never = () => assert.fail("a host that is no block reads no interface");
  assert.equal(runnerLiveOf({ AGENTRUN_RUNNER_LIVE_HOST: "Runner-1" }, KEY, never).host, "runner-1");
  assert.equal(runnerLiveOf({}, KEY, never), undefined);
  // The server dials what the runner says.
  assert.equal(dialHost(live.host, liveReachOf({ AGENTRUN_RUNNER_HOSTS: "10.32.0.0/14" }, KEY)), live.host);
});

test("a runner whose block holds none or several of its addresses is refused in words, never left on loopback", () => {
  assert.throws(() => runnerLiveOf({ AGENTRUN_RUNNER_LIVE_HOST: "10.64.0.0/14" }, KEY, interfacesOf()), (error) => error instanceof RunnerLiveRefused && /10\.64\.0\.0\/14, and no network interface of this machine has an IPv4 address in it/.test(error.message));
  assert.throws(() => runnerLiveOf({ AGENTRUN_RUNNER_LIVE_HOST: "10.32.0.0/14" }, KEY, interfacesOf("10.33.0.7")), (error) => error instanceof RunnerLiveRefused && /2 IPv4 addresses in it \(10\.32\.46\.210, 10\.33\.0\.7\)/.test(error.message));
  // Loopback's own interface is never this runner's address, whatever block names it.
  assert.throws(() => runnerLiveOf({ AGENTRUN_RUNNER_LIVE_HOST: "127.0.0.0/8" }, KEY, interfacesOf()), RunnerLiveRefused);
});

test("runner --check says where the server reaches the runner, and fails a block that holds none of its addresses", async () => {
  const rowOf = async (env, interfaces) => (await checkRunnerEnv({ env, read: (name) => env[name], answers: async () => true, dataDir: "/nonexistent-agentrun-check", interfaces })).find((row) => row.name === "AGENTRUN_RUNNER_LIVE_HOST");
  assert.deepEqual(await rowOf({ AGENTRUN_RUNNER_LIVE_HOST: "10.32.0.0/14" }, interfacesOf()), { state: "ok", name: "AGENTRUN_RUNNER_LIVE_HOST", why: "the server reaches this runner's relay and viewers at 10.32.46.210" });
  const none = await rowOf({ AGENTRUN_RUNNER_LIVE_HOST: "10.64.0.0/14" }, interfacesOf());
  assert.equal(none.state, "bad");
  assert.match(none.why, /no network interface of this machine/);
  assert.equal((await rowOf({ AGENTRUN_RUNNER_LIVE_HOST: "127.0.0.1" }, interfacesOf())).state, "warn");
  assert.equal(await rowOf({}, interfacesOf()), undefined, "unset: no row, as before");
});
