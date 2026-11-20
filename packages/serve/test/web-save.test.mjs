// web_save: one public file downloaded into the run's work folder through the public-host guard's bytes variant, granted
// by its own name. The network is a table (no socket): names resolve from it and each URL answers from it.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { localWorkspace } from "../dist/workspace/index.js";
import { SAVE_MAX_BYTES, SAVE_TIMEOUT_MS, WEB_SAVE_TOOL, webSave, webSaveTool } from "../dist/web-save.js";
import * as webSaveModule from "../dist/web-save.js";
import { CALL_TOOLS, NODE_TOOLS, TOOLS } from "../dist/tools.js";
import { isAskable, isHostTool, isTableTool, isWebHostTool, replayOf } from "../dist/tool-list.js";
import { webHostTools } from "../dist/runner/adapter-run-spec.js";
import { webFixtureOf } from "../dist/web-fake.js";
import { PNG } from "./fixtures/faux-web-files.mjs";
import { scratch } from "./support.mjs";

const FAUX_WEB_FILES = new URL("./fixtures/faux-web-files.mjs", import.meta.url).pathname;
const MiB = 1024 * 1024;
const PRIVATE = "10.0.0.5"; // key-gate: denylist an address web_save must refuse
const LINK_LOCAL = "169.254.169.254"; // key-gate: denylist the metadata address web_save must refuse
const bytes = (...parts) => Uint8Array.from(parts.flatMap((part) => (typeof part === "string" ? [...Buffer.from(part, "latin1")] : part)));
/** A body of each media kind: its magic bytes, then a tail no text decoding keeps. */
const TAIL = Array.from({ length: 64 }, (_, i) => (i * 37) & 0xff);
const BODY = {
  png: bytes("\x89PNG\r\n\x1a\n", TAIL),
  jpeg: bytes([0xff, 0xd8, 0xff, 0xe0], TAIL),
  gif: bytes("GIF89a", TAIL),
  webp: bytes("RIFF", [0x24, 0, 0, 0], "WEBPVP8 ", TAIL),
  mp3id3: bytes("ID3", [4, 0, 0], TAIL),
  mp3sync: bytes([0xff, 0xfb, 0x90, 0x64], TAIL),
  wav: bytes("RIFF", [0x24, 0, 0, 0], "WAVEfmt ", TAIL),
  ogg: bytes("OggS", [0, 2], TAIL),
  mp4: bytes([0, 0, 0, 0x18], "ftypisom", TAIL),
  m4a: bytes([0, 0, 0, 0x1c], "ftypM4A ", TAIL),
  webm: bytes([0x1a, 0x45, 0xdf, 0xa3], TAIL),
  pdf: bytes("%PDF-1.4\n", TAIL),
  html: bytes("<!doctype html><title>x</title>"),
};

/** A table network: every name public unless `names` says, each URL from `answers`, else 404. */
function network({ names = {}, answers = {} } = {}) {
  const dialled = [];
  return {
    dialled,
    lookup: async (host) => names[host] ?? ["93.184.216.34"],
    fetchImpl: async (url) => {
      dialled.push(url.href);
      const answer = answers[url.href];
      return answer ? answer() : new Response("Not here.", { status: 404, headers: { "content-type": "text/plain" } });
    },
  };
}
const serving = (url, body, type) => network({ answers: { [url]: () => new Response(body, { status: 200, headers: type ? { "content-type": type } : {} }) } });

/** A run's work folder on a tmp dir, its Workspace, and a folder outside it. */
async function folders(t) {
  const root = await scratch(t);
  const work = join(root, "work");
  const outside = join(root, "outside");
  mkdirSync(work, { recursive: true });
  mkdirSync(outside, { recursive: true });
  return { work, outside, ws: localWorkspace(work) };
}

