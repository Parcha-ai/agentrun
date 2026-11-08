// The kernel's one journal reader (runner/journal-reader.ts) reads what a run did from the kinds in journal-kinds.ts. A CLI
// adapter's session lives in a conversation of its own, named by an agentrun.session.key entry on the root: every entry in
// it is resume log, and the reader never shows one as a call or a message, whatever its kind (one that happens to use a
// call or message kind included).
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { calls, messages } from "../dist/runner/journal-reader.js";
import { KINDS } from "../dist/runner/journal-kinds.js";
import { queue, stores } from "./runner-support.mjs";

const context = BACKGROUND_CONTEXT;
const ROOT = 1;

async function runJournal() {
  const { server } = await stores({ runners: 0 });
  await queue(server, "run-1");
  const claim = await server.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const journal = server.journal(claim);
  const entry = async (conversationId, kind, data) => ({ type: "entry", value: { id: await journal.mintId(), conversationId, kind, data } });
  return { journal, entry };
}

test("a CLI run's session log is never read as calls or messages: only the run's own record is", async () => {
  const { journal, entry } = await runJournal();
  // Ids are one namespace: the session's conversation takes a minted one.
  const SESSION = await journal.mintId();
  // The run's own record, on its root conversation.
  await commitWrites(journal, [
    { type: "conversation", value: { id: ROOT } },
    await entry(ROOT, KINDS.message, { role: "person", text: "Book the room." }),
    await entry(ROOT, KINDS.sessionKey, { key: "claude:session-1", conversation: SESSION }),
    await entry(ROOT, KINDS.callStart, { callId: "c1", tool: "host:fs/write", input: { path: "a.txt" }, replaySafe: false }),
  ], context);
  // The session's resume log, in its own conversation: the kernel's and runner's kinds, and two that collide with the
  // record's kinds.
  await commitWrites(journal, [
    { type: "conversation", value: { id: SESSION } },
    await entry(SESSION, "kernel.submission", { text: "Book the room." }),
    await entry(SESSION, "kernel.start", { turn: 1 }),
    await entry(SESSION, KINDS.callStart, { callId: "log-1", tool: "Write", input: {}, replaySafe: false }),
    await entry(SESSION, KINDS.message, { role: "model", text: "a line of the resume log" }),
    await entry(SESSION, "runner.response", { ok: true }),
  ], context);
  await commitWrites(journal, [
    await entry(ROOT, KINDS.callEnd, { callId: "c1", status: "done", output: "written" }),
    await entry(ROOT, KINDS.message, { role: "model", text: "Booked." }),
  ], context);

  assert.deepEqual((await calls(journal, context)).map((call) => [call.callId, call.tool, call.status]), [["c1", "host:fs/write", "done"]]);
  assert.deepEqual((await messages(journal, context)).map((message) => [message.role, message.text]), [["person", "Book the room."], ["model", "Booked."]]);
});

test("a call started and not ended reads pending; ended, its status", async () => {
  const { journal, entry } = await runJournal();
  await commitWrites(journal, [
    { type: "conversation", value: { id: ROOT } },
    await entry(ROOT, KINDS.callStart, { callId: "c1", tool: "effect", input: {}, replaySafe: false }),
    await entry(ROOT, KINDS.callStart, { callId: "c2", tool: "read", input: {}, replaySafe: true }),
    await entry(ROOT, KINDS.callEnd, { callId: "c2", status: "refused" }),
  ], context);
  assert.deepEqual((await calls(journal, context)).map((call) => [call.callId, call.status, call.replaySafe]), [["c1", "pending", false], ["c2", "refused", true]]);
});
