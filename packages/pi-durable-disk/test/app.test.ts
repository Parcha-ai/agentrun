// The app contract for `run --app` (src/app.ts): what loads, and every way a module fails as AppError (exit 1, not
// terminal). No Archil, no network.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError, loadApp, type AppContext } from "../src/app.ts";
import { main } from "../src/cli.ts";
import { exitCodeFor } from "../src/errors.ts";
import { TERMINAL_EXITS } from "../src/hosts/local-host.ts";

const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pda-app-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const where: AppContext = { ref: { disk: "dsk-1", region: "r", id: "r1" }, root: "/mnt/archil/runs/r1", work: "/mnt/archil/runs/r1/work", store: "/mnt/archil/runs/r1/store" };
let n = 0;
const module = (source: string) => {
  const file = join(dir, `app-${++n}.mjs`);
  writeFileSync(file, source);
  return file;
};

test("an app module's default export gets where the run lives and returns Harness options with onOpen", async () => {
  const file = module(`export default async (ctx) => ({ registry: { r: 1 }, models: { m: 1 }, settings: { s: ctx.work }, onOpen() {} });`);
  const app = await loadApp(file, where);
  assert.deepEqual(app.registry, { r: 1 });
  assert.deepEqual(app.settings, { s: where.work }, "the context reached the module");
  assert.equal(typeof app.onOpen, "function");
  const sync = await loadApp(module(`export default (ctx) => ({ registry: {}, models: {} });`), where);
  assert.equal(sync.onOpen, undefined, "a plain function and no onOpen are fine");
});

test("a missing module, no default function, a throwing one, or no options: AppError, exit 1, which the unit may retry", async () => {
  const cases: [string, string, RegExp][] = [
    ["missing", join(dir, "nope.mjs"), /cannot load/],
    ["syntax error", module(`export default (`), /cannot load/],
    ["no default", module(`export const app = () => ({});`), /no default export function/],
    ["default is an object", module(`export default { registry: {}, models: {} };`), /no default export function/],
    ["throws", module(`export default async () => { throw new Error("no model key"); };`), /threw: no model key/],
    ["no registry", module(`export default () => ({ models: {} });`), /no Harness options/],
    ["nothing", module(`export default () => undefined;`), /no Harness options/],
  ];
  for (const [name, file, message] of cases) {
    const err = await loadApp(file, where).then(() => null, (e: unknown) => e);
    assert.ok(err instanceof AppError && err.code === "APP_FAILED" && message.test(err.message), `${name}: ${err}`);
    assert.equal(exitCodeFor(err), 1, name);
  }
  assert.ok(!(TERMINAL_EXITS as readonly number[]).includes(1), "exit 1 is not terminal: Restart=on-failure retries it");
});

test("run with an app module that does not load: the factory runs once the claim is held, so it exits 1 there and lets the claim go (a second open is not held)", async () => {
  const quiet = process.stderr.write;
  const lines: string[] = [];
  process.stderr.write = ((chunk: string | Uint8Array) => (lines.push(String(chunk)), true)) as typeof process.stderr.write;
  try {
    const args = ["run", "--dir", join(dir, "run-nope"), "--app", join(dir, "nope.mjs")];
    assert.equal(await main(args), 1);
    assert.equal(await main(args), 1, "not 76: the first open let its claim go");
    assert.ok(lines.some((l) => l.includes('"event":"app failed"') && l.includes("APP_FAILED")), lines.join(""));
  } finally {
    process.stderr.write = quiet;
  }
});