test("a file is saved byte for byte under work/, after a redirect, its answer the path, size, type and final URL", async (t) => {
  const { work, ws } = await folders(t);
  const net = network({ answers: {
    "https://fal.example/r/1": () => new Response(null, { status: 302, headers: { location: "https://v3.cdn.example/files/a.png" } }),
    "https://v3.cdn.example/files/a.png": () => new Response(BODY.png, { status: 200, headers: { "content-type": "image/png" } }),
  } });
  const saved = await webSave({ url: "https://fal.example/r/1", path: "media/a.png" }, ws, net);
  assert.deepEqual(saved, { ok: true, path: "media/a.png", bytes: BODY.png.length, content_type: "image/png", url: "https://v3.cdn.example/files/a.png" });
  assert.deepEqual([...readFileSync(join(work, "media", "a.png"))], [...BODY.png]);
});

test("a path with no folder goes under media/", async (t) => {
  const { work, ws } = await folders(t);
  const saved = await webSave({ url: "https://cdn.example/x", path: "cat.png" }, ws, serving("https://cdn.example/x", BODY.png, "image/png"));
  assert.equal(saved.path, "media/cat.png", JSON.stringify(saved));
  assert.deepEqual([...readFileSync(join(work, "media", "cat.png"))], [...BODY.png]);
  assert.equal(existsSync(join(work, "cat.png")), false);
});

test("a path that already holds a file or a folder is refused, the file untouched and nothing fetched; a bare name checks media/", async (t) => {
  const { work, ws } = await folders(t);
  mkdirSync(join(work, "media", "sub"), { recursive: true });
  writeFileSync(join(work, "media", "taken.png"), "old");
  for (const path of ["media/taken.png", "taken.png", "media/sub"]) {
    const net = serving("https://cdn.example/x", BODY.png, "image/png");
    const saved = await webSave({ url: "https://cdn.example/x", path }, ws, net);
    assert.equal(saved.ok, false, path);
    assert.match(saved.refused ?? "", /already holds/, path);
    assert.deepEqual(net.dialled, [], `${path}: nothing fetched`);
  }
  assert.equal(readFileSync(join(work, "media", "taken.png"), "utf8"), "old");
});

test("a path that leaves the work folder is refused before anything is fetched: .., absolute, a folder linked outside, a link as the file", async (t) => {
  const { work, outside, ws } = await folders(t);
  symlinkSync(outside, join(work, "out"));
  writeFileSync(join(outside, "target.png"), "outside");
  mkdirSync(join(work, "media"));
  symlinkSync(join(outside, "target.png"), join(work, "media", "link.png"));
  for (const path of ["../escape.png", "/tmp/escape.png", "media/../../escape.png", "out/escape.png", "media/link.png"]) {
    const net = serving("https://cdn.example/x", BODY.png, "image/png");
    const saved = await webSave({ url: "https://cdn.example/x", path }, ws, net);
    assert.equal(saved.ok, false, path);
    assert.ok(saved.refused, `${path}: ${JSON.stringify(saved)}`);
    assert.deepEqual(net.dialled, [], `${path}: nothing fetched`);
  }
  assert.deepEqual(readdirSync(outside).sort(), ["target.png"], "nothing was written outside");
  assert.equal(readFileSync(join(outside, "target.png"), "utf8"), "outside");
  assert.equal(existsSync(join(work, "..", "escape.png")), false);
});

test("a private or local host, and a redirect to one, is refused and nothing is written", async (t) => {
  const { work, ws } = await folders(t);
  const cases = [
    ["http://127.0.0.1/a.png", network()],
    ["http://localhost/a.png", network()],
    ["http://inside.example/a.png", network({ names: { "inside.example": [PRIVATE] } })],
    ["https://cdn.example/r", network({ answers: { "https://cdn.example/r": () => new Response(null, { status: 302, headers: { location: `http://${LINK_LOCAL}/latest` } }) } })],
  ];
  for (const [url, net] of cases) {
    const saved = await webSave({ url, path: "media/a.png" }, ws, net);
    assert.equal(saved.ok, false, url);
    assert.match(saved.refused ?? "", /not a public host/, url);
  }
  assert.equal(existsSync(join(work, "media", "a.png")), false);
});

