// The Docker host's own addresses, read through its socket for a server in a container (docker-host-addresses.ts): one
// short-lived container on the host's network, as nobody, with no capability, its answer the host's interface addresses
// and what host.docker.internal resolves to; unioned with AGENTRUN_DOCKER_HOST_ADDRESSES, never made up. A docker
// stand-in answers here: nothing reaches a daemon.
import assert from "node:assert/strict";
import { test } from "node:test";
import { EGRESS_IMAGE } from "@parcha/agentrun-computer";
import { addressesOf, noHostAddresses, READ_ARGS, READ_MS, readHostAddresses, unionOf } from "../dist/docker-host-addresses.js";

const flag = (name) => READ_ARGS[READ_ARGS.indexOf(name) + 1];

test("the read runs one container on the host's network, removed at its exit, as nobody, with no capability, no new privileges, a read-only root and small limits, from the egress proxy's pinned image", () => {
  assert.equal(READ_ARGS[0], "run");
  for (const one of ["--rm", "--read-only"]) assert.ok(READ_ARGS.includes(one), one);
  assert.deepEqual(
    [flag("--network"), flag("--user"), flag("--cap-drop"), flag("--security-opt"), flag("--memory"), flag("--pids-limit"), flag("--add-host"), flag("--entrypoint")],
    ["host", "65534:65534", "ALL", "no-new-privileges", "64m", "32", "host.docker.internal:host-gateway", "node"],
  );
  assert.equal(READ_ARGS[READ_ARGS.indexOf("--entrypoint") + 2], EGRESS_IMAGE, "the image every Docker computer with an allow-list needs");
  assert.equal(READ_MS, 60_000);
});

test("its answer gives the host's interface addresses and host.docker.internal's (a Desktop's way back to the Mac), each once, loopback and link-local left out, a scoped address's zone cut", () => {
  const answer = JSON.stringify({
    interfaces: ["127.0.0.1", "::1", "172.17.0.1", "203.0.113.7", "2001:db8::7", "fe80::1%eth0", "169.254.10.1", "203.0.113.7"],
    gateway: ["192.168.65.254"],
  });
  assert.deepEqual(addressesOf(answer), ["172.17.0.1", "203.0.113.7", "2001:db8::7", "192.168.65.254"]);
  assert.deepEqual(addressesOf(JSON.stringify({ interfaces: ["2001:db8::8%2", "not an address", 7] })), ["2001:db8::8"]);
});

test("a read that fails, takes too long or answers what is not its list gives no addresses, saying why; the operator's still count, the union never one or the other", async () => {
  const answering = (result) => async (args, ms) => (assert.deepEqual([args, ms], [READ_ARGS, READ_MS]), result);
  assert.deepEqual(await readHostAddresses({}, answering({ code: 0, stdout: `${JSON.stringify({ interfaces: ["203.0.113.7"], gateway: [] })}\n`, stderr: "" })), { addresses: ["203.0.113.7"] });
  assert.deepEqual(await readHostAddresses({}, answering({ code: 125, stdout: "", stderr: "Unable to find image\n" })), { why: "the read through Docker's socket failed (exit 125: Unable to find image)" });
  assert.deepEqual(await readHostAddresses({}, answering({ code: "timeout", stdout: "", stderr: "" })), { why: "the read through Docker's socket failed (it took over 60 s)" });
  assert.deepEqual(await readHostAddresses({}, answering({ code: 0, stdout: "<html>", stderr: "" })), { why: "the read through Docker's socket answered what is not its list (<html>)" });

  assert.deepEqual(unionOf({ addresses: ["203.0.113.7", "172.17.0.1"] }, ["198.51.100.9", "203.0.113.7"]), { addresses: ["203.0.113.7", "172.17.0.1", "198.51.100.9"] });
  assert.deepEqual(unionOf({ why: "it failed" }, ["198.51.100.9"]), { addresses: ["198.51.100.9"], why: "it failed" });
  assert.deepEqual(unionOf({ why: "it failed" }, undefined), { addresses: [], why: "it failed" });
  assert.equal(noHostAddresses("it failed"), "the server runs in a container and doesn't know the Docker host's own addresses (it failed), so a Docker computer can't keep this server's allow-list: set AGENTRUN_DOCKER_HOST_ADDRESSES to the host's IP addresses, or AGENTRUN_BOX_ALLOW=none for no network");
});
