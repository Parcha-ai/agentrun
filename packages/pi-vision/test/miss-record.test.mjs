// A look that failed reaches the host's `onMiss` with the record it filed. A host whose sink files nothing for an image
// no door named (a screenshot) can then file that look itself, and what the eyes charged for it is counted: a failed look
// the eyes answered without words, or a source that billed for none, is a cost whether or not a receipt exists. Every
// path that fails a look carries the record; a miss before any look (the host's own setup failing) carries none.
import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { SeeMiss, blocksSha256, guardResult, judge, lookKey, readMedia, readWithoutSetup, reportMiss, resolveLimits, see, transcribe } from "@parcha/pi-vision";
import { nodeVisionEnv } from "@parcha/pi-vision/node";
import { sharpImages } from "@parcha/pi-vision/providers/sharp";
import { LeakScan, SENTINEL_EYES_KEY, SENTINEL_LINK_SIGNATURE, SENTINEL_LINK_TOKEN, SENTINEL_SIGNED_LINK, fakeEyes, fixtureDir, imageSize, pngBytes } from "@parcha/pi-vision/testing";
import { fakeJev } from "./support/jev.mjs";

const b64 = (bytes) => Buffer.from(bytes).toString("base64");
const png = (w, h) => ({ type: "image", data: b64(pngBytes(w, h)), mimeType: "image/png" });
const TEXT_ONLY = { id: "lead-model", input: ["text"] };
const call = { conversationId: "c1", callId: "t1", model: TEXT_ONLY, signal: undefined };

/** A sink that keeps what it is given, and the host's hooks, each call in order. */
function host(over = {}) {
  const filed = [], looks = [], misses = [];
  return {
    filed, looks, misses,
    setup: {
      limits: resolveLimits(TEXT_ONLY), eyes: undefined, providers: [], sources: {}, scope: { label: "n", deriveDir: "evidence/n/media" },
      evidence: { file: async (label, record) => { filed.push(record); return { path: `evidence/${label}/${filed.length}-look.md` }; } },
      onLook: (look) => looks.push(look),
      onMiss: (miss) => misses.push(miss),
      ...over,
    },
  };
}
/** A screenshot: an image block in a tool's result that no door named, so no sink is given its look. */
const screenshot = (blocks = [png(40, 30)]) => ({ content: [{ type: "text", text: "a screenshot" }, ...blocks], details: { path: "evidence/n/1-screenshot.png" } });
/** A file a door named, which has a receipt. */
const file = (blocks = [png(40, 30)]) => ({ content: [{ type: "text", text: "drawer.png read." }, ...blocks], details: { path: "drawer.png", media: { kind: "image", path: "drawer.png", ask: "What is shown?", sha256: "ab".repeat(32) } } });
const guard = (result, h, eyes) => guardResult(result, call, { ...h.setup, eyes }, imageSize);
/** What a host that files every look it hears of would count: each ok look's price and each failed look's record's. */
const counted = (h) => [...h.looks.map((look) => look.costUsd), ...h.misses.flatMap((miss) => (miss.record ? [miss.record.facts.cost_usd ?? null] : []))];

test("a failed screenshot look the eyes charged for reaches onMiss with its record: its key, its tokens and its price; the sink never saw it", async () => {
  const blocks = [png(40, 30)];
  const h = host();
  const eyes = fakeEyes({ answers: [{ text: "", input: 1200, output: 30 }] });
  const out = await guard(screenshot(blocks), h, eyes);
  assert.equal(out.content.filter((b) => b.type === "image").length, 0);
  assert.equal(eyes.ledger.length, 1, "the eyes were asked, and charged");
  assert.equal(h.filed.length, 0, "a screenshot names no file, so the sink files nothing");
  assert.equal(h.looks.length, 0, "a failed look is not a look");
  assert.equal(h.misses.length, 1);
  const [miss] = h.misses;
  assert.deepEqual([miss.code, miss.receipt, miss.model, miss.reason], ["look_failed", null, "fake-eyes", "the vision route fake-eyes returned no text"]);
  const { record } = miss;
  assert.deepEqual([record.tool, record.status, record.body, record.args.model, record.args.native], ["look", "failed", "not seen: the vision route fake-eyes returned no text", "fake-eyes", false]);
  assert.equal(record.facts.key, lookKey({ sha256: blocksSha256(blocks), fragment: "", model: "fake-eyes" }), "the key of this look, which a retry that is answered files under too");
  assert.equal(record.facts.sha256, blocksSha256(blocks));
  assert.deepEqual([record.facts.tokens_in, record.facts.tokens_out], [1200, 30]);
  assert.ok(Math.abs(record.facts.cost_usd - (1200 * 1 + 30 * 4) / 1e6) < 1e-12 && record.facts.cost_usd > 0, "what the eyes charged");
  assert.deepEqual(counted(h), [record.facts.cost_usd], "a host that files the records it is given counts it");

  const retry = await guard(screenshot(blocks), h, fakeEyes({ answers: ["A page."] }));
  assert.match(retry.content[1].text, /seen for you by fake-eyes/);
  assert.equal(h.looks[0].record.facts.key, record.facts.key, "the answered look is filed under the failed look's key");
  assert.equal(counted(h).length, 2, "the failed look and the answered one are two payments");
});