test("a file made at the path while the download ran is kept: the save is refused, not written over it", async (t) => {
  const { work, ws } = await folders(t);
  const net = network({ answers: { "https://cdn.example/race.png": () => {
    mkdirSync(join(work, "media"), { recursive: true });
    writeFileSync(join(work, "media", "race.png"), "theirs");
    return new Response(BODY.png, { status: 200, headers: { "content-type": "image/png" } });
  } } });
  const saved = await webSave({ url: "https://cdn.example/race.png", path: "media/race.png" }, ws, net);
  assert.deepEqual([saved.ok, net.dialled.length], [false, 1]);
  assert.match(saved.refused ?? "", /already holds/);
  assert.equal(readFileSync(join(work, "media", "race.png"), "utf8"), "theirs");
});

test("the cap is 200 MiB; a body past the cap mid-stream, or one whose stream breaks mid-way, leaves nothing at the path", async (t) => {
  assert.equal(SAVE_MAX_BYTES, 200 * MiB);
  assert.ok(SAVE_TIMEOUT_MS >= 60_000, `a large file has more than a page's 30 s: ${SAVE_TIMEOUT_MS}`);
  const { work, ws } = await folders(t);
  // 1,000 bytes of PNG in 100-byte chunks, against a cap of 300.
  const chunks = (fail) => new ReadableStream({
    start(controller) { this.sent = 0; },
    pull(controller) {
      if (this.sent === 0) controller.enqueue(BODY.png.slice(0, 8));
      else if (fail && this.sent >= 300) return controller.error(new Error("connection reset mid-body"));
      else controller.enqueue(new Uint8Array(100));
      this.sent += 100;
      if (this.sent > 1_000) controller.close();
    },
  });
  const over = await webSave({ url: "https://cdn.example/big.png", path: "media/big.png" }, ws, { ...network({ answers: { "https://cdn.example/big.png": () => new Response(chunks(false), { status: 200, headers: { "content-type": "image/png" } }) } }), maxBytes: 300 });
  assert.equal(over.ok, false);
  assert.match(over.refused ?? "", /over 300 bytes/);
  const broken = await webSave({ url: "https://cdn.example/broken.png", path: "media/broken.png" }, ws, network({ answers: { "https://cdn.example/broken.png": () => new Response(chunks(true), { status: 200, headers: { "content-type": "image/png" } }) } }));
  assert.equal(broken.ok, false);
  assert.match(broken.error ?? "", /reset mid-body/);
  for (const name of ["big.png", "broken.png"]) assert.equal(existsSync(join(work, "media", name)), false, name);
  assert.deepEqual(existsSync(join(work, "media")) ? readdirSync(join(work, "media")) : [], [], "no partial or temporary file is left");
});

test("each media type the server plays is saved when its declared type and its bytes agree, answering that type", async (t) => {
  const { work, ws } = await folders(t);
  const cases = [
    ["png", "image/png", "a.png", "image/png"],
    ["jpeg", "image/jpeg", "a.jpg", "image/jpeg"],
    ["gif", "image/gif", "a.gif", "image/gif"],
    ["webp", "image/webp", "a.webp", "image/webp"],
    ["mp3id3", "audio/mpeg", "a.mp3", "audio/mpeg"],
    ["mp3sync", "audio/mpeg", "b.mp3", "audio/mpeg"],
    ["wav", "audio/wav", "a.wav", "audio/wav"],
    ["ogg", "audio/ogg", "a.ogg", "audio/ogg"],
    ["mp4", "video/mp4", "a.mp4", "video/mp4"],
    ["m4a", "audio/mp4", "a.m4a", "audio/mp4"],
    ["webm", "video/webm", "a.webm", "video/webm"],
  ];
  for (const [kind, type, name, answered] of cases) {
    const saved = await webSave({ url: `https://cdn.example/${name}`, path: `media/${name}` }, ws, serving(`https://cdn.example/${name}`, BODY[kind], `${type}; charset=binary`));
    assert.equal(saved.ok, true, `${kind}: ${JSON.stringify(saved)}`);
    assert.equal(saved.content_type, answered, kind);
    assert.deepEqual([...readFileSync(join(work, "media", name))], [...BODY[kind]], kind);
  }
});

