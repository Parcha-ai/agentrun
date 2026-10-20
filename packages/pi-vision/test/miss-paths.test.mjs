// A miss names a path only the way the caller gave it, never the host's absolute path: not the workspace the run lives
// in, not the temporary directory, not a program's location. A run's recording is published, and a machine path in it is
// a leak. Each reason a miss carries (the model's text, the thrown message, the event's `reason`, the filed record's
// `body`) is checked on the paths that build one: an environment's errors, a provider's, the eyes', a judge's.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { SeeMiss, detectOnce, firstLine, guardResult, judge, linkSafe, readMedia, resolveLimits, see, transcribe } from "@parcha/pi-vision";
import { nodeVisionEnv } from "@parcha/pi-vision/node";
import { popplerProvider } from "@parcha/pi-vision/providers/poppler";
import { sharpImages } from "@parcha/pi-vision/providers/sharp";
import { LeakScan, SENTINELS, fakeEyes, fixtureDir, imageSize, letterPdf, pngBytes } from "@parcha/pi-vision/testing";
import { fakeJev } from "./support/jev.mjs";

const TEXT_ONLY = { id: "lead-model", input: ["text"] };
const call = { conversationId: "c1", callId: "t1", model: TEXT_ONLY, signal: undefined };
const png = { type: "image", data: Buffer.from(pngBytes(40, 30)).toString("base64"), mimeType: "image/png" };

/** A workspace deep under an absolute path, and the host's hooks. */
async function rig(t) {
  const dir = await fixtureDir("pi-vision-miss-paths-");
  t.after(() => dir.remove());
  const work = join(dir.path, "live", "run", "work");
  await mkdir(work, { recursive: true });
  const filed = [], misses = [];
  const setup = {
    limits: resolveLimits(TEXT_ONLY), eyes: undefined, providers: [], sources: {}, scope: { label: "n", deriveDir: join(work, "evidence", "n") },
    evidence: { file: async (label, record) => { filed.push(record); return { path: `evidence/${label}/${filed.length}.md` }; } },
    onMiss: (miss) => misses.push(miss),
  };
  return { dir, work, filed, misses, setup, env: nodeVisionEnv({ cwd: work }) };
}
/** Every string a miss gave the model, the script and the host, as one scan target. */
const surfaces = (r, ...more) => [...more, ...r.misses, ...r.filed];
/** The workspace's absolute path and its parent are in none of `values`. */
function neverHolds(r, values, what) {
  const scan = new LeakScan({ workspace: r.work, parent: r.dir.path });
  scan.value(what, values);
  assert.equal(scan.report(), "no sentinel found", what);
  assert.ok(scan.covered(what).bytes > 200, `${what}: something was scanned`);
}

