// The tests' faux model priced on input only ($100 per million tokens), recording each call of its reply, the moment it
// is made, as one line in the file AGENTRUN_TEST_FAUX_CALLS names: which model requests reached the model, and how many of
// the person's messages each held (a reminder is not one).
import { appendFileSync } from "node:fs";
import reply, { personOf } from "./faux-model.mjs";

export const cost = { input: 100, output: 0, cacheRead: 0, cacheWrite: 100 };

export default function recorded(context, faux) {
  appendFileSync(process.env.AGENTRUN_TEST_FAUX_CALLS, `${JSON.stringify({ users: personOf(context).length })}\n`);
  return reply(context, faux);
}
