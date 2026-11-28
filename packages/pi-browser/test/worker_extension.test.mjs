import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { extensionDirectory } from "../dist/providers/chrome-args.js";
import { cdpProvider } from "../dist/providers/cdp.js";
import { COPY_NOTICE, copyExtension, endBatchesOnRelease, installedStagehand, loadConfined, REWRITE_FOR, REWRITE_MARK } from "../dist/providers/worker-extension.js";
import { scratch } from "./fixtures/scratch.mjs";

const STAGEHAND = path.join(path.dirname(fileURLToPath(import.meta.resolve("@browserbasehq/stagehand"))), "..");
const WORKER = path.join(extensionDirectory(), "service-worker.js");
const worker = () => fs.readFileSync(WORKER, "utf8");
/** What the rewrite adds, each of which must land exactly once. */
const HOOKS = ["\tconst active = new Set();\n", "\t\tactive.add(controller);\n", "\t\t\tactive.delete(controller);\n", "\t\tabortAll(reason) {\n",
  "\t\tthis.router.callbackBatchController.abortAll(/* @__PURE__ */ new Error(\"Stagehand client disconnected\"));\n"];
const count = (text, part) => text.split(part).length - 1;
/** A copy of Stagehand's extension directory whose worker is `text`, to copy from. */
const sourceWith = (dir, text) => {
  const source = path.join(dir, "source");
  fs.cpSync(extensionDirectory(), source, { recursive: true, dereference: true });
  fs.writeFileSync(path.join(source, "service-worker.js"), text);
  return source;
};