test("the type is checked: a declared type the bytes disagree with, a path whose extension disagrees, and a page that is not media are refused", async (t) => {
  const { work, ws } = await folders(t);
  const refusedFor = async (body, type, path, pattern) => {
    const saved = await webSave({ url: "https://cdn.example/f", path }, ws, serving("https://cdn.example/f", body, type));
    assert.equal(saved.ok, false, `${type} -> ${path}: ${JSON.stringify(saved)}`);
    assert.match(saved.refused ?? "", pattern, `${type} -> ${path}`);
    assert.equal(existsSync(join(work, path.includes("/") ? path : `media/${path}`)), false, path);
  };
  await refusedFor(BODY.jpeg, "image/png", "media/a.png", /image\/png/);
  // The declared type alone, with no extension to disagree: the bytes still decide.
  await refusedFor(BODY.jpeg, "image/png", "media/noext", /host says image\/png, but the bytes are image\/jpeg/);
  await refusedFor(BODY.mp4, "audio/mpeg", "media/clip", /host says audio\/mpeg, but the bytes are video\/mp4/);
  await refusedFor(BODY.webp, "audio/wav", "media/a.wav", /audio\/wav/);
  await refusedFor(BODY.html, "image/png", "media/a.png", /image\/png/);
  await refusedFor(BODY.jpeg, "image/jpeg", "media/x.png", /\.png/);
  await refusedFor(BODY.html, "text/html; charset=utf-8", "media/page.png", /text\/html/);
  await refusedFor(BODY.pdf, "application/pdf", "media/doc.bin", /application\/pdf/);
  await refusedFor(BODY.html, "", "media/page", /type/);
});

test("media bytes at a path whose extension names no type are refused with the extension to use, and nothing is written", async (t) => {
  const { work, ws } = await folders(t);
  for (const [path, hint] of [["media/card", "media/card.png"], ["media/card.bin", "media/card.png"]]) {
    const saved = await webSave({ url: "https://cdn.example/f", path }, ws, serving("https://cdn.example/f", BODY.png, "image/png"));
    assert.equal(saved.refused, `refused: ${path} has no extension of image/png; save it as ${hint}`, JSON.stringify(saved));
    assert.equal(existsSync(join(work, path)), false, path);
  }
  const untyped = await webSave({ url: "https://cdn.example/f", path: "media/clip" }, ws, serving("https://cdn.example/f", BODY.m4a, null));
  assert.match(untyped.refused ?? "", /save it as media\/clip\.m4a$/, JSON.stringify(untyped));
  assert.deepEqual(existsSync(join(work, "media")) ? readdirSync(join(work, "media")) : [], []);
  const named = await webSave({ url: "https://cdn.example/f", path: "media/card.png" }, ws, serving("https://cdn.example/f", BODY.png, "image/png"));
  assert.deepEqual([named.ok, named.content_type], [true, "image/png"], JSON.stringify(named));
  assert.deepEqual([...readFileSync(join(work, "media", "card.png"))], [...BODY.png]);
});

test("the type is sniffed: an octet-stream of PNG bytes saves as image/png; a page or a PDF saves only to a path whose extension says that type", async (t) => {
  const { work, ws } = await folders(t);
  const sniffed = await webSave({ url: "https://cdn.example/f", path: "media/s.png" }, ws, serving("https://cdn.example/f", BODY.png, "application/octet-stream"));
  assert.deepEqual([sniffed.ok, sniffed.content_type], [true, "image/png"], JSON.stringify(sniffed));
  const untyped = await webSave({ url: "https://cdn.example/f", path: "media/u.mp4" }, ws, serving("https://cdn.example/f", BODY.mp4, null));
  assert.deepEqual([untyped.ok, untyped.content_type], [true, "video/mp4"], JSON.stringify(untyped));
  const page = await webSave({ url: "https://cdn.example/f", path: "pages/p.html" }, ws, serving("https://cdn.example/f", BODY.html, "text/html; charset=utf-8"));
  assert.deepEqual([page.ok, page.content_type], [true, "text/html"], JSON.stringify(page));
  const pdf = await webSave({ url: "https://cdn.example/f", path: "docs/d.pdf" }, ws, serving("https://cdn.example/f", BODY.pdf, "application/pdf"));
  assert.deepEqual([pdf.ok, pdf.content_type], [true, "application/pdf"], JSON.stringify(pdf));
  assert.deepEqual([...readFileSync(join(work, "docs", "d.pdf"))], [...BODY.pdf]);
});

