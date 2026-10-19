// fal's queue answers a submitted job with the addresses to poll and to fetch from. The key goes only to the queue's own
// origin and the job paths of the model: an answer that names anything else is refused before a request carries the key,
// with an error that names the origin and never the key.
import assert from "node:assert/strict";
import { test } from "node:test";
import { SENTINEL_TRANSCRIBER_KEY } from "@parcha/pi-vision/testing";
import { falTranscriber } from "@parcha/pi-vision/transcribers";

const AUDIO = { bytes: Buffer.alloc(64, 1), mimeType: "audio/mpeg", name: "landing.mp3" };
const SUBMIT = "https://queue.fal.run/fal-ai/elevenlabs/speech-to-text/scribe-v2";
const GOOD = { status_url: "https://queue.fal.run/fal-ai/elevenlabs/requests/r1/status", response_url: "https://queue.fal.run/fal-ai/elevenlabs/requests/r1" };

/** A queue that answers a submission with `named` and every other request as a finished job; every request is kept. */
function queue(named, auth = "Key") {
  const seen = [];
  const fetch = async (url, init = {}) => {
    seen.push({ url: String(url), method: init.method ?? "GET", authorization: init.headers?.Authorization });
    if (init.method === "POST") return Response.json({ status: "IN_QUEUE", request_id: "r1", ...named });
    if (String(url).endsWith("/status")) return Response.json({ status: "COMPLETED" });
    return Response.json({ text: "hi", words: [{ type: "word", word: "hi", start: 0, end: 1 }] });
  };
  return { fetch, seen, run: (options = {}) => falTranscriber({ apiKey: () => SENTINEL_TRANSCRIBER_KEY, fetch, pollMs: 1, auth: auth === "Key" ? "key" : "bearer", ...options }).transcribe(AUDIO, {}) };
}
const refusal = (pattern) => (error) => error instanceof Error && pattern.test(error.message) && !error.message.includes(SENTINEL_TRANSCRIBER_KEY);

const REFUSED = [
  ["a status address on another origin", { ...GOOD, status_url: "https://evil.example/fal-ai/elevenlabs/requests/r1/status" }, /^fal named a status_url at https:\/\/evil\.example, not on the queue at https:\/\/queue\.fal\.run; the key was not sent there$/],
  ["an answer address on another origin", { ...GOOD, response_url: "https://evil.example/fal-ai/elevenlabs/requests/r1" }, /^fal named a response_url at https:\/\/evil\.example, not on the queue at https:\/\/queue\.fal\.run;/],
  ["a host that begins with the queue's name", { ...GOOD, status_url: "https://queue.fal.run.evil.example/fal-ai/elevenlabs/requests/r1/status" }, /status_url at https:\/\/queue\.fal\.run\.evil\.example, not on the queue/],
  ["the queue's origin with another scheme", { ...GOOD, status_url: "http://queue.fal.run/fal-ai/elevenlabs/requests/r1/status" }, /status_url at http:\/\/queue\.fal\.run, not on the queue/],
  ["another model's job on the queue", { ...GOOD, status_url: "https://queue.fal.run/fal-ai/flux/requests/r1/status" }, /^fal named a status_url on https:\/\/queue\.fal\.run outside the job paths of fal-ai\/elevenlabs\/speech-to-text\/scribe-v2;/],
  ["a path that climbs out of the job paths", { ...GOOD, status_url: "https://queue.fal.run/fal-ai/elevenlabs/requests/../../flux/requests/r1/status" }, /outside the job paths/],
  ["a path that climbs out with encoded dots", { ...GOOD, response_url: "https://queue.fal.run/fal-ai/elevenlabs/requests/%2e%2e/%2e%2e/flux/requests/r1" }, /outside the job paths/],
  ["an address with credentials of its own", { ...GOOD, status_url: "https://user:secret@queue.fal.run/fal-ai/elevenlabs/requests/r1/status" }, /outside the job paths of fal-ai/],
  ["a string that is not an address", { ...GOOD, status_url: "r1/status" }, /^fal named a status_url that is not an address; the key was not sent there$/],
  ["no address at all", { status_url: undefined, response_url: GOOD.response_url }, /^fal named a status_url that is not an address;/],
];
for (const [what, named, pattern] of REFUSED) {
  test(`${what} is refused before any request carries the key`, async () => {
    const q = queue(named);
    await assert.rejects(q.run(), refusal(pattern));
    assert.deepEqual(q.seen.map((r) => [r.method, r.url]), [["POST", SUBMIT]], "only the submission, to the queue itself, was sent");
  });
}

test("through a pass-through the key goes to its origin and its path only, and fal's own addresses are rewritten to it", async () => {
  const broker = "http://broker.invalid/fal-queue/";
  const prefix = "http://broker.invalid/fal-queue/fal-ai/elevenlabs/requests/r1";
  const rewritten = queue(GOOD, "Bearer");
  assert.equal((await rewritten.run({ queueUrl: broker })).text, "hi");
  assert.deepEqual(rewritten.seen.map((r) => r.url), ["http://broker.invalid/fal-queue/fal-ai/elevenlabs/speech-to-text/scribe-v2", `${prefix}/status`, prefix]);
  assert.ok(rewritten.seen.every((r) => r.authorization === `Bearer ${SENTINEL_TRANSCRIBER_KEY}` && r.url.startsWith("http://broker.invalid/fal-queue/")));
  const named = queue({ status_url: `${prefix}/status`, response_url: prefix }, "Bearer");
  assert.equal((await named.run({ queueUrl: broker })).text, "hi", "an address already on the pass-through is taken as it is");
  for (const bad of [{ ...GOOD, status_url: "https://evil.example/fal-ai/elevenlabs/requests/r1/status" }, { ...GOOD, status_url: "http://broker.invalid/other/requests/r1/status" }, { ...GOOD, response_url: "http://broker.invalid:8080/fal-queue/fal-ai/elevenlabs/requests/r1" }]) {
    const q = queue(bad, "Bearer");
    await assert.rejects(q.run({ queueUrl: broker }), refusal(/^fal named a (status|response)_url /));
    assert.equal(q.seen.length, 1, "nothing but the submission went out");
  }
});

test("the addresses fal gives for a model are taken in both forms it gives them: under the model's owner and app, and under its whole path", async () => {
  for (const root of ["fal-ai/elevenlabs", "fal-ai/elevenlabs/speech-to-text/scribe-v2"]) {
    const q = queue({ status_url: `https://queue.fal.run/${root}/requests/r1/status`, response_url: `https://queue.fal.run/${root}/requests/r1` });
    assert.equal((await q.run()).text, "hi", root);
    assert.deepEqual(q.seen.map((r) => r.url).slice(1), [`https://queue.fal.run/${root}/requests/r1/status`, `https://queue.fal.run/${root}/requests/r1`]);
  }
});
