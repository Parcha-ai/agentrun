// The DecisionProvider conformance suite: what a provider must hold for a decision workflow to rest on it. A provider
// package registers it in its own tests with a kit that builds the provider over a fake transport.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DecisionProviderError, type DecisionEvidence, type DecisionOutcome, type DecisionProvider, type DecisionRequest } from "../decision-provider.js";
import { completeConfidence, validateAnswers, type SystemOneQuestion } from "../system-one.js";

/** What the kit's fake transport answers one call with. An `answer` carries answers in the DSL's shape (and, for a
 *  provider with evidence, sources), which the kit sends in the provider's own wire format. */
export type KitReply =
  | { kind: "answer"; answers: Record<string, unknown>; evidence?: DecisionEvidence[] }
  | { kind: "status"; status: number }
  | { kind: "malformed" }
  | { kind: "hang" };

export interface DecisionProviderKit {
  /** A new provider under test whose transport answers each call with the next of `replies` (the last repeats), and
   *  the number of calls its transport has taken. Retry delays should be short: the suite waits for them. */
  build(replies: KitReply[]): { provider: DecisionProvider; calls(): number };
  /** The key the kit configures the provider with: it must never appear in a result or an error. */
  canary: string;
  /** Whether the provider's wire format can carry a refusal. */
  refuses: boolean;
}

const QUESTIONS: Record<string, SystemOneQuestion> = {
  holds: { type: "noul", instructions: "Does the statement hold?" },
  pick: { type: "choice", instructions: "Which option fits?", criteria: { first: "the first", second: "the second" } },
  level: { type: "score", instructions: "How strong is it?", criteria: ["weak", "middling", "strong"] },
};
const ANSWERS: Record<string, unknown> = {
  holds: { type: "noul", noul: 0.8 },
  pick: { type: "choice", choice: "first", probabilities: { first: 0.75, second: 0.25 }, confidence: 0.5 },
  level: { type: "score", score: 1.5, legend: { 0: "weak", 1: "middling", 2: "strong" }, probabilities: { 0: 0, 1: 0.5, 2: 0.5 }, confidence: 0.25 },
};
const EVIDENCE: DecisionEvidence[] = [{ url: "https://example.org/a", title: "A source", excerpts: ["a passage"], scope: "call" }];
const BASES = ["reported", "estimate", "unknown"];

