// The run page behind its RunSource, offline. The page is the packed replay bundle's own run-page.js (pack-page.mjs),
// drawn on a small DOM (fake-dom.mjs) over a fake source, live and replay; a replay is written by writeReplay and read
// back by staticSource from a static host under a subpath. No network beyond loopback, no key, no model.
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { startRun } from "@parcha/pi-durable-agent";
import { renderText, timelineOf } from "@parcha/pi-durable-agent/timeline";
import { buildSignedInHome, signedInHomeSkip } from "../../packages/pi-durable-agent/test/fixtures/signed-in-home.mjs";
import { ensureAgentHome } from "./agent/home.mjs";
import { byId, byTag, fakeDom, settle, shown } from "./fake-dom.mjs";
import { serveStatic, transcript } from "./fixtures.mjs";
import { packPage, REPLAY_CSP } from "./pack-page.mjs";
import { staticSource } from "./page/source.js";
import { readRunEntries, writeReplay } from "./replay.mjs";

let tmp;
let bundle;
let page;
before(async () => {
  tmp = await mkdtemp(join(tmpdir(), "run-page-"));
  bundle = await packPage(join(tmp, "bundle"));
  page = await import(pathToFileURL(join(bundle, "run-page.js")).href);
});
after(() => rm(tmp, { recursive: true, force: true }));

const rows = timelineOf(transcript, { settled: true });
const summary = (extra = {}) => ({ id: "r1", title: "Log in to the practice site", agent: "Site reporter", status: "done", state: "idle", live: false, startedAt: "2026-10-15T21:00:00.000Z", endedAt: "2026-10-15T21:05:00.000Z", costUsd: 0.05, liveView: null, ...extra });
const FILES = { "notes.md": "# Notes\n\nSigned in.", "page.html": "<h1>agent page</h1><script>parent.stolen = true</script>" };
const respond = (path) => (Object.hasOwn(FILES, path) ? new Response(FILES[path]) : new Response("", { status: 404 }));

/** A replay source: reads only. */
const replaySource = (calls = []) => ({
  list: async () => (calls.push("list"), [summary()]),
  run: async (id) => (calls.push(`run ${id}`), summary()),
  timeline: async (id) => (calls.push(`timeline ${id}`), { rows, state: "idle", costUsd: 0.05 }),
  files: async () => Object.entries(FILES).map(([path, body]) => ({ path, size: body.length })),
  file: async (id, path) => (calls.push(`file ${path}`), respond(path)),
  search: async () => [],
});

/** A live source: the run is waiting for the person, with a live view, and every way to act is there. */
const liveSource = (calls = []) => ({
  ...replaySource(calls),
  run: async () => summary({ status: "running", live: true, state: "waiting", liveView: { key: "k1" } }),
  timeline: (id, { live, signal } = {}) => {
    calls.push(`timeline ${id} ${live ? "live" : "released"}`);
    if (!live) return Promise.resolve({ rows, state: "idle", costUsd: 0.05 });
    return (async function* () {
      yield { rows: rows.slice(0, 8), state: "waiting", costUsd: 0.03 };
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    })();
  },
  start: async (text) => (calls.push(`start ${text}`), { id: "r2" }),
  submit: async (id, text) => calls.push(`submit ${id} ${text}`),
  stop: async (id) => calls.push(`stop ${id}`),
  live: (id, run) => (run.liveView ? { key: run.liveView.key, src: `runs/${id}/live?v=${run.liveView.key}` } : null),
});

/** Mount the page on a fresh DOM at `hash`, with any `fetch` outside the source failing the test. */
async function mount(t, source, hash) {
  const dom = fakeDom({ hash });
  const fetched = [];
  const real = globalThis.fetch;
  globalThis.fetch = (url) => (fetched.push(String(url)), Promise.reject(new Error("the run page reads only through its source")));
  t.after(() => (globalThis.fetch = real));
  const handle = page.mountRunPage(dom.root, source);
  t.after(() => handle.unmount());
  await settle();
  return { ...dom, handle, fetched, find: (id) => byId(dom.root, id), tabs: () => byTag(dom.root, "button").filter((b) => b.dataset.tab).map((b) => b.dataset.tab) };
}

