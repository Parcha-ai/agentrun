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
  const saved = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  try {
    const p = await placerModule(options({ episode: "model", "home-wait-ms": "10" }));
    assert.match(p.homePrompt ?? "", /trained model is in the browser/);
    const res = await p.homeCheck!(async () => undefined);
    assert.equal(res.ok, false);
    assert.match(res.reason, /no model manifest/);
    await assert.rejects(placerModule(options({ episode: "poem" })), /walks, model or obsession/);
  } finally {
    if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
  }
});

test("episode=obsession asks the server to write the user's words to a file (never into a command), and uses the model check", async () => {
  const saved = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  try {
    const p = await placerModule(options({ episode: "obsession" }));
    assert.equal(p.requestFile, "obsession/request.txt");
    assert.match(p.homePrompt ?? "", /trained model is in the browser/);
    assert.equal((await placerModule(options({ episode: "model" }))).requestFile, undefined);
  } finally {
    if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
  }
});

test("the model check says why no model exists when a program stopped on purpose (refusal, real-person gate), in its own words", async () => {
  const { checkHomeModel } = await import("../placer.ts");
  const line = (o: object) => bytes(JSON.stringify(o) + "\n");
  const refused = await checkHomeModel(files({ "find/progress.jsonl": line({ event: "refused", why: "The topic is a private individual.", kind: "private individual" }) }), { sleep: async () => undefined });
  assert.deepEqual([refused.ok, refused.reason], [false, "no model was made: The topic is a private individual."]);
  const gate = await checkHomeModel(files({ "find/progress.jsonl": line({ event: "done" }), "train/progress.jsonl": line({ event: "error", message: "the big model kept making things up about a real person, so the agent stopped before teaching the small model", gate: "false_claims" }) }), { sleep: async () => undefined });
  assert.match(gate.reason, /^no model was made: the big model kept making things up about a real person/);
  const nothing = await checkHomeModel(files({}), { sleep: async () => undefined });
  assert.match(nothing.reason, /no model manifest/);
});
