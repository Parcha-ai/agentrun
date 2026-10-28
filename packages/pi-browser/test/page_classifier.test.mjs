import assert from "node:assert/strict";
import { test } from "node:test";

const root = await import("@parcha/pi-browser");
const { createPageClassifier, pageBudget, INJECTION_THRESHOLD, PAGE_GUARD_MAX_PAGES, PAGE_WALL_THRESHOLD } = root;

/** The largest double below a positive x. */
const nextDown = (x) => { const v = new DataView(new ArrayBuffer(8)); v.setFloat64(0, x); v.setBigUint64(0, v.getBigUint64(0) - 1n); return v.getFloat64(0); };

const page = (over = {}) => ({ url: "https://s.example/a", status: 200, contentType: "text/html", text: "An article about tides.", ...over });
const answered = (content, injection, walls = {}) => ({
  answers: { wall: { type: "choice", choice: "content", probabilities: { content, ...walls }, confidence: content }, injection: { type: "noul", noul: injection } },
  request_sha256: "sha-1", model: "jev-test", usage: { input_tokens: 120, output_tokens: 0 }, cost_usd: 0.000005,
});
/** A judge that answers `answer` and keeps every request it was asked. */
const judgeOf = (answer) => {
  const asked = [];
  return { asked, judge: () => async (request) => { asked.push(request); return typeof answer === "function" ? answer(request) : answer; } };
};
const record = (verdict) => JSON.parse(verdict.guard)[0];

test("a judged page carries the judge's wall, its injection score and the guard record the receipt files, in that record's own order", async () => {
  const { asked, judge } = judgeOf(answered(0.9, 0.2));
  const verdict = await createPageClassifier({ judge })(page());
  const decision = (question, yes, threshold, action) => ({
    kind: "noul", request_sha256: "sha-1", question, options: ["true", "false"], answer: yes >= 0.5 ? "true" : "false",
    probabilities: { true: yes, false: +(1 - yes).toFixed(6) }, confidence: +(Math.abs(yes - 0.5) * 2).toFixed(6), threshold, action, model: "jev-test",
  });
  const request = { request_sha256: "sha-1", model: "jev-test", usage: { input_tokens: 120, output_tokens: 0 }, cost_usd: 0.000005 };
  assert.deepEqual(verdict, {
    wall: "content", injection: 0.2, confidence: 0.9,
    guard: JSON.stringify([{ url: "https://s.example/a", page: "content", wall: null, injection: 0.2, decisions: [decision("not_content", 1 - 0.9, 0.6, "default"), decision("injection", 0.2, 0.75, "default")], request, failure: null }]),
  });
  assert.equal(asked.length, 1);
  assert.equal(asked[0].label, "page guard");
  assert.equal(asked[0].kind, "judge");
  assert.deepEqual(Object.keys(asked[0].questions), ["wall", "injection"]);
  assert.deepEqual(asked[0].state, { page: { url: "https://s.example/a", status_code: 200, content_type: "text/html", text: "An article about tides." } });
});

test("a wall page names the likeliest wall, files as not_content, and still carries its injection score", async () => {
  const { judge } = judgeOf(answered(0.1, 0.98, { captcha_or_bot_check: 0.7, login_wall: 0.2 }));
  const verdict = await createPageClassifier({ judge })(page());
  assert.equal(verdict.wall, "captcha_or_bot_check");
  assert.equal(verdict.injection, 0.98);
  assert.equal(verdict.confidence, 0.9);
  assert.equal(record(verdict).page, "not_content");
  assert.equal(record(verdict).wall, "captcha_or_bot_check");
  assert.equal(record(verdict).decisions[1].action, "applied");
});

