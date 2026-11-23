// The Docker host's own addresses, read through its socket for a server in a container (docker-host-addresses.ts): one
// short-lived container on the host's network, as nobody, with no capability, its answer the host's interface addresses
// and what host.docker.internal resolves to; unioned with AGENTRUN_DOCKER_HOST_ADDRESSES, never made up. A read that runs
// out of time, or fails, has its container removed by name, and a name Docker didn't confirm gone is removed at the next
// read. A failed read at the start is tried again in the background until one answers. A docker stand-in, or the tests'
// fake docker, answers here: nothing reaches a daemon.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { EGRESS_IMAGE } from "@parcha/agentrun-computer";
import * as hostRead from "../dist/docker-host-addresses.js";
import { scratch } from "./support.mjs";

const { addressesOf, helperName, noHostAddresses, READ_MS, readArgsOf, readHostAddresses, unionOf } = hostRead;
const NAME = "agentrun-host-read-0123456789ab";
const ARGS = readArgsOf(NAME);
const flag = (name) => ARGS[ARGS.indexOf(name) + 1];
/** Docker's answers: `rm -f` removes, and `inspect` says it has no such container. */
const GONE = { code: 1, stdout: "", stderr: `Error: No such object: ${NAME}` };
const removed = (args) => (args[0] === "rm" ? { code: 0, stdout: `${args.at(-1)}\n`, stderr: "" } : { code: 1, stdout: "", stderr: `Error: No such object: ${args.at(-1)}` });
/** An environment of its own, so the names a read keeps (by its docker's environment) are this case's alone. */
let envs = 0;
const ownEnv = () => ({ PATH: `/nonexistent/case-${++envs}` });
const ANSWER = { code: 0, stdout: `${JSON.stringify({ interfaces: ["203.0.113.7"], gateway: [] })}\n`, stderr: "" };

test("the read runs one named container on the host's network, removed at its exit, as nobody, with no capability, no new privileges, a read-only root and small limits, from the egress proxy's pinned image", () => {
  assert.equal(ARGS[0], "run");
  for (const one of ["--rm", "--read-only"]) assert.ok(ARGS.includes(one), one);
  assert.deepEqual(
    [flag("--name"), flag("--network"), flag("--user"), flag("--cap-drop"), flag("--security-opt"), flag("--memory"), flag("--pids-limit"), flag("--add-host"), flag("--entrypoint")],
    [NAME, "host", "65534:65534", "ALL", "no-new-privileges", "64m", "32", "host.docker.internal:host-gateway", "node"],
  );
  assert.equal(ARGS[ARGS.indexOf("--entrypoint") + 2], EGRESS_IMAGE, "the image every Docker computer with an allow-list needs");
  assert.equal(READ_MS, 60_000);
  const [one, two] = [helperName(), helperName()];
  assert.match(one, /^agentrun-host-read-[0-9a-f]{12}$/);
  assert.notEqual(one, two, "a fresh name per read");
});

test("its answer gives the host's interface addresses and host.docker.internal's (a Desktop's way back to the Mac), each once, loopback and link-local left out, a scoped address's zone cut", () => {
  const answer = JSON.stringify({
    interfaces: ["127.0.0.1", "::1", "172.17.0.1", "203.0.113.7", "2001:db8::7", "fe80::1%eth0", "169.254.10.1", "203.0.113.7"],
    gateway: ["192.168.65.254"],
  });
  assert.deepEqual(addressesOf(answer), ["172.17.0.1", "203.0.113.7", "2001:db8::7", "192.168.65.254"]);
  assert.deepEqual(addressesOf(JSON.stringify({ interfaces: ["2001:db8::8%2", "not an address", 7] })), ["2001:db8::8"]);
});

