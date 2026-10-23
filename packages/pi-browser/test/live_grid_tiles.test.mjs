// The live grid example's tile screencast and its CLI entry, on fakes: no browser, no model.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { screencast } from "../examples/live-grid/tiles.mjs";
import { fakeCdp, jpeg } from "./fixtures/fake-cdp.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const until = async (check, ms = 3_000) => { for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 20))) if (check()) return true; return check(); };

test("a tile whose followed page closes goes back to the page still open, so it does not freeze on the closed one's last frame", async (t) => {
  const fake = await fakeCdp({ pages: [{ id: "PAGE1", url: "https://site.test/" }] });
  t.after(() => fake.close());
  const frames = [];
  const tile = screencast(fake.url, (data) => frames.push(data), { everyMs: 0 });
  t.after(() => tile.close());
  // Each page sends its own bytes, so a frame the popup sent before it closed cannot pass for the open page's.
  const open = jpeg(800, 500, 0, 1), popup = jpeg(800, 500, 0, 2), back = jpeg(800, 500, 0, 3);
  const shown = (bytes) => frames.includes(bytes.toString("base64"));
  assert.ok(await until(() => fake.frame({ page: "PAGE1", bytes: open }) && shown(open)), "the tile follows the open page");
  fake.newPage("POPUP", "https://site.test/popup");
  assert.ok(await until(() => fake.frame({ page: "POPUP", bytes: popup }) && shown(popup)), "a new page is the one shown");
  fake.destroyPage("POPUP");
  assert.ok(await until(() => fake.frame({ page: "PAGE1", bytes: back }) && shown(back)), "after the popup closes, the page still open is shown again: its own new frame reaches the tile");
});

test("ask-site.mjs runs as a CLI when it is started through a symlink: with no arguments it says how to use it, never exits silently", (t) => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "ask site "));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const link = path.join(dir, "ask-site.mjs");
  fs.symlinkSync(path.join(HERE, "..", "examples", "use-website", "ask-site.mjs"), link);
  const run = spawnSync(process.execPath, [link], { encoding: "utf8", timeout: 30_000 });
  assert.equal(run.status, 2, `exit ${run.status}: ${run.stderr}`);
  assert.match(run.stderr, /usage: node ask-site\.mjs/);
});

test("ask-site.mjs imported from a script read through stdin does not throw: argv[1] is \"-\" there, which names no file, so it is not the main module and askSite is exported", () => {
  const url = pathToFileURL(path.join(HERE, "..", "examples", "use-website", "ask-site.mjs")).href;
  const run = spawnSync(process.execPath, ["--input-type=module", "-"], { input: `const m = await import(${JSON.stringify(url)}); console.log(typeof m.askSite);`, cwd: path.join(HERE, ".."), encoding: "utf8", timeout: 30_000 });
  assert.equal(run.status, 0, `exit ${run.status}: ${run.stderr}`);
  assert.equal(run.stdout.trim(), "function");
});
