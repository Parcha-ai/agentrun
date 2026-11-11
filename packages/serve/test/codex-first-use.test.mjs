// Codex installs itself on first use, as Claude Code does (harness-install.ts): a codex run on a server whose data holds no
// Codex installs the pinned @openai/codex, with this platform's binary (its optional package, an npm alias), from npm into
// <data>/harnesses/codex, by the lock AgentRun ships, and runs once it is in. The registry is a fake on loopback
// (fake-npm.mjs). The first run and the run under a config that omits optional packages install the pinned binary itself
// (this checkout's, in the registry's tarball) and run it: the process that asks the model is that binary, inside the
// data's tree, at the pin's sha256. The others install a stub binary and run agentrun-harness-codex's stand-in for its
// app-server instead.
//
// Without the pinned binary here the runs of it skip; with AGENTRUN_CODEX_REQUIRE_BINARY=1 (CI) they fail.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { CODEX_BINARY_SHA256, CODEX_VERSION } from "@parcha/agentrun-harness-codex";
import { codexTarget, findCodex } from "../../run-adapters-codex/dist/binary.js";
import { verifyCodexBinary } from "../../run-adapters-codex/dist/verify.js";
import { copyStandIn } from "../../run-adapters-codex/test/stand-in.mjs";
import { agent, follow, scratch, serve } from "./support.mjs";
import { descendants, fakeNpmRegistry, npmOn, npmTarball, until } from "./fake-npm.mjs";

const CODEX = "@openai/codex";
const PIN = "0.164.0";
const LATER = "0.165.0";
const INSTALLING = "Installing Codex (first use)…";
const TARGET = codexTarget();
const PLATFORM = TARGET ? `${CODEX}-${TARGET.pkg}` : undefined;
const skip = !TARGET && "Codex ships no binary for this platform";
/** This checkout's pinned Codex binary, which the runs of it install from the registry. */
const found = findCodex();
const pinned = verifyCodexBinary(found);
const skipReal = skip || (pinned instanceof Error && process.env.AGENTRUN_CODEX_REQUIRE_BINARY !== "1" ? `no pinned Codex binary here: ${pinned.message}` : false);
const GATEWAY_KEY = `not-a-secret-${"gateway"}`;

/** The launcher's version as installed in the data's harnesses, or undefined. */
const installedIn = (data) => {
  try {
    return JSON.parse(readFileSync(join(data, "harnesses", "codex", "node_modules", ...CODEX.split("/"), "package.json"), "utf8")).version;
  } catch {
    return undefined;
  }
};
/** The platform binary an install under the data's harnesses holds. */
const binaryIn = (data) => join(data, "harnesses", "codex", "node_modules", ...PLATFORM.split("/"), "vendor", TARGET.target, "bin", "codex");

/** Codex's launcher at the pin (its platform package an optional npm alias, as Codex's own is), a later launcher the
 *  registry calls latest (its tarball missing, so an install that took it fails), and this platform's package with
 *  `binary`: the pinned binary, put in whole, or a stub file (the stand-in runs, never it). Each made once per file. */
const made = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-codex-registry-"));
after(() => rmSync(made, { recursive: true, force: true }));
const launcher = (version) => ({ name: CODEX, version, bin: { codex: "bin/codex.js" }, optionalDependencies: { [PLATFORM]: `npm:${CODEX}@${version}-${TARGET?.pkg}` } });
const platformManifest = { name: CODEX, version: `${PIN}-${TARGET?.pkg}`, os: [process.platform], cpu: [process.arch] };
const STUB = "#!/bin/sh\necho codex-cli 0.164.0\n";
const packageSets = new Map();
const packagesWith = (binary) => {
  if (!TARGET) return {};
  const key = typeof binary === "string" ? "stub" : "pinned";
  if (!packageSets.has(key))
    packageSets.set(key, {
      [CODEX]: {
        latest: LATER,
        versions: {
          [PIN]: { manifest: launcher(PIN), ...npmTarball(made, `${key}-${CODEX}-${PIN}`, { "package.json": JSON.stringify(launcher(PIN)), "bin/codex.js": "#!/usr/bin/env node\n" }) },
          [LATER]: { manifest: launcher(LATER), file: join(made, "missing.tgz"), integrity: "sha512-AAAA" },
          [`${PIN}-${TARGET.pkg}`]: { manifest: platformManifest, ...npmTarball(made, `${key}-${CODEX}-${PIN}-${TARGET.pkg}`, { "package.json": JSON.stringify(platformManifest), [`vendor/${TARGET.target}/bin/codex`]: binary }) },
        },
      },
    });
  return packageSets.get(key);
};

/** serve's gateway, on loopback: each Responses request answered at once, "Codex answered." `asked(req)`, before it
 *  answers: what the test wants to know while the process that asks is alive. */
