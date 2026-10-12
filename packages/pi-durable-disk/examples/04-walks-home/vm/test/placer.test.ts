// The demo's placer: criteria one line per environment, Jev as the only judge, and a refusal to start without its key. Tests judge with a fixed table.
import assert from "node:assert/strict";
import { test } from "node:test";
import placerModule, { buildPlacer, CRITERIA, HOME_PROMPT_ROBOT, LABELS } from "../placer.ts";
import type { JudgeRunner } from "../../../03-tab-to-cloud/placement.ts";

const logs: string[] = [];
const options = (args: Record<string, string>) => ({ log: (event: string) => void logs.push(event), args });

/**
 * A judge that answers from a fixed table keyed by the exact case (phase and message), never by reading the user's words: a message the table does
 * not know is a failing test, not a guess.
 */
const fixedJudge = (table: Record<string, string>): JudgeRunner => async ({ state, questions }) => {
  const question = questions.where!;
  const ids = Object.keys(question.criteria);
  const s = state as { task?: string; status?: string };
  const key = `${s.status ? "done" : "start"}: ${s.task}`;
  const choice = table[key];
  if (choice === undefined) throw new Error(`no fixed answer for ${key}`);
  return { answers: { where: { type: "choice", choice, probabilities: Object.fromEntries(ids.map((id) => [id, id === choice ? 0.9 : 0.1 / Math.max(1, ids.length - 1)])) } }, model: "fixed" };
};

test("the placer module needs the TypeSafe key and has no fallback judge; only jev is a client", async () => {
  const saved = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  try {
    await assert.rejects(placerModule(options({})), /TYPESAFE_API_KEY.*no fallback judge/);
    await assert.rejects(placerModule(options({ client: "jev" })), /TYPESAFE_API_KEY/);
    await assert.rejects(placerModule(options({ client: "scripted" })), /only jev decides/);
    await assert.rejects(placerModule(options({ client: "gpt" })), /only jev decides/);
  } finally {
    if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
  }
});

test("the placer over a judge runner tags every decision with jev and carries the judge's probabilities", async () => {
  const placer = buildPlacer(options({}), fixedJudge({ "start: teach it to walk": "modal-gpu", "done: teach it to walk": "tab", "start: fix the typo in my title": "tab" }));
  const ids = ["tab", "modal-gpu"];
  const start = await placer.decide({ phase: "start", message: "teach it to walk", current: "tab", environments: ids });
  assert.equal(start.choice, "modal-gpu");
  assert.equal(start.model, "jev");
  assert.equal(start.options.reduce((sum, o) => sum + o.probability, 0).toFixed(6), "1.000000");
  assert.deepEqual(start.options.map((o) => o.label), [LABELS.tab, LABELS["modal-gpu"]]);
  assert.equal((await placer.decide({ phase: "done", message: "teach it to walk", current: "modal-gpu", environments: ids })).choice, "tab");
  assert.equal((await placer.decide({ phase: "start", message: "fix the typo in my title", current: "tab", environments: ids })).choice, "tab");
  assert.equal(placer.describe("modal-gpu"), CRITERIA["modal-gpu"]);
});

test("the real Jev adapter, with an injected client, drives the placer end to end (no key, no network)", async () => {
  const { createJevRunner } = await import("@parcha/agentrun-jev");
  const { judgePlacer } = await import("../../../03-tab-to-cloud/placement.ts");
  const seen: unknown[] = [];
  const runJudge = createJevRunner({
    maxAttempts: 1,
    client: {
      async systemOne(request: { questions: Record<string, { type: string; criteria: Record<string, string> }> }) {
        seen.push(request);
        const q = request.questions.where!;
        const ids = Object.keys(q.criteria);
        return { answers: { where: { type: "choice", choice: "modal-gpu", probabilities: Object.fromEntries(ids.map((id) => [id, id === "modal-gpu" ? 0.97 : 0.03])), confidence: 0.97 } } };
      },
    } as never,
  });
  const placer = judgePlacer({ runJudge: runJudge as never, criteria: CRITERIA, labels: LABELS, model: "jev" });
  const d = await placer.decide({ phase: "start", message: "teach it to walk", current: "tab", environments: ["tab", "modal-gpu"] });
  assert.equal(d.choice, "modal-gpu");
  assert.equal(d.options.find((o) => o.id === "modal-gpu")?.probability, 0.97);
  assert.ok(d.latency_ms >= 0);
  assert.equal(seen.length, 1);
  assert.deepEqual(Object.keys((seen[0] as { questions: Record<string, { criteria: object }> }).questions.where!.criteria), ["tab", "modal-gpu"]);
});

