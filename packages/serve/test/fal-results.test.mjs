// A completed fal job's result, filed in the run's files at evidence/fal/<request_id>.json as fal answered it, so an
// agent reads it from the file instead of retyping it out of the answer. fal names the file (its request_id), so the
// name is checked as a boundary: only fal's UUID shape names a file, so a request_id that isn't one (a slash, "..", a
// NUL byte, an absolute path, a long name, a plain name that is path-safe but not a UUID) files nothing, and nothing is written through a link at evidence/ or evidence/fal/ or in place
// of a file already there. The answer the model reads is fal's text byte for byte in every case, and the call itself
// works: filing is never a failed call. wait_for_jobs bills nothing, so filing its result books nothing either.
// Each refusal case has a control that files something in the same run (a sibling job with a UUID, or the same
// answer once the link is gone), so a gateway that files nothing at all fails here too.
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { memorySessionStore } from "@parcha/agentrun-kernel/testing";
import { mcpGateway } from "../dist/mcp-gateway.js";
import { bookedIn } from "../dist/paid-calls.js";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";

const cap = await import("../../run-adapters/dist/kernel/cap/index.js");
const TOKEN = "mcp-token";
const FAL = "https://mcp.fal.ai/mcp";
const VOICE = "fal-ai/elevenlabs/tts/eleven-v3";
const textOf = (result) => result.content.map((block) => block.text).join("");

/** An eleven-v3 result with `n` timestamps chunks, as fal answers one: the audio, and each chunk's characters with
 *  their start and end times. */
function voiceResult(n = 14) {
  const words = "Scheduled exports send a report on a timetable you choose and arrive within fifteen minutes".split(" ");
  let t = 0.15;
  const timestamps = Array.from({ length: n }, (_, i) => {
    const characters = [...`${words[i % words.length]} `];
    const character_start_times_seconds = characters.map(() => Math.round((t += 0.075) * 1000) / 1000);
    const character_end_times_seconds = character_start_times_seconds.map((s) => Math.round((s + 0.075) * 1000) / 1000);
    return { characters, character_start_times_seconds, character_end_times_seconds };
  });
  return { audio: { url: "https://v3.fal.media/files/zebra/voice_output.mp3", content_type: "audio/mpeg", file_name: "output.mp3", file_size: 466560 }, timestamps };
}

/** A completed job of `endpoint` with `request_id`, in fal's wait_for_jobs shape. */
const completed = (index, request_id, result, endpoint = VOICE) => ({
  index,
  endpoint_id: endpoint,
  request_id,
  status_url: `https://queue.fal.run/${endpoint}/requests/${encodeURIComponent(request_id)}/status`,
  response_url: `https://queue.fal.run/${endpoint}/requests/${encodeURIComponent(request_id)}`,
  queue_status: "COMPLETED",
  status: "completed",
  terminal: true,
  result,
  media: [],
  has_result: true,
});

/** One run's gateway pinned to fal's address (the fake answering), whose wait_for_jobs answers `answer()` as one text
 *  block, the JSON text fal sends. `work`: the run's files. `paid`: every hold and settlement the call booked. */