test("a read that fails or answers what is not its list gives no addresses, saying why; the operator's still count, the union never one or the other", async () => {
  const answering = (result) => async (args, ms) => (args[0] === "run" ? (assert.deepEqual([args, ms], [ARGS, READ_MS]), result) : removed(args));
  const read = (result) => readHostAddresses(ownEnv(), answering(result), READ_MS, NAME);
  assert.deepEqual(await read(ANSWER), { addresses: ["203.0.113.7"] });
  assert.deepEqual(await read({ code: 125, stdout: "", stderr: "Unable to find image\n" }), { why: "the read through Docker's socket failed (exit 125: Unable to find image)" });
  assert.deepEqual(await read({ code: 0, stdout: "<html>", stderr: "" }), { why: "the read through Docker's socket answered what is not its list (<html>)" });

  assert.deepEqual(unionOf({ addresses: ["203.0.113.7", "172.17.0.1"] }, ["198.51.100.9", "203.0.113.7"]), { addresses: ["203.0.113.7", "172.17.0.1", "198.51.100.9"] });
  assert.deepEqual(unionOf({ why: "it failed" }, ["198.51.100.9"]), { addresses: ["198.51.100.9"], why: "it failed" });
  assert.deepEqual(unionOf({ why: "it failed" }, undefined), { addresses: [], why: "it failed" });
  assert.equal(noHostAddresses("it failed"), "the server runs in a container and doesn't know the Docker host's own addresses (it failed), so a Docker computer can't keep this server's allow-list: set AGENTRUN_DOCKER_HOST_ADDRESSES to the host's IP addresses, or AGENTRUN_BOX_ALLOW=none for no network");
});

test("a read that runs out of time removes its container by name and checks it is gone, saying so; one still there, or one Docker can't say of, is named with the way to remove it", async () => {
  const DAEMON = "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?";
  for (const [inspected, why] of [
    [{ code: 1, stdout: "", stderr: `Error: No such object: ${NAME}` }, "the read through Docker's socket took over 60 s (its container was removed)"],
    [{ code: 1, stdout: "", stderr: `Error response from daemon: No such container: ${NAME}` }, "the read through Docker's socket took over 60 s (its container was removed)"],
    [{ code: 0, stdout: "true\n", stderr: "" }, `the read through Docker's socket took over 60 s (its container ${NAME} is still there: remove it with docker rm -f ${NAME})`],
    // A daemon that didn't answer says nothing of the container: it may still run.
    [{ code: 1, stdout: "", stderr: `${DAEMON}\n` }, `the read through Docker's socket took over 60 s (its container ${NAME} may still be running (docker inspect failed: ${DAEMON}): remove it with docker rm -f ${NAME})`],
    [{ code: "timeout", stdout: "", stderr: "" }, `the read through Docker's socket took over 60 s (its container ${NAME} may still be running (docker inspect failed: exit timeout): remove it with docker rm -f ${NAME})`],
  ]) {
    const calls = [];
    const docker = async (args) => {
      calls.push(args);
      if (args[0] === "run") return { code: "timeout", stdout: "", stderr: "" };
      if (args[0] === "rm") return { code: 0, stdout: `${NAME}\n`, stderr: "" };
      return inspected;
    };
    assert.deepEqual(await readHostAddresses(ownEnv(), docker, READ_MS, NAME), { why });
    assert.deepEqual(calls.map((args) => args.slice(0, 2)), [["run", "--rm"], ["rm", "-f"], ["inspect", "--type"]]);
    assert.deepEqual([calls[1].at(-1), calls[2].at(-1)], [NAME, NAME]);
  }
});

