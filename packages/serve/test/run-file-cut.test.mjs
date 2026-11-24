// A run's file read under the run's own cut (GET /v2/runs/{id}/files/{path}?cut=run): its UTF-8 text with every value
// the run's cut holds (a key a person saved, a secret store's value) and every secret shape replaced by "[redacted]" in
// place, through redactSecrets over the whole text, so compact JSON past 8 KB with no whitespace comes through whole. A
// type that isn't text, or bytes that aren't UTF-8 or hold a NUL, is 415; a file over RUN_FILE_CUT_MAX is 413. Without
// the cut the file is the bytes as written. A handed sign-in's ref and a withheld run's 403 are read in
// planted-run-reads.test.mjs, beside every other run read. An API-only server serves it as the whole server does. The
// listing with the cut (GET /v2/runs/{id}/files?cut=run) names each file by its path under the same cut.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { redactSecrets } from "../dist/learn/secrets.js";
import { RUN_FILE_CUT_MAX } from "../dist/run-files.js";
import { plantedValue } from "./fixtures/planted-secrets.mjs";
import { agent, follow, runDir, serve, startRun, withEnv } from "./support.mjs";

const get = (baseUrl, token, path) => fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });

/** A finished run on a server holding a saved tool key and a webhook trigger's signing secret: the run, its work folder
 *  and the two values. */
async function heldRun(t) {
  const served = await serve(t);
  const monid = plantedValue("monid");
  assert.equal((await served.api("PUT", "/settings/tool-keys/monid", { values: { MONID_API_KEY: monid } })).status, 204);
  assert.equal((await served.api("POST", "/agents", agent("hooked"))).status, 201);
  const trigger = await served.api("POST", "/triggers", { name: "on push", source: { kind: "webhook" }, target: { kind: "start_run", agent_id: "hooked", input: { content: "Triage this event." }, max_cost_usd: 0.5 } });
  assert.equal(trigger.status, 201, JSON.stringify(trigger.body));
  const whsec = trigger.body.signing_secret ?? trigger.body.secret;
  assert.match(String(whsec), /^whsec_/);
  const { run_id } = await startRun(served.api, "writer", "Write the report.", { tools: ["write"] });
  await follow(served.api, run_id, ["completed"]);
  return { ...served, run_id, work: join(runDir(served.data, run_id), "work"), monid, whsec };
}

