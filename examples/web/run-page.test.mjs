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
import { frameLine, jpegSha, serveStatic, signInGap, transcript, writeFrames } from "./fixtures.mjs";
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
async function mount(t, source, hash, options) {
  const dom = fakeDom({ hash });
  const fetched = [];
  const real = globalThis.fetch;
  globalThis.fetch = (url) => (fetched.push(String(url)), Promise.reject(new Error("the run page reads only through its source")));
  t.after(() => (globalThis.fetch = real));
  const handle = page.mountRunPage(dom.root, source, options);
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
  const [frame] = byTag(view.find("float"), "iframe");
  assert.equal(frame.getAttribute("src"), "runs/r1/live?v=k1", "the live view's frame, from the source");
  assert.deepEqual([frame.getAttribute("sandbox"), frame.getAttribute("referrerpolicy")], ["allow-scripts allow-same-origin allow-forms allow-popups", "no-referrer"]);
  assert.match(view.find("browser").textContent, /in its own panel/);

  view.find("text").value = "done";
  view.find("send").click();
  await settle();
  assert.ok(calls.includes("submit r1 done"));
  view.find("stop").click();
  await settle();
  assert.ok(calls.includes("stop r1"));
  assert.deepEqual([...view.fetched, ...view.window.fetched], []);
});

test("a replay whose run has no cost shows no dollar figure anywhere, though its rows carry one", async (t) => {
  assert.ok(rows.some((r) => r.kind === "usage" && r.usage.usd === 0.05 && r.summary.includes("$")), "the rows hold a usage cost");
  const unpriced = summary({ costUsd: null });
  const view = await mount(t, { ...replaySource(), list: async () => [unpriced], run: async () => unpriced }, "#/run/r1");
  assert.equal(view.find("cost").textContent, "r1", "the header names the run, with no figure from the rows");
  assert.doesNotMatch(view.root.textContent, /\$/, "no dollar figure on the page");
});

test("a replay whose run has a cost shows it", async (t) => {
  const view = await mount(t, { ...replaySource(), run: async () => summary({ costUsd: 0.12 }) }, "#/run/r1");
  assert.equal(view.find("cost").textContent, "$0.120");
});

test("a live run with no summary cost still shows its rows' cost so far", async (t) => {
  const view = await mount(t, { ...liveSource(), run: async () => summary({ status: "running", live: true, state: "waiting", liveView: { key: "k1" }, costUsd: null }) }, "#/run/r1");
  assert.equal(view.find("cost").textContent, "$0.030");
});

test("the theme is data-theme on the page root, auto by default; an unknown theme is refused", async (t) => {
  const view = await mount(t, replaySource(), "#/run/r1");
  assert.equal(view.root.getAttribute("data-theme"), "auto");
  assert.throws(() => page.mountRunPage(fakeDom().root, replaySource(), { theme: "blue" }), /theme is one of auto, light, dark/);
});

test("theme dark sets data-theme dark, the file frame is told it, and the replay notice is drawn in it", async (t) => {
  const html = "<!DOCTYPE html><h1>agent page</h1>";
  const source = { ...replaySource(), file: async (id, path) => (path === "page.html" ? new Response(html) : respond(path)) };
  const dark = await mount(t, source, "#/run/r1/files/page.html", { theme: "dark" });
  assert.equal(dark.root.getAttribute("data-theme"), "dark");
  assert.equal(byTag(dark.find("files"), "iframe")[0].srcdoc, '<!DOCTYPE html><meta name="color-scheme" content="dark"><h1>agent page</h1>', "after the doctype, so the document keeps its mode");
  assert.ok(shown(dark.find("replay")), "the replay notice is drawn in the dark theme too");
});