async function gateway(t, asked = () => undefined) {
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || !/\/responses$/.test(req.url ?? "")) return void res.writeHead(404).end();
    for await (const _ of req);
    await asked(req);
    // The stream real Codex 0.164 answers from (openrouter-effort.test.mjs' shape), each event named on an `event:` line,
    // then `[DONE]`, which the stand-in reads to its end.
    const usage = { input_tokens: 1000, input_tokens_details: { cached_tokens: 0 }, output_tokens: 100, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 1100 };
    const message = { type: "message", role: "assistant", id: "msg_1", status: "completed", content: [{ type: "output_text", text: "Codex answered.", annotations: [] }] };
    const events = [
      { type: "response.created", response: { id: "resp_1", object: "response", status: "in_progress" } },
      { type: "response.output_item.added", output_index: 0, item: { ...message, status: "in_progress" } },
      { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "Codex answered." },
      { type: "response.output_item.done", output_index: 0, item: message },
      { type: "response.completed", response: { id: "resp_1", object: "response", status: "completed", output: [message], usage } },
    ];
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`${events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

/** The executables of this test's processes, by where they run from (their /proc exe, links resolved). */
async function running() {
  const exes = [];
  for (const pid of await descendants()) {
    try {
      exes.push(realpathSync(readlinkSync(`/proc/${pid}/exe`)));
    } catch {}
  }
  return exes;
}

/** A server whose data holds no Codex (`data`, else a fresh directory), its npm on `registry` and installing by its lock,
 *  its model the gateway, with an agent on codex. Codex's process is the stand-in, or with `real` the binary the install
 *  lands, whose processes the gateway records (`exes`) as each request comes. */
async function codexServe(t, registry, { data, npm = {}, agentToo = true, real = false } = {}) {
  const exes = [];
  const origin = await gateway(t, real ? async () => void exes.push(...(await running())) : undefined);
  const saved = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });
  for (const name of ["AGENTRUN_CODEX_STANDIN", "AGENTRUN_SERVE_CODEX_STANDIN", "CODEX_BIN"]) delete process.env[name];
  if (!real) {
    const standIn = join(await scratch(t), "codex-stand-in.mjs");
    await copyStandIn(standIn);
    Object.assign(process.env, { AGENTRUN_CODEX_STANDIN: "1", AGENTRUN_SERVE_CODEX_STANDIN: JSON.stringify({ command: process.execPath, args: [standIn], env: { FAKE_CODEX_MODEL: "remote" } }) });
  }
  Object.assign(process.env, { AGENT_MODEL_BASE_URL: origin, AGENT_MODEL: "gpt-test", AGENT_MODEL_API_KEY: GATEWAY_KEY, AGENT_MODEL_PRICE: "1,2,0.5" });
  await npmOn(t, registry, npm);
  const served = await serve(t, { faux: undefined, harnesses: false, harnessLocks: { codex: registry.lock }, ...(data ? { data } : {}) });
  if (agentToo) assert.equal((await served.api("POST", "/agents", agent("coder", { harness: "codex" }))).status, 201);
  return { ...served, exes };
}

/** The run that installed Codex ran the binary it installed, after its check: the process that asked the model runs from
 *  the data's tree, that file is the pin's sha256, and no Codex from beside the server ran. */
async function ranInstalled(api, runId, data, exes) {
  const installed = binaryIn(data);
  assert.equal(createHash("sha256").update(readFileSync(installed)).digest("hex"), CODEX_BINARY_SHA256[TARGET.target], "the installed binary is the pinned build");
  assert.ok(exes.includes(realpathSync(installed)), `the process that asked the model runs ${installed}: ${JSON.stringify([...new Set(exes)])}`);
  assert.ok(!exes.includes(realpathSync(found.path)), "never the Codex beside the server");
  assert.equal((await api("GET", `/runs/${runId}`)).body.result?.final_answer, "Codex answered.", "the answer came through that process");
}

const registryFor = (t, binary = STUB) => fakeNpmRegistry(t, packagesWith(binary), { [CODEX]: PIN });
const pinnedBinary = () => ({ link: found.path });

test("AgentRun ships Codex's install lock: the launcher at the pin, its platform packages, every package by sha512", () => {
  const file = new URL("../harnesses/codex/package-lock.json", import.meta.url);
  assert.ok(existsSync(file), "serve ships harnesses/codex/package-lock.json");
  const lock = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(lock.lockfileVersion, 3);
  assert.deepEqual(lock.packages[""].dependencies, { [CODEX]: CODEX_VERSION }, "the root names Codex at the pin, and nothing else");
  assert.deepEqual(JSON.parse(readFileSync(new URL("../harnesses/codex/package.json", import.meta.url), "utf8")).dependencies, { [CODEX]: CODEX_VERSION });
  assert.equal(lock.packages[`node_modules/${CODEX}`].version, CODEX_VERSION);
  if (PLATFORM) assert.equal(lock.packages[`node_modules/${PLATFORM}`]?.version, `${CODEX_VERSION}-${TARGET.pkg}`, "this platform's binary package");
  assert.deepEqual(Object.entries(lock.packages).filter(([path, entry]) => path && !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity ?? "")).map(([path]) => path), [], "every package by its sha512");
});

test("the first codex run installs exactly 0.164.0, with this platform's binary, into <data>/harnesses/codex, and runs that binary once it is in", { timeout: 300_000, skip: skipReal }, async (t) => {
  assert.equal(CODEX_VERSION, PIN);
  const registry = await registryFor(t, pinnedBinary());
  const { api, data, exes } = await codexServe(t, registry, { real: true });
  const run = await api("POST", "/agents/coder/runs", { input: { content: "Say what you did." } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const { rows, last } = await follow(api, run.body.run_id, ["completed", "failed"], { deadlineMs: 240_000 });
  assert.equal(installedIn(data), PIN, "Codex is installed in <data>/harnesses/codex, at the pin, not the registry's latest");
  assert.ok(existsSync(binaryIn(data)), "with this platform's binary");
  assert.equal(last.status, "completed", JSON.stringify(rows.slice(-3)));
  await ranInstalled(api, run.body.run_id, data, exes);
  assert.equal(registry.tarballs(CODEX).filter((hit) => hit.includes(`/${PIN}.tgz`)).length, 1, "the launcher fetched once");
});

test("a second codex run doesn't reinstall: on the same data, after a restart, no registry request", { timeout: 300_000, skip }, async (t) => {
  const registry = await registryFor(t);
  const data = join(await scratch(t), "agents");
  const first = await codexServe(t, registry, { data });
  const run = await first.api("POST", "/agents/coder/runs", { input: { content: "Say what you did." } });
  assert.equal((await follow(first.api, run.body.run_id, ["completed", "failed"], { deadlineMs: 240_000 })).last.status, "completed");
  assert.equal(installedIn(data), PIN, "the first run installed Codex");
  await first.close();
  const asked = registry.hits.length;
  const second = await serve(t, { faux: undefined, harnesses: false, harnessLocks: { codex: registry.lock }, data });
  t.after(() => second.close());
  const again = await second.api("POST", "/agents/coder/runs", { input: { content: "Say what you did again." } });
  assert.equal((await follow(second.api, again.body.run_id, ["completed", "failed"], { deadlineMs: 120_000 })).last.status, "completed");
  assert.deepEqual(registry.hits.slice(asked).filter((hit) => hit !== "/"), [], "no registry request for the second run");
  await second.close();
});

test("a person's npm config that omits optional packages still installs Codex's platform binary, and the run runs it", { timeout: 300_000, skip: skipReal }, async (t) => {
  const registry = await registryFor(t, pinnedBinary());
  const { api, data, exes } = await codexServe(t, registry, { npm: { omit: "optional" }, real: true });
  const run = await api("POST", "/agents/coder/runs", { input: { content: "Say what you did." } });
  const { rows, last } = await follow(api, run.body.run_id, ["completed", "failed"], { deadlineMs: 240_000 });
  assert.ok(existsSync(binaryIn(data)), "the binary's optional package is installed");
  assert.equal(last.status, "completed", JSON.stringify(rows.slice(-3)));
  await ranInstalled(api, run.body.run_id, data, exes);
});

test("capabilities say codex installs on first use until it is installed, and the waiting run reads that it installs", { timeout: 300_000, skip }, async (t) => {
  const registry = await registryFor(t);
  registry.hold(CODEX);
  const { api } = await codexServe(t, registry);
  const offer = async () => (await api("GET", "/capabilities")).body.harnesses.find((h) => h.id === "codex");
  const before = await offer();
  assert.equal(before.installs, "on_first_use", JSON.stringify(before));
  assert.equal(before.available, true, JSON.stringify(before));
  const run = await api("POST", "/agents/coder/runs", { input: { content: "Say what you did." } });
  await until("the run reads that it installs Codex", async () => (await api("GET", `/runs/${run.body.run_id}/timeline`)).body.rows?.some((r) => r.kind === "phase" && r.summary === INSTALLING), 60_000);
  registry.release(CODEX);
  assert.equal((await follow(api, run.body.run_id, ["completed", "failed"], { deadlineMs: 240_000 })).last.status, "completed");
  const after = await until("capabilities no longer say it installs", async () => ((await offer()).installs === undefined ? offer() : undefined), 30_000);
  assert.equal(after.available, true);
});
