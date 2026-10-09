// The warm-up against a scripted box: the trainer's commands run in order for the creature, as the run user with its HOME,
// one warm-up at a time; a repeated creature shares its warm-up; a failing command stops the rest and is reported.
import assert from "node:assert/strict";
import { test } from "node:test";
import { creatureId, warmTrain, type WarmBox } from "../warm-train.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const take = { xml: enc('<mujoco model="take"/>'), body: enc('{"jointNames":["a"]}') };
const other = { xml: enc('<mujoco model="other"/>'), body: enc('{"jointNames":["b"]}') };
const WALK = "python /opt/pda/train/train.py --mjcf {mjcf} --body {body} --universe u1.json --num-envs 512 --schedule 0.5M,1M --compile-cache $HOME/.cache/cc.tar.gz --compile-only";
const GETUP = "python /opt/pda/train/train.py --mjcf {mjcf} --body {body} --universe getup.json --schedule 5M --compile-only";

function scripted(fail?: RegExp) {
  const calls: string[] = [];
  const files = new Map<string, string>();
  let running = 0;
  let overlap = false;
  const box: WarmBox = {
    async upload(path, content) {
      files.set(path, new TextDecoder().decode(content));
    },
    async exec(command) {
      calls.push(command);
      if (!command.includes("train.py")) return { exitCode: 0, result: "" };
      if (++running > 1) overlap = true;
      await new Promise((r) => setTimeout(r, 20));
      running--;
      return fail?.test(command) ? { exitCode: 1, result: "Traceback: compile failed" } : { exitCode: 0, result: '{"event": "train.compiled"}' };
    },
  };
  return { box, calls, files, overlapped: () => overlap };
}

test("the trainer's compile-only lines run in order for the creature's files, as the run user with its HOME", async () => {
  const s = scripted();
  const w = warmTrain(s.box, { commands: [WALK, GETUP] });
  const r = await w.warm(take);
  const id = creatureId(take.xml);
  assert.equal(r.creature, id);
  assert.deepEqual([...s.files.keys()], [`/var/tmp/pda-warm/${id}/creature.xml`, `/var/tmp/pda-warm/${id}/body.json`]);
  const trains = s.calls.filter((c) => c.includes("train.py"));
  assert.equal(trains.length, 2);
  assert.match(trains[0]!, /^set -o pipefail; sudo -n -u 'pda' -H bash -c '/);
  assert.ok(trains[0]!.includes(`--mjcf /var/tmp/pda-warm/${id}/creature.xml --body /var/tmp/pda-warm/${id}/body.json --universe u1.json`));
  assert.ok(trains[1]!.includes("--universe getup.json"));
  assert.ok(s.calls.indexOf(s.calls.find((c) => c.startsWith("chown"))!) < s.calls.indexOf(trains[0]!), "the run user owns the files first");
  assert.deepEqual(w.warmed(), [id]);
  assert.equal(w.pending(), null);
});

test("a repeated creature shares its warm-up; another creature waits for it; pending is the one running", async () => {
  const s = scripted();
  const w = warmTrain(s.box, { commands: [WALK] });
  const a = w.warm(take);
  assert.equal(w.warm(take), a, "the same creature: one warm-up");
  const b = w.warm(other);
  assert.ok(w.pending());
  await Promise.all([a, b]);
  assert.equal(s.overlapped(), false, "one compile at a time");
  assert.equal(s.calls.filter((c) => c.includes("train.py")).length, 2);
  assert.deepEqual(w.warmed().sort(), [creatureId(take.xml), creatureId(other.xml)].sort());
  assert.equal(w.pending(), null);
});

test("a failing command rejects with its output, runs no later command, and does not count as warm", async () => {
  const s = scripted(/universe u1/);
  const w = warmTrain(s.box, { commands: [WALK, GETUP] });
  await assert.rejects(w.warm(take), /failed \(1\): Traceback: compile failed/);
  assert.equal(s.calls.filter((c) => c.includes("getup.json")).length, 0);
  assert.deepEqual(w.warmed(), []);
  // The next creature still runs after a failed one.
  await w.warm(other).catch(() => undefined);
  assert.equal(s.calls.filter((c) => c.includes("train.py")).length, 2);
});

test("variables reach the commands through sudo, which drops the image's environment", async () => {
  const s = scripted();
  await warmTrain(s.box, { commands: [WALK], env: { XLA_PYTHON_CLIENT_PREALLOCATE: "false" } }).warm(take);
  assert.match(s.calls.find((c) => c.includes("train.py"))!, /sudo -n -u 'pda' -H env XLA_PYTHON_CLIENT_PREALLOCATE='false' bash -c /);
  assert.throws(() => warmTrain(s.box, { commands: [WALK], env: { "A;rm": "x" } }), /NAME=value/);
});

test("only the trainer's compile-only lines with the creature's placeholders are accepted", () => {
  const s = scripted();
  assert.throws(() => warmTrain(s.box, { commands: [] }), /compile-only commands/);
  assert.throws(() => warmTrain(s.box, { commands: ["python train.py --mjcf x.xml --body {body} --compile-only"] }), /\{mjcf\} and \{body\}/);
  assert.throws(() => warmTrain(s.box, { commands: [WALK.replace(" --compile-only", "")] }), /--compile-only/);
});