test("an error status, a bad URL or a missing path is a failed answer, never a throw, and nothing is written", async (t) => {
  const { work, ws } = await folders(t);
  const gone = await webSave({ url: "https://cdn.example/gone.png", path: "media/gone.png" }, ws, network());
  assert.deepEqual([gone.ok, gone.url], [false, "https://cdn.example/gone.png"]);
  assert.match(gone.error ?? "", /404/);
  for (const args of [{ path: "media/a.png" }, { url: "not a url", path: "media/a.png" }, { url: "https://cdn.example/a.png" }, { url: "https://cdn.example/a.png", path: "" }, null]) {
    const saved = await webSave(args, ws, network());
    assert.equal(saved.ok, false, JSON.stringify(args));
    assert.ok(saved.error, JSON.stringify(saved));
  }
  assert.equal(existsSync(join(work, "media")), false);
});

test("web_save is a table tool, a host tool every harness binds by its name, askable and never run again (it writes a file a repeat would find taken); no node or call node names it", () => {
  assert.equal(WEB_SAVE_TOOL, "web_save");
  assert.deepEqual([isTableTool("web_save"), isWebHostTool("web_save"), isHostTool("web_save"), isAskable("web_save"), replayOf("web_save")], [true, true, true, true, "never"]);
  assert.equal(webSaveTool(() => localWorkspace("."), () => ({})).replay, "unsafe", "pi's registration: a cut-off call is answered interrupted, not rerun");
  assert.equal(TOOLS.web_save.nodes, false);
  assert.equal(TOOLS.web_save.effect, undefined);
  assert.equal(NODE_TOOLS.includes("web_save") || CALL_TOOLS.includes("web_save"), false);
});

/** A ToolHost on `work`, with the faux web the server's --faux reads (fixtures/faux-web-files.mjs). */
const hostOn = (work, extra = {}) => ({ where: { root: work, work, ref: { id: "run-1" } }, env: { AGENTRUN_SERVE_FAUX: "1", AGENTRUN_SERVE_FAUX_WEB: FAUX_WEB_FILES }, install() {}, ...extra });

test("only an agent granted web_save by name gets it: web_fetch alone binds no web_save", async (t) => {
  const { work } = await folders(t);
  const names = async (granted) => (await webHostTools(hostOn(work), granted, {})).map((tool) => tool.name);
  assert.deepEqual(await names(["web_fetch"]), ["web_fetch"]);
  assert.deepEqual(await names(["read", "web_fetch", "web_search"]).then((all) => all.includes("web_save")), false);
  assert.deepEqual(await names(["web_save"]), ["web_save"]);
  const [tool] = await webHostTools(hostOn(work), ["web_save"], {});
  assert.equal(tool.replay, "never");
});

test("bound for a run, web_save fetches through the server's faux web and saves into the run's Workspace (host.workspace where given)", async (t) => {
  const { work } = await folders(t);
  const { tools: [tool] } = await TOOLS.web_save.bind(hostOn(work));
  const out = await tool.execute({ url: "https://cdn.example/r/cat", path: "cat.png" }, {}, undefined);
  const answer = JSON.parse(out.output[0].text);
  assert.deepEqual(answer, { ok: true, path: "media/cat.png", bytes: PNG.length, content_type: "image/png", url: "https://cdn.example/files/cat.png" });
  assert.deepEqual([...readFileSync(join(work, "media", "cat.png"))], [...PNG]);
  // The run's own Workspace wins over the local folder at where.work (Mode 2's disk, an attached box).
  const other = await folders(t);
  const { tools: [elsewhere] } = await TOOLS.web_save.bind(hostOn(work, { workspace: other.ws }));
  const second = JSON.parse((await elsewhere.execute({ url: "https://cdn.example/files/cat.png", path: "media/two.png" }, {}, undefined)).output[0].text);
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(existsSync(join(other.work, "media", "two.png")), true);
  assert.equal(existsSync(join(work, "media", "two.png")), false);
});