// Through the tests' fake docker, whose read stalls while `host-addresses-hold` is in its state (its container made and
// running, the client never answering): the read's client is killed at its bound, and its container is removed.
test("a stalled read's container is removed through the fake docker, and the read says so", { timeout: 60_000 }, async (t) => {
  const dir = await scratch(t);
  const bin = join(dir, "bin");
  const state = join(dir, "state");
  await mkdir(bin);
  await mkdir(join(state, "containers"), { recursive: true });
  const fake = new URL("./fixtures/fake-docker.mjs", import.meta.url).pathname;
  await writeFile(join(bin, "docker"), `#!/bin/sh\nexec '${process.execPath}' '${fake}' "$@"\n`, { mode: 0o755 });
  await writeFile(join(state, "host-addresses-hold"), "");
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_DOCKER_STATE: state };
  const name = helperName();
  assert.deepEqual(await readHostAddresses(env, undefined, 2_000, name), { why: "the read through Docker's socket took over 2 s (its container was removed)" });
  assert.equal(existsSync(join(state, "host-reads.jsonl")), true, "the read was made");
  // The same, its daemon failing the check (`inspect-fail` in the fake's state): the container may still run, and the
  // read says so with the way to remove it.
  await writeFile(join(state, "inspect-fail"), "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?");
  const again = helperName();
  assert.deepEqual(await readHostAddresses(env, undefined, 2_000, again), { why: `the read through Docker's socket took over 2 s (its container ${again} may still be running (docker inspect failed: Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?): remove it with docker rm -f ${again})` });
  // The daemon answers again: the next read removes that container first, by its name, and drops the name once Docker
  // says it has no such container; the read after it removes nothing.
  await rm(join(state, "inspect-fail"));
  await rm(join(state, "host-addresses-hold"));
  const calls = () => readFileSync(join(state, "argv.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const before = calls().length;
  assert.deepEqual(await readHostAddresses(env, undefined, 2_000, helperName()), { addresses: [] });
  assert.deepEqual(calls().slice(before).map((args) => [args[0], args.at(-1) === again]), [["rm", true], ["inspect", true], ["run", false]]);
  const after = calls().length;
  assert.deepEqual(await readHostAddresses(env, undefined, 2_000, helperName()), { addresses: [] });
  assert.deepEqual(calls().slice(after).map((args) => args[0]), ["run"]);
});

test("a read that fails with no timeout (exit non-zero) removes the container its client may have made, by name: its why says so only when the container is still there; one Docker can't say of is removed at the next read; a docker that never ran made none", async () => {
  const DAEMON = "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?";
  const FAILED = "the read through Docker's socket failed (exit 125: docker: Error response from daemon: context deadline exceeded)";
  for (const [inspected, why, kept] of [
    [GONE, FAILED, false],
    [{ code: 0, stdout: "false\n", stderr: "" }, `${FAILED} (its container ${NAME} is still there: remove it with docker rm -f ${NAME})`, true],
    [{ code: 1, stdout: "", stderr: `${DAEMON}\n` }, FAILED, true],
  ]) {
    const env = ownEnv();
    const calls = [];
    let check = inspected;
    const docker = async (args) => {
      calls.push(args);
      if (args[0] === "run") return args.includes(NAME) ? { code: 125, stdout: "", stderr: "docker: Error response from daemon: context deadline exceeded\n" } : ANSWER;
      return args[0] === "rm" ? { code: 0, stdout: `${NAME}\n`, stderr: "" } : check;
    };
    assert.deepEqual(await readHostAddresses(env, docker, READ_MS, NAME), { why });
    assert.deepEqual(calls.map((args) => args[0]), ["run", "rm", "inspect"]);
    assert.deepEqual([calls[1].at(-1), calls[2].at(-1)], [NAME, NAME]);
    // Docker says it has no such container now: the next read removes a name not confirmed gone first, and only that.
    calls.length = 0;
    check = GONE;
    assert.deepEqual(await readHostAddresses(env, docker, READ_MS, "agentrun-host-read-ffffffffffff"), { addresses: ["203.0.113.7"] });
    assert.deepEqual(calls.map((args) => args[0]), kept ? ["rm", "inspect", "run"] : ["run"], JSON.stringify(why));
  }
  // A docker that never ran (not on PATH: the spawn's error, no exit code) made no container: nothing is removed.
  const calls = [];
  const missing = async (args) => (calls.push(args), { code: "ENOENT", stdout: "", stderr: "" });
  assert.deepEqual(await readHostAddresses(ownEnv(), missing, READ_MS, NAME), { why: "the read through Docker's socket failed (exit ENOENT: )" });
  assert.deepEqual(calls.map((args) => args[0]), ["run"]);
});

test("a read's container whose removal timed out is removed at the next read, by its name, and dropped once Docker says it has no such container; one Docker still has stays named", async () => {
  const env = ownEnv();
  const OTHER = "agentrun-host-read-aaaaaaaaaaaa";
  const calls = [];
  // What Docker says: NAME's first check runs out of time, and it is gone after; OTHER's container is there until its
  // third removal.
  let nameChecks = 0;
  let otherLeft = 2;
  const docker = async (args) => {
    calls.push(args);
    const name = args.at(-1);
    if (args[0] === "run") return args.includes(NAME) || args.includes(OTHER) ? { code: "timeout", stdout: "", stderr: "" } : ANSWER;
    if (args[0] === "rm") return name === NAME ? { code: "timeout", stdout: "", stderr: "" } : { code: 0, stdout: `${name}\n`, stderr: "" };
    if (name === NAME) return ++nameChecks === 1 ? { code: "timeout", stdout: "", stderr: "" } : { code: 1, stdout: "", stderr: `Error: No such container: ${NAME}` };
    return otherLeft-- > 0 ? { code: 0, stdout: "true\n", stderr: "" } : { code: 1, stdout: "", stderr: `Error: No such object: ${OTHER}` };
  };
  // The first read runs out of time, and so do its container's removal and the check: its name is kept.
  assert.deepEqual(await readHostAddresses(env, docker, READ_MS, NAME), { why: `the read through Docker's socket took over 60 s (its container ${NAME} may still be running (docker inspect failed: exit timeout): remove it with docker rm -f ${NAME})` });
  // The second removes NAME first (gone now), then runs out of time itself, its container still there: OTHER is kept.
  calls.length = 0;
  assert.deepEqual(await readHostAddresses(env, docker, READ_MS, OTHER), { why: `the read through Docker's socket took over 60 s (its container ${OTHER} is still there: remove it with docker rm -f ${OTHER})` });
  assert.deepEqual(calls.map((args) => `${args[0]} ${args.at(-1) === NAME ? "NAME" : args.at(-1) === OTHER ? "OTHER" : "-"}`), ["rm NAME", "inspect NAME", "run -", "rm OTHER", "inspect OTHER"]);
  // The third removes OTHER, which Docker still has: it stays named, and NAME, gone, is not asked of again.
  calls.length = 0;
  assert.deepEqual(await readHostAddresses(env, docker, READ_MS, helperName()), { addresses: ["203.0.113.7"] });
  assert.deepEqual(calls.map((args) => `${args[0]} ${args.at(-1) === OTHER ? "OTHER" : "-"}`), ["rm OTHER", "inspect OTHER", "run -"]);
  // The fourth removes it again, Docker says it has no such container now, and the fifth asks of no name.
  calls.length = 0;
  await readHostAddresses(env, docker, READ_MS, helperName());
  assert.deepEqual(calls.map((args) => `${args[0]} ${args.at(-1) === OTHER ? "OTHER" : "-"}`), ["rm OTHER", "inspect OTHER", "run -"]);
  calls.length = 0;
  await readHostAddresses(env, docker, READ_MS, helperName());
  assert.deepEqual(calls.map((args) => args[0]), ["run"]);
});

test("a failed read is tried again in the background, waiting 15 s, 30 s, 60 s, 120 s, then 240 s each time, until one answers: two that run out of time, then the host's addresses", async () => {
  const { retryHostAddresses, RETRY_MS } = hostRead;
  assert.deepEqual(RETRY_MS, [15_000, 30_000, 60_000, 120_000, 240_000]);
  const env = ownEnv();
  let runs = 0;
  const docker = async (args) => (args[0] === "run" ? (++runs <= 2 ? { code: "timeout", stdout: "", stderr: "" } : ANSWER) : removed(args));
  const waited = [];
  const found = [];
  await retryHostAddresses({ env, docker, read: () => readHostAddresses(env, docker, READ_MS), found: (read) => found.push(read), signal: new AbortController().signal, wait: async (ms) => void waited.push(ms) });
  assert.deepEqual(waited, [15_000, 30_000, 60_000], "a wait before each read");
  assert.deepEqual(found, [{ addresses: ["203.0.113.7"] }]);
  assert.equal(runs, 3);
  // A read that keeps failing: the last wait again each time, and nothing found until one answers.
  let failing = 8;
  const later = [];
  const kept = [];
  await retryHostAddresses({ env: ownEnv(), read: async () => (failing-- > 0 ? { why: "it failed" } : { addresses: [] }), found: (read) => kept.push(read), signal: new AbortController().signal, wait: async (ms) => void later.push(ms) });
  assert.deepEqual(later, [15_000, 30_000, 60_000, 120_000, 240_000, 240_000, 240_000, 240_000, 240_000]);
  assert.deepEqual(kept, [{ addresses: [] }], "a read that answers stops it, though it found none");
});

test("after a read answers, the retry goes on removing the containers the failed reads left, on the same waits, until Docker says none is left; a removal whose check gets no answer ends that sweep", async () => {
  const { retryHostAddresses } = hostRead;
  const env = ownEnv();
  const calls = [];
  // Docker has the first read's container for three checks: the read that made it, the read that answers, and the
  // retry's first sweep after the answer.
  let there = 3;
  let runs = 0;
  const docker = async (args) => {
    calls.push(args[0]);
    if (args[0] === "run") return ++runs === 1 ? { code: "timeout", stdout: "", stderr: "" } : ANSWER;
    if (args[0] === "rm") return { code: 0, stdout: "", stderr: "" };
    return there-- > 0 ? { code: 0, stdout: "true\n", stderr: "" } : { code: 1, stdout: "", stderr: `Error: No such object: ${args.at(-1)}` };
  };
  const waited = [];
  const found = [];
  await retryHostAddresses({ env, docker, read: () => readHostAddresses(env, docker, READ_MS), found: (read) => found.push(read), signal: new AbortController().signal, wait: async (ms) => void waited.push(ms) });
  assert.deepEqual(found, [{ addresses: ["203.0.113.7"] }], "found once");
  assert.deepEqual(waited, [15_000, 30_000, 60_000, 120_000]);
  assert.deepEqual(calls, ["run", "rm", "inspect", "rm", "inspect", "run", "rm", "inspect", "rm", "inspect"], "no read after the answer: removals alone");
  assert.equal(runs, 2);

  // Two names kept; the daemon stops answering checks: the sweep ends at the first, and the second waits.
  const swept = ownEnv();
  const asked = [];
  let check = { code: 0, stdout: "true\n", stderr: "" };
  const stuck = async (args) => (asked.push(`${args[0]} ${args.at(-1).startsWith("agentrun-host-read-") ? args.at(-1).slice(-1) : "-"}`), args[0] === "run" ? { code: 125, stdout: "", stderr: "failed\n" } : args[0] === "rm" ? { code: 0, stdout: "", stderr: "" } : check);
  await readHostAddresses(swept, stuck, READ_MS, "agentrun-host-read-00000000000a");
  await readHostAddresses(swept, stuck, READ_MS, "agentrun-host-read-00000000000b");
  asked.length = 0;
  check = { code: "timeout", stdout: "", stderr: "" };
  await readHostAddresses(swept, stuck, READ_MS, "agentrun-host-read-00000000000c");
  assert.deepEqual(asked, ["rm a", "inspect a", "run -", "rm c", "inspect c"]);
});

test("the retry stops at close: its pending wait ends at once and no read follows; a read in flight at the close is not taken; no timer is left", async () => {
  const { retryHostAddresses } = hostRead;
  // Closed while it waits (the default wait, its first 15 s): it ends at once, with no read and no timer left.
  const timers = () => process.getActiveResourcesInfo().filter((one) => one === "Timeout").length;
  const idle = timers();
  const stopping = new AbortController();
  let reads = 0;
  const found = [];
  const retried = retryHostAddresses({ env: ownEnv(), read: async () => (reads++, { addresses: ["203.0.113.7"] }), found: (read) => found.push(read), signal: stopping.signal });
  assert.equal(timers(), idle + 1, "its wait's timer");
  stopping.abort();
  await retried;
  assert.deepEqual([reads, found, timers()], [0, [], idle]);
  // Closed while a read is in flight: the read's answer is not taken, and no wait or read follows.
  const closing = new AbortController();
  let answer;
  const waits = [];
  const inFlight = retryHostAddresses({ env: ownEnv(), read: () => new Promise((resolve) => (answer = resolve)), found: (read) => found.push(read), signal: closing.signal, wait: async (ms) => void waits.push(ms) });
  while (!answer) await new Promise(setImmediate);
  closing.abort();
  answer({ addresses: ["203.0.113.7"] });
  await inFlight;
  assert.deepEqual([waits, found], [[15_000], []]);
  // Closed before it starts: no wait, no read.
  await retryHostAddresses({ env: ownEnv(), read: async () => assert.fail("no read after the close"), found: () => assert.fail("nothing found"), signal: AbortSignal.abort(), wait: async () => assert.fail("no wait after the close") });
});