test("the judge is shown the page redacted, its text cut at 16,000 characters, its frames when it has any, and the screen's signal", async () => {
  const { asked, judge } = judgeOf(answered(0.9, 0.1));
  const redact = (text) => text.replaceAll("hunter2", "[redacted]");
  const signal = new AbortController().signal;
  await createPageClassifier({ judge, redact })(page({ url: "https://s.example/a?token=hunter2", text: `hunter2 ${"x".repeat(20_000)}`, frames: ["https://hunter2.example"], frameText: ["hunter2 says hi"] }), signal);
  const shown = asked[0].state.page;
  assert.equal(shown.url, "https://s.example/a?token=[redacted]");
  assert.equal(shown.text.length, 16_000);
  assert.ok(shown.text.startsWith("[redacted] "));
  assert.deepEqual(shown.frames, ["https://[redacted].example"]);
  assert.deepEqual(shown.frame_text, ["[redacted] says hi"]);
  assert.equal(asked[0].signal, signal);
  assert.doesNotMatch(JSON.stringify(asked[0]), /hunter2/);
});

test("the injection decision is marked at pi-browser's own INJECTION_THRESHOLD, the value the page screen marks at", async () => {
  const at = INJECTION_THRESHOLD, below = nextDown(at);
  for (const [score, action] of [[at, "applied"], [below, "default"]]) {
    const { judge } = judgeOf(answered(0.9, score));
    const injection = record(await createPageClassifier({ judge })(page())).decisions.find((d) => d.question === "injection");
    assert.equal(injection.threshold, INJECTION_THRESHOLD, "the threshold the decision records is the root's");
    assert.equal(injection.action, action, `a score of ${score} is ${action}`);
  }
});

test("a side counts at PAGE_WALL_THRESHOLD and not below it: neither side there leaves the page unjudged, with the answers and the injection score kept", async () => {
  assert.equal(PAGE_WALL_THRESHOLD, 0.6);
  const { judge: atJudge } = judgeOf(answered(PAGE_WALL_THRESHOLD, 0.1));
  assert.equal((await createPageClassifier({ judge: atJudge })(page())).wall, "content");
  const { judge } = judgeOf(answered(0.5, 0.1, { paywall: 0.5 }));
  const verdict = await createPageClassifier({ judge })(page());
  assert.deepEqual({ wall: verdict.wall, injection: verdict.injection, confidence: verdict.confidence }, { wall: "unjudged", injection: 0.1, confidence: null });
  const r = record(verdict);
  assert.deepEqual(Object.keys(r), ["url", "page", "decisions", "request", "failure"], "the unjudged record, as before");
  assert.equal(r.page, "unjudged");
  assert.equal(r.failure, "no side reached 0.6: content 0.50");
  assert.deepEqual(r.decisions.map((d) => [d.question, d.threshold]), [["not_content", 0.6], ["injection", 0.75]]);
  assert.equal(r.request.request_sha256, "sha-1");
});

test("a page the judge cannot place still carries a sure injection score, so the screen marks it whatever the wall", async () => {
  const { judge } = judgeOf(answered(0.5, 0.99, { captcha_or_bot_check: 0.5 }));
  const verdict = await createPageClassifier({ judge })(page());
  assert.deepEqual({ wall: verdict.wall, injection: verdict.injection, confidence: verdict.confidence }, { wall: "unjudged", injection: 0.99, confidence: null });
  const r = record(verdict);
  assert.equal(r.failure, "no side reached 0.6: content 0.50");
  assert.deepEqual(r.decisions.find((d) => d.question === "injection").action, "applied");
  assert.match(root.pageNotice(verdict), /^page_guard: injection /, "the reader is told of the injection, not only that the page was unscreened");
});