test("no color is written in the page's script, and every color in app.css is a token, the same ones in light and in both dark rules", async () => {
  const script = await readFile(new URL("./page/run-page.js", import.meta.url), "utf8");
  assert.doesNotMatch(script, /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color-mix)\(|\bstyle\b/i, "run-page.js sets no color of its own");
  const css = await readFile(new URL("./page/app.css", import.meta.url), "utf8");
  const blocks = {
    light: /^:where\(\.runs-app\) \{([^}]*)\}/m.exec(css)?.[1],
    system: /^@media \(prefers-color-scheme: dark\) \{ :where\(\.runs-app:not\(\[data-theme="light"\]\)\) \{([^}]*)\} \}/m.exec(css)?.[1],
    dark: /^:where\(\.runs-app\[data-theme="dark"\]\) \{([^}]*)\}/m.exec(css)?.[1],
  };
  for (const [name, block] of Object.entries(blocks)) assert.ok(block, `the ${name} token rule`);
  for (const [name, block] of Object.entries(blocks)) assert.doesNotMatch(block, /var\(/, `the ${name} token rule gives each token a color of its own, never another token`);
  const tokens = (block) => [...block.matchAll(/(--ar-[a-z-]+):/g)].map((m) => m[1]).filter((name) => name !== "--ar-mono").sort();
  assert.deepEqual(tokens(blocks.system), tokens(blocks.light), "the system's dark redefines every color token");
  assert.deepEqual(tokens(blocks.dark), tokens(blocks.light), "and so does data-theme=dark");
  const rules = css.split("\n").filter((line) => !line.startsWith(":where(.runs-app") && !line.startsWith("@media (prefers-color-scheme: dark)"));
  const literal = rules.filter((line) => /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(|:\s*(?:white|black)\b/i.test(line));
  assert.deepEqual(literal, [], "a color outside the token rules");
  const defined = new Set([...blocks.light.matchAll(/(--ar-[a-z-]+):/g)].map((m) => m[1]));
  const used = [...new Set([...css.matchAll(/var\((--[a-z-]+)\)/g)].map((m) => m[1]))];
  assert.deepEqual(used.filter((name) => !defined.has(name)), [], "every token used is defined");
});

test("a file view keeps every guard: agent HTML in a frame with nothing allowed, a path out of the workspace never asked for", async (t) => {
  const calls = [];
  const view = await mount(t, replaySource(calls), "#/run/r1/files/page.html");
  const frame = byTag(view.find("files"), "iframe")[0];
  assert.equal(frame.getAttribute("sandbox"), "", "sandboxed, no scripts and no same origin");
  assert.equal(frame.srcdoc, `<meta name="color-scheme" content="light dark">${FILES["page.html"]}`, "the page's own HTML, shown as a document of its own and told the page's colors");
  assert.equal(frame.hasAttribute("src"), false);
  view.window.navigate("#/run/r1/files/notes.md");
  await settle();
  assert.match(view.find("files").innerHTML + view.find("files").textContent, /Notes/);
  view.handle.unmount();
  assert.equal(view.window.pending(), 0, "unmount leaves no timer");
  assert.equal(view.window.hashListeners(), 0, "and no listener");
});

const BIG = "x".repeat(600 * 1024);
/** A source whose files answer the way the runs server does: a long text file cut short inline, whole with download,
 *  where the whole answer waits for `download` (its promise) to settle. */
function cappingSource(calls, download) {
  return {
    ...replaySource(calls),
    files: async () => [{ path: "big.txt", size: BIG.length }, ...Object.entries(FILES).map(([path, body]) => ({ path, size: body.length }))],
    file: async (id, path, options) => {
      calls.push(`file ${path}${options?.download ? " download" : ""}`);
      if (path !== "big.txt") return respond(path);
      return options?.download ? download : new Response(BIG.slice(0, 512 * 1024), { headers: { "x-truncated": "1" } });
    },
  };
}
const downloadLink = (view, name) => byTag(view.find("files"), "a").find((a) => a.textContent === "Download" && (a.getAttribute("download") ?? name) === name);

