// An agent's ask for a person's time in the browser (browser-person.ts personTime, pauses: true) that the run's cap refuses
// pauses the run as main does (cap.ts paidCall's pause: the run's next request is refused in the cap's words): on the
// runner's one ledger the adapter loop journals the pause at once (pauseAtCap, before pi hears of it) and parks the run
// at its next request with the cap's figures; a raise resumes it. A person's take-over (pauses: false) never pauses it.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { cap, capRun, rootEntries } from "./adapter-pi-cap-support.mjs";
import { closeOpenSessions, piAdapterSpec, scriptedOrigin } from "./conformance-pi-adapter.mjs";

const { browserSpend } = await import("../dist/browser-cost.js");
const { sendCommand } = await import("../dist/runner/commands.js");
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
after(closeOpenSessions);

const CAP = 0.01;
/** The run's own model, free: its requests always fit, so only the browser ask meets the cap. */
const FREE = { id: "claude-sonnet-4-5", api: "anthropic-messages", price: { input: 0, output: 0 }, outputCeiling: 8_192 };
/** Browserbase at $0.12 an hour: a person's fifteen minutes are $0.03, past a $0.01 cap. */
const PRICE = { usdPerHour: 0.12, minimumS: 60 };

/** A run whose one tool asks a person for fifteen minutes in the browser (`pauses`: the agent's ask, or a take-over). */
async function askRun(t, pauses) {
  const answered = [];
  const script = [{ call: "ask_person" }, { say: "done" }];
  const specOf = (sent) => async (claim, run) => {
    const spend = browserSpend("browserbase", PRICE, 180, async () => {}, () => {}, { paid: run.ledger?.paid, pause: run.ledger?.pause });
    const askPerson = {
      name: "ask_person",
      replaySafe: false,
      run: async () => {
        const hold = await spend.personTime("your time in the browser", 900, { pauses, tag: "s1" });
        answered.push("refused" in hold ? hold.refused : "held");
        return "refused" in hold ? hold.refused : "a person has the browser";
      },
    };
    return piAdapterSpec({ script, tools: { ask_person: askPerson }, hooks: quiet }, { fetch: scriptedOrigin(script, sent) })(claim, run);
  };
  // The cap as E2 hands it to the loop, kept by the server across a raise (adapter-pi-cap-raise.test.mjs's closure).
  let capUsd = CAP;
  const runCap = { get capUsd() { return capUsd; }, park: (refusal) => cap.parkOf(refusal, capUsd), checkRaise: cap.checkRaise, followUpOf: cap.followUpOf };
  const run = await capRun(t, { script, specOf, cap: runCap, runCap: { capUsd: () => capUsd, modelOf: () => FREE } });
  /** A person's raise: the server keeps the new cap and writes the raise row. */
  const raise = (usd) => {
    capUsd = usd;
    return sendCommand(run.server, "run-1", { kind: "raise", body: { capUsd: usd } });
  };
  return { ...run, answered, raise };
}

test("an agent's ask refused at the cap parks the run at its next request with the cap's figures, and a raise resumes it", async (t) => {
  const { row, server, answered, raise } = await askRun(t, true);
  assert.match(answered[0] ?? "", /could cost up to \$0\.03/, `the ask was refused in the cap's words: ${JSON.stringify(answered)}`);
  assert.equal(row.state, "parked", `the run parked on the refused ask: ${JSON.stringify({ state: row.state, summary: row.summary })}`);
  const budgets = await rootEntries(server, "agentrun.budget");
  assert.equal(budgets.length, 1, `one pause: ${JSON.stringify(budgets)}`);
  assert.equal(budgets[0].pending.cap_usd, CAP, "at the run's cap");
  assert.ok(budgets[0].pending.least_cap_usd >= 0.03, `the least cap that sends the ask: ${JSON.stringify(budgets[0])}`);
  assert.equal(row.summary, budgets[0].words, "the row says the cap's words");
  // A raise resumes it.
  await raise(1);
  const from = Date.now();
  let now = row;
  while (!(now.state !== "parked" && now.state !== "running" && now.runner === null)) {
    if (Date.now() - from > 20_000) throw new Error(`the raise did not resume the run: ${JSON.stringify(now)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    now = await server.runs.get("run-1");
  }
  assert.equal(now.state, "ended", `the raise resumed the run, and it ended: ${JSON.stringify({ state: now.state, summary: now.summary })}`);
});

test("a person's take-over refused at the cap never pauses the run: the agent goes on and the run ends", async (t) => {
  const { row, answered } = await askRun(t, false);
  assert.match(answered[0] ?? "", /could cost up to \$0\.03/, `the take-over was refused in the cap's words: ${JSON.stringify(answered)}`);
  assert.equal(row.state, "ended", `a take-over's refusal pauses nothing: ${JSON.stringify({ state: row.state, summary: row.summary })}`);
});
