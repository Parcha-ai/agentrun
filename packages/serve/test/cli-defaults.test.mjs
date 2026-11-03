// What agentrun-serve picks when it is not told: the first free port from its default, the model a provider key gives
// when no AGENT_MODEL is set, and, with --open, the browser on the console's address where there is one to open.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import * as host from "../dist/host.js";
import * as model from "../dist/model.js";

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const MODEL_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "AGENT_MODEL", "AGENT_MODEL_FAST", "AGENT_MODEL_STRONG", "AGENT_MODEL_BASE_URL", "AGENT_MODEL_API_KEY", "AGENTRUN_TOKEN", "CI", "DISPLAY", "WAYLAND_DISPLAY"];

test("a provider key gives the server its model when none is set: the first of Anthropic, OpenAI and OpenRouter; a model or a gateway already set wins; each is in pi-ai's catalog", () => {
  const has = (...keys) => (name) => keys.includes(name);
  assert.equal(model.keyModel?.({}, has("OPENAI_API_KEY", "ANTHROPIC_API_KEY")), "anthropic/claude-sonnet-5-5");
  assert.equal(model.keyModel?.({}, has("OPENAI_API_KEY")), "openai/gpt-6.1-sol");
  assert.equal(model.keyModel?.({}, has("OPENROUTER_API_KEY")), "openrouter/anthropic/claude-sonnet-5.5");
  assert.equal(model.keyModel?.({}, has()), undefined, "no key: no model");
  assert.equal(model.keyModel?.({ AGENT_MODEL: "openai/gpt-5" }, has("ANTHROPIC_API_KEY")), undefined);
  assert.equal(model.keyModel?.({ AGENT_MODEL_BASE_URL: "https://gateway.example/v1" }, has("OPENAI_API_KEY")), undefined);
  const models = builtinModels({});
  for (const [, ref] of model.KEY_MODELS ?? []) assert.ok(models.getModel(ref.slice(0, ref.indexOf("/")), ref.slice(ref.indexOf("/") + 1)), ref);
  assert.equal(model.KEY_MODELS?.length, 3);
});

test("the first free port from a given one passes over one in use; --open opens a browser unless in CI or on a Linux with no display", async (t) => {
  const first = await host.freePort?.(7340, "127.0.0.1");
  assert.ok(first >= 7340);
  const held = createServer();
  await new Promise((resolve) => held.listen(first, "127.0.0.1", resolve));
  t.after(() => held.close());
  assert.ok((await host.freePort(first, "127.0.0.1")) > first);
  assert.deepEqual([host.canOpen?.({}, "darwin"), host.canOpen?.({ CI: "1" }, "darwin"), host.canOpen?.({}, "linux"), host.canOpen?.({ DISPLAY: ":0" }, "linux"), host.canOpen?.({ WAYLAND_DISPLAY: "w" }, "freebsd")], [true, false, false, true, true]);
});

/** agentrun-serve started with `args` and no --port, in a fresh home with no model key, on `data` (else a fresh store);
 *  resolves with its base URL once its banner is out. */
async function serve(t, args, env = {}, data = undefined) {
  const home = mkdtempSync(join(tmpdir(), "serve-defaults-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !MODEL_KEYS.includes(name)));
  const child = spawn(process.execPath, [CLI, "--data", data ?? join(home, "agents"), ...args], { env: { ...clean, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise((resolve) => child.on("exit", resolve));
  t.after(async () => { child.kill("SIGTERM"); await exited; });
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (err += chunk));
  for (let i = 0; !/^Open /m.test(out); i++) {
    assert.ok(i < 600 && child.exitCode === null, `the server printed its banner: ${out}${err}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const stop = async () => { child.kill("SIGTERM"); await exited; };
  return { home, base: /AGENTRUN_BASE_URL=(\S+)\/v2/.exec(out)[1], out, stop };
}

test("demo: with no --port the server takes the first free port from its default, and a provider key with no model gives it one", { timeout: 120_000 }, async (t) => {
  const busy = await host.freePort(7340, "127.0.0.1");
  const held = createServer();
  await new Promise((resolve) => held.listen(busy, "127.0.0.1", resolve));
  t.after(() => held.close());
  const { base } = await serve(t, [], { ANTHROPIC_API_KEY: "not-a-secret" });
  const port = Number(new URL(base).port);
  assert.ok(port > busy, `${port} passes over ${busy}, which is in use`);
  const caps = await (await fetch(`${base}/v2/capabilities`)).json();
  assert.equal(caps.models.default, "anthropic/claude-sonnet-5-5");
});

test("demo: --open opens the console's address in the browser where there is a display, and never in CI; with accounts off, the banner's sign-in link when this start made the token", { timeout: 180_000 }, async (t) => {
  const fake = mkdtempSync(join(tmpdir(), "serve-open-"));
  t.after(() => rmSync(fake, { recursive: true, force: true }));
  const opened = join(fake, "opened");
  for (const name of ["xdg-open", "open"]) {
    writeFileSync(join(fake, name), `#!/bin/sh\nprintf '%s\\n' "$1" >> '${opened}'\n`);
    chmodSync(join(fake, name), 0o755);
  }
  const path = `${fake}:${process.env.PATH}`;
  const { base } = await serve(t, ["--port", "0", "--open"], { PATH: path, DISPLAY: ":0" });
  for (let i = 0; !existsSync(opened) && i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(readFileSync(opened, "utf8"), `${base}/\n`);
  rmSync(opened);
  // Accounts off, on a fresh store: the browser gets the link the banner prints, whose token signs it in.
  const store = join(fake, "store");
  const made = await serve(t, ["--port", "0", "--open"], { PATH: path, DISPLAY: ":0", AGENTRUN_ACCOUNTS: "0" }, store);
  for (let i = 0; !existsSync(opened) && i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 50));
  const link = /^Open (\S+)/m.exec(made.out)?.[1];
  assert.match(link ?? "", /^http:\/\/127\.0\.0\.1:\d+\/\?token=[\w%.-]+$/, made.out);
  assert.equal(existsSync(opened) && readFileSync(opened, "utf8"), `${link}\n`, "the sign-in link, as the banner prints it");
  rmSync(opened);
  await made.stop();
  // The same store started again: the token is not printed, so the browser gets the plain address, never a placeholder.
  const kept = await serve(t, ["--port", "0", "--open"], { PATH: path, DISPLAY: ":0", AGENTRUN_ACCOUNTS: "0" }, store);
  for (let i = 0; !existsSync(opened) && i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(existsSync(opened) && readFileSync(opened, "utf8"), `${kept.base}/\n`);
  rmSync(opened);
  await serve(t, ["--port", "0", "--open"], { PATH: path, DISPLAY: ":0", CI: "1" });
  await serve(t, ["--port", "0"], { PATH: path, DISPLAY: ":0" });
  assert.equal(existsSync(opened), false, "not in CI, and not without --open");
});
