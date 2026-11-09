// The run's Docker computer from module D's provider (runner/computer.ts): the spec it asks for, and how it wires create,
// connect, read-back and release. A fake provider records the spec and answers the calls, so this reads the wiring with
// no real container, no ports and no clock.
import assert from "node:assert/strict";
import { test } from "node:test";
import { dockerComputer, dockerSpec, COMPUTER_LIFETIME_MS } from "../dist/runner/computer.js";

const mount = { kind: "bind", path: "/tmp/run/work" };
const workspace = { mountSpec: async () => mount };

function fakeProvider() {
  const state = { spec: undefined, released: [], ref: { id: "c1" } };
  const provider = {
    id: "docker",
    version: "test",
    capabilities: () => ({}),
    check: () => [],
    async create(spec) { state.spec = spec; return { ok: true, value: state.ref }; },
    async connect() { return { ok: true, value: { client: { call: async () => ({ ok: true, value: {} }), close: async () => {} }, hello: { version: "test", os: "linux", kind: "linux", arch: "amd64", groups: ["exec", "files", "processes"] }, close: async () => {} } }; },
    async attach(ref) { return { ok: true, value: { id: ref.id, spec: { mount } } }; },
    async release(ref, how) { state.released.push([ref.id, how]); return { ok: true, value: undefined }; },
    async list() { return { ok: true, value: [] }; },
    async network() { return { ok: true, value: {} }; },
  };
  return { provider, state };
}

test("the Docker spec: D's default image unless one is named, the run's folder, no network, run and epoch labels", () => {
  const spec = dockerSpec({ runId: "run-1", epoch: 3 }, mount);
  assert.equal(typeof spec.image, "string");
  assert.ok(spec.image.length > 0, "an image is always named (D's default when the owner names none)");
  assert.equal(spec.lifetimeMs, COMPUTER_LIFETIME_MS);
  assert.equal(spec.network, "none");
  assert.deepEqual(spec.mount, mount);
  assert.equal(spec.labels["agentrun.run"], "run-1");
  assert.equal(spec.labels["agentrun.epoch"], "3");
});

test("the owner's image and a box allow-list are passed through", () => {
  const spec = dockerSpec({ runId: "run-1", epoch: 1, image: "example/image:tag", boxAllow: ["api.example.com"] }, mount);
  assert.equal(spec.image, "example/image:tag");
  assert.deepEqual(spec.network, { allow: ["api.example.com"] });
});

test('boxAllow "none" is no network', () => {
  assert.equal(dockerSpec({ runId: "r", epoch: 1, boxAllow: "none" }, mount).network, "none");
});

test("dockerComputer makes the computer, exposes its client and read-back, and release ends it", async () => {
  const { provider, state } = fakeProvider();
  const handle = await dockerComputer(workspace, { runId: "run-1", epoch: 3 }, async () => provider);
  // It was created with the run's spec (the folder mounted, the run/epoch labels).
  assert.deepEqual(state.spec.mount, mount);
  assert.equal(state.spec.labels["agentrun.epoch"], "3");
  assert.equal(handle.run.computer.id, "c1");
  assert.equal(typeof handle.run.computer.client.call, "function");
  assert.equal(typeof handle.run.check.readBackOf, "function");
  // The check carries the claim's epoch (D6's fence for a disk read-back).
  assert.equal(handle.run.check.epoch, 3);
  // Its read-back is the mount D made; the check reads back the same shape for the mount it asked for.
  assert.deepEqual(await handle.run.computer.readBack(), { ok: true, value: mount });
  assert.deepEqual(handle.run.check.readBackOf(mount), { kind: "bind", path: mount.path });
  await handle.release();
  assert.deepEqual(state.released, [["c1", "delete"]], "release deletes the computer");
});

test("a create that fails throws in words and leaks no computer", async () => {
  const { provider, state } = fakeProvider();
  provider.create = async () => ({ ok: false, error: { code: "denied", message: "no docker here" } });
  await assert.rejects(dockerComputer(workspace, { runId: "r", epoch: 1 }, async () => provider), /could not be made: no docker here/);
  assert.deepEqual(state.released, [], "nothing to release when create failed");
});

test("a computer that cannot be reached is released, not leaked", async () => {
  const { provider, state } = fakeProvider();
  provider.connect = async () => ({ ok: false, error: { code: "unavailable", message: "no daemon" } });
  await assert.rejects(dockerComputer(workspace, { runId: "r", epoch: 1 }, async () => provider), /could not be reached: no daemon/);
  assert.deepEqual(state.released, [["c1", "delete"]], "the made-but-unreachable computer is deleted");
});