test("a template eval's web fake answers web_save from the case: its bytes saved, its error and unknown URLs failed, the guard still on", async (t) => {
  const fixture = {
    search: { answers: [], default: { results: [] } },
    fetch: { answers: [], default: { error: "fetch failed" } },
    save: { answers: [
      { url: "https://v3.fal.example/files/out.png", content_type: "image/png", base64: Buffer.from(BODY.png).toString("base64") },
      { url: "https://v3.fal.example/files/note.txt", content_type: "text/plain", text: "hello" },
      { url: "https://v3.fal.example/files/gone.png", error: "connect ETIMEDOUT" },
    ] },
  };
  const problems = [];
  assert.deepEqual(webFixtureOf(fixture, "web.json", (problem) => problems.push(problem)), fixture);
  assert.deepEqual(problems, []);
  const { work } = await folders(t);
  const { tools: [tool] } = await TOOLS.web_save.bind(hostOn(work, { web: fixture }));
  const call = async (url, path) => JSON.parse((await tool.execute({ url, path }, {}, undefined)).output[0].text);
  assert.deepEqual(await call("https://v3.fal.example/files/out.png", "out.png"), { ok: true, path: "media/out.png", bytes: BODY.png.length, content_type: "image/png", url: "https://v3.fal.example/files/out.png" });
  assert.deepEqual([...readFileSync(join(work, "media", "out.png"))], [...BODY.png]);
  assert.deepEqual(await call("https://v3.fal.example/files/note.txt", "notes/note.txt"), { ok: true, path: "notes/note.txt", bytes: 5, content_type: "text/plain", url: "https://v3.fal.example/files/note.txt" });
  const gone = await call("https://v3.fal.example/files/gone.png", "gone.png");
  assert.match(gone.error ?? "", /ETIMEDOUT/);
  const unknown = await call("https://v3.fal.example/files/other.png", "other.png");
  assert.equal(unknown.ok, false, "a URL the case does not answer fails, as a refused connection");
  const local = await call("http://127.0.0.1/x.png", "x.png");
  assert.match(local.refused ?? "", /not a public host/);
  const { tools: [down] } = await TOOLS.web_save.bind(hostOn(work, { web: "unavailable" }));
  assert.equal(JSON.parse((await down.execute({ url: "https://v3.fal.example/files/out.png", path: "again.png" }, {}, undefined)).output[0].text).ok, false);
});

test("a web fixture's save section is checked whole: each answer {url, content_type?, status?, text | base64} or {url, error}", () => {
  const base = { search: { answers: [], default: { results: [] } }, fetch: { answers: [], default: { error: "x" } } };
  const problems = [];
  const bad = { ...base, save: { answers: [{ url: "https://a.example/x.png" }, { url: "not a url", text: "x" }, { url: "https://a.example/y", base64: 7 }], default: { status: 99, text: "" } } };
  assert.equal(webFixtureOf(bad, "web.json", (problem) => problems.push(problem)), undefined);
  assert.equal(problems.filter((problem) => /save\.answers\.\d/.test(problem)).length, 3, problems.join("\n"));
  assert.ok(problems.some((problem) => /save\.default/.test(problem)), problems.join("\n"));
  const fine = [];
  assert.ok(webFixtureOf(base, "web.json", (problem) => fine.push(problem)), "a fixture with no save section is still whole");
  assert.deepEqual(fine, []);
});

/** A network whose downloads wait until the test answers them: `started` the URLs dialled, in order, and `answer(url)` lets
 *  one through with `body` (a PNG by default). A dial whose signal aborts rejects with its reason, as a real fetch does. */
