// The run's computer from the runner (runner/computer.ts dockerComputer) is the kinded RunComputer runTools takes
// (workspace/run-tools.ts): its kind from the run's setting (a sandbox for a plain box), its groups from the computer's
// own hello, checked against the computer module's kind registry (servingRefusals): a computer whose hello does not
// serve the kind is refused in its words, and released, never handed on. A fake provider answers; no container is made.
import assert from "node:assert/strict";
import { test } from "node:test";
import { dockerComputer } from "../dist/runner/computer.js";

const mount = { kind: "bind", path: "/tmp/run/work" };
const workspace = { mountSpec: async () => mount };
const LINUX = { version: "test", os: "linux", kind: "linux", arch: "amd64", groups: ["exec", "files", "processes"] };
const DESKTOP = { version: "test", os: "linux", kind: "desktop", arch: "amd64", groups: ["exec", "files", "processes", "screen", "input.pointer", "input.keys"] };

/** A provider stand-in whose computer says `hello`; it records its spec and each release. */
function fakeProvider(hello) {
  const state = { spec: undefined, released: [] };
  const provider = {
    id: "docker",
    version: "test",
    capabilities: () => ({}),
    check: () => [],
    async create(spec) { state.spec = spec; return { ok: true, value: { id: "c1", name: "c1" } }; },
    async connect() { return { ok: true, value: { client: { call: async () => ({ ok: true, value: {} }) }, hello, close: async () => {} } }; },
    async attach(ref) { return { ok: true, value: { id: ref.id, spec: { mount } } }; },
    async release(ref, how) { state.released.push([ref.id, how]); return { ok: true, value: undefined }; },
    async list() { return { ok: true, value: [] }; },
  };
  return { provider, state };
}

test("a plain box is a sandbox computer: its kind, the attachable computer and the mount check", async () => {
  const { provider } = fakeProvider(LINUX);
  const handle = await dockerComputer(workspace, { runId: "run-1", epoch: 3 }, async () => provider);
  assert.equal(handle.run.kind, "sandbox");
  assert.equal(handle.run.computer.id, "c1");
  assert.equal(handle.run.check.epoch, 3);
  await handle.release();
});

test("a desktop setting is a desktop computer, its groups the computer's own hello's, with the run's folder's check", async () => {
  const { provider } = fakeProvider(DESKTOP);
  const handle = await dockerComputer(workspace, { runId: "run-1", epoch: 3, kind: "desktop" }, async () => provider);
  assert.equal(handle.run.kind, "desktop");
  assert.deepEqual(handle.run.groups, DESKTOP.groups);
  assert.equal(handle.run.check.epoch, 3, "the run's folder is mounted: its check");
  await handle.release();
});

test("a computer whose hello does not serve the kind is refused in the registry's words, and released", async () => {
  const { provider, state } = fakeProvider({ ...LINUX, groups: ["exec", "files"] });
  await assert.rejects(dockerComputer(workspace, { runId: "run-1", epoch: 3 }, async () => provider), /the run's computer can't serve a sandbox: kind sandbox needs groups processes/);
  assert.deepEqual(state.released, [["c1", "delete"]], "never handed on, never leaked");
  const desktop = fakeProvider(LINUX);
  await assert.rejects(dockerComputer(workspace, { runId: "run-1", epoch: 3, kind: "desktop" }, async () => desktop.provider), /kind desktop is a desktop machine, not a linux one/);
  assert.deepEqual(desktop.state.released, [["c1", "delete"]]);
});
