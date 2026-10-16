// The run page behind its RunSource, offline. The page is the packed replay bundle's own run-page.js (pack-page.mjs),
// drawn on a small DOM (fake-dom.mjs) over a fake source, live and replay; a replay is written by writeReplay and read
// back by staticSource from a static host under a subpath. No network beyond loopback, no key, no model.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import { packPage, REPLAY_CSP, REPLAY_THEMES } from "./pack-page.mjs";
import { staticSource } from "./page/source.js";
import { readRunEntries, writeReplay } from "./replay.mjs";

/** fetch as Node has it: a test that mounts more than once restores this, not an earlier mount's stand-in. */
const REAL_FETCH = globalThis.fetch;
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
  globalThis.fetch = (url) => (fetched.push(String(url)), Promise.reject(new Error("the run page reads only through its source")));
  t.after(() => (globalThis.fetch = REAL_FETCH));
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

/** The `replay-theme` meta of a packed bundle's index.html, and replay.js run as the browser runs it: against that
 *  document, on a fake page, with every read failing (only the theme it mounts with is looked at). */
async function bootstrapTheme(t, dir) {
  const index = await readFile(join(dir, "index.html"), "utf8");
  const meta = (name) => {
    const found = new RegExp(`<meta name="${name}" content="([^"]*)">`).exec(index);
    return found ? { getAttribute: () => found[1] } : null;
  };
  const dom = fakeDom({ hash: "#/" });
  dom.window.setInterval = () => 0;
  dom.window.clearInterval = () => {};
  globalThis.document = { querySelector: (selector) => meta(/name="([a-z-]+)"/.exec(selector)[1]), getElementById: () => dom.root };
  globalThis.location = { href: "http://page.test/run/" };
  globalThis.fetch = () => Promise.reject(new Error("no network in this test"));
  t.after(() => {
    delete globalThis.document;
    delete globalThis.location;
    globalThis.fetch = REAL_FETCH;
  });
  await import(`${pathToFileURL(join(dir, "replay.js")).href}`);
  await settle();
  return { meta: meta("replay-theme")?.getAttribute(), theme: dom.root.getAttribute("data-theme") };
}

test("pack-page --theme: the packed bootstrap carries the theme, auto by default, and replay.js mounts the page in it", async (t) => {
  assert.deepEqual(REPLAY_THEMES, page.THEMES, "the packer and the page know the same themes");
  const plain = await packPage(join(tmp, "theme-default"));
  assert.match(await readFile(join(plain, "index.html"), "utf8"), /<meta name="replay-data" content="\.\/data\/">\n<meta name="replay-theme" content="auto">/);
  assert.deepEqual(await bootstrapTheme(t, plain), { meta: "auto", theme: "auto" });
  for (const theme of ["dark", "light"]) {
    const dir = await packPage(join(tmp, `theme-${theme}`), { theme });
    assert.deepEqual(await bootstrapTheme(t, dir), { meta: theme, theme }, `a ${theme} bundle mounts ${theme}`);
  }
});

