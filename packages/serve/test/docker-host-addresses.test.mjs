// The Docker host's own addresses, read through its socket for a server in a container (docker-host-addresses.ts): one
// short-lived container on the host's network, as nobody, with no capability, its answer the host's interface addresses
// and what host.docker.internal resolves to; unioned with AGENTRUN_DOCKER_HOST_ADDRESSES, never made up. A read that runs
// out of time has its container removed by name. A docker stand-in, or the tests' fake docker, answers here: nothing
// reaches a daemon.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { EGRESS_IMAGE } from "@parcha/agentrun-computer";
import { addressesOf, helperName, noHostAddresses, READ_MS, readArgsOf, readHostAddresses, unionOf } from "../dist/docker-host-addresses.js";
import { scratch } from "./support.mjs";

const NAME = "agentrun-host-read-0123456789ab";
const ARGS = readArgsOf(NAME);
const flag = (name) => ARGS[ARGS.indexOf(name) + 1];

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
  const answering = (result) => async (args, ms) => (assert.deepEqual([args, ms], [ARGS, READ_MS]), result);
  const read = (result) => readHostAddresses({}, answering(result), READ_MS, NAME);
  assert.deepEqual(await read({ code: 0, stdout: `${JSON.stringify({ interfaces: ["203.0.113.7"], gateway: [] })}\n`, stderr: "" }), { addresses: ["203.0.113.7"] });
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
    assert.deepEqual(await readHostAddresses({}, docker, READ_MS, NAME), { why });
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
});
