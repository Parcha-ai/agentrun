import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, utimesSync, writeFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { cli, scratch, server } from "./support.mjs";
import { deployCapturedSetup as runCaptured, deployConnected, localSetup as runLocal } from "../lib/deploy-local.mjs";

const BASE = "https://console.example/v2";
const OWNER = "owner-credential-never-print";
const ENROLL = "enrollment-credential-never-print";
const CONNECTOR = "connector-credential-never-print";
const NOW = Date.parse("2026-01-01T00:00:00Z");
const MINUTE = 60_000, DAY = 24 * 60 * MINUTE;
const deployCapturedSetup = (ctx, source, target, options) => runCaptured(ctx, source, target, { now: () => NOW, ...options });
const localSetup = (ctx, options) => runLocal(ctx, { now: () => NOW, ...options });
const snapshot = (digest = "a".repeat(64)) => ({ version: 1, digest, complete: true,
  source: { runtime: "codex", machine_id: "machine", project: "/projects/example", selector: { kind: "project" } },
  entries: [{ path: "project/main.ts", type: "file", bytes: 4 }], blobs: {}, skills: [{ name: "test" }],
  configuration: { tools: [] }, blockers: [] });
const captured = (digest) => ({ snapshot: snapshot(digest), target: { ...snapshot().source, skills: ["test"], capabilities: { launch: true } } });
const fail = (code, message) => Object.assign(new Error(message), { code });
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "agentrun-local-deploy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let out = "", err = "";
  const ctx = { values: { yes: true }, args: [], env: { HOME: dir, XDG_CONFIG_HOME: join(dir, ".config") },
    io: { stdin: { isTTY: false }, stdout: { write: x => out += x }, stderr: { write: x => err += x } },
    cli: { fail, alive: pid => { try { process.kill(pid, 0); return true; } catch { return false; } }, privateFile: file => { try { return readFileSync(file, "utf8"); } catch (e) { if (e.code !== "ENOENT") throw e; } } } };
  return { dir, ctx, output: () => ({ out, err }), clear: () => { out = ""; err = ""; } };
}
function destination({ loseUpload = false, loseRegistration = false, blocker = false, capability = { version: 1, runtimes: ["claude-code", "codex", "pi"] }, staleCurrent = false, clock = { now: NOW } } = {}) {
  const seen = [], state = { generation: "generation", sequence: -1, enabled: true, agent_id: "remote-existing", source: snapshot().source };
  let moved = false, uploaded = false, registered = false;
  const call = async (path, init = {}) => {
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    seen.push({ path: new URL(path).pathname, method: init.method, body, auth: new Headers(init.headers).get("authorization") });
    const route = new URL(path).pathname.slice(3);
    let value;
    if (route === "/capabilities") value = { source_deployment: capability };
    else if (route === "/connectors/enrollment") value = { enrollment_token: `${ENROLL}-${clock.now}`, expires_at: new Date(clock.now + 10 * MINUTE).toISOString() };
    else if (route === "/connectors") {
      if (loseRegistration && !registered) { registered = true; throw new Error("connection reset"); }
      value = { connector: { id: "connector", capabilities: { observe: true, native_execution: false, history_import: false, config_sync: true } }, credential: `${CONNECTOR}-${clock.now}`, credential_expires_at: new Date(clock.now + 30 * DAY).toISOString() };
    }
    else if (route.endsWith("/import")) value = { agent_id: "remote-existing" };
    else if (route.endsWith("/sync/grant")) value = state;
    else if (route.endsWith("/sync")) {
      if (state.sequence === body.sequence) assert.equal(state.attempt.digest, body.snapshot.digest);
      Object.assign(state, { sequence: body.sequence, snapshot: body.snapshot.digest, attempt: { digest: body.snapshot.digest, blockers: [] } });
      if (loseUpload && !uploaded) { uploaded = true; throw new Error("connection reset"); }
      value = state;
    } else if (route.endsWith("/source/move")) { moved = true; value = { source: { moved: true }, agent: { agent_id: state.agent_id } }; }
    else if (route.endsWith("/source")) value = { enabled: true, moved, state: blocker ? "needs_attention" : moved ? "moved" : "ready", snapshot: state.snapshot, current_snapshot: moved ? staleCurrent ? "b".repeat(64) : state.snapshot : undefined, blockers: blocker ? [{ code: "model", message: "Choose a destination model." }] : [] };
    else if (route === "/agents/remote-existing") value = { agent_id: "remote-existing", console_url: "https://console.example/#/agents/remote-existing", revision: "revision" };
    else throw Error("Unexpected request " + route);
    return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetch: call, seen, state };
}
const target = { base: BASE, token: OWNER };

