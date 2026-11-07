// A workflow's decisions and steps under its spend cap, at the mechanism (decision-cap.ts, budget.ts):
//  - OpenRouter's catalog down for a moment mid-run: the price is read again and the decision goes; down for good, the
//    request fails unsent as a connection error, which the node's attempts take, never a stop of the cap's that ends the
//    run spend_cap_reached;
//  - a decision an earlier process asked and never saw answered is escalated unsent by the driver: it holds nothing and
//    never waits for a raise;
//  - a model node's failure takes a refusal kept with no path of its own only while that node runs alone.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { budgetWaits, CapStop } from "../dist/budget.js";
import { useSpend } from "../dist/cap.js";
import * as decisionCap from "../dist/decision-cap.js";

const { cappedDecisions } = decisionCap;
const PRICE = { promptUsd: 0, completionUsd: 0, requestUsd: 0.001, imageUsd: 0, maxCompletionTokens: null };
const params = (extra = {}) => ({ label: "coi", kind: "judge", executionPath: "/root", decisionId: "d-1", model: "liquid/d1", provider: "openrouter", state: { doc: "x" }, questions: { is_coi: { type: "noul" } }, ...extra });
/** The run's waits, as a fake: what stopped the run and what waited for a raise. */
function fakeWaits() {
  const seen = { stops: [], waits: [] };
  return { seen, waits: { stop: (refusal) => { seen.stops.push(refusal.words); throw new CapStop(refusal, undefined); }, record: () => undefined } };
}
/** `before`'s outcome for `request`: sent (the next judge was asked) or what it threw. */
const outcome = (judge, request) => judge(request).then((value) => ["sent", value], (error) => ["threw", error?.name, error?.code ?? null]);

test("OpenRouter's catalog down for a moment mid-run: the price is read again and the decision is sent, never stopped by the cap", { timeout: 30_000 }, async (t) => {
  t.after(() => useSpend(undefined));
  useSpend({ cap: 1, spent: () => 0, add: () => undefined });
  let down = 1;
  const openrouter = { id: "openrouter", priceOf: async () => { if (down-- > 0) throw new Error("catalog 503"); return PRICE; } };
  const { seen, waits } = fakeWaits();
  const capped = cappedDecisions({ providers: { providers: { openrouter }, default: "openrouter" }, waits, mode: "expected", book: async () => undefined });
  const judge = capped.before(async () => "answered", () => false);
  assert.deepEqual([await outcome(judge, params()), seen.stops], [["sent", "answered"], []]);
});

test("OpenRouter's catalog down for good mid-run: the decision fails unsent as a connection error the node's attempts take, never a stop of the cap's", { timeout: 30_000 }, async (t) => {
  t.after(() => useSpend(undefined));
  useSpend({ cap: 1, spent: () => 0, add: () => undefined });
  let reads = 0;
  const openrouter = { id: "openrouter", priceOf: async () => { reads += 1; throw new Error("catalog 503"); } };
  const { seen, waits } = fakeWaits();
  const capped = cappedDecisions({ providers: { providers: { openrouter }, default: "openrouter" }, waits, mode: "expected", book: async () => undefined });
  const judge = capped.before(async () => "answered", () => false);
  assert.deepEqual([await outcome(judge, params()), seen.stops], [["threw", "DecisionProviderError", "connection"], []]);
  assert.equal(reads, decisionCap.CATALOG_TRIES, "read again before it fails");
});

test("a decision an earlier process asked and never saw answered holds nothing and never waits for a raise: the driver escalates it unsent; one that failed is held again", { timeout: 30_000 }, async (t) => {
  t.after(() => useSpend(undefined));
  const waited = [];
  // Parallel's $0.001 does not fit what is left of a $0.0005 cap: a request held here waits for a raise.
  useSpend({ cap: 0.0005, spent: () => 0, add: () => undefined, wait: async (refusal) => (waited.push(refusal.words), false) });
  const parallel = { id: "parallel" };
  const { waits } = fakeWaits();
  const capped = cappedDecisions({ providers: { providers: { parallel }, default: "parallel" }, waits, mode: "expected", book: async () => undefined });
  const driver = (status) => ({ routeDecision: () => undefined, decisionRequests: () => ({ "d-1": { status } }) });
  const asked = (status) => (request) => decisionCap.askedBefore?.(driver(status), request) ?? false;
  const requested = await outcome(capped.before(async () => "escalated", asked("requested")), params({ provider: "parallel", model: undefined }));
  assert.deepEqual([requested, waited.length], [["sent", "escalated"], 0], "asked before: no hold, no wait");
  const failed = await outcome(capped.before(async () => "answered", asked("failed")), params({ provider: "parallel", model: undefined }));
  assert.deepEqual([failed[0], waited.length], ["threw", 1], "failed before: held again, and waits for a raise");
});

test("a model node's failure takes a refusal kept with no path of its own only while that node runs alone", (t) => {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "cap-stop-alone-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const waits = budgetWaits(root, { cap: 1, spent: () => 0, add: () => undefined }, { letGo: () => undefined });
  waits.record({ words: "Not sent: what the run has spent is unknown, so its cap of $1 cannot be kept: the run is out of budget.", room: false, capUsd: 1 }, undefined);
  assert.deepEqual([waits.stopped("/root/steps/1", false) instanceof CapStop, waits.stopped("/root/steps/1", true) instanceof CapStop], [false, true]);
});

test("a map's items wait for a raise at paths of their own: holding item 0 leaves item 1's held time at 0, and item 0's wait ending never stops item 1's clock", { timeout: 30_000 }, async (t) => {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "item-held-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const waits = budgetWaits(root, { cap: 1, spent: () => 0, add: () => undefined }, { letGo: () => undefined });
  const refusal = { words: "Not sent: the call could cost up to $2. Raise the cap to at least $2 to continue.", room: true, capUsd: 1 };
  const [zero, one] = ["/root/steps/0/items/0/body", "/root/steps/0/items/1/body"];
  const first = new AbortController();
  const second = new AbortController();
  const held0 = waits.wait(refusal, first.signal, { label: "fetch", path: zero });
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.deepEqual([waits.held(one), waits.held(zero) >= 300], [0, true], "item 0 held, item 1 untouched");
  const held1 = waits.wait(refusal, second.signal, { label: "fetch", path: one });
  await new Promise((resolve) => setTimeout(resolve, 100));
  first.abort();
  await held0;
  const before = waits.held(one);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.ok(waits.held(one) >= before + 300, `item 1's clock runs on after item 0's wait ended: ${before} then ${waits.held(one)}`);
  second.abort();
  await held1;
});
