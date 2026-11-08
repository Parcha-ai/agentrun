// pi through the adapter under a cap: the cap's refusal is final to pi-ai, whatever digits its words hold. pi-ai retries a
// request whose error text holds a status it retries on ("429", "502") unless the text says the run is out of budget
// (pi-ai's isRetryableAssistantError): the cap's refusal for room begins "spend_cap_reached (out of budget): ", and one
// for good is final too. A cap of $0.0004295 puts "429" in the words: one ask, nothing sent, never asked again, and no
// retry backoff. And one ledger: the run's requests are judged by beforeRequestOf alone, through the one rule, and
// createCap's own ledger books nothing for a pi run.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeOpenSessions } from "./conformance-pi-adapter.mjs";
import { beforeRequestOf, cap, capRun, SONNET } from "./adapter-pi-cap-support.mjs";

after(closeOpenSessions);
const CAP = 0.0004295;

test("pi through the adapter: the cap's refusal with retry digits in its words is final: one ask, nothing sent, never asked again, no backoff", async (t) => {
  const { row, asked, sent, ms } = await capRun(t, { script: [{ say: "never sent" }], beforeRequest: beforeRequestOf({ capUsd: () => CAP, modelOf: () => SONNET }) });
  assert.match(asked[0]?.answer?.refuse ?? "", /^spend_cap_reached \(out of budget\): .*\$0\.0004295/, JSON.stringify(asked[0]?.answer));
  assert.equal(sent.length, 0, "nothing reached the provider");
  assert.equal(asked.length, 1, `asked once, never again: ${asked.length}`);
  assert.notEqual(row.state, "running", `the run is no longer running: ${JSON.stringify(row)}`);
  assert.ok(ms < 10_000, `no retry backoff: ${ms} ms`);
});

test("pi through the adapter: a refusal no raise can fix (the run's spend unknown) fails the run in the cap's own words, never as a run that gave no answer", async (t) => {
  const { row, asked, sent } = await capRun(t, { script: [{ say: "never sent" }], beforeRequest: beforeRequestOf({ capUsd: () => 1, modelOf: () => SONNET, spentUsd: () => null }) });
  const words = "spend_cap_reached: Not sent: what the run has spent is unknown, so its cap of $1 cannot be kept: the run is out of budget.";
  assert.equal(asked[0]?.answer?.refuse, words);
  assert.equal(sent.length, 0, "nothing reached the provider");
  assert.deepEqual([row.state, row.summary], ["failed", words], JSON.stringify(row));
});

test("one ledger: a pi run's requests are judged by beforeRequestOf through the one rule, and createCap's own ledger books nothing", async (t) => {
  const { capRule } = cap;
  const ledger = await import("../../run-adapters/dist/kernel/cap/ledger.js");
  const judged = { count: 0 };
  const booked = [];
  const judge = capRule.judge;
  capRule.judge = (...args) => (judged.count++, judge(...args));
  const { hold, settle } = ledger.Ledger.prototype;
  ledger.Ledger.prototype.hold = function (...args) { booked.push("hold"); return hold.apply(this, args); };
  ledger.Ledger.prototype.settle = function (...args) { booked.push("settle"); return settle.apply(this, args); };
  t.after(() => {
    capRule.judge = judge;
    ledger.Ledger.prototype.hold = hold;
    ledger.Ledger.prototype.settle = settle;
  });
  const { row, asked } = await capRun(t, { script: [{ say: "done" }], beforeRequest: beforeRequestOf({ capUsd: () => 1, modelOf: () => SONNET }) });
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.ok(asked.length >= 1, "the host was asked");
  assert.equal(judged.count, asked.length, "one judgement per ask, by the one rule");
  assert.deepEqual(booked, [], "createCap's ledger booked nothing");
});
