// The tests' faux model priced as faux-workflow-priced.mjs ($100 per million output tokens, each answer 400 of them, at
// most 16,384 output tokens a request), whose first answer waits for a gate: with AGENTRUN_TEST_FAUX_GATE set, the first
// request writes <gate>.waiting and is answered once <gate> exists, so a test acts while a workflow's first node runs.
import { existsSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import reply from "./faux-model.mjs";

export const cost = { input: 0, output: 100, cacheRead: 0, cacheWrite: 0 };
export const usage = () => ({ input: 0, output: 400, cacheRead: 0, cacheWrite: 0 });
export const maxTokens = 16_384;

let first = true;
export default async function gated(context, faux) {
  const gate = process.env.AGENTRUN_TEST_FAUX_GATE;
  if (first && gate) {
    first = false;
    writeFileSync(`${gate}.waiting`, "");
    while (!existsSync(gate)) await sleep(50);
  }
  return reply(context, faux);
}