test("a source that is not there: the miss names it as asked, and nothing of the workspace around it", async (t) => {
  const r = await rig(t);
  await assert.rejects(see({ ask: "What is it?", paths: ["shots/gone.png"] }, r.env, call, { ...r.setup, eyes: fakeEyes() }), (error) => {
    assert.ok(error instanceof SeeMiss && error.code === "unreadable");
    assert.match(error.message, /shots\/gone\.png is not a file that opens \(ENOENT: no such file or directory, lstat '(?!\/)/, "the path the caller gave, not the host's");
    neverHolds(r, [error.message, ...surfaces(r)], "see");
    return true;
  });
  await assert.rejects(judge({ paths: ["shots/gone.png"], questions: { q: { type: "noul", instructions: "Is `images[0].image` blank?" } } }, r.env, call, { ...r.setup, jev: { judge: fakeJev().judge } }), (error) => {
    neverHolds(r, [error.message, ...surfaces(r)], "judge");
    return true;
  });
  await assert.rejects(transcribe({ path: "shots/gone.mp3" }, r.env, call, { ...r.setup, transcriber: { provider: "stt", model: "stt-1", transcribe: async () => ({ text: "", words: [] }) } }), (error) => {
    neverHolds(r, [error.message, ...surfaces(r)], "transcribe");
    return true;
  });
  assert.equal(r.misses.length, 3);
  assert.ok(r.misses.every((miss, i) => miss.code === "unreadable" && !miss.reason.includes(r.work) && r.filed[i].body === `not seen: ${miss.reason}` && miss.record === r.filed[i]), "the event and the record say the same words");
});

/** The environment of a host whose own errors carry absolute paths, as pi's do: no program starts, and the error says
 *  where it looked for it and in which directory it ran. */
function noPrograms(r) {
  return {
    ...r.env,
    get id() { return r.env.id; },
    get cwd() { return r.env.cwd; },
    exec: async () => ({ ok: false, error: Object.assign(new Error(`spawn /usr/local/bin/pdftotext ENOENT (cwd ${r.work})`), { code: "spawn_error" }) }),
  };
}

test("a reader whose programs fail to start with the host's paths: the miss text, the event and the record carry none", async (t) => {
  const r = await rig(t);
  await writeFile(join(r.work, "letter.pdf"), letterPdf());
  const result = await readMedia(noPrograms(r), { path: "letter.pdf" }, call, { ...r.setup, providers: [popplerProvider()] });
  const text = result.content.map((b) => b.text).join("\n");
  assert.equal(result.details.miss.code, "needs");
  assert.match(text, /^letter\.pdf could not be read: .*\(spawn pdftotext ENOENT \(cwd work\)\)\. The file is saved at letter\.pdf\./, "the program and the directory by their last parts");
  assert.equal(r.misses.length, 1);
  neverHolds(r, [text, ...surfaces(r)], "readMedia");
  const scan = new LeakScan({ program: "/usr/local/bin" });
  scan.value("readMedia", [text, ...surfaces(r)]);
  assert.equal(scan.report(), "no sentinel found", "nor where a program lives");
});

test("an eyes route, a judge's port and a provider's detection that fail with a path: the model's text, the event and the record carry none", async (t) => {
  const r = await rig(t);
  const hidden = join(r.work, ".find");
  const failure = (verb) => Object.assign(new Error(`ENOENT: no such file or directory, ${verb} '${hidden}'`), { code: "ENOENT", path: hidden });
  const out = await guardResult({ content: [{ type: "text", text: "a screenshot" }, png], details: { path: "shot.png" } }, call, { ...r.setup, eyes: fakeEyes({ answers: [{ fail: failure("open").message }] }) }, imageSize);
  const text = out.content.map((b) => b.text ?? "").join("\n");
  assert.match(text, /failed: ENOENT: no such file or directory, open '\.find'/, "the file by its name");
  await assert.rejects(judge({ images: [png], questions: { q: { type: "noul", instructions: "Is `images[0].image` blank?" } } }, undefined, call, { ...r.setup, images: sharpImages(sharp), jev: { judge: fakeJev({ fail: failure("open") }).judge } }), (error) => /Jev failed: ENOENT: no such file or directory, open '\.find'/.test(error.message));
  const detection = await detectOnce({ name: "p", capabilities: [], kinds: [], detect: async () => { throw failure("access"); } }, { id: "paths", cwd: r.work });
  assert.deepEqual(detection, { available: false, needs: "p", reason: "detect failed: ENOENT: no such file or directory, access '.find'" });
  neverHolds(r, [text, detection, ...surfaces(r)], "route");
});

test("a workspace whose directories have apostrophes in their names is hidden whole: by the error's own path when it names one, by the shape of the line when an apostrophe is followed by a word", async (t) => {
  const dir = await fixtureDir("pi-vision-miss-paths-");
  t.after(() => dir.remove());
  const work = join(dir.path, "owner's-private", "o' x", "work");
  await mkdir(work, { recursive: true });
  const misses = [];
  const setup = { limits: resolveLimits(TEXT_ONLY), eyes: fakeEyes(), providers: [], sources: {}, scope: { label: "n", deriveDir: "evidence/n" }, evidence: { file: async () => null }, onMiss: (miss) => misses.push(miss) };
  await assert.rejects(see({ ask: "What is it?", paths: ["gone.png"] }, nodeVisionEnv({ cwd: work }), call, setup), (error) => {
    assert.match(error.message, /^unreadable: gone\.png is not a file that opens \(ENOENT: no such file or directory, lstat 'gone\.png'\)$/);
    return true;
  });
  const scan = new LeakScan({ owner: "owner's-private", space: "o' x", dir: dir.path });
  scan.value("see", misses);
  assert.equal(scan.report(), "no sentinel found");
  const quoted = join(dir.path, "owner's-private", "work", "gone.png");
  assert.equal(firstLine(new Error(`ENOENT: no such file or directory, open '${quoted}'`)), "ENOENT: no such file or directory, open 'gone.png'", "an apostrophe a word goes on from is part of the name");
});

test("firstLine names a path by its last part and leaves every other slash alone", () => {
  const cases = [
    ["ENOENT: no such file or directory, open '/srv/run/work/.find'", "ENOENT: no such file or directory, open '.find'"],
    ["ENOENT: no such file or directory, rename '/srv/run/a.tmp' -> '/srv/run/b.txt'", "ENOENT: no such file or directory, rename 'a.tmp' -> 'b.txt'"],
    ["spawn /usr/local/bin/ffmpeg ENOENT", "spawn ffmpeg ENOENT"],
    ["could not open \"/srv/my files/scan one.png\" for reading", "could not open \"scan one.png\" for reading"],
    ["failed (/srv/run/work/a.pdf), then retried", "failed (a.pdf), then retried"],
    ["ENOENT: no such file or directory, lstat '/srv/owner's-private/work/gone.png'", "ENOENT: no such file or directory, lstat 'gone.png'"],
    ["rename '/srv/it's/a.tmp' -> '/srv/it's/b.txt'", "rename 'a.tmp' -> 'b.txt'"],
    ["cannot read /srv/run/work/a.pdf.", "cannot read a.pdf."],
    ["cwd=/srv/run/work failed", "cwd=work failed"],
    ["open 'C:\\Users\\run\\work\\a.png' failed", "open 'a.png' failed"],
    ["open file:///srv/run/work/a%20b.png failed", "open a%20b.png failed"],
    ["see https://host.invalid/a/b?token=1 and shots/a.png, page 3/4, offset/limit, and/or from_s..to_s", "see https://host.invalid/a/b and shots/a.png, page 3/4, offset/limit, and/or from_s..to_s"],
    ["a relative path ./shots/a.png and ../b.png and ~/c.png are kept", "a relative path ./shots/a.png and ../b.png and ~/c.png are kept"],
  ];
  for (const [said, kept] of cases) assert.equal(firstLine(new Error(said)), kept, said);
  assert.equal(firstLine("/srv/run/work/.find"), ".find", "a thrown string too");
  assert.equal(firstLine(new Error("first /srv/run/a.png\nsecond /srv/run/b.png")), "first a.png", "the first line only");
  assert.equal(linkSafe("open '/srv/run/work/.find'"), "open '/srv/run/work/.find'", "linkSafe still cuts links and nothing else");
});

test("the absolute-path sentinel is found wherever a run writes, and not in the clean form", () => {
  const work = "/srv/pv-sentinel-workspace-4f1d9c27/live/run/work";
  const clean = new LeakScan({ ...SENTINELS, workspace: work });
  clean.value("miss", { reason: "ENOENT: no such file or directory, open '.find'", record: { body: "not seen: ENOENT, open '.find'" } });
  assert.equal(clean.report(), "no sentinel found");
  for (const [where, value] of [
    ["a reason", { reason: `ENOENT: no such file or directory, open '${work}/.find'` }],
    ["a record", { record: { args: { path: `${work}/a.png` } } }],
    ["a thrown error", Object.assign(new Error("failed"), { cause: new Error(`open '${work}'`) })],
    ["a file name", [`${work}.txt`]],
  ]) {
    const scan = new LeakScan({ workspace: work });
    scan.value(where, value);
    assert.deepEqual([...new Set(scan.findings.map((f) => f.sentinel))], ["workspace"], where);
  }
});