test("a request that threw has no price to file; one the eyes cannot price files null; neither is ever a 0 nobody earned", async () => {
  const thrown = host();
  await guard(screenshot(), thrown, fakeEyes({ answers: [{ fail: "route down" }] }));
  const [{ record }] = thrown.misses;
  assert.deepEqual([record.status, record.facts.key.length, "cost_usd" in record.facts, "tokens_in" in record.facts], ["failed", 64, false, false], "unknown by its absence, as a receipt says");
  const unpriced = host();
  await guard(screenshot(), unpriced, fakeEyes({ price: null, answers: [{ text: "", input: 900, output: 10 }] }));
  const [{ record: unknown }] = unpriced.misses;
  assert.deepEqual([unknown.facts.cost_usd, unknown.facts.tokens_in], [null, 900]);
  const before = host();
  await guard(screenshot(), before, undefined);
  const [{ record: free }] = before.misses;
  assert.deepEqual([free.facts.cost_usd, free.facts.tokens_in, free.facts.tokens_out, free.body], [0, 0, 0, "not seen: no vision route is configured for this run"], "a miss before any request cost nothing, and says so");
});

test("a failed look a door named is still filed as a receipt, and the event carries the very record the sink was given", async () => {
  const h = host();
  const out = await guard(file(), h, fakeEyes({ answers: [{ text: "", input: 500, output: 5 }] }));
  assert.match(out.content[1].text, /Receipt filed at evidence\/n\/1-look\.md\./);
  assert.equal(h.filed.length, 1);
  const [miss] = h.misses;
  assert.equal(miss.receipt, "evidence/n/1-look.md");
  assert.deepEqual(miss.record, h.filed[0], "the same record, filed and told");
  assert.deepEqual([miss.record.status, miss.record.args.path, miss.record.args.ask, miss.record.facts.sha256], ["failed", "drawer.png", "What is shown?", "ab".repeat(32)]);
  assert.ok(miss.record.facts.cost_usd > 0);
  assert.equal(h.looks.length, 0);
});

test("a file that cannot be read is a failed look with a record that costs nothing; a source that billed for an answer with no words is charged its price", async (t) => {
  const dir = await fixtureDir("pi-vision-miss-record-");
  t.after(() => dir.remove());
  await dir.file("blob.bin", Buffer.from([0, 1, 2, 3]));
  const env = nodeVisionEnv({ cwd: dir.path });
  const h = host();
  const out = await readMedia(env, { path: "blob.bin" }, call, h.setup);
  assert.match(out.content[0].text, /^blob\.bin could not be read/);
  const [unreadable] = h.misses;
  assert.deepEqual(unreadable.record, h.filed[0]);
  assert.deepEqual([unreadable.code, unreadable.record.status, unreadable.record.facts.cost_usd, unreadable.record.args.model], ["unsupported", "failed", 0, "none"]);

  const rows = host({ sources: { session: { via: "reviewer", look: async () => ({ text: "  ", model: "reviewer-1", costUsd: 0.02 }) } } });
  const recording = await readMedia(env, { path: "session:abc", ask: "What happened?" }, call, rows.setup);
  assert.match(recording.content[0].text, /returned no text/);
  const [empty] = rows.misses;
  assert.deepEqual([empty.code, empty.record.status, empty.record.facts.cost_usd, empty.record.facts.provider, empty.record.facts.kind], ["look_failed", "failed", 0.02, "reviewer", "recording"]);
  assert.deepEqual(empty.record, rows.filed[0]);

  const threw = host({ sources: { session: { via: "reviewer", look: async () => { throw new Error("reviewer down"); } } } });
  await readMedia(env, { path: "session:abc" }, call, threw.setup);
  assert.deepEqual([threw.misses[0].record.status, "cost_usd" in threw.misses[0].record.facts], ["failed", false], "a source that threw may have billed: unknown");
});