test("a long text file draws its cut-short preview at once from one request; Download fetches the whole file only when clicked and saves all of it", async (t) => {
  const calls = [];
  let finish;
  const whole = new Promise((resolve) => { finish = resolve; });
  const view = await mount(t, cappingSource(calls, whole), "#/run/r1/files/big.txt");
  assert.match(view.find("files").textContent, /longer than the preview/, "the preview is drawn");
  assert.deepEqual(calls.filter((c) => c.startsWith("file ")), ["file big.txt"], "one request, the capped one");
  const link = downloadLink(view, "big.txt");
  assert.equal(link.getAttribute("href"), "#", "nothing downloaded yet");
  link.click();
  await settle();
  assert.deepEqual(calls.filter((c) => c.startsWith("file ")), ["file big.txt", "file big.txt download"], "the click asks for the whole file");
  assert.match(view.find("files").textContent, /longer than the preview/, "the preview stays while it downloads");
  finish(new Response(BIG));
  await settle();
  assert.equal(link.getAttribute("download"), "big.txt");
  assert.equal(view.window.blobOf(link.getAttribute("href")).size, BIG.length, "the whole file is saved, not the preview");
});

test("leaving a large file's view keeps nothing of it: three files in turn, and the page holds no listener of any old Download", async (t) => {
  const calls = [];
  const names = ["a.txt", "b.txt", "c.txt"];
  const big = (path) => new Response(BIG.slice(0, 512 * 1024), { headers: { "x-truncated": "1" } });
  const source = {
    ...replaySource(calls),
    files: async () => names.map((path) => ({ path, size: BIG.length })),
    file: async (id, path) => (names.includes(path) ? big(path) : respond(path)),
  };
  const view = await mount(t, source, `#/run/r1/files/${names[0]}`);
  const touched = [];
  for (const [index, name] of names.entries()) {
    if (index > 0) {
      view.window.navigate(`#/run/r1/files/${name}`);
      await settle();
    }
    const link = byTag(view.find("files"), "a").find((a) => a.textContent === "Download");
    assert.ok(link && link.getAttribute("href") === "#", `${name}: a Download that fetches on click`);
    const remove = link.removeEventListener.bind(link);
    link.removeEventListener = (...args) => (touched.push(name), remove(...args));
  }
  view.handle.unmount();
  assert.deepEqual(touched, [], "unmount reached no Download link: the page kept no entry for any file view it left");
});

test("a download that fails says so and leaves the preview", async (t) => {
  const calls = [];
  const view = await mount(t, cappingSource(calls, Promise.resolve(new Response("", { status: 503, statusText: "Service Unavailable" }))), "#/run/r1/files/big.txt");
  const link = downloadLink(view, "big.txt");
  const error = byTag(view.find("files"), "p").find((p) => p.getAttribute("class") === "err");
  assert.ok(error && !shown(error), "no error before the click");
  link.click();
  await settle();
  assert.ok(shown(error), "the error is shown");
  assert.equal(error.textContent, "The download failed: 503 Service Unavailable");
  assert.match(view.find("files").textContent, /longer than the preview/, "the preview stays");
  assert.equal(link.getAttribute("href"), "#");
});

test("a file shown whole downloads from the bytes in hand, with no second request", async (t) => {
  const calls = [];
  const view = await mount(t, cappingSource(calls, new Promise(() => {})), "#/run/r1/files/notes.md");
  const link = downloadLink(view, "notes.md");
  assert.equal(view.window.blobOf(link.getAttribute("href")).size, FILES["notes.md"].length);
  assert.deepEqual(calls.filter((c) => c.startsWith("file ")), ["file notes.md"]);
});