test("a replay: the runs, the rows and the files, the replay notice, and no way to act and no live browser", async (t) => {
  const calls = [];
  const view = await mount(t, replaySource(calls), "#/run/r1");
  for (const id of ["text", "send", "stop", "new", "banner-btn"]) assert.equal(view.find(id), null, `no #${id} in a replay`);
  assert.ok(!view.tabs().includes("browser"), "no Browser tab in a replay");
  assert.ok(shown(view.find("replay")) && view.find("replay").textContent === page.REPLAY_NOTICE);
  assert.match(view.find("steps").textContent, /Log in to https:\/\/the-internet\.herokuapp\.com\/login/);
  assert.match(view.find("files").textContent, /notes\.md/);
  assert.match(view.find("browser").textContent, /not part of a replay/);
  assert.match(view.find("runs").textContent, /Log in to the practice site/);
  assert.deepEqual([...view.fetched, ...view.window.fetched], [], "the page read nothing but its source");
  assert.ok(calls.includes("timeline r1") && calls.filter((c) => c.startsWith("run ")).length === 1, "a replay is read once");

  view.window.navigate("#/");
  await settle();
  assert.match(view.find("view").textContent, /This is a replay/);
  assert.equal(byTag(view.find("view"), "textarea").length, 0, "no new-run box in a replay");
});

test("a live source: the message box, stop, new run and the Browser tab, each acting through the source", async (t) => {
  const calls = [];
  const view = await mount(t, liveSource(calls), "#/run/r1");
  for (const id of ["text", "send", "stop", "new", "banner-btn"]) assert.ok(view.find(id), `#${id} on a live page`);
  assert.deepEqual(view.tabs().filter((name) => name === "browser").length, 2, "a Browser tab, and its button on a phone");
  assert.ok(shown(view.find("banner")), "the run waits for the person");
  assert.ok(calls.includes("timeline r1 live"), "a live run's timeline is followed");
  const frame = byTag(view.find("browser"), "iframe")[0];
  assert.equal(frame.getAttribute("src"), "runs/r1/live?v=k1", "the live view's frame, from the source");

  view.find("text").value = "done";
  view.find("send").click();
  await settle();
  assert.ok(calls.includes("submit r1 done"));
  view.find("stop").click();
  await settle();
  assert.ok(calls.includes("stop r1"));
  assert.deepEqual([...view.fetched, ...view.window.fetched], []);
});

test("a file view keeps every guard: agent HTML in a frame with nothing allowed, a path out of the workspace never asked for", async (t) => {
  const calls = [];
  const view = await mount(t, replaySource(calls), "#/run/r1/files/page.html");
  const frame = byTag(view.find("files"), "iframe")[0];
  assert.equal(frame.getAttribute("sandbox"), "", "sandboxed, no scripts and no same origin");
  assert.equal(frame.srcdoc, FILES["page.html"], "the page's own HTML, shown as a document of its own");
  assert.equal(frame.hasAttribute("src"), false);
  view.window.navigate("#/run/r1/files/notes.md");
  await settle();
  assert.match(view.find("files").innerHTML + view.find("files").textContent, /Notes/);
  view.handle.unmount();
  assert.equal(view.window.pending(), 0, "unmount leaves no timer");
  assert.equal(view.window.hashListeners(), 0, "and no listener");
});