test("the rewrite was written against the installed Stagehand, and every place it changes is there exactly once", async (t) => {
  const installed = JSON.parse(fs.readFileSync(path.join(STAGEHAND, "package.json"), "utf8")).version;
  assert.equal(installedStagehand(), installed);
  assert.equal(installed, REWRITE_FOR, `Stagehand ${installed} is installed; the worker rewrite in src/providers/worker-extension.ts was written against ${REWRITE_FOR}: re-read its anchors against the new worker (and drop the rewrite if Stagehand now ends a released client's batches itself), then move REWRITE_FOR`);
  const rewritten = endBatchesOnRelease(worker());
  assert.ok(rewritten.startsWith(REWRITE_MARK));
  for (const hook of HOOKS) assert.deepEqual([count(worker(), hook), count(rewritten, hook)], [0, 1], `added once: ${JSON.stringify(hook)}`);
  // The browser loads the worker as a module: the rewritten one still parses as one.
  const dir = await scratch(t, "worker-extension-");
  fs.writeFileSync(path.join(dir, "worker.mjs"), rewritten);
  const check = spawnSync(process.execPath, ["--check", path.join(dir, "worker.mjs")], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
});

test("the copy carries the rewritten worker, Stagehand's LICENSE and a NOTICE saying what changed", async (t) => {
  const dir = await scratch(t, "worker-extension-");
  const copy = await copyExtension(dir);
  assert.equal(fs.readFileSync(path.join(copy, "service-worker.js"), "utf8"), endBatchesOnRelease(worker()));
  assert.equal(fs.readFileSync(path.join(copy, "LICENSE"), "utf8"), fs.readFileSync(path.join(STAGEHAND, "LICENSE"), "utf8"));
  assert.equal(fs.readFileSync(path.join(copy, "NOTICE"), "utf8"), COPY_NOTICE);
  assert.equal(fs.readFileSync(WORKER, "utf8").startsWith(REWRITE_MARK), false, "Stagehand's own worker is left as it was");
});

test("a worker that has moved a place the rewrite changes is refused by name, and no copy is made", async (t) => {
  const dir = await scratch(t, "worker-extension-");
  const gone = worker().replace("\treleaseClient() {\n\t\tthis.clientConnected = false;\n", "\treleaseClient() {\n\t\tthis.connected = false;\n");
  const refusal = new RegExp(`\\(service-worker\\.js, Stagehand ${installedStagehand().replaceAll(".", "\\.")}\\) has no match for the client's release, [^]*written against Stagehand ${REWRITE_FOR.replaceAll(".", "\\.")}\\. No browser was started\\.$`);
  await assert.rejects(copyExtension(path.join(dir, "into"), sourceWith(dir, gone)), (error) => error.name === "BrowserFailureError" && error.failure.code === "browser_unavailable" && refusal.test(error.message));
  assert.equal(fs.existsSync(path.join(dir, "into")), false, "nothing was copied: no copy without the rewrite exists to be loaded");
  assert.throws(() => endBatchesOnRelease(gone, "9.9.9"), /Stagehand 9\.9\.9\) has no match for the client's release/, "it names the Stagehand that is installed");
  const twice = worker().replace("\treturn { run };\n}\nfunction createCallbackContextFacade(", (found) => `${found}\n}\n${found}`);
  assert.throws(() => endBatchesOnRelease(twice), /more than one match for the batch controller's interface/);
  assert.throws(() => endBatchesOnRelease(endBatchesOnRelease(worker())), /no match for a batch's end/, "a worker rewritten already is not rewritten again");
});

// Nothing listens here: the load fails after the policy is written.
const DEAD = "ws://127.0.0.1:9/devtools/browser/not-there";
const manifestOf = (copy) => JSON.parse(fs.readFileSync(path.join(copy, "manifest.json"), "utf8"));

test("a load that failed after the policy was written can be tried again, and fails for the same reason", async (t) => {
  const dir = await scratch(t, "worker-extension-");
  const copy = await copyExtension(dir);
  const first = await loadConfined(copy, DEAD).then(() => null, (error) => error);
  assert.ok(first, "the first load fails: nothing answers");
  assert.doesNotMatch(first.message, /already sets/);
  const second = await loadConfined(copy, DEAD).then(() => null, (error) => error);
  assert.ok(second, "the retry fails too");
  assert.doesNotMatch(second.message, /already sets/, "and not because its own earlier write is taken for someone else's policy");
  assert.match(manifestOf(copy).content_security_policy.extension_pages, /connect-src 'self' ws:\/\/127\.0\.0\.1:9\/devtools\/browser\/not-there$/);
});

test("a policy the manifest already carries that is not this lease's own is refused, not overwritten", async (t) => {
  const dir = await scratch(t, "worker-extension-");
  const copy = await copyExtension(dir);
  const file = path.join(copy, "manifest.json");
  const foreign = { extension_pages: "script-src 'self'; object-src 'self'; connect-src *" };
  fs.writeFileSync(file, JSON.stringify({ ...manifestOf(copy), content_security_policy: foreign }));
  await assert.rejects(loadConfined(copy, DEAD), /already sets a content security policy/);
  assert.deepEqual(manifestOf(copy).content_security_policy, foreign, "the policy is left as it was");
});

test("a local Chrome launch whose extension worker the rewrite refuses fails with that error, and Chrome is never started", async (t) => {
  const dir = await scratch(t, "worker-extension-");
  const moved = worker().replace("\tasync function run(params, {", "\tasync function runBatch(params, {").replace("function createCallbackBatchController(router) {\n", "function createBatchController(router) {\n");
  const before = process.env.STAGEHAND_EXTENSION_DIRECTORY_PATH;
  process.env.STAGEHAND_EXTENSION_DIRECTORY_PATH = sourceWith(dir, moved);
  t.after(() => { if (before === undefined) delete process.env.STAGEHAND_EXTENSION_DIRECTORY_PATH; else process.env.STAGEHAND_EXTENSION_DIRECTORY_PATH = before; }, { timeout: 30_000 });
  // A "Chrome" that only says it was started.
  const started = path.join(dir, "started");
  const chrome = path.join(dir, "chrome");
  fs.writeFileSync(chrome, `#!/bin/sh\ntouch ${JSON.stringify(started)}\n`, { mode: 0o755 });
  const provider = cdpProvider({ chrome: { executablePath: chrome, profileRoot: path.join(dir, "profiles") } });
  const spec = { tag: "refused", maxLifetimeS: 600, idleTimeoutS: 60, proxies: false, verified: false, captcha: false, viewport: { width: 800, height: 600 }, metadata: {} };
  await assert.rejects(provider.create(spec, new AbortController().signal), (error) => error.failure?.code === "browser_unavailable" && /has no match for the batch registry/.test(error.message));
  assert.equal(fs.existsSync(started), false, "Chrome was never started: not on a copy without the rewrite, nor on Stagehand's own directory");
  assert.deepEqual(fs.readdirSync(path.join(dir, "profiles")).filter((name) => !name.startsWith(".")), [], "and the launch left no profile behind");
});