test("connect then deploy keeps its identity, source assets, least-privilege grant and private credential journal", async t => {
  const local = setup(t), peer = destination();
  assert.equal(await deployCapturedSetup(local.ctx, captured(), target, { fetch: peer.fetch, connectOnly: true }), 0);
  assert.equal(JSON.parse(local.output().out).status, "connected");
  assert.equal(peer.seen.some(x => x.path.endsWith("/move")), false);
  const sent = peer.seen.find(x => x.path.endsWith("/sync")).body.snapshot;
  assert.deepEqual(sent, snapshot());
  const enrolled = peer.seen.find(x => x.path.endsWith("/enrollment")).body.capabilities;
  assert.deepEqual(enrolled, { native_execution: false, history_import: false, config_sync: true });
  const journalRoot = join(local.dir, ".config/agentrun/deployments");
  const orphanedHold = join(journalRoot, readdirSync(journalRoot)[0], "held");
  mkdirSync(orphanedHold, { mode: 0o700 });
  utimesSync(orphanedHold, new Date(0), new Date(0));
  local.clear();
  assert.equal(await deployCapturedSetup(local.ctx, captured(), target, { fetch: peer.fetch }), 0);
  assert.deepEqual(JSON.parse(local.output().out).agent_id, "remote-existing");
  assert.equal(peer.seen.filter(x => x.path.endsWith("/import")).length, 1);
  assert.deepEqual(peer.seen.find(x => x.path.endsWith("/move")).body, { snapshot: snapshot().digest });
  assert.equal(peer.seen.filter(x => x.path.endsWith("/sync")).length, 1);
  assert.equal(JSON.parse(local.output().out).console_url, "https://console.example/#/agents/remote-existing");
  const root = join(local.dir, ".config", "agentrun", "deployments");
  const held = join(root, readdirSync(root)[0]);
  assert.equal(statSync(held).mode & 0o777, 0o700);
  assert.equal(statSync(join(held, "state.json")).mode & 0o777, 0o600);
  for (const secret of [OWNER, ENROLL, CONNECTOR]) assert.equal((local.output().out + local.output().err).includes(secret), false);
});

test("lost registration or upload response reuses its exact request and credential without a second agent", async t => {
  for (const boundary of ["registration", "upload"]) {
    const local = setup(t), peer = destination({ loseUpload: boundary === "upload", loseRegistration: boundary === "registration" });
    await assert.rejects(deployCapturedSetup(local.ctx, captured(), target, { fetch: peer.fetch }), e => e.code === 1);
    local.clear();
    assert.equal(await deployCapturedSetup(local.ctx, captured(), target, { fetch: peer.fetch }), 0);
    const retries = peer.seen.filter(x => boundary === "upload" ? x.path.endsWith("/sync") : x.path === "/v2/connectors");
    assert.equal(retries.length, 2);
    assert.deepEqual(retries[0], retries[1]);
    assert.equal(peer.seen.filter(x => x.path.endsWith("/enrollment")).length, 1);
    assert.equal(peer.seen.filter(x => x.path.endsWith("/import")).length, 1);
  }
});