async function runOn(t, answer) {
  const fake = await startFakeMcp({ token: TOKEN });
  t.after(() => fake.close());
  const said = [];
  fake.tools.wait_for_jobs = {
    description: "wait_for_jobs",
    input: { type: "object", properties: {} },
    run: () => {
      const text = JSON.stringify(answer());
      said.push(text);
      return { content: [{ type: "text", text }] };
    },
  };
  const work = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "fal-results-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  const store = memorySessionStore();
  const tools = await cap.runCap({ sessions: store, capUsd: () => 5, modelOf: () => undefined }).tools(await store.open(cap.TOOL_SESSION));
  const booked = [];
  const paid = {
    admit: (request) => (booked.push({ admit: request }), tools.admit(request)),
    settle: (id, usd, options) => (booked.push({ settle: id, usd }), tools.settle(id, usd, options)),
  };
  const gateway = mcpGateway({
    pin: { fal: { url: FAL, tools: [{ name: "wait_for_jobs", inputSchema: { type: "object" } }], meter: "fal" } },
    credentials: { fal: { url: FAL, headers: { authorization: `Bearer ${TOKEN}` } } },
    work: () => work,
    commit: () => async (change) => change({ appendEntry: async () => undefined }),
    capped: true,
    fetch: (input, init) => fetch(String(input instanceof Request ? input.url : input).replace(FAL, fake.url), init),
  });
  let calls = 0;
  return {
    work,
    booked,
    said,
    /** wait_for_jobs, checked to work: not an error, and its text fal's byte for byte. */
    async wait() {
      const callId = `c${(calls += 1)}`;
      const result = await bookedIn({ call: callId, paid }, () => gateway.call("fal", "wait_for_jobs", { requests: [{ index: 0, request_id: "any" }] }, { signal: new AbortController().signal, callId }));
      assert.equal(result.isError, undefined, `the call works: ${textOf(result)}`);
      assert.equal(textOf(result), said.at(-1), "the model reads fal's answer byte for byte");
      return result;
    },
  };
}

/** Every path under `dir`, relative, links included and never followed. */
async function tree(dir, at = "") {
  const out = [];
  for (const entry of await readdir(join(dir, at), { withFileTypes: true }).catch(() => [])) {
    const path = at ? `${at}/${entry.name}` : entry.name;
    out.push(path);
    if (entry.isDirectory()) out.push(...(await tree(dir, path)));
  }
  return out.sort();
}

const filed = async (work, id) => JSON.parse(await readFile(join(work, "evidence", "fal", `${id}.json`), "utf8"));

test("a completed job's result is filed at evidence/fal/<request_id>.json as fal answered it; the answer is unchanged and nothing is booked", async (t) => {
  const result = voiceResult(14);
  const id = "01a1fae4-8bd3-74a0-a095-67c75220bb80";
  const run = await runOn(t, () => ({ all_terminal: true, jobs: [completed(0, id, result)] }));
  await run.wait();
  assert.deepEqual(await filed(run.work, id), result, "the file is the job's result, all 14 chunks");
  assert.equal((await filed(run.work, id)).timestamps.length, 14);
  // wait_for_jobs reads jobs fal already ran: no hold, no settlement, nothing sent again.
  assert.deepEqual(run.booked, [], "nothing is held or booked for it");
  assert.equal(run.said.length, 1, "fal was asked once");
});

for (const [name, bad] of [
  ["a slash", "a/b"],
  ["a parent name", ".."],
  ["a parent step", "../escaped"],
  ["a NUL byte", "x\u0000y"],
  ["an absolute path", "/ABSOLUTE"],
  ["a name past the limit (129 plain characters)", "a".repeat(129)],
  ["a name longer than a filename (300 characters)", "b".repeat(300)],
  // Path-safe, but not fal's: fal's request ids are UUIDs, and only a UUID names a file.
  ["a plain name that is not a UUID", "req-probe-1"],
  ["a UUID with a suffix", "01a1fae4-8bd3-74a0-a095-67c75220bb80.x"],
]) {
  test(`a request_id with ${name} files nothing, the call works and its sibling with a UUID is filed`, async (t) => {
    const outside = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "fal-results-outside-"));
    t.after(() => rm(outside, { recursive: true, force: true }));
    const id = bad === "/ABSOLUTE" ? join(outside, "abs") : bad;
    const good = "01a1fb16-9efc-7bb0-9c97-321095a32f8f";
    const run = await runOn(t, () => ({ all_terminal: true, jobs: [completed(0, id, voiceResult(2)), completed(1, good, voiceResult(3))] }));
    await run.wait();
    assert.deepEqual(await filed(run.work, good), voiceResult(3), "the UUID sibling's result is filed");
    assert.deepEqual(await tree(run.work), ["evidence", "evidence/fal", `evidence/fal/${good}.json`], "and nothing else in the run's files");
    assert.deepEqual(await tree(outside), [], "nothing outside them");
  });
}