import { dummyPolicy } from "../../tab/src/dummy.ts";
const bytes = (s: string) => new TextEncoder().encode(s);
const SHA = "a".repeat(64);
// A policy the browser loads: the tab's own test builder, for a body of six joints.
const JOINTS = ["a1", "a2", "b1", "b2", "c1", "c2"];
const policy = (over: Record<string, unknown> = {}) => bytes(JSON.stringify({ ...dummyPolicy({ mjcfSha256: SHA, mujocoVersion: "3.2.0", nj: JOINTS.length }), ...over }));
const files = (map: Record<string, Uint8Array | undefined>) => async (path: string) => map[path];

test("the home check: a valid brain made for the drawn body is in place; every other case says what is wrong", async () => {
  const { checkHomePolicy } = await import("../placer.ts");
  const body = bytes(JSON.stringify({ mjcf_sha256: SHA, jointNames: JOINTS }));
  assert.equal((await checkHomePolicy(files({ "home/policy.json": policy(), "creature/body.json": body }))).ok, true);
  const bad = async (map: Record<string, Uint8Array | undefined>, re: RegExp) => {
    const r = await checkHomePolicy(files(map));
    assert.equal(r.ok, false);
    assert.match(r.reason, re);
  };
  await bad({ "creature/body.json": body }, /was not written/);
  await bad({ "home/policy.json": bytes("{not json"), "creature/body.json": body }, /not valid JSON/);
  await bad({ "home/policy.json": bytes("[1]"), "creature/body.json": body }, /not a policy object/);
  await bad({ "home/policy.json": policy({ format: "mlp-v2" }), "creature/body.json": body }, /unknown format/);
  await bad({ "home/policy.json": policy({ spec_version: undefined }), "creature/body.json": body }, /no spec version/);
  await bad({ "home/policy.json": policy({ mjcf_sha256: "xyz" }), "creature/body.json": body }, /does not name its body/);
  await bad({ "home/policy.json": policy() }, /body file is missing/);
  await bad({ "home/policy.json": policy(), "creature/body.json": bytes(JSON.stringify({ mjcf_sha256: "b".repeat(64), jointNames: JOINTS })) }, /different body/);
  // What the browser would refuse, though the file has the right shape at a glance.
  await bad({ "home/policy.json": policy({ spec_version: 2 }), "creature/body.json": body }, /browser would refuse.*spec_version/);
  const { obs: _o, layers: _l, ...bare } = JSON.parse(new TextDecoder().decode(policy())) as Record<string, unknown>;
  await bad({ "home/policy.json": bytes(JSON.stringify(bare)), "creature/body.json": body }, /browser would refuse/);
  await bad({ "home/policy.json": policy(), "creature/body.json": bytes(JSON.stringify({ mjcf_sha256: SHA, jointNames: JOINTS.slice(0, 4) })) }, /browser would refuse/);
  await bad({ "home/policy.json": policy(), "creature/body.json": bytes(JSON.stringify({ mjcf_sha256: SHA })) }, /does not list its joints/);
});