function held() {
  const started = [];
  const waiting = new Map();
  return {
    started,
    lookup: async () => ["93.184.216.34"],
    fetchImpl: (url, init) => new Promise((resolve, reject) => {
      started.push(url.href);
      init.signal?.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      waiting.set(url.href, (response) => {
        try { resolve(response()); } catch (error) { reject(error); }
      });
    }),
    answer: (href, response = () => new Response(BODY.png, { status: 200, headers: { "content-type": "image/png" } })) => waiting.get(href)(response),
  };
}
/** Waits, a millisecond at a time and at most two seconds, until `ok()`; then asserts it. */
const until = async (ok, what) => {
  for (let i = 0; i < 2_000 && !ok(); i++) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.ok(ok(), what);
};
const { SAVE_CONCURRENCY, saveSlots } = webSaveModule;

test("at most 4 downloads at once per server: a fifth waits without dialling until one ends, then all five save", async (t) => {
  assert.equal(SAVE_CONCURRENCY, 4);
  assert.equal(typeof saveSlots, "function", "web-save.js exports saveSlots");
  const { work, ws } = await folders(t);
  const urls = [1, 2, 3, 4, 5].map((n) => `https://cdn.example/v${n}.png`);
  const run = async (slots) => {
    const net = held();
    const saves = urls.map((url, i) => webSave({ url, path: `media/${slots ? "g" : "d"}${i}.png` }, ws, { ...net, ...(slots ? { slots } : {}) }));
    await until(() => net.started.length >= 4, `four dialled: ${net.started}`);
    if (slots) await until(() => slots.waiting === 1, "the fifth waits for a slot");
    else await new Promise((resolve) => setTimeout(resolve, 20));
    // Which four get in first depends on their path checks' timing; the one left out has not dialled.
    assert.equal(net.started.length, 4, `the fifth has not dialled: ${net.started}`);
    const [fifth] = urls.filter((url) => !net.started.includes(url));
    net.answer(net.started[1]);
    await until(() => net.started.length === 5, "the fifth dials once one ends");
    assert.equal(net.started[4], fifth);
    for (const url of net.started.filter((_, i) => i !== 1)) net.answer(url);
    const answers = await Promise.all(saves);
    assert.deepEqual(answers.map((answer) => answer.ok), [true, true, true, true, true], JSON.stringify(answers));
    if (slots) assert.deepEqual([slots.busy, slots.waiting], [0, 0]);
  };
  await run(saveSlots(4));
  await run(undefined);
  assert.equal(readdirSync(join(work, "media")).length, 10);
});

test("a save whose deadline passes while it waits for a slot answers the timeout, never dials, writes nothing, and holds no slot", async (t) => {
  const { work, ws } = await folders(t);
  const slots = saveSlots(1);
  const net = held();
  const first = webSave({ url: "https://cdn.example/a.png", path: "media/a.png" }, ws, { ...net, slots });
  await until(() => net.started.length === 1, "the first holds the slot");
  const late = await webSave({ url: "https://cdn.example/late.png", path: "media/late.png" }, ws, { ...net, slots, timeoutMs: 50 });
  assert.deepEqual(late, { ok: false, url: "https://cdn.example/late.png", path: "media/late.png", error: "the download did not finish in 0.05 s: it waited all that time for a free download slot (at most 1 at once)" });
  assert.deepEqual(net.started, ["https://cdn.example/a.png"], "the late save never dialled");
  assert.deepEqual([slots.busy, slots.waiting], [1, 0], "it left the queue");
  net.answer("https://cdn.example/a.png");
  assert.equal((await first).ok, true);
  assert.equal(existsSync(join(work, "media", "late.png")), false);
  assert.deepEqual([slots.busy, slots.waiting], [0, 0]);
  const next = webSave({ url: "https://cdn.example/b.png", path: "media/b.png" }, ws, { ...net, slots });
  await until(() => net.started.length === 2, "a new save gets the slot at once");
  net.answer("https://cdn.example/b.png");
  assert.equal((await next).ok, true);
});