test("expired enrollment and connector credentials recover without changing agent identity or pending snapshot bytes", async t => {
  for (const boundary of ["registration", "upload"]) {
    const local = setup(t), clock = { now: NOW }, peer = destination({ clock, loseRegistration: boundary === "registration", loseUpload: boundary === "upload" });
    let loseRenewal = false;
    const options = { fetch: async (url, init) => {
      const response = await peer.fetch(url, init);
      if (loseRenewal && new URL(url).pathname === "/v2/connectors") { loseRenewal = false; throw new Error("connection reset"); }
      return response;
    }, now: () => clock.now };
    await assert.rejects(deployCapturedSetup(local.ctx, captured(), target, options), e => e.code === 1);
    const root = join(local.dir, ".config/agentrun/deployments"), journal = join(root, readdirSync(root)[0]);
    const before = JSON.parse(readFileSync(join(journal, "state.json"), "utf8"));
    assert.equal(before[boundary === "registration" ? "enrollment_expires_at" : "credential_expires_at"], new Date(NOW + (boundary === "registration" ? 10 * MINUTE : 30 * DAY)).toISOString());
    clock.now += boundary === "registration" ? 11 * MINUTE : 31 * DAY;
    if (boundary === "upload") {
      loseRenewal = true;
      await assert.rejects(deployCapturedSetup(local.ctx, captured(), target, options), e => e.code === 1);
    }
    assert.equal(await deployCapturedSetup(local.ctx, captured(), target, options), 0);
    const after = JSON.parse(readFileSync(join(journal, "state.json"), "utf8"));
    assert.equal(after.installation_id, before.installation_id);
    assert.equal(after.target_id, before.target_id);
    assert.equal(after.agent_id, "remote-existing");
    assert.equal(after.connector_id, "connector");
    assert.equal(after.credential_expires_at, new Date(clock.now + 30 * DAY).toISOString());
    assert.equal(after.enrollment_token, undefined);
    const enrollments = peer.seen.filter(x => x.path.endsWith("/enrollment"));
    assert.equal(enrollments.length, 2);
    assert.equal(enrollments[1].body.connector_id, boundary === "upload" ? before.connector_id : undefined);
    assert.equal(peer.seen.filter(x => x.path.endsWith("/import")).length, 1);
    const registrations = peer.seen.filter(x => x.path === "/v2/connectors");
    assert.equal(registrations[0].body.installation_id, registrations[1].body.installation_id);
    assert.notEqual(registrations[0].body.operation_id, registrations[1].body.operation_id);
    if (boundary === "upload") {
      assert.equal(registrations.length, 3);
      assert.deepEqual(registrations[1], registrations[2]);
      const uploads = peer.seen.filter(x => x.path.endsWith("/sync"));
      assert.equal(uploads.length, 2);
      assert.deepEqual(uploads[0].body, uploads[1].body);
      assert.notEqual(uploads[0].auth, uploads[1].auth);
    }
  }
});

test("a rejected unexpired credential preserves the connection and pending snapshot instead of renewing authorization", async t => {
  const local = setup(t), peer = destination({ loseUpload: true });
  await assert.rejects(deployCapturedSetup(local.ctx, captured(), target, { fetch: peer.fetch }), e => e.code === 1);
  const root = join(local.dir, ".config/agentrun/deployments"), journal = join(root, readdirSync(root)[0]);
  const pending = readFileSync(join(journal, "pending.json"), "utf8"), saved = readFileSync(join(journal, "state.json"), "utf8");
  await assert.rejects(deployCapturedSetup(local.ctx, captured(), target, { fetch: async (url, init) => {
    if (new URL(url).pathname.endsWith("/sync/grant")) return Response.json({ error: { code: "unauthorized", message: "Credential revoked." } }, { status: 401 });
    return peer.fetch(url, init);
  } }), e => e.code === 4 && /revoked or replaced/.test(e.message));
  assert.equal(peer.seen.filter(x => x.path.endsWith("/enrollment")).length, 1);
  assert.equal(readFileSync(join(journal, "state.json"), "utf8"), saved);
  assert.equal(readFileSync(join(journal, "pending.json"), "utf8"), pending);
});

