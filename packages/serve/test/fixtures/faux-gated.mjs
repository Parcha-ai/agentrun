// The tests' faux model, loaded only once the file FAUX_GATE names exists, so a run's process waits, started and not
// yet sending, for as long as a test needs; each request it answers is a line in FAUX_SENT.
import { appendFileSync, existsSync } from "node:fs";
import reply from "./faux-model.mjs";

for (let i = 0; process.env.FAUX_GATE && !existsSync(process.env.FAUX_GATE) && i < 600; i++) await new Promise((resolve) => setTimeout(resolve, 100));

export default function gated(context, faux) {
  if (process.env.FAUX_SENT) appendFileSync(process.env.FAUX_SENT, "request\n");
  return reply(context, faux);
}