test("a slot is freed on every failing path: a refused type, an error status, a download error, a path taken at the second check, a failed write", async (t) => {
  const { work, ws } = await folders(t);
  const slots = saveSlots(1);
  const failing = [
    ["refused type", "media/t.png", () => new Response(BODY.html, { status: 200, headers: { "content-type": "image/png" } }), (a) => /bytes are not image\/png/.test(a.refused)],
    ["error status", "media/s.png", () => new Response("no", { status: 500 }), (a) => /answered 500/.test(a.error)],
    ["download error", "media/d.png", () => { throw new Error("connection reset"); }, (a) => /connection reset/.test(a.error)],
    ["taken at the second check", "media/race.png", () => {
      writeFileSync(join(work, "media", "race.png"), "theirs");
      return new Response(BODY.png, { status: 200, headers: { "content-type": "image/png" } });
    }, (a) => /already holds/.test(a.refused)],
  ];
  mkdirSync(join(work, "media"), { recursive: true });
  const unwritable = { ...ws, stat: (path) => ws.stat(path), write: async () => { throw new Error("the disk is full"); } };
  for (const [name, path, response, expected] of failing) {
    const net = held();
    const saving = webSave({ url: "https://cdn.example/f", path }, ws, { ...net, slots });
    await until(() => net.started.length === 1, name);
    net.answer("https://cdn.example/f", response);
    const answer = await saving;
    assert.ok(answer.ok === false && expected(answer), `${name}: ${JSON.stringify(answer)}`);
    assert.deepEqual([slots.busy, slots.waiting], [0, 0], `${name} freed its slot`);
  }
  const net = held();
  const saving = webSave({ url: "https://cdn.example/w", path: "media/w.png" }, unwritable, { ...net, slots });
  await until(() => net.started.length === 1, "write failure");
  net.answer("https://cdn.example/w");
  assert.match((await saving).error ?? "", /disk is full/);
  assert.deepEqual([slots.busy, slots.waiting], [0, 0], "a failed write freed its slot");
  // And a save after all of them dials at once.
  const after = held();
  const ok = webSave({ url: "https://cdn.example/ok", path: "media/ok.png" }, ws, { ...after, slots });
  await until(() => after.started.length === 1, "the slot is free");
  after.answer("https://cdn.example/ok");
  assert.equal((await ok).ok, true);
});

test("bad arguments and a path already taken are answered at once, never waiting for a slot", async (t) => {
  const { work, ws } = await folders(t);
  const slots = saveSlots(1);
  const net = held();
  const busy = webSave({ url: "https://cdn.example/a.png", path: "media/a.png" }, ws, { ...net, slots });
  await until(() => net.started.length === 1, "the slot is held");
  mkdirSync(join(work, "media"), { recursive: true });
  writeFileSync(join(work, "media", "taken.png"), "x");
  assert.match((await webSave({ url: "not a url", path: "media/x.png" }, ws, { ...net, slots, timeoutMs: 2_000 })).error, /absolute URL/);
  assert.match((await webSave({ url: "https://cdn.example/x", path: "media/taken.png" }, ws, { ...net, slots, timeoutMs: 2_000 })).refused ?? "", /already holds/);
  assert.equal(slots.waiting, 0);
  net.answer("https://cdn.example/a.png");
  assert.equal((await busy).ok, true);
});

test("a caller's abort while waiting for a slot leaves the queue without taking one, answered as an abort is", async (t) => {
  const { ws } = await folders(t);
  const slots = saveSlots(1);
  const net = held();
  const first = webSave({ url: "https://cdn.example/a.png", path: "media/a.png" }, ws, { ...net, slots });
  await until(() => net.started.length === 1, "the first holds the slot");
  const caller = new AbortController();
  const waiting = webSave({ url: "https://cdn.example/w.png", path: "media/w.png" }, ws, { ...net, slots, signal: caller.signal });
  await until(() => slots.waiting === 1, "the second waits");
  caller.abort();
  const answer = await waiting;
  assert.deepEqual(answer, { ok: false, url: "https://cdn.example/w.png", path: "media/w.png", error: "This operation was aborted" });
  assert.deepEqual([slots.busy, slots.waiting], [1, 0]);
  net.answer("https://cdn.example/a.png");
  assert.equal((await first).ok, true);
  assert.deepEqual(net.started, ["https://cdn.example/a.png"], "the aborted save never dialled");
  assert.deepEqual([slots.busy, slots.waiting], [0, 0]);
});
