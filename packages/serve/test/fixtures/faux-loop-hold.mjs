// The free looping faux model (faux-loop.mjs) with one request held open, for a test that restarts the runner while it is
// out: the request after the AGENTRUN_TEST_FAUX_HOLD_AT - 1 that faux-loop recorded (AGENTRUN_TEST_FAUX_CALLS) is held
// until the file AGENTRUN_TEST_FAUX_RELEASE exists, once a run (the file "<release>.held" says it was), and is never
// recorded: the runner that sent it is gone by then, and the next one sends it again. Every other request is faux-loop's.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import reply from "./faux-loop.mjs";

export const HOLD_AT_ENV = "AGENTRUN_TEST_FAUX_HOLD_AT";
export const RELEASE_ENV = "AGENTRUN_TEST_FAUX_RELEASE";

const recorded = (file) => (file && existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).length : 0);

export default async function held(context, faux) {
  const at = Number(process.env[HOLD_AT_ENV] ?? 0);
  const release = process.env[RELEASE_ENV];
  if (at > 0 && release && !existsSync(`${release}.held`) && recorded(process.env.AGENTRUN_TEST_FAUX_CALLS) === at - 1) {
    writeFileSync(`${release}.held`, "");
    while (!existsSync(release)) await new Promise((resolve) => setTimeout(resolve, 50));
    return faux.message("Held past a restart.");
  }
  return reply(context, faux);
}