test("a page unmounted while a run's timeline is still loading does no more work for it", async (t) => {
  const calls = [];
  let loaded;
  const gate = new Promise((resolve) => { loaded = resolve; });
  const source = {
    ...liveSource(calls),
    run: async () => summary(),
    timeline: async (id) => (calls.push(`timeline ${id}`), await gate, { rows, state: "idle", costUsd: 0.05 }),
    files: async () => (calls.push("files"), []),
  };
  const view = await mount(t, source, "#/run/r1");
  assert.ok(calls.includes("timeline r1"), "the timeline is loading");
  const before = calls.filter((c) => c === "files").length;
  view.handle.unmount();
  loaded();
  await settle();
  assert.equal(calls.filter((c) => c === "files").length, before, "no files loaded after unmount");
  assert.equal(view.window.pending(), 0, "and no timer set");
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

/** A replay written before, so a later write that fails can be shown to leave it whole. */
async function oldReplay(out) {
  await writeReplay(out, [{ summary: summary({ id: "old" }), rows, files: { "kept.md": "# Kept" } }]);
  return { runs: await readFile(join(out, "runs.json"), "utf8"), file: await readFile(join(out, "runs", "old", "files", "kept.md"), "utf8") };
}
const siblings = async (out) => (await readdir(join(out, ".."))).filter((name) => name !== "data");

test("writeReplay refuses runs whose paths collide before touching the replay that is there", async () => {
  const out = join(tmp, "collide", "data");
  const before = await oldReplay(out);
  await assert.rejects(writeReplay(out, [{ summary: summary({ id: "a" }), rows }, { summary: summary({ id: "a.json" }), rows }]),
    /runs\/a\.json as a file and as a directory/);
  assert.equal(await readFile(join(out, "runs.json"), "utf8"), before.runs, "the old replay's runs.json");
  assert.equal(await readFile(join(out, "runs", "old", "files", "kept.md"), "utf8"), before.file, "and its files");
  assert.deepEqual(await siblings(out), [], "nothing left beside it");
});

test("writeReplay that fails while writing leaves the replay that was there whole", async () => {
  const out = join(tmp, "half", "data");
  const before = await oldReplay(out);
  await assert.rejects(writeReplay(out, [{ summary: summary({ id: "new" }), rows, files: { [`${"x".repeat(300)}.md`]: "too long a name for the file system" } }]), /ENAMETOOLONG|name too long/i);
  assert.equal(await readFile(join(out, "runs.json"), "utf8"), before.runs);
  assert.equal(await readFile(join(out, "runs", "old", "files", "kept.md"), "utf8"), before.file);
  assert.deepEqual(await readdir(join(out, "runs")), ["old", "old.json"], "the new run is not there");
  assert.deepEqual(await siblings(out), [], "nothing left beside it");
});

test("writeReplay refuses a summary for another run's id, so every listed run opens", async () => {
  const out = join(tmp, "renamed", "data");
  await assert.rejects(writeReplay(out, [{ id: "r1", summary: summary({ id: "r2" }), rows }]), /the run r1 has a summary for "r2"/);
  await assert.rejects(readdir(out), { code: "ENOENT" }, "nothing was written");
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

/** The run's rows up to its request for a sign-in. */
const asking = rows.slice(0, rows.findIndex((r) => r.kind === "waiting") + 1);

/** A live run whose state the test moves: `move(state)` sends the page a new view of its timeline. */
function movingSource(calls = [], first = "working") {
  let state = first;
  let push = () => {};
  const source = {
    ...liveSource(calls),
    run: async () => summary({ status: "running", live: true, state, liveView: { key: "k1" } }),
    timeline: (id, { live, signal } = {}) => {
      if (!live) return Promise.resolve({ rows, state: "idle", costUsd: 0.05 });
      return (async function* () {
        for (;;) {
          yield { rows: asking, state, costUsd: 0.03 };
          const next = new Promise((resolve) => ((push = resolve), signal.addEventListener("abort", resolve, { once: true })));
          await next;
          if (signal.aborted) return;
        }
      })();
    },
  };
  return { source, move: (next) => ((state = next), push()) };
}

test("the live browser floats over the page: large while the run waits, small once the person answers; minimize keeps its bar, close leaves a chip; one frame throughout", async (t) => {
  const { source, move } = movingSource();
  const view = await mount(t, source, "#/run/r1");
  const panel = view.find("float");
  const frame = byTag(panel, "iframe")[0];
  assert.ok(shown(panel) && !shown(view.find("show-browser")));
  assert.equal(panel.getAttribute("data-size"), "small", "docked small while the agent works");
  assert.equal(view.root.dataset.tab, "timeline", "the timeline stays in view");

  move("waiting");
  await settle();
  assert.equal(panel.getAttribute("data-size"), "large", "opened large: the person signs in there");
  assert.equal(view.root.dataset.tab, "timeline");
  assert.match(view.find("float-note").textContent, /^Waiting for you: Sign in to the practice site to read its secure area\. Reply "done" below/, "the large panel covers the banner, so it says what the agent asked");
  move("working");
  await settle();
  assert.equal(panel.getAttribute("data-size"), "small", "back to small once the person answered");
  assert.equal(view.find("float-note").textContent, "");

  view.find("float-min").click();
  assert.deepEqual([panel.getAttribute("data-size"), view.find("float-min").textContent], ["min", "Restore"]);
  view.find("float-close").click();
  assert.ok(!shown(panel) && shown(view.find("show-browser")), "closed: a Show browser chip");
  move("waiting");
  await settle();
  assert.ok(shown(panel) && panel.getAttribute("data-size") === "large", "a new wait opens it again, large");
  view.find("float-size").click();
  assert.equal(panel.getAttribute("data-size"), "small");
  view.find("float-close").click();
  view.find("show-browser").click();
  assert.ok(shown(panel) && panel.getAttribute("data-size") === "small");
  for (const tab of ["files", "browser", "timeline"]) byTag(view.root, "button").find((b) => b.dataset.tab === tab).click();
  await settle();
  assert.equal(byTag(panel, "iframe")[0], frame, "one frame for the run: no tab change or resize reloads the live view");
  assert.deepEqual([...view.fetched, ...view.window.fetched], []);
});

test("the saved sign-ins on the history, never a ref; a run's page says what it started signed in to", async (t) => {
  const signIns = [
    { key: "default", provider: "browserbase", state: "ready", sites: ["https://the-internet.herokuapp.com"], verifiedAt: "2026-10-16T05:58:00.000Z", heldBy: null },
    { key: "other", provider: "browserbase", state: "ready", sites: [], verifiedAt: null, heldBy: "r2" },
  ];
  const source = { ...liveSource(), agent: async () => ({ name: "Site reporter", signIns }), run: async () => summary({ signedIn: [{ key: "default", provider: "browserbase", sites: ["https://the-internet.herokuapp.com"] }] }) };
  const view = await mount(t, source, "#/run/r1");
  const lines = byTag(view.find("signins"), "div").filter((d) => d.getAttribute("class") === "saved").map((d) => d.getAttribute("title"));
  assert.match(view.find("signins").textContent, /^Saved sign-ins/);
  assert.match(lines[0], /^the-internet\.herokuapp\.com · Browserbase · saved \d\d:\d\d$/);
  assert.equal(lines[1], "Saved sign-in (Browserbase), sites not recorded · in use by r2", "and the run that holds it");
  assert.match(view.find("signins").textContent, /the-internet\.herokuapp\.comBrowserbase · saved \d\d:\d\dSaved sign-in \(Browserbase\), sites not recordedin use by r2$/, "the site, then what keeps it, on lines of their own");
  assert.ok(shown(view.find("started")));
  assert.equal(view.find("started").textContent, "Started signed in to the-internet.herokuapp.com");
  assert.equal(page.startedLine([{ key: "default", provider: "browserbase", sites: [] }]), "Started signed in (Browserbase sign-in, sites not recorded)");
  assert.equal(page.startedLine([]), "");
  assert.equal(page.signInLine({ ...signIns[0], verifiedAt: null }), "the-internet.herokuapp.com · Browserbase");

  const replay = await mount(t, replaySource(), "#/run/r1");
  assert.equal(replay.find("signins"), null, "a replay shows no saved sign-in");
  assert.ok(!shown(replay.find("started")));
});

const SHA = { a: "a".repeat(64), b: "b".repeat(64), c: "c".repeat(64) };
const FRAMES = [frameLine(1, 1_000, SHA.a), frameLine(2, 1_500, SHA.b), signInGap(3, 2_000, 1_500), frameLine(4, 61_500, SHA.c)];

test("a run that is not live plays back what its browser showed: the frame at each time, play and pause, and the sign-in drawn as a gap and named", async (t) => {
  const calls = [];
  const source = { ...liveSource(calls), run: async () => summary({ frames: true }), frames: async (id) => (calls.push(`frames ${id}`), FRAMES), frameSrc: (id, sha) => `runs/${id}/frames/${sha}.jpg` };
  const view = await mount(t, source, "#/run/r1");
  byTag(view.root, "button").find((b) => b.dataset.tab === "browser").click();
  await settle();
  assert.ok(calls.includes("frames r1"));
  const img = view.find("frame-img");
  const scrub = view.find("scrub");
  assert.equal(img.getAttribute("src"), `runs/r1/frames/${SHA.a}.jpg`, "the first frame");
  assert.deepEqual([scrub.getAttribute("min"), scrub.getAttribute("max")], ["1000", "61500"]);
  assert.equal(view.find("play-time").textContent, "0:00 / 1:01");
  const [marks] = byTag(view.find("browser"), "div").filter((d) => d.getAttribute("class") === "marks");
  assert.equal(marks.innerHTML, `<svg viewBox="0 0 1000 10" preserveAspectRatio="none" aria-hidden="true"><rect x="${((500 / 60_500) * 1000).toFixed(1)}" y="0" width="${((60_000 / 60_500) * 1000).toFixed(1)}" height="10"><title>You signed in here (not recorded)</title></rect></svg>`, "the gap, drawn where it falls on the scrubber");
  assert.match(view.find("browser").textContent, /0:01 to 1:01 You signed in here \(not recorded\)/);

  scrub.value = "30000";
  scrub.dispatchEvent({ type: "input" });
  assert.ok(shown(view.find("gap-note")) && view.find("gap-note").textContent === "You signed in here (not recorded)", "inside the gap: no picture of the sign-in, only the note");
  assert.equal(img.getAttribute("src"), `runs/r1/frames/${SHA.b}.jpg`);
  scrub.value = "61500";
  scrub.dispatchEvent({ type: "input" });
  assert.ok(!shown(view.find("gap-note")));
  assert.equal(img.getAttribute("src"), `runs/r1/frames/${SHA.c}.jpg`);
  view.find("play").click();
  assert.equal(view.find("play").textContent, "Pause", "at the end, play starts again from the first frame");
  assert.equal(img.getAttribute("src"), `runs/r1/frames/${SHA.a}.jpg`);
  view.find("play").click();
  assert.equal(view.find("play").textContent, "Play");

  const track = page.frameTrack([...FRAMES, { kind: "frame.gap", t: 70_000, data: { from: 61_500, reason: "session_released" } }]);
  assert.deepEqual(track.gaps.map((g) => [g.from, g.to, g.label]), [[1_500, 61_500, page.SIGNED_IN_GAP]], "a gap with no frame after it ends the track");

  const live = await mount(t, { ...source, run: async () => summary({ status: "running", live: true, frames: true, liveView: { key: "k1" } }) }, "#/run/r1");
  assert.equal(live.find("frame-img"), null, "a live run shows its live browser, not the player");
});

test("a replay never carries a sign-in or a frame: writeReplay drops what a run started signed in to and refuses a frame or a run's own directory; staticSource never asks for one", async (t) => {
  const out = join(tmp, "no-frames", "data");
  await writeReplay(out, [{ summary: summary({ id: "r1", signedIn: [{ key: "default", provider: "browserbase", sites: ["https://the-internet.herokuapp.com"] }], frames: true }), rows, files: FILES }]);
  const written = await readFile(join(out, "runs.json"), "utf8") + await readFile(join(out, "runs", "r1.json"), "utf8");
  assert.doesNotMatch(written, /signedIn|herokuapp|"frames"/);
  for (const path of ["frames/frames.jsonl", `frames/blobs/${SHA.a}.jpg`, `out/frames/blobs/${SHA.b}.jpg`]) {
    await assert.rejects(writeReplay(join(tmp, "refused-frames"), [{ summary: summary({ id: "r1" }), rows, files: { [path]: "x" } }]), /browser frame/, path);
  }
  const home = await ensureAgentHome(join(tmp, "frames-home"));
  const { dir } = await startRun(home, { runId: "framed", host: "test" });
  writeFrames(dir, [frameLine(1, 1_000, jpegSha(Buffer.from("x")))], [Buffer.from("x")]);
  await assert.rejects(writeReplay(join(tmp, "refused-frames"), [{ summary: summary({ id: "r1" }), rows, files: dir }]), /a run's directory/);
  await assert.rejects(readdir(join(tmp, "refused-frames")), { code: "ENOENT" }, "nothing was written");

  const host = await serveStatic(join(tmp, "no-frames"), "/run/");
  t.after(() => host.close());
  const source = staticSource(`${host.url}data/`);
  assert.equal((await source.file("r1", "frames/frames.jsonl")).status, 404);
  assert.ok(!host.requests.some((path) => path.includes("frames/")), "never asked for");
  assert.equal(typeof source.frames, "undefined");
  assert.ok(!(await readdir(bundle, { recursive: true })).some((f) => /frames|\.jpg$/.test(f)), "the packed page holds no frame");
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

/** The reference job's golden timeline as a replay of a recording that is not real shows it: the last row counts its
 *  model requests and names no dollar figure. */
async function unpricedGolden() {
  const golden = await readFile(GOLDEN, "utf8");
  const shown = golden.replace("Cost so far: $0 over 4 model requests", "4 model requests");
  assert.notEqual(shown, golden, "the golden ends on the usage row");
  return shown;
}

test("a recorded run through writeReplay: its store gives the golden rows, its manifest its result and its title", async () => {
  const dir = join(tmp, "recorded");
  const store = await referenceStore(dir);
  const out = join(dir, "data");
  await writeReplay(out, [{ id: "reference-job", store, manifest: new URL("manifest.json", RECORDING).pathname }]);
  const text = await readFile(join(out, "runs", "reference-job", "timeline.json"), "utf8");
  const rows = JSON.parse(text);
  assert.equal(`${renderText(rows)}\n`, await unpricedGolden(), "the golden rows, the usage row without its dollar figure");
  const stored = timelineOf(await readRunEntries(store), { settled: true });
  assert.deepEqual(rows, stored.map((r) => (r.kind === "usage" ? { ...r, summary: "4 model requests", usage: { ...r.usage, usd: null } } : r)), "the rows of the one store reader");
  assert.doesNotMatch(text, /\$/, "a scripted recording's replay names no dollar figure");
  const result = "36e45a1b7f0e6d02c266c85157ab7c69c8db99113a9d0374f48005bddcaf7b2b";
  assert.deepEqual(JSON.parse(await readFile(join(out, "runs", "reference-job", "files.json"), "utf8")).map((f) => f.path), ["result.json"], "the result blob, and no frame, screenshot or evidence");
  assert.deepEqual(await readFile(join(out, "runs", "reference-job", "files", "result.json")), await readFile(new URL(`blobs/${result}.json`, RECORDING)));
  const [listed] = JSON.parse(await readFile(join(out, "runs.json"), "utf8")).runs;
  assert.deepEqual([listed.title, listed.startedAt, listed.costUsd, listed.live], ["The reference job, no key", "2026-10-14T23:01:10.811Z", null, false], "a scripted recording has no cost");
  assert.equal(JSON.parse(await readFile(join(out, "runs", "reference-job.json"), "utf8")).costUsd, null);
});

test("a recording whose manifest says its providers are real keeps its cost and its usage rows", async () => {
  const dir = join(tmp, "real");
  const store = await referenceStore(dir);
  await cp(RECORDING, join(dir, "rec"), { recursive: true });
  const manifestPath = join(dir, "rec", "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.providers, "scripted", "the reference job is scripted as recorded");
  await writeFile(manifestPath, JSON.stringify({ ...manifest, providers: "real", cost: { ...manifest.cost, usd: 0.07 } }));
  const out = join(dir, "data");
  await writeReplay(out, [{ id: "reference-job", store, manifest: manifestPath }]);
  const [listed] = JSON.parse(await readFile(join(out, "runs.json"), "utf8")).runs;
  assert.equal(listed.costUsd, 0.07);
  const rows = JSON.parse(await readFile(join(out, "runs", "reference-job", "timeline.json"), "utf8"));
  assert.deepEqual(rows, timelineOf(await readRunEntries(store), { settled: true }), "the rows as stored, the usage row's figure kept");
  assert.equal(`${renderText(rows)}\n`, await readFile(GOLDEN, "utf8"));
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