for (const [name, link] of [
  ["evidence/fal", ["evidence", "fal"]],
  ["evidence/", ["evidence"]],
]) {
  test(`a link at ${name} is never written through: nothing lands where it points, and once it is gone the same answer is filed`, async (t) => {
    const outside = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "fal-results-outside-"));
    t.after(() => rm(outside, { recursive: true, force: true }));
    const id = "01a1fae4-8f96-7df1-9efb-5f6e4100fc89";
    const run = await runOn(t, () => ({ all_terminal: true, jobs: [completed(0, id, voiceResult(4))] }));
    if (link.length === 2) await mkdir(join(run.work, link[0]));
    await symlink(outside, join(run.work, ...link));
    await run.wait();
    assert.deepEqual(await tree(outside), [], "nothing written where the link points");
    assert.ok((await lstat(join(run.work, ...link))).isSymbolicLink(), "the link is left as it was");
    // The control: the link removed, the same answer is filed in the run's own files.
    await rm(join(run.work, ...link));
    await run.wait();
    assert.deepEqual(await filed(run.work, id), voiceResult(4));
    assert.deepEqual(await tree(outside), []);
  });
}

test("a link already at evidence/fal/<request_id>.json is never followed or replaced; a sibling job is filed", async (t) => {
  const outside = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "fal-results-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const id = "01a1faea-0044-7862-9398-3a051d9253c8";
  const good = "01a1fb09-6d45-72a1-a5c1-30494186d99a";
  await writeFile(join(outside, "target.json"), "OUTSIDE");
  const run = await runOn(t, () => ({ all_terminal: true, jobs: [completed(0, id, voiceResult(2)), completed(1, good, voiceResult(5))] }));
  await mkdir(join(run.work, "evidence", "fal"), { recursive: true });
  await symlink(join(outside, "target.json"), join(run.work, "evidence", "fal", `${id}.json`));
  await run.wait();
  assert.equal(await readFile(join(outside, "target.json"), "utf8"), "OUTSIDE", "the link's target is untouched");
  assert.ok((await lstat(join(run.work, "evidence", "fal", `${id}.json`))).isSymbolicLink(), "the link is not replaced");
  assert.deepEqual(await filed(run.work, good), voiceResult(5), "the sibling is filed");
});

test("write-once: a file already at the path is never overwritten, and a second identical answer leaves the filed bytes and file as they were", async (t) => {
  const kept = "01a1fae4-8b76-7802-af62-221d532166b1";
  const fresh = "01a1fae4-8b94-7ba3-bc06-0fbe5eee95cc";
  const run = await runOn(t, () => ({ all_terminal: true, jobs: [completed(0, kept, voiceResult(6)), completed(1, fresh, voiceResult(7))] }));
  await mkdir(join(run.work, "evidence", "fal"), { recursive: true });
  await writeFile(join(run.work, "evidence", "fal", `${kept}.json`), "ALREADY HERE");
  await run.wait();
  assert.equal(await readFile(join(run.work, "evidence", "fal", `${kept}.json`), "utf8"), "ALREADY HERE", "the file already there is kept");
  const path = join(run.work, "evidence", "fal", `${fresh}.json`);
  assert.deepEqual(await filed(run.work, fresh), voiceResult(7), "the other job is filed");
  const before = { bytes: await readFile(path), ...(({ ino, mtimeMs }) => ({ ino, mtimeMs }))(await stat(path)) };
  // The same answer again (a second wait on the same jobs): nothing is written over it.
  await run.wait();
  const after = { bytes: await readFile(path), ...(({ ino, mtimeMs }) => ({ ino, mtimeMs }))(await stat(path)) };
  assert.deepEqual(after, before, "the same file, its bytes and its time unchanged");
  assert.equal(await readFile(join(run.work, "evidence", "fal", `${kept}.json`), "utf8"), "ALREADY HERE");
});