test("vision.see and vision.judge fail a look with its record too, each as filed", async () => {
  const blocks = [png(40, 30)];
  const h = host({ eyes: fakeEyes({ answers: [{ text: "", input: 700, output: 7 }] }) });
  await assert.rejects(see({ ask: "What is it?", images: blocks }, undefined, call, h.setup), (error) => error instanceof SeeMiss && error.code === "look_failed");
  const [seen] = h.misses;
  assert.deepEqual(seen.record, h.filed[0]);
  assert.deepEqual([seen.tool, seen.record.status, seen.record.facts.tokens_in, seen.record.facts.cost_usd > 0, seen.record.facts.key.length], ["vision.see", "failed", 700, true, 64]);

  const jev = host({ images: sharpImages(sharp), jev: { judge: fakeJev({ fail: Object.assign(new Error("400 Bad Request: an image was rejected"), { status: 400 }) }).judge } });
  await assert.rejects(judge({ images: blocks, questions: { q: { type: "noul", instructions: "Is `images[0].image` blank?" } } }, undefined, call, jev.setup), /Jev failed/);
  const [judged] = jev.misses;
  assert.deepEqual(judged.record, jev.filed[0]);
  assert.deepEqual([judged.tool, judged.record.status, judged.record.args.via, "cost_usd" in judged.record.facts, judged.record.facts.key.length], ["vision.judge", "failed", "jev", false, 64]);
});

/** An MP3 as its first bytes say: an ID3 tag, then frame bytes nothing decodes. */
const mp3 = () => Buffer.concat([Buffer.from("ID3\x04\x00\x00\x00\x00\x00\x00", "latin1"), Buffer.alloc(2048, 0x55)]);

test("vision.transcribe fails a look with its record: an answer without word times is charged at the model's price, a request that threw is not priced", async (t) => {
  const dir = await fixtureDir("pi-vision-miss-record-");
  t.after(() => dir.remove());
  await dir.file("landing.mp3", mp3());
  const env = nodeVisionEnv({ cwd: dir.path });
  const untimed = host({ transcriber: { provider: "stt", model: "stt-1", usdPerMinute: 0.006, transcribe: async () => ({ text: "hello there", words: [], durationS: 120 }) } });
  await assert.rejects(transcribe({ path: "landing.mp3" }, env, call, untimed.setup), (error) => error instanceof SeeMiss && error.code === "unsupported");
  const [charged] = untimed.misses;
  assert.deepEqual(charged.record, untimed.filed[0]);
  assert.deepEqual([charged.tool, charged.record.tool, charged.record.status, charged.record.facts.cost_usd, charged.record.facts.provider, charged.record.facts.key.length], ["vision.transcribe", "transcribe", "failed", 0.012, "stt", 64]);
  const threw = host({ transcriber: { provider: "stt", model: "stt-1", usdPerMinute: 0.006, transcribe: async () => { throw new Error("stt down"); } } });
  await assert.rejects(transcribe({ path: "landing.mp3" }, env, call, threw.setup), SeeMiss);
  assert.deepEqual([threw.misses[0].record.status, "cost_usd" in threw.misses[0].record.facts, threw.misses[0].record.facts.key.length], ["failed", false, 64]);
  const none = host();
  await assert.rejects(transcribe({ path: "landing.mp3" }, env, call, none.setup), SeeMiss);
  assert.deepEqual([none.misses[0].record.facts.cost_usd, none.misses[0].code], [0, "no_vision_route"], "before any request it cost nothing");
});

test("a miss with no look behind it carries no record: the host's own setup failed before there was one", async (t) => {
  const dir = await fixtureDir("pi-vision-miss-record-");
  t.after(() => dir.remove());
  await dir.file("scan.png", pngBytes(8, 8));
  const misses = [];
  const out = await readWithoutSetup(nodeVisionEnv({ cwd: dir.path }), { path: "scan.png" }, call, new Error("no scope for c1"), { sources: {}, onMiss: (miss) => misses.push(miss) });
  assert.match(out.content[0].text, /this host could not set the read up: no scope for c1/);
  assert.equal(misses.length, 1);
  assert.deepEqual([misses[0].code, misses[0].receipt, "record" in misses[0]], ["look_failed", null, false]);
});

