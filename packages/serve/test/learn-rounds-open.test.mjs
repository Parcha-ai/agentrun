// Whether a run's learning round is going (learning-rounds.ts roundOpen): the newest of its job's end kept for its
// look-back (KINDS.jobEnd) and its run's end (KINDS.end) decides it, read newest first and no further. A run that worked
// long reads no more of its journal than one that worked a little, every time a claim waits on it (about every 2 s) or
// a run of its agent starts, and the answer is the one its whole journal gives (feedback-round.ts keptEndOf).
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { roundOpen } from "../dist/learning-rounds.js";
import { keptEndOf } from "../dist/runner/feedback-round.js";
import { KINDS } from "../dist/runner/journal-kinds.js";
import { journalEntries } from "../dist/runner/journal-reader.js";
import { queue, stores } from "./runner-support.mjs";

const context = BACKGROUND_CONTEXT;
const ROOT = 1;
const dataOf = (kind) => (kind === KINDS.jobEnd ? { end: { state: "ended", summary: "Booked." }, endedAt: 5 } : kind === KINDS.end ? { state: "ended" } : { role: "model", text: "More." });

/** A claimed run `runId` whose root holds `work` messages of its job, then entries of `tail` kinds, in commits of 100. */
async function runWith(server, runId, work, tail) {
  await queue(server, runId);
  const claim = await server.claim(runId, "runner-a", { leaseMs: 60_000 });
  const journal = server.journal(claim);
  const entry = async (kind, data) => ({ type: "entry", value: { id: await journal.mintId(), conversationId: ROOT, kind, data } });
  const writes = [{ type: "conversation", value: { id: ROOT } }];
  for (let i = 0; i < work; i++) writes.push(await entry(KINDS.message, { role: i % 2 ? "model" : "person", text: `Step ${i}.` }));
  for (const kind of tail) writes.push(await entry(kind, dataOf(kind)));
  for (let at = 0; at < writes.length; at += 100) await commitWrites(journal, writes.slice(at, at + 100), context);
  await journal.close(context);
  const row = await server.runs.get(runId);
  assert.equal(row.state, "running");
  return row;
}

/** `server` as roundOpen reads it, each entry its journal scans hand back counted in `read.entries`. */
const counted = (server, read) => ({
  commands: (runId, after) => server.commands(runId, after),
  readJournal: (runId) =>
    new Proxy(server.readJournal(runId), {
      get(target, key) {
        if (key === "scanEntries") {
          return async (...args) => {
            const page = await target.scanEntries(...args);
            read.entries += page.items.length;
            return page;
          };
        }
        const value = target[key];
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
});

/** roundOpen's answer for each run of `work` job messages followed by `tail`, the entries it read, and what the run's
 *  whole journal answers. */
async function answers(tail) {
  const { server } = await stores({ runners: 0 });
  const out = [];
  for (const work of [300, 900]) {
    const row = await runWith(server, `run-${work}`, work, tail);
    const read = { entries: 0 };
    const open = await roundOpen(counted(server, read), row, []);
    const whole = keptEndOf(await journalEntries(server.readJournal(row.id), context), []) !== undefined;
    out.push({ open, whole, entries: read.entries });
  }
  return out;
}

test("a run looking back after a long job reads no more of its journal than after a short one, and answers as its whole journal does", async () => {
  const [short, long] = await answers([KINDS.message, KINDS.jobEnd, KINDS.message, KINDS.message]);
  assert.deepEqual([short.open, long.open], [true, true], "its look-back is under way");
  assert.deepEqual([short.open, long.open], [short.whole, long.whole], "the answer its whole journal gives");
  assert.equal(long.entries, short.entries, `900 job messages read as many entries as 300: ${short.entries} and ${long.entries}`);
  assert.ok(long.entries < 300, `it reads back to its job's end, not the job: ${long.entries} entries`);
});

test("a run in a follow-up's turn after its round ended reads back to that end only, and is no open round", async () => {
  const [short, long] = await answers([KINDS.jobEnd, KINDS.message, KINDS.end, KINDS.message, KINDS.message]);
  assert.deepEqual([short.open, long.open], [false, false], "the round ended; the follow-up's job is not over");
  assert.deepEqual([short.open, long.open], [short.whole, long.whole], "the answer its whole journal gives");
  assert.equal(long.entries, short.entries, `900 job messages read as many entries as 300: ${short.entries} and ${long.entries}`);
  assert.ok(long.entries < 300, `it reads back to the run's end, not the job: ${long.entries} entries`);
});
