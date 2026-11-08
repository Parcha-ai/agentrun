// A run's journal opened for reading only (store.readJournal): the server reads a run — its timeline, the records analytics
// sums — with no claim, so a read never fences and never mints an id. The same read half every writer's journal(claim) has,
// so the kernel's one journal reader (runner/journal-reader.ts) runs on it unchanged. A run whose journal was written under
// a claim reads back the same records with no claim; another run's commits never appear; an unknown run reads empty.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { calls, messages } from "../dist/runner/journal-reader.js";
import { KINDS } from "../dist/runner/journal-kinds.js";
import { queue, stores } from "./runner-support.mjs";

const context = BACKGROUND_CONTEXT;
const ROOT = 1;

/** A claimed run on the server's store with its own record written under the claim, then released. */
async function writtenRun(server, runId) {
  await queue(server, runId);
  const claim = await server.claim(runId, "runner-a", { leaseMs: 60_000 });
  const journal = server.journal(claim);
  const entry = async (kind, data) => ({ type: "entry", value: { id: await journal.mintId(), conversationId: ROOT, kind, data } });
  await commitWrites(journal, [
    { type: "conversation", value: { id: ROOT } },
    await entry(KINDS.message, { role: "person", text: "Book the room." }),
    await entry(KINDS.callStart, { callId: "c1", tool: "host:fs/write", input: { path: "a.txt" }, replaySafe: false }),
  ], context);
  await commitWrites(journal, [
    await entry(KINDS.callEnd, { callId: "c1", status: "done", output: "written" }),
    await entry(KINDS.message, { role: "model", text: "Booked." }),
  ], context);
  await journal.close(context);
  await server.release(claim, { state: "ended" });
  return runId;
}

test("readJournal reads a run's records back with no claim, as the kernel's journal reader sees them", async () => {
  const { server } = await stores({ runners: 0 });
  await writtenRun(server, "run-1");

  const view = server.readJournal("run-1");
  assert.equal(view.runId, "run-1");
  // The same read half the writer's journal has: the kernel's reader runs on it unchanged.
  assert.deepEqual((await calls(view, context)).map((call) => [call.callId, call.tool, call.status]), [["c1", "host:fs/write", "done"]]);
  assert.deepEqual((await messages(view, context)).map((message) => [message.role, message.text]), [["person", "Book the room."], ["model", "Booked."]]);
  // And its commits, commit by commit, as commitsAfter gives them for the live view: the two batches written above.
  const page = await view.commitsAfter(0, 10, context);
  assert.equal(page.commits.length, 2, "the two commits the run's record was written in");
  await view.close(context);
});

test("a run's read view holds no other run's commits, and an unknown run reads empty", async () => {
  const { server } = await stores({ runners: 0 });
  await writtenRun(server, "run-a");
  await writtenRun(server, "run-b");

  const view = server.readJournal("run-a");
  assert.deepEqual((await messages(view, context)).map((m) => m.text), ["Book the room.", "Booked."], "only run-a's");
  await view.close(context);

  const missing = server.readJournal("no-such-run");
  assert.equal(missing.runId, "no-such-run");
  assert.deepEqual((await missing.commitsAfter(0, 10, context)).commits, [], "an unknown run reads empty");
  assert.deepEqual(await calls(missing, context), [], "no calls");
  await missing.close(context);
});

test("readJournal reads a run whose claim is still held (a live run), without taking the claim", async () => {
  const { server } = await stores({ runners: 0 });
  await queue(server, "run-live");
  const claim = await server.claim("run-live", "runner-a", { leaseMs: 60_000 });
  const journal = server.journal(claim);
  await commitWrites(journal, [
    { type: "conversation", value: { id: ROOT } },
    { type: "entry", value: { id: await journal.mintId(), conversationId: ROOT, kind: KINDS.message, data: { role: "person", text: "mid-run" } } },
  ], context);

  // Read while the claim is still open: a read never fences, so it needs none of the claim.
  const view = server.readJournal("run-live");
  assert.deepEqual((await messages(view, context)).map((m) => m.text), ["mid-run"]);
  await view.close(context);
});