test("paused journal publication and release cannot interfere with a competing command's ownership", async t => {
  for (const phase of ["publish", "release"]) {
    const local = setup(t), peer = destination();
    await deployCapturedSetup(local.ctx, captured(), target, { fetch: peer.fetch, connectOnly: true });
    const gate = new Int32Array(new SharedArrayBuffer(4));
    const worker = new Worker(`
      const fs = require("node:fs"), { basename, dirname } = require("node:path");
      const { parentPort, workerData } = require("node:worker_threads");
      const mkdir = fs.mkdirSync, rm = fs.rmSync, gate = new Int32Array(workerData.gate);
      const pause = () => { parentPort.postMessage({ paused: true }); Atomics.wait(gate, 0, 0); };
      fs.mkdirSync = function(path, ...args) {
        const result = mkdir(path, ...args), name = basename(path);
        if (workerData.phase === "publish" && (name === "held" || name.startsWith(".hold-"))) {
          fs.utimesSync(path, new Date(0), new Date(0));
          pause();
        }
        return result;
      };
      fs.rmSync = function(path, ...args) {
        const result = rm(path, ...args);
        if (workerData.phase === "release" && basename(dirname(path)) === "held" && basename(path).endsWith(".json")) pause();
        return result;
      };
      require("node:module").syncBuiltinESMExports();
      (async () => {
        const { deployCapturedSetup } = await import(workerData.module);
        let requests = 0;
        const ctx = { values: { yes: true }, env: workerData.env,
          io: { stdin: { isTTY: false }, stdout: { write() {} }, stderr: { write() {} } },
          cli: { fail: (code, message) => Object.assign(new Error(message), { code }), alive: () => true,
            privateFile: path => fs.readFileSync(path, "utf8") } };
        try {
          await deployCapturedSetup(ctx, workerData.captured, workerData.target, { connectOnly: true, now: () => workerData.now,
            fetch: async () => {
              const response = workerData.responses[requests++];
              if (!response) throw new Error("Unexpected network request");
              return Response.json(response);
            } });
          parentPort.postMessage({ code: 0, requests });
        } catch (error) { parentPort.postMessage({ code: error.code, requests }); }
      })().catch(error => { throw error; });
    `, { eval: true, workerData: { gate: gate.buffer, module: new URL("../lib/deploy-local.mjs", import.meta.url).href,
      env: local.ctx.env, captured: captured(), target, now: NOW, phase,
      responses: phase === "publish" ? [] : [peer.state, { state: "ready", snapshot: snapshot().digest, blockers: [] }, { agent_id: "remote-existing" }] } });
    t.after(() => worker.terminate());
    assert.deepEqual((await once(worker, "message"))[0], { paused: true });
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    const competing = deployCapturedSetup(local.ctx, captured(), target, { connectOnly: true, fetch: async (url, init) => {
      entered.resolve(); await release.promise; return peer.fetch(url, init);
    } });
    competing.catch(entered.reject);
    try {
      await entered.promise;
      const result = once(worker, "message");
      Atomics.store(gate, 0, 1); Atomics.notify(gate, 0);
      assert.deepEqual((await result)[0], phase === "publish" ? { code: 2, requests: 0 } : { code: 0, requests: 3 });
      const root = join(local.dir, ".config/agentrun/deployments");
      assert.equal(readdirSync(join(root, readdirSync(root)[0], "held")).length, 1);
    } finally { release.resolve(); await competing; }
  }
});

test("source blockers, destination blockers and missing confirmation never cut over", async t => {
  for (const kind of ["source", "destination", "confirmation"]) {
    const local = setup(t), peer = destination({ blocker: kind === "destination" }), source = captured();
    if (kind === "source") { source.snapshot.complete = false; source.snapshot.blockers = [{ code: "extension", message: "The extension needs an adapter." }]; }
    if (kind === "confirmation") local.ctx.values.yes = false;
    assert.equal(await deployCapturedSetup(local.ctx, source, target, { fetch: peer.fetch }), kind === "confirmation" ? 2 : 3);
    assert.equal(peer.seen.some(x => x.path.endsWith("/move")), false);
    if (kind !== "destination") assert.equal(peer.seen.length, 0);
  }
});

test("deploying an already connected agent moves that exact identity without enrollment or import", async t => {
  const local = setup(t), peer = destination();
  peer.state.snapshot = snapshot().digest;
  assert.equal(await deployConnected(local.ctx, "remote-existing", target, { fetch: peer.fetch }), 0);
  assert.equal(JSON.parse(local.output().out).agent_id, "remote-existing");
  assert.equal(peer.seen.some(x => x.path.includes("connectors")), false);
});

test("a missing or incompatible destination capability refuses before reading the local setup", async t => {
  for (const capability of [undefined, false, { version: 1, runtimes: ["codex"] }]) {
    const local = setup(t), peer = destination({ capability: capability ?? null });
    local.ctx.values = { from: "pi", to: "cloud", yes: true };
    local.ctx.args = ["/projects/example"];
    local.ctx.cli.targetOf = () => target;
    local.ctx.cli.baseOf = value => value;
    let captures = 0;
    await assert.rejects(localSetup(local.ctx, { fetch: peer.fetch, capture: () => { captures++; return captured(); } }), e => e.code === 5);
    assert.equal(captures, 0);
    assert.deepEqual(peer.seen.map(x => [x.method, x.path]), [["GET", "/v2/capabilities"]]);
  }
});

