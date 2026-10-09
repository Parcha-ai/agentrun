// Which file of the winner's run goes home, with fixtures built like the trainer's (f32ToBase64 weights): the combined
// walk + getup file when it is clean, current and loadable; the walk file alone otherwise, saying why; none when the walk
// file itself is refused.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { f32ToBase64, type PolicyFile } from "../../policy/policy.ts";
import { chooseHomePolicy, MIN_WALK_M, strictPolicy, type PolicyFileRead } from "../home-policy.ts";

const xml = '<mujoco model="creature"/>';
const sha = createHash("sha256").update(xml).digest("hex");
const nj = 2;
const layer = (value: number) => [{ in: 2, out: nj, w: f32ToBase64(new Float32Array(2 * nj).fill(value)), b: f32ToBase64(new Float32Array(nj)), act: "none" as const }];
const net = (value: number): PolicyFile => ({
  format: "mlp-v1", spec_version: 1, mujoco_version: "3.15.0", mjcf_sha256: sha, control_dt: 0.02,
  obs: { spec: [{ name: "phase", size: 2 }], mean: [0, 0], std: [1, 1] }, clock: { gait_hz: 2 },
  act: { scale: 0.5, clip: 1 }, layers: layer(value),
});
const walk = (steps: number, metres: number) => ({ ...net(0.1), provenance: { steps, walk_10s: { distance_m: metres } } });
const getup = (steps: number) => ({ ...net(0.2), provenance: { steps } });
const combined = (walkSteps: number, getupSteps: number, weight = 0.1) => ({
  ...net(weight),
  getup: { layers: layer(0.2), switch: { below_up: 0.3, above_up: 0.9 } },
  provenance: { walk: { steps: walkSteps }, getup: { steps: getupSteps } },
});

function sources(files: Record<string, unknown>, raw: Record<string, string> = {}, times: Record<string, number> = {}) {
  return {
    read: async (path: string): Promise<PolicyFileRead | null> => {
      const text = raw[path] ?? (files[path] !== undefined ? JSON.stringify(files[path]) : undefined);
      return text === undefined ? null : { text, ...(times[path] !== undefined ? { mtimeMs: times[path] } : {}) };
    },
    universe: "u3",
    creatureXml: xml,
    nj,
  };
}
const good = { "train/u3/policy.json": walk(200, 4.8), "getup/policy.json": getup(150), "home/policy.json": combined(200, 150) };

test("the combined policy goes home when it is clean, current and the tab loads it", async () => {
  assert.deepEqual(await chooseHomePolicy(sources(good)), { path: "home/policy.json", getup: true });
});

test("1: NaN anywhere, the base64 weights included, sends the walk policy home alone", async () => {
  // What Python's json.dump writes for float('nan') in obs.mean.
  const nanText = JSON.stringify(combined(200, 150)).replace('"mean":[0,0]', '"mean":[0,NaN]');
  let choice = await chooseHomePolicy(sources(good, { "home/policy.json": nanText }));
  assert.equal(choice.path, "train/u3/policy.json");
  assert.match(choice.reason!, /getup not attached: not strict JSON/);
  // A diverged network: NaN inside the float32 weights, which JSON cannot see.
  choice = await chooseHomePolicy(sources({ ...good, "home/policy.json": combined(200, 150, Number.NaN) }));
  assert.equal(choice.path, "train/u3/policy.json");
  assert.match(choice.reason!, /layer 0 has NaN or infinite weights/);
  assert.equal(strictPolicy(JSON.stringify(net(Number.POSITIVE_INFINITY))).ok, false);
});

test("2: a walk policy that does not walk goes home not at all", async () => {
  const choice = await chooseHomePolicy(sources({ ...good, "train/u3/policy.json": walk(200, 0.003) }));
  assert.equal(choice.path, null);
  assert.match(choice.reason!, /walk test covered 0.003 m/);
  assert.ok(MIN_WALK_M > 0.003);
});

test("3: a combined file built from a stale walk or getup snapshot, or older than them, is not the one that goes home", async () => {
  let choice = await chooseHomePolicy(sources({ ...good, "home/policy.json": combined(120, 150) }));
  assert.equal(choice.path, "train/u3/policy.json");
  assert.match(choice.reason!, /another walk policy \(120 steps, the winner's has 200\)/);
  choice = await chooseHomePolicy(sources({ ...good, "home/policy.json": combined(200, 90) }));
  assert.match(choice.reason!, /another getup policy/);
  choice = await chooseHomePolicy(sources(good, {}, { "home/policy.json": 1_000, "train/u3/policy.json": 2_000, "getup/policy.json": 500 }));
  assert.match(choice.reason!, /older than the files it was built from/);
});

test("a getup file with NaN or broken JSON sends the walk policy home alone, and never throws", async () => {
  const nanGetup = JSON.stringify(getup(150)).replace('"mean":[0,0]', '"mean":[NaN,0]');
  for (const text of [nanGetup, '{"layers": [', ""]) {
    const choice = await chooseHomePolicy(sources(good, { "getup/policy.json": text }));
    assert.equal(choice.path, "train/u3/policy.json");
    assert.match(choice.reason!, /getup not attached: the getup policy it was built from is refused: not strict JSON/);
  }
});

test("4: a combined file the tab's loader refuses (another body) sends the walk policy home alone", async () => {
  const choice = await chooseHomePolicy(sources({ ...good, "home/policy.json": { ...combined(200, 150), mjcf_sha256: "0".repeat(64) } }));
  assert.equal(choice.path, "train/u3/policy.json");
  assert.match(choice.reason!, /the tab refuses it/);
});