test("pack-page refuses a theme the page does not draw in, before writing anything; the CLI takes --theme", async () => {
  const out = join(tmp, "theme-bad");
  await assert.rejects(packPage(out, { theme: "blue" }), /the run page's theme is one of auto, light, dark, not "blue"/);
  await assert.rejects(packPage(out, { theme: '"><script>' }), /theme is one of/);
  await assert.rejects(readdir(out), { code: "ENOENT" }, "nothing was written");
  const run = (...args) => spawnSync(process.execPath, [new URL("./pack-page.mjs", import.meta.url).pathname, ...args], { encoding: "utf8" });
  const ok = run(join(tmp, "theme-cli"), "--theme", "dark");
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(await readFile(join(tmp, "theme-cli", "index.html"), "utf8"), /<meta name="replay-theme" content="dark">/);
  const bad = run(join(tmp, "theme-cli-bad"), "--theme", "blue");
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /theme is one of auto, light, dark/);
  await assert.rejects(readdir(join(tmp, "theme-cli-bad")), { code: "ENOENT" }, "and wrote nothing");
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

// ---- long first messages, and a replay's input ---------------------------------------------------------------------

const userRow = (id, text) => ({ ...rows[0], id, text, summary: `You: ${text}` });
/** The fixture's rows with the first message replaced. */
const withFirst = (text) => [userRow(rows[0].id, text), ...rows.slice(1)];
/** A replay source over `ready` rows, its run record carrying `extra`. */
const replayOf = (ready, extra = {}) => ({ ...replaySource(), run: async () => summary(extra), timeline: async () => ({ rows: ready, state: "idle", costUsd: 0.05 }) });
// Page nodes link to their parents and their document: compare them with `ok(a === b)`, since a failed `equal` or
// `deepEqual` would format that whole graph.
const userRows = (view) => byTag(view.find("steps"), "div").filter((d) => /^row user\b/.test(d.getAttribute("class") ?? ""));
const foldButtons = (view) => byTag(view.find("steps"), "button");
const part = (node, cls) => byTag(node, "div").find((d) => d.getAttribute("class") === cls);
const INPUT = { company: "Acme Ltd", urls: ["http://registry.example/companies/01234567", "http://news.example/acme-opens-a-second-plant"] };

test("a first message over 600 characters shows its head and a toggle for the whole; the toggle expands and collapses it", async (t) => {
  const long = `${"a".repeat(599)}b${"c".repeat(400)}`;
  const view = await mount(t, replayOf(withFirst(long)), "#/run/r1");
  const [toggle, ...others] = foldButtons(view);
  assert.equal(others.length, 0, "one toggle");
  assert.equal(toggle.tagName, "BUTTON");
  assert.equal(toggle.getAttribute("type"), "button");
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(toggle.textContent, "Show the whole message");
  const [row] = userRows(view);
  assert.equal(part(row, "msg").textContent, `${"a".repeat(599)}b…`, "the first 600 characters, then an ellipsis");
  toggle.click();
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(toggle.textContent, "Show less");
  assert.equal(part(row, "msg").textContent, long, "the whole message");
  toggle.click();
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(toggle.textContent, "Show the whole message");
  assert.equal(part(row, "msg").textContent, `${"a".repeat(599)}b…`);
  assert.doesNotMatch(view.find("steps").textContent, /c{10}/, "none of the rest shows folded");
});

test("a first message over 8 lines folds to its first 8; 8 lines and 600 characters are not folded", async (t) => {
  const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");
  const view = await mount(t, replayOf(withFirst(lines(12))), "#/run/r1");
  const [row] = userRows(view);
  assert.equal(part(row, "msg").textContent, `${lines(8)}…`);
  foldButtons(view)[0].click();
  assert.equal(part(row, "msg").textContent, lines(12));

  for (const [name, text] of [["8 lines", lines(8)], ["600 characters", "x".repeat(600)]]) {
    const whole = await mount(t, replayOf(withFirst(text)), "#/run/r1");
    assert.equal(foldButtons(whole).length, 0, `${name}: no toggle`);
    assert.equal(userRows(whole)[0].textContent, text, `${name}: the message whole, in the row as before`);
    assert.equal(userRows(whole)[0].getAttribute("class"), "row user");
  }
  const edge = await mount(t, replayOf(withFirst("x".repeat(601))), "#/run/r1");
  assert.equal(foldButtons(edge).length, 1, "601 characters folds");
  assert.equal(userRows(edge)[0].textContent.startsWith("x".repeat(600)), true);
});

test("the fold never cuts a surrogate pair", async (t) => {
  const text = `${"a".repeat(599)}\u{1F600}${"b".repeat(100)}`;
  assert.equal(page.messageHead(text), `${"a".repeat(599)}…`, "the emoji's first half is not left behind");
  assert.equal(page.messageHead(`${"a".repeat(598)}\u{1F600}${"b".repeat(100)}`), `${"a".repeat(598)}\u{1F600}…`, "a whole pair at the edge stays");
  assert.equal(page.messageHead("short"), null);
  const view = await mount(t, replayOf(withFirst(text)), "#/run/r1");
  assert.doesNotMatch(part(userRows(view)[0], "msg").textContent, /[\ud800-\udbff](?![\udc00-\udfff])/, "no lone surrogate on the page");
});

test("a fold's rows are the source's rows: the fold changes nothing it was given, and a short first message has no toggle", async (t) => {
  const long = withFirst("y".repeat(1500));
  const before = structuredClone(long);
  const view = await mount(t, replayOf(long), "#/run/r1");
  foldButtons(view)[0].click();
  assert.deepEqual(long, before, "the rows are as the source gave them");
  assert.equal(long[0].text.length, 1500);
  assert.equal(Object.keys(long[0]).sort().join(), Object.keys(rows[0]).sort().join(), "no field on a timeline row");

  const plain = await mount(t, replayOf(rows), "#/run/r1");
  assert.equal(foldButtons(plain).length, 0, "the fixture's short messages have no toggle");
  assert.deepEqual(userRows(plain).map((row) => [row.getAttribute("class"), row.textContent]), [["row user", rows[0].text], ["row user", "done"]]);
});

/** A live source whose timeline yields `first`, then, once `more()` is called, the same rows and one more: a repaint. */
function repainting(first, extra) {
  let more;
  const gate = new Promise((resolve) => (more = resolve));
  const source = {
    ...liveSource(),
    run: async () => summary({ status: "running", live: true, state: "waiting", liveView: { key: "k1" }, ...extra }),
    timeline: (id, { live, signal } = {}) => {
      if (!live) return Promise.resolve({ rows: first, state: "idle", costUsd: 0.05 });
      return (async function* () {
        yield { rows: first, state: "waiting", costUsd: 0.03 };
        await gate;
        yield { rows: [...first, { ...rows[3], id: "later:1", summary: "later row" }], state: "waiting", costUsd: 0.04 };
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      })();
    },
  };
  return { source, more };
}

test("an expanded long message stays expanded when the page repaints, and a collapsed one stays collapsed", async (t) => {
  const long = "z".repeat(900);
  const { source, more } = repainting(withFirst(long), {});
  const view = await mount(t, source, "#/run/r1");
  const before = foldButtons(view)[0];
  before.click();
  more();
  await settle();
  assert.match(view.find("steps").textContent, /later row/, "the page repainted");
  const after = foldButtons(view)[0];
  assert.ok(after !== before, "a new button: the rows were drawn again");
  assert.equal(after.getAttribute("aria-expanded"), "true");
  assert.equal(part(userRows(view)[0], "msg").textContent, long);

  const second = repainting(withFirst(long), {});
  const closed = await mount(t, second.source, "#/run/r1");
  const was = foldButtons(closed)[0];
  second.more();
  await settle();
  assert.ok(foldButtons(closed)[0] !== was, "a new button");
  assert.equal(foldButtons(closed)[0].getAttribute("aria-expanded"), "false");
  assert.equal(part(userRows(closed)[0], "msg").textContent, `${"z".repeat(600)}…`);
});

test("what is opened in one run is closed in the next, though the two runs' rows share ids", async (t) => {
  const long = "w".repeat(900);
  const view = await mount(t, replayOf(withFirst(long)), "#/run/r1");
  foldButtons(view)[0].click();
  const think = byTag(view.find("steps"), "details")[0];
  think.setAttribute("open", "");
  think.dispatchEvent({ type: "toggle" });
  assert.equal(foldButtons(view)[0].getAttribute("aria-expanded"), "true");
  assert.ok(byTag(view.find("steps"), "details")[0].open, "a thinking row opened too");

  view.window.navigate("#/run/r2");
  await settle();
  const [button] = foldButtons(view);
  assert.equal(button.getAttribute("aria-expanded"), "false", "the second run's message is folded");
  assert.equal(part(userRows(view)[0], "msg").textContent, `${"w".repeat(600)}…`);
  assert.equal(byTag(view.find("steps"), "details")[0].open, false, "and its thinking row is closed");
});

test("a repaint hands the keyboard focus on to the fold button drawn for the same message, and gives it to no one who had none", async (t) => {
  const last = rows.findLast((r) => r.kind === "user_message");
  const two = withFirst("a".repeat(900)).map((r) => (r.id === last.id ? { ...r, text: "b".repeat(900) } : r));
  const { source, more } = repainting(two, {});
  const view = await mount(t, source, "#/run/r1");
  const before = foldButtons(view);
  assert.equal(before.length, 2, "two folded messages, two buttons");
  assert.ok(view.document.activeElement === null, "nothing focused yet");
  before[1].focus();
  assert.ok(view.document.activeElement === before[1]);
  more();
  await settle();
  const after = foldButtons(view);
  assert.match(view.find("steps").textContent, /later row/, "the page repainted");
  assert.ok(after[1] !== before[1], "a new button: the rows were drawn again");
  assert.ok(view.document.activeElement === after[1], "the focus is on the second message's new button, not the first");

  const other = repainting(two, {});
  const quiet = await mount(t, other.source, "#/run/r1");
  other.more();
  await settle();
  assert.ok(quiet.document.activeElement === null, "no focus given where there was none");
  const second = repainting(two, {});
  const typing = await mount(t, second.source, "#/run/r1");
  typing.find("text").focus();
  second.more();
  await settle();
  assert.ok(typing.document.activeElement === typing.find("text"), "the message box keeps the focus it had");
});

test("a replay with the job's input shows the first message as Input, and the message the agent got behind a toggle", async (t) => {
  const view = await mount(t, replayOf(rows, { input: INPUT }), "#/run/r1");
  const [first, second] = userRows(view);
  assert.equal(first.getAttribute("class"), "row user input");
  assert.equal(part(first, "tag").textContent, "Input");
  assert.equal(byTag(first, "pre")[0].textContent, JSON.stringify(INPUT, null, 2), "the input, pretty-printed");
  const sent = part(first, "msg");
  const [toggle, ...others] = byTag(first, "button");
  assert.equal(others.length, 0);
  assert.equal(toggle.textContent, "Show the message the agent got");
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.ok(!shown(sent), "folded by default");
  assert.ok(!first.textContent.includes(rows[0].text), "the message is not on the page folded");
  toggle.click();
  assert.ok(shown(sent));
  assert.equal(sent.textContent, rows[0].text, "the message the agent got, whole");
  assert.equal(toggle.textContent, "Hide the message the agent got");
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  toggle.click();
  assert.ok(!shown(sent));
  assert.ok(!first.textContent.includes(rows[0].text));
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(second.getAttribute("class"), "row user", "only the first message is the Input");
  assert.equal(second.textContent, "done");
});

test("with no input, or a null one, the first message is shown as before; an input shows whole when the message is long", async (t) => {
  for (const extra of [{}, { input: null }]) {
    const view = await mount(t, replayOf(rows, extra), "#/run/r1");
    assert.ok(part(userRows(view)[0], "tag") === undefined, `no Input row for ${JSON.stringify(extra)}`);
    assert.equal(userRows(view)[0].getAttribute("class"), "row user");
    assert.equal(userRows(view)[0].textContent, rows[0].text);
  }
  const long = "q".repeat(2000);
  const view = await mount(t, replayOf(withFirst(long), { input: { n: 1 } }), "#/run/r1");
  const [row] = userRows(view);
  assert.equal(foldButtons(view).length, 1, "one toggle: the message's, none of the generic fold");
  foldButtons(view)[0].click();
  assert.equal(part(row, "msg").textContent, long, "the whole message, not its head");
});

test("an expanded message the agent got stays expanded when the page repaints", async (t) => {
  const { source, more } = repainting(rows, { input: INPUT });
  const view = await mount(t, source, "#/run/r1");
  const before = byTag(view.find("steps"), "button")[0];
  before.click();
  more();
  await settle();
  const [first] = userRows(view);
  const after = byTag(first, "button")[0];
  assert.ok(after !== before, "a new button");
  assert.equal(after.getAttribute("aria-expanded"), "true");
  assert.ok(shown(part(first, "msg")));
  assert.equal(part(first, "msg").textContent, rows[0].text);
});

/** The reference recording, copied, with a job blob (`{ workflow, input, files }`) named by its SHA-256 in its manifest. */
async function recordingWithJob(dir, jobBytes, { sha256 } = {}) {
  await cp(RECORDING, join(dir, "rec"), { recursive: true });
  const sha = createHash("sha256").update(jobBytes).digest("hex");
  await writeFile(join(dir, "rec", "blobs", `${sha}.json`), jobBytes);
  const manifestPath = join(dir, "rec", "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.job, undefined, "the reference recording has no job blob as recorded");
  await writeFile(manifestPath, JSON.stringify({ ...manifest, job: { blob: sha, sha256: sha256 ?? sha } }));
  return manifestPath;
}

test("a recording with a job blob: writeReplay writes the job's input on the run record, and the page shows it as Input", async (t) => {
  const dir = join(tmp, "job");
  const store = await referenceStore(dir);
  const job = { workflow: "reference-company-check", input: INPUT, files: [] };
  const manifest = await recordingWithJob(dir, Buffer.from(JSON.stringify(job)));
  const out = join(dir, "data");
  await writeReplay(out, [{ id: "reference-job", store, manifest }]);
  const run = JSON.parse(await readFile(join(out, "runs", "reference-job.json"), "utf8"));
  assert.deepEqual(run.input, INPUT);
  const { runs } = JSON.parse(await readFile(join(out, "runs.json"), "utf8"));
  assert.ok(runs.every((r) => !("input" in r)), "the history's summaries carry no input");
  assert.ok(JSON.parse(await readFile(join(out, "runs", "reference-job", "files.json"), "utf8")).some((f) => f.path === "job.json"), "the job blob stays a file, as before");

  const host = await serveStatic(dir, "/run/");
  t.after(() => host.close());
  const source = staticSource(`${host.url}data/`);
  const [record, timeline] = [await source.run("reference-job"), await source.timeline("reference-job")];
  assert.deepEqual(record.input, INPUT, "staticSource hands the page the input");
  const view = await mount(t, { ...replaySource(), run: async () => record, list: async () => [record], timeline: async () => timeline }, "#/run/reference-job");
  const [first] = userRows(view);
  assert.equal(part(first, "tag").textContent, "Input");
  assert.equal(byTag(first, "pre")[0].textContent, JSON.stringify(INPUT, null, 2));
  assert.ok(!shown(part(first, "msg")));
  assert.equal(byTag(first, "button")[0].textContent, "Show the message the agent got");
  byTag(first, "button")[0].click();
  assert.equal(part(first, "msg").textContent, timeline.rows.find((r) => r.kind === "user_message").text);
});

test("a recording's job blob that is not a JSON object is refused, and a recording without one writes no input", async () => {
  const dir = join(tmp, "job-bad");
  for (const [name, bytes] of [["not JSON", Buffer.from("{nope")], ["an array", Buffer.from("[1]")], ["null", Buffer.from("null")]]) {
    const manifest = await recordingWithJob(join(dir, name.replace(/\W/g, "-")), bytes);
    await assert.rejects(writeReplay(join(dir, "data"), [{ id: "bad", rows: [], manifest }]), /the job blob is not (?:JSON|a JSON object)/, name);
  }
  await assert.rejects(readdir(join(dir, "data")), { code: "ENOENT" }, "nothing was written");
  const none = join(tmp, "job-none");
  await writeReplay(join(none, "data"), [{ id: "reference-job", rows: [], manifest: new URL("manifest.json", RECORDING).pathname }]);
  assert.equal("input" in JSON.parse(await readFile(join(none, "data", "runs", "reference-job.json"), "utf8")), false);
});

test("a job blob's sha256 in the manifest must be the SHA-256 of its bytes: a wrong one, a tampered blob, and a non-hash are refused, before anything is written", async () => {
  const dir = join(tmp, "job-sha");
  const bytes = Buffer.from(JSON.stringify({ workflow: "reference-company-check", input: INPUT, files: [] }));
  const other = createHash("sha256").update("another job").digest("hex");
  const data = join(dir, "data");
  for (const [name, sha256] of [["a different hash", other], ["not a hash", "nope"], ["a number", 7]]) {
    const manifest = await recordingWithJob(join(dir, name.replace(/\W/g, "-")), bytes, { sha256 });
    await assert.rejects(writeReplay(data, [{ id: "bad", rows: [], manifest }]), /the job's sha256 is not the SHA-256 of its blob/, name);
  }
  const tampered = await recordingWithJob(join(dir, "tampered"), bytes);
  const name = createHash("sha256").update(bytes).digest("hex");
  await writeFile(join(dir, "tampered", "rec", "blobs", `${name}.json`), JSON.stringify({ workflow: "x", input: { company: "Elsewhere Ltd" }, files: [] }));
  await assert.rejects(writeReplay(data, [{ id: "bad", rows: [], manifest: tampered }]), /the job blob does not match its SHA-256/);
  await assert.rejects(readdir(data), { code: "ENOENT" }, "nothing was written");

  const good = await recordingWithJob(join(dir, "good"), bytes);
  await writeReplay(data, [{ id: "ok", rows: [], manifest: good }]);
  assert.deepEqual(JSON.parse(await readFile(join(data, "runs", "ok.json"), "utf8")).input, INPUT, "the matching sha256 is accepted");
});
