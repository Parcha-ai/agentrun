// Under --faux only: the fake Parallel (faux-parallel.mjs), with each request's key filed first. A test hands each claim a
// key of its own (made at run time, never a real one) and reads back which key each request carried, in order, from the
// file AGENTRUN_TEST_FAUX_PARALLEL_KEYS names: one line per request, {path, key}. The request then goes to the fake on its
// canary key, so it answers as for any authorized run.
import { appendFileSync } from "node:fs";
import fakeParallel, { CANARY } from "./faux-parallel.mjs";

export default async function keyedParallel(url, init = {}) {
  const headers = new Headers(init.headers);
  if (process.env.AGENTRUN_TEST_FAUX_PARALLEL_KEYS) appendFileSync(process.env.AGENTRUN_TEST_FAUX_PARALLEL_KEYS, `${JSON.stringify({ path: new URL(String(url)).pathname, key: headers.get("x-api-key") })}\n`);
  headers.set("x-api-key", CANARY);
  return fakeParallel(url, { ...init, headers });
}