test("the model check: the manifest and the tab's receipt must agree; it waits for the receipt, then says no", async () => {
  const { checkHomeModel } = await import("../placer.ts");
  const SHA2 = "c".repeat(64);
  const manifest = bytes(JSON.stringify({ sha256: SHA2, bytes: 806000000 }));
  const receipt = (over: Record<string, unknown> = {}) => bytes(JSON.stringify({ sha256: SHA2, answered: true, ...over }));
  const fast = { sleep: async () => undefined };
  assert.deepEqual((await checkHomeModel(files({ "home/model/manifest.json": manifest, "creature/model-loaded.json": receipt() }), fast)).ok, true);
  const no = async (map: Record<string, Uint8Array | undefined>, re: RegExp, extra = {}) => {
    const r = await checkHomeModel(files(map), { ...fast, ...extra });
    assert.equal(r.ok, false);
    assert.match(r.reason, re);
  };
  await no({}, /no model manifest/);
  await no({ "home/model/manifest.json": bytes(JSON.stringify({ sha256: "nope" })) }, /sha256/);
  await no({ "home/model/manifest.json": manifest, "creature/model-loaded.json": receipt({ sha256: "d".repeat(64) }) }, /different model file/);
  await no({ "home/model/manifest.json": manifest, "creature/model-loaded.json": receipt({ answered: false }) }, /did not answer|did not report/, { waitMs: 3000, pollMs: 1000, now: (() => { let c = 0; return () => (c += 1000); })() });
  await no({ "home/model/manifest.json": manifest, "creature/model-loaded.json": bytes(JSON.stringify({ error: "a chunk failed its sha256", answered: false })) }, /could not load the model: a chunk failed/);
  // no receipt: waits (on a fake clock) up to waitMs, then says the browser did not report
  let t = 0;
  await no({ "home/model/manifest.json": manifest }, /did not report loading/, { waitMs: 5000, pollMs: 1000, now: () => t, sleep: async (ms: number) => void (t += ms) });
  assert.equal(t, 5000, "it waited the whole budget before saying no");
  // a receipt that arrives while waiting is accepted
  let polls = 0;
  const late = async (path: string) => (path === "home/model/manifest.json" ? manifest : ++polls >= 3 ? receipt() : undefined);
  assert.equal((await checkHomeModel(late, { waitMs: 60_000, pollMs: 1, sleep: async () => undefined })).ok, true);
});

test("episode=model wires the model check and its home prompt; an unknown episode is an error", async () => {
  const p = buildPlacer(options({ episode: "model", "home-wait-ms": "10" }), fixedJudge({}));
  assert.match(p.homePrompt ?? "", /trained model is in the browser/);
  const res = await p.homeCheck!(async () => undefined);
  assert.equal(res.ok, false);
  assert.match(res.reason, /no model manifest/);
  assert.throws(() => buildPlacer(options({ episode: "poem" }), fixedJudge({})), /walks, model, obsession or robot/);
});

test("episode=obsession asks the server to write the user's words to a file (never into a command), and uses the model check", () => {
  const p = buildPlacer(options({ episode: "obsession" }), fixedJudge({}));
  assert.equal(p.requestFile, "obsession/request.txt");
  assert.match(p.homePrompt ?? "", /trained model is in the browser/);
  assert.equal(buildPlacer(options({ episode: "model" }), fixedJudge({})).requestFile, undefined);
});

test("the model check says why no model exists when a program stopped on purpose (refusal, real-person gate), in its own words", async () => {
  const { checkHomeModel } = await import("../placer.ts");
  const line = (o: object) => bytes(JSON.stringify(o) + "\n");
  const refused = await checkHomeModel(files({ "find/progress.jsonl": line({ event: "refused", why: "The topic is a private individual.", kind: "private individual" }) }), { sleep: async () => undefined });
  // The refusal is said in the server's one fixed sentence, never in the judge's words (which can name the person).
  const named = await checkHomeModel(files({ "find/progress.jsonl": line({ event: "refused", why: "Dave from number 12 is a private individual.", kind: "private individual" }) }), { sleep: async () => undefined });
  assert.deepEqual([refused.ok, refused.reason], [false, "the topic was refused by the program's own policy check, so no model was made."]);
  assert.equal(named.reason, refused.reason);
  const gate = await checkHomeModel(files({ "find/progress.jsonl": line({ event: "done" }), "train/progress.jsonl": line({ event: "error", message: "the big model kept making things up about a real person, so the agent stopped before teaching the small model", gate: "false_claims" }) }), { sleep: async () => undefined });
  assert.match(gate.reason, /^no model was made: the big model kept making things up about a real person/);
  const nothing = await checkHomeModel(files({}), { sleep: async () => undefined });
  assert.match(nothing.reason, /no model manifest/);
});