test("reportMiss tells the record it filed, and none when the miss says the host's setup failed", async () => {
  const told = [];
  const filing = { conversationId: "c1", label: "n", evidence: { file: async () => null }, onMiss: (miss) => told.push(miss) };
  const record = { tool: "look", args: { path: "a.png", model: "m", native: false }, status: "ok", facts: { sha256: "ab".repeat(32), kind: "image", fragment: "", key: "cd".repeat(32), cost_usd: 0.01 }, body: "an answer" };
  await reportMiss(filing, "read", record, { code: "look_failed", reason: "it failed" });
  await reportMiss(filing, "read", record, { code: "look_failed", reason: "it failed", setup: true });
  assert.deepEqual(told[0].record, { ...record, status: "failed", body: "not seen: it failed" }, "filed as failed whatever the caller's record said");
  assert.equal(record.status, "ok", "the caller's record is not changed");
  assert.equal("record" in told[1], false);
});

test("no key and no part of a signed link reaches the record, whichever path failed the look", async (t) => {
  const dir = await fixtureDir("pi-vision-miss-record-");
  t.after(() => dir.remove());
  await dir.file("blob.bin", Buffer.from([0, 1, 2, 3]));
  await dir.file("landing.mp3", mp3());
  const env = nodeVisionEnv({ cwd: dir.path });
  const line = (n) => `request ${n} to ${SENTINEL_SIGNED_LINK} failed with status 401`;
  const everything = [];
  const failing = (n) => ({ fail: `${line(n)}\nsecond line ${SENTINEL_EYES_KEY} ${SENTINEL_SIGNED_LINK}` });

  const g = host();
  await guard(screenshot(), g, fakeEyes({ answers: [failing(1)] }));
  await guard(file(), g, fakeEyes({ answers: [failing(2)] }));
  const s = host({ eyes: fakeEyes({ answers: [failing(3)] }) });
  await assert.rejects(see({ ask: "What?", images: [png(40, 30)] }, undefined, call, s.setup), SeeMiss);
  const j = host({ images: sharpImages(sharp), jev: { judge: fakeJev({ fail: new Error(`${line(4)}\nsecond line ${SENTINEL_EYES_KEY}`) }).judge } });
  await assert.rejects(judge({ images: [png(40, 30)], questions: { q: { type: "noul", instructions: "Is `images[0].image` blank?" } } }, undefined, call, j.setup), /Jev failed/);
  const r = host({ sources: { session: { via: "reviewer", look: async () => { throw new Error(`${line(5)}\nsecond line ${SENTINEL_EYES_KEY}`); } } } });
  await readMedia(env, { path: "session:abc" }, call, r.setup);
  const x = host({ transcriber: { provider: "stt", model: "stt-1", transcribe: async () => { throw new Error(`${line(6)}\nsecond line ${SENTINEL_EYES_KEY}`); } } });
  await assert.rejects(transcribe({ path: "landing.mp3" }, env, call, x.setup), SeeMiss);
  const b = host();
  await readMedia(env, { path: "blob.bin" }, call, b.setup);

  for (const rows of [g, s, j, r, x, b]) for (const miss of rows.misses) everything.push(miss);
  assert.deepEqual(everything.map((miss) => miss.record?.status), Array(7).fill("failed"), "every miss carries its record");
  const scan = new LeakScan();
  for (const [i, miss] of everything.entries()) scan.value(`miss ${i}`, miss);
  for (const rows of [g, s, j, r, x, b]) scan.value("filed", rows.filed);
  assert.equal(scan.report(), "no sentinel found");
  assert.ok(scan.covered("miss").records === everything.length && scan.covered("miss").bytes > 2000, "the events, records included, were scanned");
  const reasons = everything.map((miss) => miss.record.body);
  assert.ok(reasons.slice(0, 6).every((body) => body.includes("https://files.sentinel.invalid/reports/statement.pdf") && !body.includes("?")), "the link is cut to its origin and path");

  const planted = new LeakScan();
  planted.value("miss", { ...everything[0], record: { ...everything[0].record, body: `not seen: ${SENTINEL_EYES_KEY}` } });
  planted.value("miss", { ...everything[0], record: { ...everything[0].record, args: { ...everything[0].record.args, ask: SENTINEL_LINK_TOKEN } } });
  planted.value("miss", { ...everything[0], record: { ...everything[0].record, facts: { ...everything[0].record.facts, derived: [`p-${SENTINEL_LINK_SIGNATURE}.png`] } } });
  assert.deepEqual(planted.findings.map((f) => f.sentinel).sort(), ["eyesKey", "linkSignature", "linkToken"], "a secret in the record would be found where the scan reads it");
});
