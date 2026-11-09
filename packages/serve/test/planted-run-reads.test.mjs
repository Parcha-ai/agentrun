// The planted-secret harness over a run's reads: every GET operation the served API document lists that reads a run (its
// view, timeline, files, graph, browser, learning, and the run lists) is called for a run whose words hold planted
// secrets, and none may show them. A run read route the harness has no case for fails the build (the gate below), so a
// new read route can't skip the cut.
import assert from "node:assert/strict";
import { test } from "node:test";
import { openapiDocument } from "../dist/openapi.js";

/** The run read operations: every GET whose path reads a run or a list of runs. */
export function runReadOperations(doc) {
  return Object.entries(doc.paths ?? {})
    .filter(([path, item]) => item.get && /(^|\/)runs(\/|$)/.test(path))
    .map(([path, item]) => ({ path, operation: item.get.operationId }));
}

/** The harness's case for each run read operation, by operationId. */
const RUN_READS = {};

test("every run read operation the API document lists has a case in the harness: a new one fails until it does", () => {
  const listed = runReadOperations(openapiDocument(() => undefined));
  assert.ok(listed.length >= 2, "the document lists run reads");
  assert.deepEqual(listed.filter(({ operation }) => !Object.hasOwn(RUN_READS, operation)).map(({ path, operation }) => `GET ${path} (${operation})`), [], "run reads with no case");
});
