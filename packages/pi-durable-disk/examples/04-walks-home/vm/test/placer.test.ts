// The demo's placer: criteria one line per environment, a scripted stand-in client that is always tagged "scripted", and a refusal
// to say "jev" without a key.
import assert from "node:assert/strict";
import { test } from "node:test";
import placerModule, { CRITERIA, LABELS } from "../placer.ts";

const logs: string[] = [];
const options = (args: Record<string, string>) => ({ log: (event: string) => void logs.push(event), args });

test("without a key the placer is scripted and says so on every decision", async () => {
  const saved = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  try {
    const placer = await placerModule(options({}));
    const ids = ["tab", "modal-gpu"];
    const start = await placer.decide({ phase: "start", message: "teach it to walk", current: "tab", environments: ids });
    assert.equal(start.choice, "modal-gpu");
    assert.equal(start.model, "scripted");
    assert.equal(start.options.reduce((sum, o) => sum + o.probability, 0).toFixed(6), "1.000000");
    assert.deepEqual(start.options.map((o) => o.label), [LABELS.tab, LABELS["modal-gpu"]]);
    const back = await placer.decide({ phase: "done", message: "teach it to walk", current: "modal-gpu", environments: ids });
    assert.equal(back.choice, "tab");
    const small = await placer.decide({ phase: "start", message: "fix the typo in my title", current: "tab", environments: ids });
    assert.equal(small.choice, "tab");
    assert.equal(placer.describe("modal-gpu"), CRITERIA["modal-gpu"]);
    assert.ok(logs.includes("placer.ready"));
  } finally {
    if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
  }
});

test("client=jev without a key is an error, not a silent stand-in; an unknown client is an error", async () => {
  const saved = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  try {
    await assert.rejects(placerModule(options({ client: "jev" })), /needs TYPESAFE_API_KEY/);
    await assert.rejects(placerModule(options({ client: "gpt" })), /scripted or jev/);
  } finally {
    if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
  }
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

const bytes = (s: string) => new TextEncoder().encode(s);
const SHA = "a".repeat(64);
const policy = (over: Record<string, unknown> = {}) => bytes(JSON.stringify({ format: "mlp-v1", spec_version: 1, mjcf_sha256: SHA, ...over }));
const files = (map: Record<string, Uint8Array | undefined>) => async (path: string) => map[path];

test("the home check: a valid brain made for the drawn body is in place; every other case says what is wrong", async () => {
  const { checkHomePolicy } = await import("../placer.ts");
  const body = bytes(JSON.stringify({ mjcf_sha256: SHA }));
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
  await bad({ "home/policy.json": policy(), "creature/body.json": bytes(JSON.stringify({ mjcf_sha256: "b".repeat(64) })) }, /different body/);
});