test("robot episode: the placer asks with the robot's own criteria, takes the judge's choice as it comes, and the home check reads the skills", async () => {
  const { checkHomeSkills, CRITERIA_ROBOT } = await import("../placer.ts");
  const asked: { criteria: Record<string, string | null>; task: unknown }[] = [];
  const judge: JudgeRunner = async (params) => {
    asked.push({ criteria: params.questions.where!.criteria, task: (params.state as { task?: unknown }).task });
    return fixedJudge({ "start: Make me a robot.": "tab", "start: Teach it to move.": "modal-vm", "done: Teach it to move.": "tab" })(params);
  };
  const placer = buildPlacer(options({ episode: "robot", skills: "8" }), judge);
  const ask = async (message: string, phase: "start" | "done" = "start") => (await placer.decide({ phase, message, current: "tab", environments: ["tab", "modal-vm"] })).choice;
  assert.equal(await ask("Make me a robot."), "tab");
  assert.equal(await ask("Teach it to move."), "modal-vm");
  assert.equal(await ask("Teach it to move.", "done"), "tab");
  assert.deepEqual(asked[0]!.criteria, CRITERIA_ROBOT);
  assert.equal(placer.describe("modal-vm"), CRITERIA_ROBOT["modal-vm"]);

  const skills = (names: string[]) => bytes(JSON.stringify({ skills: names }));
  const ok = await checkHomeSkills(files({ "home/skills.json": skills(["walk", "spin"]), "home/skills/walk.json": bytes("{}"), "home/skills/spin.json": bytes("{}") }), 2);
  assert.equal(ok.ok, true);
  assert.match(ok.reason, /2 skills are home.*walk, spin/);
  assert.equal((await checkHomeSkills(files({}))).ok, false);
  assert.match((await checkHomeSkills(files({ "home/skills.json": bytes("nope") }))).reason, /not valid JSON/);
  assert.match((await checkHomeSkills(files({ "home/skills.json": skills(["walk"]) }))).reason, /not written: walk/);
  assert.match((await checkHomeSkills(files({ "home/skills.json": skills(["walk"]), "home/skills/walk.json": bytes("{}") }), 8)).reason, /1 of the 8 skills/);
  assert.match((await checkHomeSkills(files({ "home/skills.json": bytes("{\"skills\":[]}") }))).reason, /lists no skill/);
  // Repeated names count once (and are refused), a broken or non-object skill file does not pass, and a name that is not a plain skill name is refused.
  assert.match((await checkHomeSkills(files({ "home/skills.json": skills(["walk", "walk"]), "home/skills/walk.json": bytes("{}") }), 2)).reason, /more than once: walk/);
  assert.match((await checkHomeSkills(files({ "home/skills.json": skills(["walk"]), "home/skills/walk.json": bytes('{"policy":') }))).reason, /not valid JSON objects: home\/skills\/walk\.json/);
  assert.match((await checkHomeSkills(files({ "home/skills.json": skills(["walk"]), "home/skills/walk.json": bytes("[1]") }))).reason, /not valid JSON objects/);
  assert.match((await checkHomeSkills(files({ "home/skills.json": skills(["../creature/robot"]), "home/skills/../creature/robot.json": bytes("{}") }))).reason, /not a plain skill name/);
  // What the round trained decides what must come home: one skill asked for, one skill home, is a yes even when the teach step was for 8; a trained skill that did not come home is a no.
  const round = (names: string[]) => bytes(JSON.stringify({ version: 1, skills: Object.fromEntries(names.map((n) => [n, { status: "done" }])) }));
  const one = await checkHomeSkills(files({ "home/skills.json": skills(["walk"]), "home/skills/walk.json": bytes("{}"), "home/round.json": round(["walk"]) }), 8);
  assert.equal(one.ok, true);
  assert.match(one.reason, /^1 skill is home and installed: walk/);
  const partial = await checkHomeSkills(files({ "home/skills.json": skills(["walk"]), "home/skills/walk.json": bytes("{}"), "home/round.json": round(["walk", "spin", "wave"]) }), 1);
  assert.equal(partial.ok, false);
  assert.match(partial.reason, /1 of the 3 skills trained this round came home \(not home: spin, wave\)/);
  // A summary that is not version 1, or not readable, is no summary: the teach step's own count applies.
  assert.match((await checkHomeSkills(files({ "home/skills.json": skills(["walk"]), "home/skills/walk.json": bytes("{}"), "home/round.json": bytes("nope") }), 8)).reason, /1 of the 8 skills came home/);
  // The index as D2/D3 write it: an object of skills.
  assert.equal((await checkHomeSkills(files({ "home/skills.json": bytes('{"version":1,"default":"walk","skills":{"walk":{},"turn-left":{}}}'), "home/skills/walk.json": bytes("{}"), "home/skills/turn-left.json": bytes("{}") }), 2)).ok, true);
});