/** Registers the suite as `node:test` tests named under `name`. */
export function registerDecisionProviderConformance(name: string, kit: DecisionProviderKit): void {
  const it = (title: string, body: () => Promise<void>, options: { skip?: string | false } = {}) => test(`${name}: ${title}`, { skip: options.skip ?? false, timeout: 20_000 }, body);
  /** The questions of each type the provider answers, with answers to them. */
  const asked = (provider: DecisionProvider) => {
    const ids = Object.keys(QUESTIONS).filter((id) => provider.capabilities.types.includes(QUESTIONS[id].type));
    return { questions: Object.fromEntries(ids.map((id) => [id, QUESTIONS[id]])), answers: Object.fromEntries(ids.map((id) => [id, structuredClone(ANSWERS[id])])) };
  };
  const request = (questions: Record<string, SystemOneQuestion>, state: unknown = { case: "conformance" }): DecisionRequest => ({ label: "conformance", kind: "judge", state, questions });
  const ctx = (over: { signal?: AbortSignal; deadlineMs?: number | null } = {}) => ({ decisionId: "conformance-decision", signal: over.signal ?? new AbortController().signal, deadlineMs: over.deadlineMs === undefined ? 5_000 : over.deadlineMs });
  /** One decision on a provider whose transport gives `replies`. */
  const decideOn = async (replies: KitReply[], questions?: Record<string, SystemOneQuestion>, context = ctx()) => {
    const { provider } = kit.build(replies);
    return provider.decide(request(questions ?? asked(provider).questions), context);
  };
  const answerReply = (provider: DecisionProvider, extra: Partial<Extract<KitReply, { kind: "answer" }>> = {}): KitReply => ({ kind: "answer", answers: asked(provider).answers, ...extra });
  const probe = () => kit.build([{ kind: "hang" }]).provider;
  /** `promise`, or a failure once `ms` pass: the referenced timer also keeps the process up while a request hangs. */
  const within = <T>(ms: number, promise: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`still pending after ${ms} ms`)), ms); });
    return Promise.race([promise, late]).finally(() => clearTimeout(timer));
  };
  const failsWith = (expected: string) => (error: unknown) => {
    assert.ok(error instanceof DecisionProviderError, `a provider fails with a DecisionProviderError, got ${String(error)}`);
    assert.equal(error.code, expected);
    return true;
  };

  it("it answers exactly the questions asked, each in its declared type", async () => {
    const { questions } = asked(probe());
    const outcome = await decideOn([answerReply(probe())]);
    assert.deepEqual(Object.keys(outcome.answers).sort(), Object.keys(questions).sort());
    const { answers } = completeConfidence(questions, outcome.answers as Record<string, unknown>);
    validateAnswers(questions, answers);
  });

  it("an answer to a question not asked, or none for one asked, is invalid_response", async () => {
    const { answers } = asked(probe());
    await assert.rejects(decideOn([{ kind: "answer", answers: { ...answers, unasked: { type: "noul", noul: 0.5 } } }]), failsWith("invalid_response"));
    const [first, ...rest] = Object.keys(answers);
    assert.ok(first && rest.length, "the provider answers at least two of noul, choice and score");
    await assert.rejects(decideOn([{ kind: "answer", answers: Object.fromEntries(rest.map((id) => [id, answers[id]])) }]), failsWith("invalid_response"));
  });

  it("a cost it does not know is null, never 0, and cost_basis says how it was reached", async () => {
    const outcome: DecisionOutcome = await decideOn([answerReply(probe())]);
    assert.ok(BASES.includes(outcome.cost_basis), `cost_basis is one of ${BASES.join(", ")}, got ${String(outcome.cost_basis)}`);
    assert.equal(outcome.cost_usd === null, outcome.cost_basis === "unknown", `an unknown cost is null and a known one is not: ${outcome.cost_usd} (${outcome.cost_basis})`);
    if (outcome.cost_usd !== null) assert.ok(Number.isFinite(outcome.cost_usd) && outcome.cost_usd >= 0);
    if (outcome.usage !== null) assert.ok(Number.isSafeInteger(outcome.usage.input_tokens) && Number.isSafeInteger(outcome.usage.output_tokens));
  });

  it("401 and 403 are auth errors", async () => {
    await assert.rejects(decideOn([{ kind: "status", status: 401 }]), failsWith("auth"));
    await assert.rejects(decideOn([{ kind: "status", status: 403 }]), failsWith("auth"));
  });

  it("422 is invalid_request", async () => {
    await assert.rejects(decideOn([{ kind: "status", status: 422 }]), failsWith("invalid_request"));
  });

  it("429 is rate_limited once its retries are spent", async () => {
    await assert.rejects(decideOn([{ kind: "status", status: 429 }]), failsWith("rate_limited"));
  });

  it("a 5xx is an http error", async () => {
    await assert.rejects(decideOn([{ kind: "status", status: 500 }]), failsWith("http"));
  });

  it("a malformed body is invalid_response", async () => {
    await assert.rejects(decideOn([{ kind: "malformed" }]), failsWith("invalid_response"));
  });

  it("an abort stops a request in flight as aborted", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(within(2_000, decideOn([{ kind: "hang" }], undefined, ctx({ signal: controller.signal, deadlineMs: 10_000 }))), failsWith("aborted"));
  });

  it("a request past its deadline stops as timeout", async () => {
    await assert.rejects(within(3_000, decideOn([{ kind: "hang" }], undefined, ctx({ deadlineMs: 50 }))), failsWith("timeout"));
  });

  it("no key appears in a result or an error", async () => {
    const seen: string[] = [JSON.stringify(await decideOn([answerReply(probe(), { evidence: EVIDENCE })]))];
    for (const reply of [{ kind: "status", status: 401 }, { kind: "status", status: 422 }, { kind: "status", status: 429 }, { kind: "status", status: 500 }, { kind: "malformed" }] as KitReply[]) {
      try { await decideOn([reply]); seen.push("no error"); }
      catch (error) { seen.push(String(error), (error as Error)?.stack ?? "", JSON.stringify(error)); }
    }
    for (const text of seen) assert.ok(!text.includes(kit.canary), "the key appears in what the provider returned or threw");
  });

  it("a request beyond its declared capabilities is refused before anything is sent", async (): Promise<void> => {
    const { provider, calls } = kit.build([answerReply(probe())]);
    const { maxQuestions, maxStateBytes, types } = provider.capabilities;
    const over: DecisionRequest[] = [];
    if (maxQuestions !== null) over.push(request(Object.fromEntries(Array.from({ length: maxQuestions + 1 }, (_, i) => [`q${i}`, { type: "noul", instructions: `Question ${i}?` } as SystemOneQuestion]))));
    if (!types.includes("box")) over.push(request({ spot: { type: "box", instructions: "Where is it?" } }));
    if (maxStateBytes !== null) over.push(request(asked(provider).questions, { text: "x".repeat(maxStateBytes + 1) }));
    for (const each of over) await assert.rejects(provider.decide(each, ctx()), failsWith("invalid_request"));
    assert.equal(calls(), 0, "nothing was sent");
  });

  it("a refusal comes back as a refusal", async () => {
    const { answers } = asked(probe());
    const outcome = await decideOn([{ kind: "answer", answers: { ...answers, holds: { type: "refusal" } } }]);
    assert.deepEqual(outcome.answers.holds, { type: "refusal" });
  }, { skip: kit.refuses ? false : "the provider's wire format carries no refusal" });

  it("evidence is a list of sources, and the request id a string or null", async () => {
    const provider = probe();
    const outcome = await decideOn([answerReply(provider, { evidence: EVIDENCE })]);
    assert.ok(Array.isArray(outcome.evidence), "evidence is a list");
    for (const source of outcome.evidence) {
      assert.equal(typeof source.url, "string");
      assert.ok(source.title === null || typeof source.title === "string");
      assert.ok(Array.isArray(source.excerpts) && source.excerpts.every((excerpt) => typeof excerpt === "string"));
      assert.equal(typeof source.scope, "string");
    }
    if (provider.capabilities.evidence === "none") assert.equal(outcome.evidence.length, 0, "a provider with no evidence returns none");
    else assert.ok(outcome.evidence.length > 0, "a provider with evidence returns the sources it was given");
    assert.ok(outcome.provider_request_id === null || typeof outcome.provider_request_id === "string");
  });

  it("needs names environment variables, never their values", async () => {
    const { needs } = probe();
    for (const variable of needs) {
      assert.match(variable, /^[A-Z][A-Z0-9_]*$/);
      assert.ok(!variable.includes(kit.canary));
    }
  });
}
