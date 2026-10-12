// The environment poppler's programs are started with when `handle.pdfText` reads a PDF: a key the host process holds
// in its environment is not in it, unless the host passes it. Each program is reached through a wrapper, first on PATH,
// that appends the environment it was started with to a file and then runs the real one. Needs the programs: `npm run
// test:binaries` fails without them, `npm test` does not run this file.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createVisionExtension } from "@parcha/pi-vision/durable";
import { inheritedEnv } from "@parcha/pi-vision/node";
import { SENTINEL_EYES_KEY, fixtureDir, pdfBytes } from "@parcha/pi-vision/testing";

const PROGRAMS = ["pdftotext", "pdfinfo", "pdftoppm"];
const LINES = ["Invented notice for a test", "Reference number 4471", "Nothing here is real"];
const onPath = (program) => (process.env.PATH ?? "").split(path.delimiter).map((dir) => path.join(dir, program)).find((file) => { try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; } });
const real = Object.fromEntries(PROGRAMS.map((program) => [program, onPath(program)]));
const missing = PROGRAMS.filter((program) => !real[program]);

test("poppler's programs are started without the host's environment through handle.pdfText, and with what the host passes", async (t) => {
  if (missing.length) {
    const why = `poppler is not installed (${missing.join(", ")} not on PATH)`;
    if (process.env.PI_VISION_REQUIRE_BINARIES === "1") throw new Error(why);
    return t.skip(why);
  }
  const dir = await fixtureDir("pi-vision-child-env-");
  const before = { path: process.env.PATH, secret: process.env.VISION_TEST_SECRET };
  t.after(() => {
    process.env.PATH = before.path;
    if (before.secret === undefined) delete process.env.VISION_TEST_SECRET; else process.env.VISION_TEST_SECRET = before.secret;
    return dir.remove();
  });
  /** A directory of wrappers that log to `dump`, put first on this process's PATH. */
  const wrapped = async (name) => {
    const dump = path.join(dir.path, `${name}.env`);
    for (const program of PROGRAMS) {
      const file = await dir.file(`${name}/${program}`, `#!/bin/sh\nenv >> '${dump}'\nexec '${real[program]}' "$@"\n`);
      fs.chmodSync(file, 0o755);
    }
    process.env.PATH = `${path.join(dir.path, name)}${path.delimiter}${before.path}`;
    return () => (fs.existsSync(dump) ? fs.readFileSync(dump, "utf8") : "");
  };
  process.env.VISION_TEST_SECRET = SENTINEL_EYES_KEY;
  const options = { evidence: { file: async () => null }, scope: () => ({ label: "l", deriveDir: "d" }) };
  const pdf = pdfBytes([{ lines: LINES }]);

  const byDefault = await wrapped("default");
  const text = await createVisionExtension(options).pdfText(pdf);
  for (const line of LINES) assert.match(text, new RegExp(line));
  assert.match(byDefault(), /^PATH=/m, "a poppler program ran through its wrapper and logged its environment");
  assert.ok(!byDefault().includes(SENTINEL_EYES_KEY), "the key is in no poppler program's environment");
  assert.doesNotMatch(byDefault(), /^VISION_TEST_SECRET=/m);

  const passed = await wrapped("passed");
  const again = await createVisionExtension({ ...options, env: { ...inheritedEnv(), VISION_TEST_SECRET: SENTINEL_EYES_KEY } }).pdfText(pdf);
  for (const line of LINES) assert.match(again, new RegExp(line));
  assert.ok(passed().split("\n").includes(`VISION_TEST_SECRET=${SENTINEL_EYES_KEY}`), "the host passed it, so the programs have it");
});