test("a text file read with cut=run has a saved tool key and a secret store's value cut in place; read raw it is the bytes as written", { timeout: 120_000 }, async (t) => {
  const { baseUrl, token, run_id, work, monid, whsec } = await heldRun(t);
  const text = `key=${monid}\nhook=${whsec}\nthe rest stays.\n`;
  await writeFile(join(work, "notes.txt"), text);
  const cut = await get(baseUrl, token, `/runs/${run_id}/files/notes.txt?cut=run`);
  assert.equal(cut.status, 200);
  assert.equal(cut.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(cut.headers.get("cache-control"), "no-store");
  assert.equal(cut.headers.get("x-agentrun-cut"), "run", "marked as the cut text");
  assert.equal(await cut.text(), "key=[redacted]\nhook=[redacted]\nthe rest stays.\n");
  const raw = await get(baseUrl, token, `/runs/${run_id}/files/notes.txt`);
  assert.equal(raw.status, 200);
  assert.equal(raw.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(raw.headers.get("x-agentrun-cut"), null, "the raw bytes carry no cut mark");
  assert.equal(await raw.text(), text, "without the cut, the bytes as written");
});

test("compact JSON past 8 KB with no whitespace comes through a cut read whole, and a held value in it is cut in place", { timeout: 120_000 }, async (t) => {
  const { baseUrl, token, run_id, work, monid } = await heldRun(t);
  const words = JSON.stringify({ words: Array.from({ length: 1500 }, (_, i) => ({ w: `word${i}`, start: i * 0.25, end: i * 0.25 + 0.2 })) });
  assert.ok(Buffer.byteLength(words) > 8192 && !/\s/.test(words), "one run with no whitespace past 8 KB");
  await writeFile(join(work, "timestamps.json"), words);
  const whole = await get(baseUrl, token, `/runs/${run_id}/files/timestamps.json?cut=run`);
  assert.equal(whole.status, 200);
  assert.equal(await whole.text(), words, "whole, never blanked for its length");
  const held = JSON.stringify({ key: monid, words: JSON.parse(words).words });
  await writeFile(join(work, "held.json"), held);
  const cut = await get(baseUrl, token, `/runs/${run_id}/files/held.json?cut=run`);
  assert.equal(cut.status, 200);
  assert.equal(await cut.text(), held.replace(monid, "[redacted]"));
  // An untyped extension is read as text when its bytes are UTF-8.
  await writeFile(join(work, "captions.srt"), `1\n00:00:00,000 --> 00:00:01,000\n${monid}\n`);
  const srt = await get(baseUrl, token, `/runs/${run_id}/files/captions.srt?cut=run`);
  assert.equal(srt.status, 200);
  assert.equal(await srt.text(), "1\n00:00:00,000 --> 00:00:01,000\n[redacted]\n");
});

test("a cut read of a file that isn't text is 415, of one over the cap 413, and a cut other than run 400", { timeout: 120_000 }, async (t) => {
  const { baseUrl, token, run_id, work } = await heldRun(t);
  const codeOf = async (path) => {
    const res = await get(baseUrl, token, `/runs/${run_id}/files/${path}`);
    const body = await res.json();
    return [res.status, body.error?.code];
  };
  await writeFile(join(work, "shot.png"), Buffer.from("89504e470d0a1a0a", "hex"));
  await writeFile(join(work, "blob.dat"), Buffer.from([0x61, 0xff, 0xfe, 0x62]));
  await writeFile(join(work, "nul.txt"), "a\u0000b");
  assert.deepEqual(await codeOf("shot.png?cut=run"), [415, "unsupported_media_type"], "an image");
  assert.deepEqual(await codeOf("blob.dat?cut=run"), [415, "unsupported_media_type"], "bytes that aren't UTF-8");
  assert.deepEqual(await codeOf("nul.txt?cut=run"), [415, "unsupported_media_type"], "a NUL byte");
  await writeFile(join(work, "at-cap.txt"), "a".repeat(RUN_FILE_CUT_MAX));
  await writeFile(join(work, "past-cap.txt"), "a".repeat(RUN_FILE_CUT_MAX + 1));
  const atCap = await get(baseUrl, token, `/runs/${run_id}/files/at-cap.txt?cut=run`);
  assert.equal(atCap.status, 200);
  assert.equal((await atCap.text()).length, RUN_FILE_CUT_MAX, "a file of the cap's size is read whole");
  assert.deepEqual(await codeOf("past-cap.txt?cut=run"), [413, "payload_too_large"]);
  assert.deepEqual(await codeOf("notes.txt?cut=whole"), [400, "bad_request"]);
  // Raw, each is served as before.
  for (const path of ["shot.png", "blob.dat", "nul.txt", "past-cap.txt"]) assert.equal((await get(baseUrl, token, `/runs/${run_id}/files/${path}`)).status, 200, path);
});

test("redactSecrets over a whole file of 120,000 characters and of the cut read's cap, with 20 held values, is bounded", () => {
  const held = Array.from({ length: 20 }, (_, i) => `held-${i}-${randomBytes(16).toString("hex")}`);
  const prose = (size) => {
    const line = "the quick brown fox jumps over the lazy dog, then reads the timestamps file again. ";
    const text = line.repeat(Math.ceil(size / line.length)).slice(0, size - held[0].length - 1);
    return `${text} ${held[0]}`;
  };
  for (const size of [120_000, RUN_FILE_CUT_MAX]) {
    const text = prose(size);
    const began = performance.now();
    const out = redactSecrets(text, held, Buffer.byteLength(text));
    const took = performance.now() - began;
    assert.ok(out.endsWith(" [redacted]") && !out.includes(held[0]), "the held value is cut in place");
    // About 40 ms (120,000) and 80 ms (the cap) here.
    assert.ok(took < 1500, `${size}: took ${Math.round(took)} ms`);
  }
});

test("an API-only server serves the cut read with its token: a key the server holds cut in place, marked; the raw read as written", { timeout: 120_000 }, async (t) => {
  // A key in the server's environment, made at runtime (no credential-shaped literal for the source export).
  const held = ["not", "a", "real", "key", randomBytes(8).toString("hex")].join("-");
  withEnv(t, { CUT_READ_TEST_API_KEY: held });
  const server = await serve(t, { apiOnly: true });
  const inline = await server.api("POST", "/runs", { external: { source: "backend", kind: "expert", id: "cut-1", version: 1 }, definition: { name: "Expert cut-1", instructions: "Answer the question.", skills: [], tools: [], harness: "pi" }, input: { content: "What is six times seven." } });
  assert.equal(inline.status, 202, JSON.stringify(inline.body));
  await follow(server.api, inline.body.run_id, ["completed"], { deadlineMs: 60_000 });
  const text = `token=${held}\n${JSON.stringify({ ids: Array.from({ length: 1200 }, (_, i) => `id-${i}`) })}\n`;
  await writeFile(join(runDir(server.data, inline.body.run_id), "work", "out.txt"), text);
  const cut = await get(server.baseUrl, server.token, `/runs/${inline.body.run_id}/files/out.txt?cut=run`);
  assert.equal(cut.status, 200);
  assert.equal(cut.headers.get("x-agentrun-cut"), "run");
  assert.equal(await cut.text(), text.replace(held, "[redacted]"));
  const raw = await get(server.baseUrl, server.token, `/runs/${inline.body.run_id}/files/out.txt`);
  assert.equal(await raw.text(), text, "the raw read as written");
  assert.equal((await fetch(`${server.baseUrl}/runs/${inline.body.run_id}/files/out.txt?cut=run`)).status, 401, "and it takes the token");
});

test("a listing with cut=run gives each file its name under the run's cut, a held value in a path cut in place; without cut no name; another cut 400", { timeout: 120_000 }, async (t) => {
  const { baseUrl, token, run_id, work, monid } = await heldRun(t);
  await mkdir(join(work, "cache"), { recursive: true });
  await mkdir(join(work, "media"), { recursive: true });
  await writeFile(join(work, "cache", `${monid}.json`), "{}\n");
  await writeFile(join(work, "media", `${monid}.mp3`), Buffer.from("fffb9000", "hex"));
  await writeFile(join(work, "plain.txt"), "plain\n");
  const cut = await get(baseUrl, token, `/runs/${run_id}/files?cut=run`);
  assert.equal(cut.status, 200);
  const listed = await cut.json();
  const byPath = new Map(listed.files.map((file) => [file.path, file]));
  assert.equal(byPath.get(`cache/${monid}.json`)?.name, "cache/[redacted].json");
  assert.equal(byPath.get(`media/${monid}.mp3`)?.name, "media/[redacted].mp3", "a file the cut read doesn't take (audio) is named under the cut too");
  assert.equal(byPath.get("plain.txt")?.name, "plain.txt", "a path with no held value is its own name");
  assert.ok(listed.files.every((file) => typeof file.name === "string" && !file.name.includes(monid)), "every entry has a name, none holding the value");
  const raw = await (await get(baseUrl, token, `/runs/${run_id}/files`)).json();
  assert.ok(raw.files.every((file) => file.name === undefined), "without the cut, no name");
  assert.ok(raw.files.some((file) => file.path === `cache/${monid}.json`), "and the paths as they are");
  const bad = await get(baseUrl, token, `/runs/${run_id}/files?cut=whole`);
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error?.code, "bad_request");
});
