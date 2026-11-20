// web_save: one public file downloaded into the run's work folder through the public-host guard's bytes variant, granted
// by its own name. The network is a table (no socket): names resolve from it and each URL answers from it.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { connect, createServer } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { localWorkspace } from "../dist/workspace/index.js";
import { SAVE_MAX_BYTES, SAVE_TIMEOUT_MS, WEB_SAVE_TOOL, webSave, webSaveTool } from "../dist/web-save.js";
import * as webSaveModule from "../dist/web-save.js";
import { CALL_TOOLS, NODE_TOOLS, TOOLS } from "../dist/tools.js";
import { isAskable, isHostTool, isTableTool, isWebHostTool, replayOf } from "../dist/tool-list.js";
import { buildToolHost, webHostTools } from "../dist/runner/adapter-run-spec.js";
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
const { SAVE_CONCURRENCY, SERVER_SLOTS, saveSlots } = webSaveModule;

test("at most 4 downloads at once per runner: a fifth waits without dialling until one ends, then all five save", async (t) => {
  assert.equal(SAVE_CONCURRENCY, 4);
  assert.equal(typeof saveSlots, "function", "web-save.js exports saveSlots");
  const { work, ws } = await folders(t);
  const urls = [1, 2, 3, 4, 5].map((n) => `https://cdn.example/v${n}.png`);
  const run = async (slots) => {
    const net = held();
    const saves = urls.map((url, i) => webSave({ url, path: `media/${slots ? "g" : "d"}${i}.png` }, ws, { ...net, ...(slots ? { slots } : {}) }));
    await until(() => net.started.length >= 4, `four dialled: ${net.started}`);
    await until(() => (slots ?? SERVER_SLOTS).waiting === 1, "the fifth waits for a slot");
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

// ---------------------------------------------------------------------------------------------------------------------
// The runner's one gate, shared by its runs' own processes over their channels (runner/save-slots.ts). Each "run" here is
// a channel pair over a real Unix socket: the runner's side is the runner's own (run-child-host.ts runChannel, on a gate of
// the test's), the run's side takes its slots as run-child.ts does (remoteSaveSlots).

const sharedSlots = await import("../dist/runner/save-slots.js").catch(() => ({}));
const { runChannel } = await import("../dist/runner/run-child-host.js");
const { Channel } = await import("../dist/runner/run-channel.js");

let socketCount = 0;
/** A runner's channel to one run's process and the run's side of it, over a Unix socket pair in a scratch folder; both
 *  ended when the test ends. */
async function runProcess(t, gate) {
  assert.equal(typeof runChannel, "function", "run-child-host.js exports runChannel");
  assert.equal(typeof sharedSlots.remoteSaveSlots, "function", "runner/save-slots.js exports remoteSaveSlots");
  const dir = await scratch(t);
  const path = join(dir, `run-${socketCount++}.sock`);
  const server = createServer();
  await new Promise((resolve) => server.listen(path, resolve));
  const accepted = once(server, "connection");
  const childSocket = connect(path);
  const [[runnerSocket]] = await Promise.all([accepted, once(childSocket, "connect")]);
  server.close();
  const runner = runChannel(runnerSocket, () => {}, gate);
  const child = new Channel(childSocket);
  const end = () => { child.close(); runner.close(); };
  t.after(end);
  return { runner, child, childSocket, slots: sharedSlots.remoteSaveSlots(child), end };
}

test("two run processes share their runner's one gate of 4: three saves in each, four dial, two wait; one ends, one more dials", async (t) => {
  const gate = saveSlots(SAVE_CONCURRENCY);
  const [a, b] = [await runProcess(t, gate), await runProcess(t, gate)];
  const [wa, wb] = [await folders(t), await folders(t)];
  const net = held();
  const saves = [
    ...[0, 1, 2].map((i) => webSave({ url: `https://cdn.example/a${i}.png`, path: `media/a${i}.png` }, wa.ws, { ...net, slots: a.slots })),
    ...[0, 1, 2].map((i) => webSave({ url: `https://cdn.example/b${i}.png`, path: `media/b${i}.png` }, wb.ws, { ...net, slots: b.slots })),
  ];
  await until(() => net.started.length >= 4 && gate.waiting === 2, `four dialled, two wait: ${net.started}, ${gate.waiting}`);
  assert.equal(net.started.length, 4, `exactly four dialled: ${net.started}`);
  assert.deepEqual([gate.busy, gate.waiting], [4, 2]);
  net.answer(net.started[0]);
  await until(() => net.started.length === 5, "one more dials once one ends");
  assert.deepEqual([gate.busy, gate.waiting], [4, 1]);
  for (const url of net.started.slice(1)) net.answer(url);
  await until(() => net.started.length === 6, "the last dials");
  net.answer(net.started[5]);
  const answers = await Promise.all(saves);
  assert.deepEqual(answers.map((answer) => answer.ok), [true, true, true, true, true, true], JSON.stringify(answers));
  await until(() => gate.busy === 0, "every slot back");
  assert.deepEqual([gate.busy, gate.waiting], [0, 0]);
  a.end();
  b.end();
});

test("a run process that holds slots and dies frees them, and its waiters, at its runner: a waiter of another run then dials", async (t) => {
  const gate = saveSlots(SAVE_CONCURRENCY);
  const [a, b] = [await runProcess(t, gate), await runProcess(t, gate)];
  const [wa, wb] = [await folders(t), await folders(t)];
  const net = held();
  const doomed = [0, 1, 2, 3, 4, 5].map((i) => webSave({ url: `https://cdn.example/a${i}.png`, path: `media/a${i}.png` }, wa.ws, { ...net, slots: a.slots }));
  await until(() => net.started.length === 4 && gate.waiting === 2, "the first run holds all four and waits for two more");
  const other = webSave({ url: "https://cdn.example/b.png", path: "media/b.png" }, wb.ws, { ...net, slots: b.slots });
  await until(() => gate.waiting === 3, "the other run waits behind it");
  // Its process is gone: its end of the socket closes under the runner.
  a.childSocket.destroy();
  await until(() => net.started.includes("https://cdn.example/b.png"), "the other run's save dials once the dead run's slots are back");
  assert.deepEqual([gate.busy, gate.waiting], [1, 0], "the dead run holds and waits for nothing");
  net.answer("https://cdn.example/b.png");
  assert.equal((await other).ok, true);
  for (const url of net.started.filter((url) => url.includes("/a"))) net.answer(url);
  await Promise.all(doomed);
  assert.deepEqual([gate.busy, gate.waiting], [0, 0]);
  b.end();
});

test("a run process's abort or deadline while it waits crosses to its runner: the waiter leaves the gate's queue, takes no slot, and says why", async (t) => {
  const gate = saveSlots(SAVE_CONCURRENCY);
  const [a, b] = [await runProcess(t, gate), await runProcess(t, gate)];
  const [wa, wb] = [await folders(t), await folders(t)];
  const net = held();
  const holding = [0, 1, 2, 3].map((i) => webSave({ url: `https://cdn.example/a${i}.png`, path: `media/a${i}.png` }, wa.ws, { ...net, slots: a.slots }));
  await until(() => gate.busy === 4 && net.started.length === 4, "the first run holds all four");
  const caller = new AbortController();
  const aborted = webSave({ url: "https://cdn.example/w.png", path: "media/w.png" }, wb.ws, { ...net, slots: b.slots, signal: caller.signal });
  await until(() => gate.waiting === 1, "the other run's save waits at the runner");
  caller.abort();
  assert.deepEqual(await aborted, { ok: false, url: "https://cdn.example/w.png", path: "media/w.png", error: "This operation was aborted" });
  assert.deepEqual([gate.busy, gate.waiting], [4, 0], "it left the queue");
  const late = await webSave({ url: "https://cdn.example/late.png", path: "media/late.png" }, wb.ws, { ...net, slots: b.slots, timeoutMs: 50 });
  assert.deepEqual(late, { ok: false, url: "https://cdn.example/late.png", path: "media/late.png", error: "the download did not finish in 0.05 s: it waited all that time for a free download slot (at most 4 at once)" });
  assert.deepEqual([gate.busy, gate.waiting], [4, 0], "the late one left the queue too");
  assert.equal(net.started.length, 4, "neither dialled");
  for (const url of net.started) net.answer(url);
  assert.deepEqual((await Promise.all(holding)).map((answer) => answer.ok), [true, true, true, true]);
  await until(() => gate.busy === 0, "every slot back");
  a.end();
  b.end();
});

test("a run process's release frees its own take's slot once: a second call frees nothing, and the target answers nothing but take", async (t) => {
  const gate = saveSlots(SAVE_CONCURRENCY);
  const run = await runProcess(t, gate);
  const signal = new AbortController().signal;
  const first = await run.child.call("saves", "take", [signal]);
  await run.child.call("saves", "take", [signal]);
  assert.equal(gate.busy, 2);
  await first();
  await first();
  assert.equal(gate.busy, 1, "the second call of one release freed no other slot");
  await assert.rejects(run.child.call("saves", "free", []), /no free/);
  await assert.rejects(run.child.call("saves", "take", ["not a signal"]), /under the call's signal/);
  run.end();
  await until(() => gate.busy === 0, "the run's end gave its last slot back");
});

test("in a run's own process web_save takes its slots where its ToolHost says (its runner's gate), else this process's", async (t) => {
  const { work } = await folders(t);
  const took = [];
  const spy = { size: 4, busy: 0, waiting: 0, take: async (signal) => { took.push(signal instanceof AbortSignal); return () => took.push("released"); } };
  const { tools: [tool] } = await TOOLS.web_save.bind(hostOn(work, { saveSlots: spy }));
  const answer = JSON.parse((await tool.execute({ url: "https://cdn.example/r/cat", path: "cat.png" }, {}, undefined)).output[0].text);
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.deepEqual(took, [true, "released"], "the host's slots were taken and released");
  assert.equal(SERVER_SLOTS?.size, SAVE_CONCURRENCY, "web-save.js exports the process's gate");
  const host = buildToolHost({ root: work, workspace: localWorkspace(work), claim: { runId: "run-1" }, env: {}, run: {}, store: {}, sealKey: undefined, life: { register: {} }, redact: (text) => text, saveSlots: spy });
  assert.equal(host.saveSlots, spy, "the spec's ToolHost carries the deps' slots");
});

test("a run process's release after its channel ended leaves no unhandled rejection behind (its runner freed the slot at the end)", async (t) => {
  const gate = saveSlots(SAVE_CONCURRENCY);
  const run = await runProcess(t, gate);
  const unhandled = [];
  const listen = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", listen);
  t.after(() => process.off("unhandledRejection", listen));
  const release = await run.slots.take(new AbortController().signal);
  assert.equal(gate.busy, 1);
  run.end();
  await until(() => gate.busy === 0, "the channel's end freed the slot");
  release();
  // And whatever the release's call answers (here a rejection of its own, not the channel's stand-in's), never unhandled.
  const stub = sharedSlots.remoteSaveSlots({ call: async () => () => Promise.reject(new Error("the channel ended")) });
  (await stub.take(new AbortController().signal))();
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(unhandled.map(String), []);
});

test("one run process may have at most SAVE_SLOTS_PER_RUN takes held or waiting at its runner: the next is refused at once, never queued", { timeout: 10_000 }, async (t) => {
  const { SAVE_SLOTS_PER_RUN } = sharedSlots;
  assert.equal(SAVE_SLOTS_PER_RUN, 16, "save-slots.js exports SAVE_SLOTS_PER_RUN");
  const gate = saveSlots(1);
  const run = await runProcess(t, gate);
  const callers = Array.from({ length: SAVE_SLOTS_PER_RUN }, () => new AbortController());
  const takes = callers.map((caller) => run.child.call("saves", "take", [caller.signal]));
  for (const take of takes) take.catch(() => {});
  await until(() => gate.busy === 1 && gate.waiting === SAVE_SLOTS_PER_RUN - 1, `1 held, 15 waiting: ${gate.busy}, ${gate.waiting}`);
  // The refusal comes before any queue: a take that queued instead never settles, and the test's timeout catches it.
  const outcome = await run.child.call("saves", "take", [new AbortController().signal]).then(() => "granted", (error) => error);
  assert.match(String(outcome?.message ?? outcome), /this run already has 16 web_save downloads held or waiting/);
  assert.deepEqual([gate.busy, gate.waiting], [1, SAVE_SLOTS_PER_RUN - 1], "the refused take never queued");
  callers.at(-1).abort();
  await until(() => gate.waiting === SAVE_SLOTS_PER_RUN - 2, "the aborted waiter left");
  const again = run.child.call("saves", "take", [new AbortController().signal]);
  again.catch(() => {});
  await until(() => gate.waiting === SAVE_SLOTS_PER_RUN - 1, "a new take is accepted once one left");
  const held = await takes[0];
  await held();
  await until(() => gate.waiting === SAVE_SLOTS_PER_RUN - 2, "the held one released, the next waiter took it");
  const third = run.child.call("saves", "take", [new AbortController().signal]);
  third.catch(() => {});
  await until(() => gate.waiting === SAVE_SLOTS_PER_RUN - 1, "a new take is accepted once one was released");
  run.end();
  await until(() => gate.busy === 0 && gate.waiting === 0, "the run's end let go of all of it");
});

// ---------------------------------------------------------------------------------------------------------------------
// A write bigger than a channel frame from a run's process (runner/big-writes.ts): the runner pulls it in pieces of the
// length it asks, through a gate of its own, and writes it once on the Workspace it handed. Each "run" is a channel pair
// of small frames over a real Unix socket; the runner hands a local Workspace with its pieced write, as heldFor's archil
// hands the run's folder on its disk (run-child-held.test.mjs drives that one).

const big = await import("../dist/runner/big-writes.js").catch(() => ({}));
const FRAME = 256 * 1024;
const PIECE = 64 * 1024;

/** A run process over a channel of FRAME-byte frames whose runner hands `ws` (with its pieced write, on `gate`) as
 *  target "folder": the run's side has `folder()`, what it was handed. */
async function bigRun(t, gate, ws, options = {}) {
  assert.equal(typeof big.runBigWrites, "function", "runner/big-writes.js exports runBigWrites");
  const dir = await scratch(t);
  const path = join(dir, `big-${socketCount++}.sock`);
  const server = createServer();
  await new Promise((resolve) => server.listen(path, resolve));
  const accepted = once(server, "connection");
  const childSocket = connect(path);
  const [[runnerSocket]] = await Promise.all([accepted, once(childSocket, "connect")]);
  server.close();
  const bigs = big.runBigWrites({ gate, piece: PIECE, ...options });
  const runner = runChannel(runnerSocket, () => {}, saveSlots(SAVE_CONCURRENCY), { bigs, maxFrame: FRAME });
  runner.expose("folder", () => ({ workspace: ws, pieces: bigs.pieces(ws) }));
  const child = new Channel(childSocket, { maxFrame: FRAME });
  const end = () => { child.close(); runner.close(); };
  t.after(end);
  return { child, childSocket, end, folder: () => child.call("folder", "open", []) };
}

/** `ws` with every write it is asked counted: [path, bytes]. */
const counted = (ws) => {
  const writes = [];
  const real = ws.write.bind(ws);
  ws.write = async (path, data) => { writes.push([path, data.length]); return real(path, data); };
  return { ws, writes };
};

test("a write bigger than the channel's frame lands byte for byte through the run's held Workspace, written once by the runner; a small one is one call", async (t) => {
  const { work, ws: local } = await folders(t);
  const { ws, writes } = counted(local);
  const run = await bigRun(t, saveSlots(4), ws);
  const handed = await run.folder();
  assert.equal(handed.pieces.piece, PIECE, "the runner says the piece it pulls");
  const remote = big.piecedWorkspace(handed.workspace, handed.pieces);
  const bytes = randomBytes(3 * FRAME + 7);
  await remote.write("media/big.bin", bytes);
  assert.equal(Buffer.compare(readFileSync(join(work, "media", "big.bin")), bytes), 0, "byte for byte");
  await remote.write("media/small.txt", "small");
  assert.equal(readFileSync(join(work, "media", "small.txt"), "utf8"), "small");
  assert.deepEqual(writes, [["media/big.bin", bytes.length], ["media/small.txt", 5]], "each file written once, the big one whole");
  // Without the pieces the big write is one call, past the frame: what the run's process could not do before.
  await assert.rejects(handed.workspace.write("media/again.bin", bytes), /past the channel's/);
});

test("a piece of another length than the runner asked is refused, and nothing is written; the gate is let go", async (t) => {
  const { work, ws } = await folders(t);
  const gate = saveSlots(4);
  const run = await bigRun(t, gate, ws);
  const { pieces } = await run.folder();
  const size = 3 * PIECE;
  for (const [what, pull] of [
    ["short", async (offset, length) => new Uint8Array(offset === PIECE ? length - 1 : length)],
    ["long", async (offset, length) => new Uint8Array(offset === PIECE ? length + 1 : length)],
    ["not bytes", async (offset, length) => (offset === PIECE ? "x".repeat(length) : new Uint8Array(length))],
  ]) {
    await assert.rejects(pieces.write("media/bad.bin", size, pull), (error) => error.code === "REFUSED" && /the piece at 65536 of a write is .*not the 65536 asked for: nothing was written/.test(error.message), what);
    assert.equal(existsSync(join(work, "media")), false, `${what}: nothing at the path, no temporary file`);
    assert.deepEqual([gate.busy, gate.waiting], [0, 0], `${what}: the gate let go`);
  }
});

test("a declared size over the cap is refused before anything is pulled or the gate is taken", async (t) => {
  const { work, ws } = await folders(t);
  const took = [];
  const gate = { size: 4, busy: 0, waiting: 0, take: async () => { took.push("take"); return () => {}; } };
  const run = await bigRun(t, gate, ws);
  const { pieces } = await run.folder();
  assert.equal(big.BIG_WRITE_MAX, SAVE_MAX_BYTES, "the cap is web_save's");
  const pulled = [];
  await assert.rejects(pieces.write("media/huge.bin", big.BIG_WRITE_MAX + 1, async (offset, length) => { pulled.push(offset); return new Uint8Array(length); }), (error) => error.code === "TOO_LARGE");
  assert.deepEqual([pulled, took], [[], []], "nothing pulled, no slot taken");
  assert.equal(existsSync(join(work, "media")), false);
});

test("the run's channel ending mid-transfer writes nothing and lets the gate go, its waiters too", async (t) => {
  const { work, ws } = await folders(t);
  const gate = saveSlots(1);
  const run = await bigRun(t, gate, ws);
  const { pieces } = await run.folder();
  const pulled = [];
  // The first piece comes, the second never does.
  const stuck = (offset, length) => { pulled.push(offset); return offset === 0 ? Promise.resolve(new Uint8Array(length)) : new Promise(() => {}); };
  const first = pieces.write("media/a.bin", 3 * PIECE, stuck);
  const second = pieces.write("media/b.bin", 3 * PIECE, stuck);
  first.catch(() => {});
  second.catch(() => {});
  await until(() => pulled.length === 2 && gate.waiting === 1, `one pulling, one waiting: ${pulled}, ${gate.waiting}`);
  run.childSocket.destroy();
  await until(() => gate.busy === 0 && gate.waiting === 0, `the run's end let go of the hold and the wait: ${gate.busy}, ${gate.waiting}`);
  await assert.rejects(first);
  await assert.rejects(second);
  assert.equal(existsSync(join(work, "media")), false, "no file and no temporary one");
});

test("the runner's gate bounds big writes across runs, and the run's signal ends its own: a held one, aborted, writes nothing", async (t) => {
  const { work, ws } = await folders(t);
  const gate = saveSlots(2);
  const [a, b] = [await bigRun(t, gate, ws), await bigRun(t, gate, ws)];
  const [pa, pb] = [(await a.folder()).pieces, (await b.folder()).pieces];
  const waiting = [];
  /** A pull whose second piece waits until `go()`. */
  const gated = () => {
    let go;
    const ready = new Promise((resolve) => (go = resolve));
    return { go, pull: async (offset, length) => { if (offset > 0) { waiting.push(offset); await ready; } return new Uint8Array(length).fill(offset / PIECE + 1); } };
  };
  const [x, y, z] = [gated(), gated(), gated()];
  const caller = new AbortController();
  const wx = pa.write("media/x.bin", 2 * PIECE, x.pull, caller.signal);
  const wy = pb.write("media/y.bin", 2 * PIECE, y.pull);
  const wz = pb.write("media/z.bin", 2 * PIECE, z.pull);
  wx.catch(() => {});
  await until(() => gate.busy === 2 && gate.waiting === 1 && waiting.length === 2, `two held, one waits: ${gate.busy}, ${gate.waiting}, ${waiting}`);
  caller.abort(new Error("the run stopped"));
  await assert.rejects(wx, /the run stopped/);
  await until(() => waiting.length === 3, "the waiter took the freed slot");
  y.go();
  z.go();
  await Promise.all([wy, wz]);
  assert.equal(existsSync(join(work, "media", "x.bin")), false, "the aborted write left nothing");
  assert.deepEqual([...readFileSync(join(work, "media", "y.bin"))].slice(PIECE - 1, PIECE + 1), [1, 2], "the pieces in order");
  assert.deepEqual([gate.busy, gate.waiting], [0, 0]);
});

test("one run may have at most BIG_WRITES_PER_RUN big writes held or waiting: the next is refused at once; a piece not answered in time fails its write", async (t) => {
  const { work, ws } = await folders(t);
  const gate = saveSlots(1);
  const run = await bigRun(t, gate, ws, { pieceMs: 200 });
  const { pieces } = await run.folder();
  const never = () => new Promise(() => {});
  const writes = Array.from({ length: big.BIG_WRITES_PER_RUN }, (_, i) => pieces.write(`media/${i}.bin`, 2 * PIECE, never));
  for (const write of writes) write.catch(() => {});
  await until(() => gate.busy === 1 && gate.waiting === big.BIG_WRITES_PER_RUN - 1, `1 held, the rest waiting: ${gate.busy}, ${gate.waiting}`);
  await assert.rejects(pieces.write("media/over.bin", 2 * PIECE, never), /this run already has 8 big writes held or waiting/);
  // The held one's piece never comes: it fails at the piece's deadline, and the next takes the slot, and so on.
  await assert.rejects(writes[0], { name: "TimeoutError" });
  await until(() => gate.waiting === big.BIG_WRITES_PER_RUN - 2, "the next waiter took the slot");
  run.end();
  await until(() => gate.busy === 0 && gate.waiting === 0, "the run's end let go of all of it");
  assert.equal(existsSync(join(work, "media")), false);
});

test("the run's channel ending lets its waiting big writes leave the gate at once, while one of its writes is still being written", async (t) => {
  const { work, ws } = await folders(t);
  // The runner's write of the first file waits until the test lets it go: its slot stays held through the channel's end.
  let finish;
  const writing = new Promise((resolve) => (finish = resolve));
  const real = ws.write.bind(ws);
  const started = [];
  ws.write = async (path, data) => { started.push(path); await writing; return real(path, data); };
  const gate = saveSlots(1);
  const run = await bigRun(t, gate, ws);
  const { pieces } = await run.folder();
  const bytes = async (_offset, length) => new Uint8Array(length);
  const first = pieces.write("media/a.bin", 2 * PIECE, bytes);
  await until(() => started.length === 1, "the first is being written");
  const queued = [pieces.write("media/b.bin", 2 * PIECE, bytes), pieces.write("media/c.bin", 2 * PIECE, bytes)];
  for (const write of [first, ...queued]) write.catch(() => {});
  await until(() => gate.waiting === 2, "two wait behind it");
  run.childSocket.destroy();
  await until(() => gate.waiting === 0, `the run's end took its waiters out of the gate: ${gate.waiting}`);
  assert.equal(gate.busy, 1, "the write in progress still holds its slot");
  finish();
  await until(() => gate.busy === 0, "and gives it back when it returns");
  assert.deepEqual(started, ["media/a.bin"], "no waiter was ever written");
  assert.equal(existsSync(join(work, "media", "b.bin")) || existsSync(join(work, "media", "c.bin")), false);
});