test("a judge that cannot answer leaves the page unjudged with the reason, and classifyPage never rejects", async () => {
  const thrower = (error) => () => async () => { throw error; };
  const cases = [
    ["no judge route", () => { throw new Error("no judge route"); }, /^no judge route$/],
    ["no judge at all", () => undefined, /not a function/],
    ["a judge that throws", thrower(new Error("HTTP 500 from the judge")), /^HTTP 500 from the judge$/],
    ["a judge that times out", thrower(Object.assign(new Error("the judge did not answer in 60000 ms"), { name: "TimeoutError" })), /did not answer in 60000 ms/],
    ["a judge that throws a value with no message", thrower({ toString() { throw new Error("no string"); } }), /^the judge failed$/],
    ["no answers", judgeOf({ request_sha256: "s" }).judge, /reading 'wall'/],
    ["a NaN injection score", judgeOf(answered(0.9, Number.NaN)).judge, /did not have the questions' shapes/],
    ["an injection score that is not a number", judgeOf(answered(0.9, "0.9")).judge, /did not have the questions' shapes/],
    ["an infinite injection score", judgeOf(answered(0.9, Number.POSITIVE_INFINITY)).judge, /did not have the questions' shapes/],
    ["an injection score over 1", judgeOf(answered(0.9, 1.5)).judge, /did not have the questions' shapes/],
    ["an injection score under 0", judgeOf(answered(0.9, -0.5)).judge, /did not have the questions' shapes/],
    ["a content probability over 1", judgeOf(answered(1.7, 0.1)).judge, /did not have the questions' shapes/],
    ["a wall probability over 1", judgeOf(answered(0.1, 0.1, { paywall: 1.2 })).judge, /did not have the questions' shapes/],
    ["a wall probability under 0", judgeOf(answered(0.9, 0.1, { paywall: -0.1 })).judge, /did not have the questions' shapes/],
    ["a wall probability that is not a number", judgeOf(answered(0.9, 0.1, { paywall: "0.1" })).judge, /did not have the questions' shapes/],
    ["a wall answered as yes/no", judgeOf({ answers: { wall: { type: "noul", noul: 0.9 }, injection: { type: "noul", noul: 0.1 } }, request_sha256: "s" }).judge, /did not have the questions' shapes/],
    ["a null result", judgeOf(null).judge, /null/],
  ];
  for (const [name, judge, failure] of cases) {
    const verdict = await createPageClassifier({ judge })(page());
    assert.deepEqual({ wall: verdict.wall, injection: verdict.injection, confidence: verdict.confidence }, { wall: "unjudged", injection: null, confidence: null }, name);
    const r = record(verdict);
    assert.deepEqual(Object.keys(r), ["url", "page", "decisions", "request", "failure"], name);
    assert.equal(r.url, "https://s.example/a", name);
    assert.equal(r.page, "unjudged", name);
    assert.match(r.failure, failure, name);
  }
});

test("a page whose screen already ended, or past the run's page budget, is unjudged without a question and spends nothing", async () => {
  const { asked, judge } = judgeOf(answered(0.9, 0.1));
  const ended = new AbortController();
  ended.abort();
  assert.equal(record(await createPageClassifier({ judge })(page(), ended.signal)).failure, "aborted");
  assert.equal(asked.length, 0);

  const budget = pageBudget(1);
  const classify = createPageClassifier({ judge, budget });
  await createPageClassifier({ judge, budget })(page(), ended.signal);
  assert.equal((await classify(page())).wall, "content", "an aborted page took none of the budget");
  assert.equal(record(await classify(page())).failure, "the run classifies at most 1 pages");
  assert.equal(asked.length, 1);

  const capped = createPageClassifier({ judge, maxPages: 0 });
  assert.equal(record(await capped(page())).failure, "the run classifies at most 0 pages");
  assert.equal(asked.length, 1);
});

test("a redactor or budget that throws leaves the page unjudged with no URL recorded, never a rejection", async () => {
  const { asked, judge } = judgeOf(answered(0.9, 0.1));
  const redacted = await createPageClassifier({ judge, redact: () => { throw new Error("redactor down"); } })(page({ url: "https://s.example/?key=hunter2" }));
  assert.equal(redacted.wall, "unjudged");
  assert.deepEqual([record(redacted).url, record(redacted).failure], ["", "redactor down"]);
  assert.doesNotMatch(redacted.guard, /hunter2/);
  const budgeted = await createPageClassifier({ judge, budget: { limit: 1, take() { throw new Error("budget down"); } } })(page());
  assert.equal(record(budgeted).failure, "budget down");
  assert.equal(asked.length, 0);
});

test("pageBudget counts pages up to its limit, PAGE_GUARD_MAX_PAGES by default", () => {
  assert.equal(PAGE_GUARD_MAX_PAGES, 500);
  assert.equal(pageBudget().limit, PAGE_GUARD_MAX_PAGES);
  const budget = pageBudget(2);
  assert.deepEqual([budget.take(), budget.take(), budget.take()], [true, true, false]);
});
