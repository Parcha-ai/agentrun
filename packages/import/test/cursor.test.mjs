// A cursor resumes a file where the last read stopped: by its identity (device, inode) and the byte after the last
// whole line read. A file truncated or replaced since is read again from its start; a last line with no newline yet is
// left for the next read; and a line appended later that repeats a request already read still sets its usage.
import assert from "node:assert/strict";
import { appendFile, rename, truncate, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { deserialize, serialize } from "node:v8";
import { parseHome, READERS } from "../dist/index.js";
import { anthropicUsage, claudeAnswer, claudeFile, claudeUser, jsonl, tempHome, writeJsonl } from "./fixtures.mjs";

/** Claude Code's reader on one file, from `cursor`: its one session, with the read's cursor and bytes. */
async function readFrom(file, cursor) {
  const { sessions, ...rest } = await READERS["claude-code"].read({ file }, cursor);
  return { ...sessions[0], ...rest };
}
const output = (result) => result.requests.reduce((n, turn) => n + (turn.usage?.output ?? 0), 0);
const opening = [
  claudeUser({ uuid: "u1", text: "Fixture question.", i: 0 }),
  claudeAnswer({ uuid: "a1", msg: "msg_1", req: "req_1", usage: anthropicUsage(10, 5), i: 1 }),
];

test("append: the next read takes only the new bytes, and a later line of a request read before replaces its usage", async (t) => {
  const file = await writeJsonl(claudeFile(await tempHome(t)), opening);
  const first = await readFrom(file);
  assert.equal(first.read, Buffer.byteLength(jsonl(opening)));
  assert.equal(first.cursor.offset, first.read);
  assert.equal(output(first), 5);
  const more = jsonl([
    claudeAnswer({ uuid: "a2", msg: "msg_1", req: "req_1", usage: anthropicUsage(10, 30), i: 2 }),
    claudeAnswer({ uuid: "a3", msg: "msg_2", req: "req_2", usage: anthropicUsage(4, 2), i: 3 }),
  ]);
  await appendFile(file, more);
  const second = await readFrom(file, first.cursor);
  assert.equal(second.read, Buffer.byteLength(more), "only the appended bytes are read");
  assert.equal(second.requests.length, 2, "msg_1 is still one request");
  assert.equal(output(second), 30 + 2, "msg_1 at its last line's 30, not 5 + 30");
  assert.deepEqual(second.session.turns.filter((turn) => turn.role === "assistant").map((turn) => turn.usage.output), [30, 2]);
  // The first read's result is its own: resuming never changes it.
  assert.equal(output(first), 5);
  // Nothing new: nothing read, the same totals.
  const third = await readFrom(file, second.cursor);
  assert.equal(third.read, 0);
  assert.equal(output(third), 32);
});

test("a cursor kept as bytes (v8 serialize) resumes as well as the live one", async (t) => {
  const file = await writeJsonl(claudeFile(await tempHome(t)), opening);
  const kept = serialize((await readFrom(file)).cursor);
  await appendFile(file, jsonl([claudeAnswer({ uuid: "a2", msg: "msg_1", req: "req_1", usage: anthropicUsage(10, 30), i: 2 })]));
  const resumed = await readFrom(file, deserialize(kept));
  assert.equal(resumed.requests.length, 1);
  assert.equal(output(resumed), 30);
});

test("truncate: a file shorter than the cursor's offset is read again from its start", async (t) => {
  const file = await writeJsonl(claudeFile(await tempHome(t)), [
    ...opening,
    claudeAnswer({ uuid: "a2", msg: "msg_2", req: "req_2", usage: anthropicUsage(10, 70), i: 2 }),
  ]);
  const first = await readFrom(file);
  assert.equal(output(first), 75);
  const shorter = jsonl([claudeUser({ uuid: "u9", text: "Other question.", i: 0 }), claudeAnswer({ uuid: "a9", msg: "msg_9", req: "req_9", usage: anthropicUsage(1, 3), i: 1 })]);
  await truncate(file, 0);
  await writeFile(file, shorter);
  const second = await readFrom(file, first.cursor);
  assert.equal(second.read, Buffer.byteLength(shorter));
  assert.equal(output(second), 3, "nothing of the old content is left");
  assert.equal(second.session.users, 1);
});

test("replace: another file at the same path (a new inode) is read from its start, even when it is longer", async (t) => {
  const home = await tempHome(t);
  const file = await writeJsonl(claudeFile(home), opening);
  const first = await readFrom(file);
  const replacement = await writeJsonl(join(home, "replacement.jsonl"), [
    claudeUser({ uuid: "u7", text: "Replacement question.", i: 0 }),
    claudeAnswer({ uuid: "a7", msg: "msg_7", req: "req_7", usage: anthropicUsage(1, 11), i: 1 }),
    claudeAnswer({ uuid: "a8", msg: "msg_8", req: "req_8", usage: anthropicUsage(1, 13), i: 2 }),
  ]);
  await rename(replacement, file);
  const second = await readFrom(file, first.cursor);
  assert.notEqual(second.cursor.ino, first.cursor.ino);
  assert.equal(second.read, second.cursor.offset);
  assert.equal(output(second), 24);
});

test("a partial last line is not consumed: the cursor stops before it, and the next read takes it whole, once", async (t) => {
  const file = await writeJsonl(claudeFile(await tempHome(t)), opening);
  const line = JSON.stringify(claudeAnswer({ uuid: "a2", msg: "msg_2", req: "req_2", usage: anthropicUsage(3, 9), i: 2 }));
  await appendFile(file, line.slice(0, 40));
  const first = await readFrom(file);
  assert.equal(first.cursor.offset, Buffer.byteLength(jsonl(opening)));
  assert.equal(output(first), 5);
  // The rest of the line, still without its newline: a whole record now, read, but not yet consumed.
  await appendFile(file, line.slice(40));
  const second = await readFrom(file, first.cursor);
  assert.equal(output(second), 14);
  assert.equal(second.cursor.offset, first.cursor.offset);
  await appendFile(file, "\n");
  const third = await readFrom(file, second.cursor);
  assert.equal(third.cursor.offset, Buffer.byteLength(jsonl(opening)) + Buffer.byteLength(line) + 1);
  assert.equal(output(third), 14, "msg_2 once");
  assert.equal(third.requests.length, 2);
});

test("parseHome with a state: a second pass reads only what was appended and agrees with a fresh pass", async (t) => {
  const home = await tempHome(t);
  const file = await writeJsonl(claudeFile(home), opening);
  const state = {};
  const [before] = await parseHome(home, { sources: ["claude-code"], state });
  assert.equal(before.tokens.output, 5);
  const more = jsonl([claudeAnswer({ uuid: "a2", msg: "msg_1", req: "req_1", usage: anthropicUsage(10, 30), i: 2 })]);
  await appendFile(file, more);
  const [after] = await parseHome(home, { sources: ["claude-code"], state });
  assert.equal(state.read, Buffer.byteLength(more));
  assert.deepEqual(after, (await parseHome(home, { sources: ["claude-code"] }))[0]);
  assert.equal(after.tokens.output, 30);
  assert.equal(after.calls, 1);
});

// A resumed session's file opens with copies of the session it resumed; the copies count in the first file in the import's
// order (by project folder, oldest written first). A pass with a state must come out as a fresh pass would, whatever
// changed that order since the last one.
const ORIGINAL = "00000000-0000-4000-8000-0000000000a1";
const RESUMED = "00000000-0000-4000-8000-0000000000b2";
const shared = [claudeUser({ uuid: "u1", text: "Fixture prompt.", i: 0, session: ORIGINAL }), claudeAnswer({ uuid: "a1", msg: "msg_1", req: "req_1", usage: anthropicUsage(100, 5), i: 1, session: ORIGINAL })];
const restamped = shared.map((record) => ({ ...record, sessionId: RESUMED }));
const own = (session, n, i) => [claudeUser({ uuid: `${session}-u${n}`, text: "More.", i, session }), claudeAnswer({ uuid: `${session}-a${n}`, msg: `${session}-msg_${n}`, req: `${session}-req_${n}`, usage: anthropicUsage(7, 3), i: i + 1, session })];
const setTime = (file, seconds) => utimes(file, seconds, seconds);
const scan = (home, state) => parseHome(home, { sources: ["claude-code"], catalog: false, ...(state ? { state } : {}) });

test("parseHome with a state: an append that moves the original after its resumed copy gives the fresh pass's totals", async (t) => {
  const home = await tempHome(t);
  const original = await writeJsonl(claudeFile(home, ORIGINAL), shared);
  const resumed = await writeJsonl(claudeFile(home, RESUMED), [...restamped, ...own(RESUMED, 1, 10)]);
  await setTime(original, 1_000);
  await setTime(resumed, 2_000);
  const state = {};
  await scan(home, state);
  await appendFile(original, jsonl(own(ORIGINAL, 1, 20)));
  await setTime(original, 3_000);
  const again = await scan(home, state);
  const fresh = await scan(home);
  assert.equal(fresh.find(({ id }) => id === RESUMED).calls, 2, "fresh: the copy is first now, and keeps the shared request");
  assert.deepEqual(again, fresh);
});

test("parseHome with a state: a new file that comes before a known one holding the same records gives the fresh pass's totals", async (t) => {
  const home = await tempHome(t);
  await writeJsonl(claudeFile(home, ORIGINAL, "-work-b"), shared);
  const state = {};
  await scan(home, state);
  // A session moved to a folder that sorts first, its copy carried on there.
  await writeJsonl(claudeFile(home, RESUMED, "-work-a"), [...restamped, ...own(RESUMED, 1, 10)]);
  const again = await scan(home, state);
  const fresh = await scan(home);
  assert.equal(fresh.length, 1, "fresh: the original's records are all the new file's");
  assert.deepEqual(again, fresh);
});

test("parseHome with a state: a change of order among files that share no record reads only the new bytes", async (t) => {
  const home = await tempHome(t);
  const UNRELATED = "00000000-0000-4000-8000-0000000000c3";
  const original = await writeJsonl(claudeFile(home, ORIGINAL), shared);
  const resumed = await writeJsonl(claudeFile(home, RESUMED), [...restamped, ...own(RESUMED, 1, 10)]);
  const unrelated = await writeJsonl(claudeFile(home, UNRELATED), own(UNRELATED, 1, 0));
  await setTime(original, 1_000);
  await setTime(unrelated, 1_500);
  await setTime(resumed, 2_000);
  const state = {};
  await scan(home, state);
  // The unrelated file moves after the copy; the original stays before it.
  const more = jsonl(own(UNRELATED, 2, 20));
  await appendFile(unrelated, more);
  await setTime(unrelated, 3_000);
  const again = await scan(home, state);
  assert.equal(state.read, Buffer.byteLength(more));
  assert.deepEqual(again, await scan(home));
});