test("writeReplay writes the static layout staticSource reads under any path: the reference job's rows, its files, and search", async (t) => {
  const recording = (await readFile(new URL("../../apps/viewer/recordings/reference-job/events.jsonl", import.meta.url), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const entries = recording.filter((l) => l.channel === "durable" && l.source === "pi" && Array.isArray(l.data?.model)).map((l) => l.data);
  const reference = timelineOf(entries, { settled: true });
  const out = join(tmp, "site", "data");
  await writeReplay(out, [
    { summary: summary({ id: "reference-job", title: "The reference job", liveView: { key: "secret-key" }, busy: "idle" }), rows: reference, files: { "report.md": "# Report", "out/rows.csv": "a,b\n1,2\n" } },
    { summary: summary({ id: "r1", startedAt: "2026-10-14T21:00:00.000Z" }), rows, files: FILES },
  ]);
  const host = await serveStatic(join(tmp, "site"), "/run/");
  t.after(() => host.close());
  const source = staticSource(`${host.url}data/`);

  const runs = await source.list();
  assert.deepEqual(runs.map((r) => r.id), ["reference-job", "r1"], "newest first");
  assert.ok(runs.every((r) => r.live === false && r.liveView === null && !("busy" in r)), "a replay carries no live view and nothing of the moment");
  const timeline = await source.timeline("reference-job");
  assert.deepEqual(timeline.rows, reference);
  assert.equal(`${renderText(timeline.rows)}\n`, await readFile(new URL("../../packages/pi-durable-agent/test/fixtures/timeline-reference-job.txt", import.meta.url), "utf8"), "the golden rows");
  assert.equal(timeline.state, "idle");
  assert.deepEqual(await source.files("reference-job"), [{ path: "out/rows.csv", size: 8 }, { path: "report.md", size: 8 }]);
  assert.equal(await (await source.file("reference-job", "out/rows.csv")).text(), "a,b\n1,2\n");
  assert.equal((await source.file("reference-job", "../r1.json")).status, 404, "a path out of the workspace is never asked for");
  assert.ok(!host.requests.some((path) => path.includes("..")));
  assert.deepEqual((await source.search("reference")).map((hit) => hit.runId), ["reference-job"]);
  assert.equal((await source.run("r1")).title, "Log in to the practice site");
  await assert.rejects(source.run("../runs"), /no run/);
});

test("writeReplay refuses an id or a path a run page could not ask for, before writing anything", async () => {
  const out = join(tmp, "refused");
  const run = (files, id = "ok") => [{ summary: summary({ id }), rows: [], files }];
  for (const path of ["../x", "a/../b", "/abs", ".git/config", "a/.secret", "a\\b", "", "a//b", "a/"]) {
    await assert.rejects(writeReplay(out, run({ [path]: "x" })), /cannot hold/, JSON.stringify(path));
  }
  for (const id of ["../r", ".hidden", "a/b", ""]) await assert.rejects(writeReplay(out, run({}, id)), /run id/, JSON.stringify(id));
  await assert.rejects(writeReplay(out, run({ a: "x", "a/b": "y" })), /as a file and as a directory/);
  await assert.rejects(readdir(out), { code: "ENOENT" }, "nothing was written");
});

test("the packed replay page: every URL relative, the CSP in a meta tag, no way to act in its bootstrap", async () => {
  const files = (await readdir(bundle, { recursive: true })).filter((f) => /\.(html|js|css)$/.test(f));
  assert.deepEqual(files.filter((f) => !f.startsWith("timeline")).sort(), ["app.css", "index.html", "replay.js", "run-page.js", "source.js"]);
  assert.ok(files.includes(join("timeline", "index.js")));
  for (const file of files) {
    const body = await readFile(join(bundle, file), "utf8");
    const absolute = body.match(/(?:\b(?:src|href|action)=["']|\bfrom\s+["']|\bimport\(\s*["']|\burl\(\s*["']?|\bfetch\(\s*["'`])\/(?!\/)[^"'`)\s]*/g);
    assert.equal(absolute, null, `${file}: ${absolute}`);
  }
  const index = await readFile(join(bundle, "index.html"), "utf8");
  assert.ok(index.includes(`<meta http-equiv="Content-Security-Policy" content="${REPLAY_CSP}">`));
  assert.match(index, /<meta name="replay-data" content="\.\/data\/">/);
  assert.match(await readFile(join(bundle, "replay.js"), "utf8"), /staticSource/);
  assert.doesNotMatch(await readFile(join(bundle, "replay.js"), "utf8"), /httpSource/);
  await assert.rejects(packPage(join(tmp, "x"), { data: "/data/" }), /relative/);
});

const RECORDING = new URL("../../apps/viewer/recordings/reference-job/", import.meta.url);
const GOLDEN = new URL("../../packages/pi-durable-agent/test/fixtures/timeline-reference-job.txt", import.meta.url);

/** A run store holding the reference-job recording's entries. The recording keeps no store blob, so its store is made
 *  here: a real run store (startRun), with the entries its durable lines hold written into its entries table. */
async function referenceStore(dir) {
  const lines = (await readFile(new URL("events.jsonl", RECORDING), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const entries = lines.filter((l) => l.channel === "durable" && l.source === "pi" && Array.isArray(l.data?.model)).map((l) => l.data);
  const { storePath } = await startRun(await ensureAgentHome(join(dir, "home")), { runId: "reference", host: "test" });
  const db = new DatabaseSync(storePath);
  const insert = db.prepare("INSERT INTO entries (id, conversation_id, head, commit_seq, record) VALUES (?, ?, NULL, ?, ?)");
  for (const entry of entries) insert.run(entry.id, entry.conversationId, entry.id, JSON.stringify(entry));
  db.close();
  return storePath;
}

test("a recorded run through writeReplay: its store gives the golden rows, its manifest its result and its title", async () => {
  const dir = join(tmp, "recorded");
  const store = await referenceStore(dir);
  const out = join(dir, "data");
  await writeReplay(out, [{ id: "reference-job", store, manifest: new URL("manifest.json", RECORDING).pathname }]);
  const rows = JSON.parse(await readFile(join(out, "runs", "reference-job", "timeline.json"), "utf8"));
  assert.equal(`${renderText(rows)}\n`, await readFile(GOLDEN, "utf8"), "the golden rows");
  assert.deepEqual(rows, timelineOf(await readRunEntries(store), { settled: true }), "the rows of the one store reader");
  const result = "36e45a1b7f0e6d02c266c85157ab7c69c8db99113a9d0374f48005bddcaf7b2b";
  assert.deepEqual(JSON.parse(await readFile(join(out, "runs", "reference-job", "files.json"), "utf8")).map((f) => f.path), ["result.json"], "the result blob, and no frame, screenshot or evidence");
  assert.deepEqual(await readFile(join(out, "runs", "reference-job", "files", "result.json")), await readFile(new URL(`blobs/${result}.json`, RECORDING)));
  const [listed] = JSON.parse(await readFile(join(out, "runs.json"), "utf8")).runs;
  assert.deepEqual([listed.title, listed.startedAt, listed.costUsd, listed.live], ["The reference job, no key", "2026-10-14T23:01:10.811Z", 0, false]);
});

test("writeReplay refuses a store that is not exported: a signed-in run's store, before writing anything", { skip: signedInHomeSkip }, async () => {
  const dir = join(tmp, "signed-in");
  const { runStore } = await buildSignedInHome(dir);
  const out = join(dir, "data");
  await assert.rejects(writeReplay(out, [{ id: "signed-in", store: runStore }]), /not exported: it holds browser\.profiles/);
  await assert.rejects(readdir(out), { code: "ENOENT" }, "nothing was written");
});

test("a recording's blob that does not match its name is refused; files from a directory skip dotfiles and links", async () => {
  const dir = join(tmp, "tampered");
  await cp(RECORDING, join(dir, "rec"), { recursive: true });
  const result = join(dir, "rec", "blobs", "36e45a1b7f0e6d02c266c85157ab7c69c8db99113a9d0374f48005bddcaf7b2b.json");
  await writeFile(result, "{}");
  await assert.rejects(writeReplay(join(dir, "data"), [{ id: "t", rows: [], manifest: join(dir, "rec", "manifest.json") }]), /does not match its SHA-256/);

  const work = join(dir, "work");
  await mkdir(join(work, "out"), { recursive: true });
  await writeFile(join(work, "report.md"), "# R");
  await writeFile(join(work, "out", "rows.csv"), "a\n");
  await writeFile(join(work, ".secret"), "no");
  await symlink(result, join(work, "linked.json"));
  await writeReplay(join(dir, "data"), [{ id: "w", rows: [], files: work }]);
  assert.deepEqual(JSON.parse(await readFile(join(dir, "data", "runs", "w", "files.json"), "utf8")).map((f) => f.path), ["out/rows.csv", "report.md"]);
});