test("the robot placement question is asked with the skills the robot already has, read from the run's index; no index, a broken one or odd names give none", async () => {
  const { robotContext } = await import("../placer.ts");
  const files = (m: Record<string, string>) => async (path: string) => (m[path] === undefined ? undefined : new TextEncoder().encode(m[path]));
  assert.deepEqual(await robotContext(files({ "home/skills.json": '{"version":1,"skills":{"walk":{},"spin":{}}}' })), { skills_already_taught: ["walk", "spin"] });
  assert.deepEqual(await robotContext(files({ "home/skills.json": '{"skills":["walk",{"name":"wave"}]}' })), { skills_already_taught: ["walk", "wave"] });
  assert.deepEqual(await robotContext(files({})), { skills_already_taught: [] });
  assert.deepEqual(await robotContext(files({ "home/skills.json": "nope" })), { skills_already_taught: [] });
  assert.deepEqual(await robotContext(files({ "home/skills.json": '{"skills":{"../etc":{},"ok-1":{}}}' })), { skills_already_taught: ["ok-1"] });
  // The judge receives them next to the task, through the placer the module builds for the robot episode.
  const seen: unknown[] = [];
  const placer = buildPlacer(options({ episode: "robot", skills: "8" }), async (params) => (seen.push(params.state), fixedJudge({ "start: make it spin": "tab" })(params)));
  await placer.decide({ phase: "start", message: "make it spin", current: "tab", environments: ["tab", "modal-vm"], read: files({ "home/skills.json": '{"skills":{"spin":{}}}' }) });
  assert.deepEqual(seen[0], { task: "make it spin", running_now_in: "tab", skills_already_taught: ["spin"] });
  // Without a way to read the run's files the question is asked as before.
  await placer.decide({ phase: "start", message: "make it spin", current: "tab", environments: ["tab", "modal-vm"] });
  assert.deepEqual(seen[1], { task: "make it spin", running_now_in: "tab" });
});

test("the robot's home prompt asks for one new line (back, and what to try), not the result again", () => {
  assert.match(HOME_PROMPT_ROBOT, /you already told them how the teaching went before the move: do not repeat it\./);
  assert.match(HOME_PROMPT_ROBOT, /Say one short line that adds only what is new: that you are back in their browser, and one thing they can try now\. When the server's check below gives the line to try, say that line; otherwise name one skill from the list in the check: "Back in your browser\. Try: make it <that skill>\."/);
  assert.doesNotMatch(HOME_PROMPT_ROBOT, /Try: make it spin/, "the example names no skill that may not be home");
  assert.match(HOME_PROMPT_ROBOT, /If the check says NO, say instead, plainly and in simple words, that the last step did not work and which skills are missing\./);
  assert.doesNotMatch(HOME_PROMPT_ROBOT, /name how many|how it went for their robot's skills/);
});

test("with a flag on the floor the home check gives the line to try, the run to the flag, when walk or sprint came home; otherwise it gives none", async () => {
  const { checkHomeSkills } = await import("../placer.ts");
  const scene = bytes(JSON.stringify({ version: 1, flag: { x: 3, y: -0.1, radius: 0.25 } }));
  const home = (names: string[], more: Record<string, Uint8Array> = {}) => files({ "home/skills.json": bytes(JSON.stringify({ skills: names })), ...Object.fromEntries(names.map((n) => [`home/skills/${n}.json`, bytes("{}")])), ...more });
  const reason = async (names: string[], more: Record<string, Uint8Array> = {}) => (await checkHomeSkills(home(names, more))).reason;
  assert.equal(await reason(["walk", "spin"], { "creature/scene.json": scene }), '2 skills are home and installed: walk, spin. There is a flag on the floor and the robot waits at the start for the ask, so the line to try is: "Back in your browser. Try: walk to the flag."');
  assert.match(await reason(["sprint"], { "creature/scene.json": scene }), /Try: sprint to the flag\."$/);
  assert.equal(await reason(["walk", "spin"]), "2 skills are home and installed: walk, spin.", "no flag: no line to try");
  assert.equal(await reason(["spin", "wave"], { "creature/scene.json": scene }), "2 skills are home and installed: spin, wave.", "nothing that goes to the flag came home");
  assert.equal(await reason(["walk"], { "creature/scene.json": bytes("{") }), "1 skill is home and installed: walk.", "a scene that does not parse is no flag");
});
