// The providers and the image processor the adapter hands the core, with the real core behind it: the host's
// converters first and the package's own after them, so a host that names none still reads a PDF; and Photon when the
// host gives no processor.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { visionContext } from "@parcha/pi-vision";
import { createVisionExtension, packageProviders } from "@parcha/pi-vision/durable";
import { inheritedEnv } from "@parcha/pi-vision/node";
import { SENTINEL_EYES_KEY, pdfBytes } from "@parcha/pi-vision/testing";
import { drive, textOf, tmp } from "./durable/rig.mjs";

const evidence = { file: async () => null };
const scope = (id) => ({ label: `conv-${id}`, deriveDir: `.vision/${id}` });
const LINES = ["Invented notice for a test", "Reference number 4471", "Nothing here is real"];

test("the package's own providers: binaries before the zero-install readers, one of each, a fresh list each call", () => {
  const names = packageProviders().map((provider) => provider.name);
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.indexOf("poppler") < names.indexOf("unpdf"), "poppler is tried before pdf.js");
  assert.ok(names.indexOf("poppler") < names.indexOf("pdfium"), "poppler is tried before PDFium");
  assert.ok(names.includes("office-js") && names.includes("soffice") && names.includes("ffmpeg"));
  assert.notEqual(packageProviders(), packageProviders());
});

test("a host that names no providers gets a PDF's text from handle.pdfText and from the wrapped read", async () => {
  const vision = createVisionExtension({ evidence, scope });
  const text = await vision.pdfText(pdfBytes([{ lines: LINES }]));
  for (const line of LINES) assert.match(text, new RegExp(line));
  const cwd = tmp();
  fs.writeFileSync(path.join(cwd, "notice.pdf"), pdfBytes([{ lines: LINES }]));
  const run = await drive({ extensions: [vision.extension], rounds: [[["read", { path: "notice.pdf" }]]], cwd });
  assert.equal(run.results[0].isError, false);
  for (const line of LINES) assert.match(textOf(run.results[0]), new RegExp(line));
});

test("a host's provider is tried before the package's own", async () => {
  const asked = [];
  const hosted = {
    name: "hosted-reader", capabilities: ["text"], kinds: ["pdf"],
    detect: async () => ({ available: true, version: "1" }),
    text: async (source) => { asked.push(source.kind); return { madeBy: { provider: "hosted-reader", version: "1" }, pages: [{ page: 1, text: "read by the host's reader" }] }; },
  };
  const vision = createVisionExtension({ evidence, scope, providers: [hosted] });
  const text = await vision.pdfText(pdfBytes([{ lines: LINES }]));
  assert.match(text, /read by the host's reader/);
  assert.doesNotMatch(text, /Invented notice/, "the package's readers were not reached");
  assert.deepEqual(asked, ["pdf"]);
});

test("importing ./durable and making an extension loads no provider's dependency: each loads when a provider first runs", () => {
  const script = `
    import { registerHooks } from "node:module";
    const seen = new Set();
    registerHooks({ resolve(specifier, context, next) { if (!/^(node:|\\.|\\/|file:)/.test(specifier)) seen.add(specifier); return next(specifier, context); } });
    const { createVisionExtension, packageProviders } = await import("@parcha/pi-vision/durable");
    createVisionExtension({ evidence: { file: async () => null }, scope: () => ({ label: "l", deriveDir: "d" }) });
    packageProviders();
    console.log(JSON.stringify([...seen]));`;
  const seen = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: new URL("..", import.meta.url), encoding: "utf8" }));
  assert.deepEqual(seen, ["@parcha/pi-vision/durable"]);
});

/** A host's PDF reader that starts a real program through the environment it is called with, as poppler is started,
 *  and has it write the environment it found itself with to `file`. */
const programReader = (file) => ({
  name: "program-reader", capabilities: ["text"], kinds: ["pdf"],
  detect: async () => ({ available: true, version: "1" }),
  text: async (source, request, call) => {
    const ran = await call.env.exec([process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1], JSON.stringify(process.env))", file], { timeout: 30 }, visionContext(call.signal));
    assert.deepEqual(ran, { ok: true, value: { exitCode: 0 } });
    return { madeBy: { provider: "program-reader", version: "1" }, pages: [{ page: 1, text: "read by a program" }] };
  },
});

test("no program a read starts is given the host's environment, through pdfText, the wrapped read on pi's environment and a host's own read; the host's `env` is what they get", async (t) => {
  const before = process.env.VISION_TEST_SECRET;
  t.after(() => { if (before === undefined) delete process.env.VISION_TEST_SECRET; else process.env.VISION_TEST_SECRET = before; });
  process.env.VISION_TEST_SECRET = SENTINEL_EYES_KEY;
  const pdf = pdfBytes([{ lines: LINES }]);
  const dir = tmp();
  const seenBy = (name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
  const clean = (env, why) => {
    assert.ok(!JSON.stringify(env).includes(SENTINEL_EYES_KEY), `${why}: the key is nowhere in the program's environment`);
    assert.deepEqual(Object.keys(env).filter((name) => name in process.env && !(name in inheritedEnv())), [], `${why}: nothing of this process's environment but the named few`);
    assert.equal(env.PATH, process.env.PATH, `${why}: programs are still found`);
  };
  const call = { conversationId: "c", callId: "1", model: undefined, signal: undefined };
  /** Each way a read reaches a program, with the extension `options` builds. */
  const through = async (label, options) => {
    const made = (name) => createVisionExtension({ evidence, scope: (id) => ({ label: `c${id}`, deriveDir: `.vision/${label}-${name}` }), providers: [programReader(path.join(dir, `${label}-${name}.json`))], ...options });
    assert.match(await made("pdfText").pdfText(pdf), /read by a program/);
    const cwd = tmp();
    fs.writeFileSync(path.join(cwd, "notice.pdf"), pdf);
    const run = await drive({ extensions: [made("wrapped").extension], rounds: [[["read", { path: "notice.pdf" }]]], cwd });
    assert.match(textOf(run.results[0]), /read by a program/);
    // A host whose `read` is its own, handing the adapter pi's environment as it is.
    const own = await made("own").read(new NodeExecutionEnv({ cwd }), { path: "notice.pdf" }, call);
    assert.match(textOf(own), /read by a program/);
    return { pdfText: seenBy(`${label}-pdfText.json`), wrapped: seenBy(`${label}-wrapped.json`), own: seenBy(`${label}-own.json`) };
  };

  const byDefault = await through("default", {});
  for (const [way, env] of Object.entries(byDefault)) clean(env, way);

  const passed = await through("passed", { env: { ...inheritedEnv(), VISION_TEST_SECRET: SENTINEL_EYES_KEY } });
  for (const [way, env] of Object.entries(passed)) assert.deepEqual([env.VISION_TEST_SECRET, env.PATH], [SENTINEL_EYES_KEY, process.env.PATH], `${way}: the host passed it`);

  const whole = await through("whole", { env: { ONLY: "this" } });
  for (const [way, env] of Object.entries(whole)) assert.deepEqual([env.ONLY, env.HOME, env.VISION_TEST_SECRET], ["this", undefined, undefined], `${way}: the host's environment is the whole of it`);
});
