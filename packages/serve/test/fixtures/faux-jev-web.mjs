// Under --faux only: the fake Jev (faux-jev.mjs) with each request's wire body filed first, for the web tools' Jev
// (web-run.ts jevWebOf). One line per request in the file AGENTRUN_TEST_FAUX_JEV_WEB_CALLS names: its path, the model
// its body names (null when it names none), its questions' count, and whether it carried the canary key as its bearer.
// Never the key itself. The request then goes to faux-jev.mjs as it came.
import { appendFileSync } from "node:fs";
import fakeJev, { CANARY } from "./faux-jev.mjs";

export { CANARY };

export default async function filedJev(url, init = {}) {
  const file = process.env.AGENTRUN_TEST_FAUX_JEV_WEB_CALLS;
  if (file) {
    const body = typeof init.body === "string" && init.body ? JSON.parse(init.body) : {};
    const authorized = new Headers(init.headers).get("authorization") === `Bearer ${CANARY}`;
    appendFileSync(file, `${JSON.stringify({ path: new URL(String(url)).pathname, model: body.model ?? null, questions: Object.keys(body.questions ?? {}).length, authorized })}\n`);
  }
  return fakeJev(url, init);
}
