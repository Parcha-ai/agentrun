// A run that learns starts from its agent's learning (its seed). A seed that failed is said, in the run's learning
// and in one timeline row of kind `learning`, and the run asks no end-of-run turn: nothing was seeded. A run that does
// not learn has no learning row at all.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ended, LEARN, learner, learningRows, made, reflectRows, settled, started, unreadable } from "./learn-support.mjs";
import { agent, follow, serve } from "./support.mjs";

test("a seed that failed is a learning row, seed_failed, and a run that does not learn has none", { timeout: 90_000 }, async (t) => {
  const { api, data } = await serve(t, { learning: "on", faux: LEARN });
  await made(api, learner("blocked", { learning: { compile_after: 1 } }));
  await made(api, agent("plain", { tools: ["write"] }));
  await unreadable(data, "blocked");
  // (On the switch a run's learning reads from its kept learning, written at its end: none is shown while it runs.)
  const runId = await started(api, "blocked");
  const { view, rows } = await ended(api, runId);
  settled(view, rows, "dropped", "seed_failed");
  assert.equal(reflectRows(rows).length, 0, "no turn, though a compile was due: nothing was seeded");
  // Its learning read says why, and that it was given no # Learned text.
  const learning = (await api("GET", `/runs/${runId}/learning`)).body;
  assert.deepEqual([learning.reason, learning.seed, learning.seed_failed, learning.learned_chars], ["seed_failed", null, "unreadable", 0], JSON.stringify(learning));
  const plainId = await started(api, "plain");
  const plain = await follow(api, plainId, ["completed"]);
  assert.deepEqual([learningRows(plain.rows).length, reflectRows(plain.rows).length], [0, 0]);
  assert.equal((await api("GET", `/runs/${plainId}`)).body.learning, null);
});