test("a changed source grant retains pending bytes, and a different serving snapshot is never reported deployed", async t => {
  const local = setup(t), peer = destination({ loseUpload: true });
  await assert.rejects(deployCapturedSetup(local.ctx, captured(), target, { fetch: peer.fetch }), e => e.code === 1);
  peer.state.generation = "another-generation";
  await assert.rejects(deployCapturedSetup(local.ctx, captured(), target, { fetch: peer.fetch }), e => e.code === 2);
  assert.equal(peer.seen.filter(x => x.path.endsWith("/sync")).length, 1);
  assert.equal(peer.seen.some(x => x.path.endsWith("/move")), false);
  const stale = setup(t), stalePeer = destination({ staleCurrent: true });
  await assert.rejects(deployCapturedSetup(stale.ctx, captured(), target, { fetch: stalePeer.fetch }), e => e.code === 1);
  assert.equal(stale.output().out, "");
});

test("a dashboard workspace mismatch refuses export, and separate authenticated workspaces never reuse a source connection", async t => {
  const local = setup(t), capability = { version: 1, runtimes: ["codex"], workspace_id: "team:first" };
  local.ctx.values = { from: "codex", workspace: "team:second", yes: true };
  local.ctx.args = ["/projects/example"];
  local.ctx.cli.targetOf = () => target;
  let captures = 0;
  const first = destination({ capability });
  await assert.rejects(localSetup(local.ctx, { fetch: first.fetch, capture: () => { captures++; return captured(); } }), e => e.code === 4);
  assert.equal(captures, 0);
  assert.deepEqual(first.seen.map(x => x.path), ["/v2/capabilities"]);
  delete local.ctx.values.workspace;
  for (const workspace of ["team:first", "team:second"]) {
    const peer = destination({ capability: { ...capability, workspace_id: workspace } });
    assert.equal(await localSetup(local.ctx, { fetch: peer.fetch, capture: () => captured() }), 0);
    assert.equal(peer.seen.filter(x => x.path.endsWith("/enrollment")).length, 1);
  }
  const root = join(local.dir, ".config/agentrun/deployments");
  const states = readdirSync(root).map(id => JSON.parse(readFileSync(join(root, id, "state.json"), "utf8")));
  assert.deepEqual(states.map(x => x.workspace).sort(), ["team:first", "team:second"]);
  assert.notEqual(states[0].installation_id, states[1].installation_id);
});


test("the CLI uploads a real Pi project and skill assets to a real server while destination blockers keep it pending", async t => {
  const { dir, env } = scratch("deploy-source");
  const destination = await server(t, { data: join(dir, "destination"), env });
  const home = join(dir, "source-home"), project = join(dir, "project"), bin = join(dir, "bin");
  for (const path of [join(home, ".pi/agent"), join(project, ".agents/skills/check"), bin]) mkdirSync(path, { recursive: true });
  writeFileSync(join(bin, "pi"), '#!/bin/sh\nprintf "1.5.2\\n"\n', { mode: 0o755 });
  writeFileSync(join(home, ".pi/agent/settings.json"), JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-5.5", defaultProjectTrust: "always" }));
  writeFileSync(join(project, "AGENTS.md"), "Read reference.txt before answering.");
  writeFileSync(join(project, "reference.txt"), "Source project asset.");
  writeFileSync(join(project, ".agents/skills/check/SKILL.md"), "---\nname: check\ndescription: Read the reference.\n---\nRead references.txt.");
  writeFileSync(join(project, ".agents/skills/check/references.txt"), "Whole skill asset.");
  const sourceEnv = { ...env, HOME: home, PI_CODING_AGENT_DIR: join(home, ".pi/agent"), PATH: `${bin}:${env.PATH}`, AGENTRUN_API_KEY: destination.token };
  const args = ["deploy", project, "--from", "pi", "--to", destination.base, "--yes"];
  const preview = await cli(sourceEnv, [...args, "--dry-run"]);
  assert.equal(preview.code, 0, preview.err);
  assert.equal(preview.json().skills, 1);
  assert.ok(preview.json().files >= 4);
  const first = await cli(sourceEnv, args);
  assert.equal(first.code, 3, first.err);
  assert.equal(first.json().status, "needs_attention");
  assert.ok(first.json().agent_id);
  const status = await destination.api("GET", `/agents/${first.json().agent_id}/source`);
  assert.equal(status.body.snapshot, preview.json().snapshot);
  assert.equal(status.body.moved, false);
  assert.equal(status.body.state, "needs_attention");
  assert.ok(status.body.blockers.length);
  const retry = await cli(sourceEnv, args);
  assert.equal(retry.code, 3, retry.err);
  assert.equal(retry.json().agent_id, first.json().agent_id);
  assert.equal(`${preview.out}${preview.err}${first.out}${first.err}${retry.out}${retry.err}`.includes(destination.token), false);
});
