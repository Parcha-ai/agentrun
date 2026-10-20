// A program a code-mode global starts gets the child environment `read`'s programs get, never the host process's
// own: here `vision.transcribe` finding a recording's length with ffprobe, as an agent's code calls it on a real
// pi-durable Harness whose environment (pi's own) would give a program all of `process.env`. The ffprobe on PATH is a
// stand-in that writes the environment it was started with to a file and answers a length.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createVisionExtension } from "@parcha/pi-vision/durable";
import { inheritedEnv } from "@parcha/pi-vision/node";
import { SENTINEL_EYES_KEY } from "@parcha/pi-vision/testing";
import { codeTool } from "./durable/code-tool.mjs";
import { drive, textOf, tmp } from "./durable/rig.mjs";

const mp3 = () => Buffer.concat([Buffer.from("ID3\x04\x00\x00\x00\x00\x00\x00", "latin1"), Buffer.alloc(4096, 0x55)]);
const said = { provider: "fake", model: "fake-stt", usdPerMinute: 0.006, transcribe: async () => ({ words: [{ text: "Hello", start: 0, end: 0.5 }], text: "Hello" }) };

/** A stand-in ffprobe, first on this process's PATH: it writes its environment to `dump` and 12.5 seconds to `-o`. */
function stubProbe(t) {
  const bin = tmp("vision-probe-");
  const dump = path.join(bin, "env.txt");
  fs.writeFileSync(path.join(bin, "ffprobe"), `#!/bin/sh\nenv > '${dump}'\nwhile [ $# -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done\necho 12.5 > "$out"\n`, { mode: 0o755 });
  const before = { path: process.env.PATH, secret: process.env.VISION_TEST_SECRET };
  process.env.PATH = `${bin}${path.delimiter}${before.path}`;
  process.env.VISION_TEST_SECRET = SENTINEL_EYES_KEY;
  t.after(() => {
    process.env.PATH = before.path;
    if (before.secret === undefined) delete process.env.VISION_TEST_SECRET; else process.env.VISION_TEST_SECRET = before.secret;
    fs.rmSync(bin, { recursive: true, force: true });
  });
  return () => fs.readFileSync(dump, "utf8").split("\n");
}

/** One `vision.transcribe` call by an agent's code, with the extension `options` add to. */
async function transcribed(t, options = {}) {
  const cwd = tmp("vision-hear-");
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, "landing.mp3"), mp3());
  const vision = createVisionExtension({ transcriber: said, evidence: { file: async () => null }, scope: () => ({ label: "hear", deriveDir: ".vision" }), ...options });
  const { results } = await drive({ extensions: [codeTool(vision), vision.extension], rounds: [[["code", { code: `return (await vision.transcribe({ path: "landing.mp3" })).costUsd;` }]]], cwd });
  return JSON.parse(textOf(results[0]));
}

test("the ffprobe vision.transcribe starts is not given the host's environment, and is given what the host passes", async (t) => {
  const seen = stubProbe(t);
  const byDefault = await transcribed(t);
  assert.deepEqual(byDefault, { ok: true, value: 0.00125 }, "the length came from the stand-in, so the price is 12.5 s at $0.006 a minute");
  assert.ok(!seen().some((line) => line.includes(SENTINEL_EYES_KEY)), "the key held in this process's environment is not in the program's");
  assert.deepEqual(seen().filter((line) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(line)).map((line) => line.split("=")[0]).filter((name) => name in process.env && !(name in inheritedEnv()) && name !== "PWD" && name !== "SHLVL" && name !== "_"), [], "nothing of this process's environment but the few a program needs (and what the shell sets itself)");

  const passed = await transcribed(t, { env: { ...inheritedEnv(), VISION_TEST_SECRET: SENTINEL_EYES_KEY } });
  assert.equal(passed.ok, true);
  assert.ok(seen().includes(`VISION_TEST_SECRET=${SENTINEL_EYES_KEY}`), "a variable the host passes is there");
});
