// The spend cap's wrap-up (CAP_WRAPUP): the note the run's model was told near its cap shows as the server's row, as the
// other rows the server writes do (`origin: "server"`, "AgentRun: <words>"), so a host labels it by its origin. It is no
// message its turn took: its id ends in NOTE_SUFFIX, which isMessageRow passes over, as it does BESIDE's.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as timeline from "../dist/timeline/index.js";
import { CAP_WRAPUP, isMessageRow, timelineOf } from "../dist/timeline/index.js";
import { custom, user } from "./timeline-lib-support.mjs";

const WORDS = "About $1 left of this run's budget: finish now with your answer.";

test("the wrap-up's row is the server's: origin server, its summary in the server's words, its id ending in NOTE_SUFFIX, and it is no message the turn took", () => {
  const rows = timelineOf([user("go"), custom(CAP_WRAPUP, { capUsd: 1, leftUsd: 1, words: WORDS })], { settled: true });
  const row = rows.find((r) => r.text === WORDS);
  assert.deepEqual([row?.kind, row?.origin, row?.summary], ["phase", "server", `AgentRun: ${WORDS}`], JSON.stringify(row));
  assert.equal(typeof timeline.NOTE_SUFFIX, "string", "NOTE_SUFFIX is exported");
  assert.ok(row?.id?.endsWith(timeline.NOTE_SUFFIX), `its id ends in the suffix: ${row?.id}`);
  assert.equal(isMessageRow(row), false, "a note to the model, never a message its turn took");
  assert.deepEqual(rows.filter(isMessageRow).map((r) => r.text), ["go"], "the run's one message is the person's");
});
