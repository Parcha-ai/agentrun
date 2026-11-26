// What a search sends Jev, pinned to what the docs name: each result's url, title and snippet, and its published date
// when the provider gave one. A new field in the sift state fails here until someone names it in the docs (serve's
// capabilities why, its README and a changes fragment) and adds it below. The test captures the request jevWebDecider
// hands jevProvider, which sends its state as it is (jev's test/web-step-request.test.mjs pins that). The search runs
// on Parallel's fake, whose first result carries a publish date.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as web from "../dist/index.js";
import { decideWeb, scoringProvider, SCORES, TASK } from "./fixtures/decide-runs.mjs";

const NAMED = ["published", "snippet", "title", "url"];

test("a search sends Jev each result's url, title and snippet, and its published date when it has one: nothing else", async () => {
  const { asked, provider } = scoringProvider(SCORES);
  const jevProvider = () => ({ ...provider, id: "jev", needs: ["TYPESAFE_API_KEY"] });
  const { decider, policy } = web.jevWebDecider({ key: "fake-test-key", jevProvider, price: { requestUsd: 0.0002 } });
  const { answer } = await decideWeb({ decider, policy }).search("widgets delaware", { n: 4, task: TASK });
  assert.equal(answer.error, undefined, `the search ran: ${JSON.stringify(answer).slice(0, 300)}`);
  assert.equal(asked.length, 1, "one sift request");
  const sent = Object.values(asked[0].request.state.results);
  assert.equal(sent.length, 4, "Jev is asked about every result");
  for (const result of sent) {
    const keys = Object.keys(result);
    assert.deepEqual(keys.filter((key) => !NAMED.includes(key)), [], `a result sent to Jev carries only the fields the docs name; ${result.url} carried ${keys.join(", ")}`);
    for (const field of ["url", "title", "snippet"]) assert.equal(typeof result[field], "string", `${result.url} carries its ${field}`);
  }
  assert.ok(sent.some((result) => result.published === "2026-10-01"), "a result's published date goes to Jev when the provider gave one, as the docs say");
});
