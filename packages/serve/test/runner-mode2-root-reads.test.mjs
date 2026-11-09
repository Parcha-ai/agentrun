// A Mode 2 run's spec reads the run's own files through the run's Workspace, on its Archil disk, and never touches a
// folder of this machine. Both spec builders, pi's (adapter-run-spec.ts adapterRunSpecFromLaunch) and the CLI
// harnesses' (cli-run-spec.ts cliRunSpecFromLaunch), are built for a claimed run with the server's Archil settings
// saved, over the Archil fake. The run's folder on the disk holds the real files; the run's local folder path holds
// decoys:
//   - the first message's file manifest (firstMessage) lists the run's inputs/ on the disk;
//   - the gate's file checks (runGate) read the turn's origin, turn-origin.json, on the disk: a reflect turn's write under
//     .learning/ is refused;
//   - and nothing at all is read under the run's local folder path while the spec is built and used: every node:fs read
//     is watched (its CommonJS functions wrapped, then synced into the ESM bindings every module imported), so any lingering
//     local read fails the test, whoever makes it. (What the agent learned goes to the launch, read with no folder, so it
//     is not asserted here: it is one of those reads until it moves.)
// The run's mount credential is minted per run at Archil's control plane, lazily (the lead's ruling): a run with no
// computer makes no control call at all; a computer that mounts the folder mints one at the claim, and it is removed at
// the run's end. The control plane is ws-c3's fake as a fetch function (archil-control-fake.mjs archilControlFetch: no port, so
// it sees every request the claim makes and nothing else), given through the spec's mountControl; any other fetch to a
// host other than this machine's loopback fails the test, so none reaches Archil.
import assert from "node:assert/strict";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";

const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { cliRunSpecFromLaunch } = await import("../dist/runner/cli-run-spec.js");
const { runFolder, runKey } = await import("../dist/workspace/paths.js");
const { saveArchilSettings } = await import("../dist/archil-settings.js");
const { ARCHIL_API_KEY_ROW } = await import("../dist/workspace/index.js");
const { sealColumn, sealedAt } = await import("../dist/store/seal.js");
const { OPENCODE_STANDIN_ENV } = await import("../dist/adapters.js");
const { NOTE_ONLY_TEXT } = await import("../dist/tool-gate.js");
const { FakeArchilDisk } = await import("./fixtures/archil-fake.mjs");
const { archilControlFetch } = await import("./archil-control-fake.mjs");

process.env.AGENTRUN_OPENCODE_STANDIN = "1";
const STAND_IN = new URL("./fixtures/fake-opencode-serve.mjs", import.meta.url).pathname;
const SEAL_KEY = Buffer.alloc(32, 7);
const RUN = "run-1";
const AGENT = "agent-1";
const ARCHIL_SETTINGS = { diskId: "dsk-0000000000000001", region: "aws-us-east-1", s3Url: "https://s3.green.us-east-1.aws.prod.archil.com" };
const KEY = runKey(AGENT, RUN);
const stubRoute = async () => ({ model: "faux-1", provider: { api: "anthropic-messages", origin: "https://route.invalid", credential: () => "not-a-secret" } });

/** Every node:fs read under `folder`, recorded while the watch is on: the CommonJS fs and fs.promises functions that read
 *  a path are wrapped, then synced into the ESM bindings (syncBuiltinESMExports), so a module's own `import { readFile }`
 *  is watched too. `off()` puts them back. */
function watchReads(folder) {
  const require = createRequire(import.meta.url);
  const fs = require("node:fs");
  const under = (path) => typeof path === "string" && (resolve(path) === folder || resolve(path).startsWith(`${folder}/`));
  const seen = [];
  const kept = [];
  const wrap = (owner, name, label) => {
    const original = owner[name];
    if (typeof original !== "function") return;
    kept.push([owner, name, original]);
    owner[name] = function watched(path, ...rest) {
      if (under(typeof path === "string" ? path : path?.toString?.())) seen.push(`${label}(${path})`);
      return original.call(this, path, ...rest);
    };
  };
  for (const name of ["readFileSync", "readdirSync", "statSync", "lstatSync", "existsSync", "openSync", "accessSync", "realpathSync", "readlinkSync", "createReadStream"]) wrap(fs, name, `fs.${name}`);
  for (const name of ["readFile", "readdir", "stat", "lstat", "open", "access", "realpath", "readlink", "opendir"]) wrap(fs.promises, name, `fs.promises.${name}`);
  syncBuiltinESMExports();
  return {
    seen,
    off() {
      for (const [owner, name, original] of kept.reverse()) owner[name] = original;
      syncBuiltinESMExports();
    },
  };
}

/** Every fetch to a host other than this machine's loopback, refused and recorded while the guard is on: no test here may
 *  reach Archil's control plane (or anything else). `off()` puts fetch back. */
function guardFetch() {
  const original = globalThis.fetch;
  const outbound = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url ?? String(input));
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
      outbound.push(`${init?.method ?? "GET"} ${url.origin}${url.pathname}`);
      throw new Error(`a test reached ${url.origin}: no call leaves this machine`);
    }
    return original(input, init);
  };
  return { outbound, off: () => void (globalThis.fetch = original) };
}

/** A computer that mounts the run's folder, as a mounting provider's start does (resolve-computer.ts asks the folder's
 *  mount for the computer's spec), and lets the mount credential go at its release (computerForClaim's revokeMount). */
const mountingComputer = async (_launch, _store, given) => {
  await given.workspace.mountSpec();
  return { release: async () => void (await given.revokeMount?.()) };
};

/** A claimed run in Mode 2 over the Archil fake, the run's folder on the disk holding the real files and its local path the
 *  decoys, and `build`'s spec for its claim. `watch`: every read under the run's local folder path while the spec is built
 *  and used (`use`) is recorded. `computer`: the run's computerForClaim (none by default). The control plane is the
 *  fake as a fetch function (`control`: no port), and every other outbound fetch is refused (`outbound`). */
async function mode2Spec(t, { harness, build, watch = false, use = async () => {}, computer = async () => ({ release: async () => {} }) }) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-mode2-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  const control = archilControlFetch();
  const guard = guardFetch();
  let spec;
  let harnessRun;
  t.after(async () => {
    await spec?.release?.().catch(() => {});
    guard.off();
    await harnessRun?.close(ctx).catch(() => {});
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: AGENT, name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", ...(harness ? { harness } : {}), tools: ["read", "write"] } });
  const launch = { input: { content: "Do the thing." }, title: "t", place: { mode: "runner" }, ...(harness ? { harness, model: { provider: "openai", modelId: "gpt-5" } } : { model: { provider: "anthropic", modelId: "claude-sonnet-5.5" } }) };
  await server.runs.create({ id: RUN, agentId: AGENT, revisionId: "rev-1" }, { body: launch });
  // Mode 2: the server's Archil settings, and its account key sealed under the runner's seal key, as the server saves them.
  // No disk token is kept any more (places/computers): the mount credential is minted per run from the account key.
  await saveArchilSettings(server, ARCHIL_SETTINGS);
  await server.sealedKeys.put(ARCHIL_API_KEY_ROW, sealColumn(SEAL_KEY, sealedAt.sealedKey(ARCHIL_API_KEY_ROW), "fake-test-key-api-0001"));
  await server.flush?.();

  // The run's files on the disk: an input, and a reflect turn's origin.
  const disk = new FakeArchilDisk();
  disk.files.set(`${KEY}/inputs/from-disk.txt`, Buffer.from("on the disk"));
  disk.files.set(`${KEY}/turn-origin.json`, Buffer.from(JSON.stringify({ origin: "reflect" })));
  // Decoys at the run's folder path on this machine, which a Mode 2 run never reads.
  const local = runFolder(dir, AGENT, RUN);
  mkdirSync(join(local, "inputs"), { recursive: true });
  writeFileSync(join(local, "inputs", "decoy.txt"), "on this machine");
  writeFileSync(join(local, "turn-origin.json"), JSON.stringify({ origin: "person" }));

  const [claim] = await store.runs.claimMany("runner-a", 1, { leaseMs: 60_000 });
  const registry = createRegistry();
  let models = createModels();
  harnessRun = await Harness.open(store.journal(claim), { models: () => models, registry, onReport: () => {} }, ctx);
  const env = { AGENT_MODEL_BASE_URL: "http://127.0.0.1:9", AGENT_MODEL_API_KEY: `not-a-secret-${"gateway"}`, [OPENCODE_STANDIN_ENV]: JSON.stringify({ command: process.execPath, args: [STAND_IN] }) };
  const deps = {
    env, data: dir, journal: (c) => store.journal(c), store, sealKey: SEAL_KEY, routeOf: stubRoute,
    // The run's Archil disk is the fake (Mode 2's disk, for both builders), and its control plane the fake's fetch.
    makeArchilDisk: () => disk,
    mountControl: { baseUrl: control.baseUrl, fetch: control.fetch },
    computerForClaim: computer,
  };
  // The run's whole local folder path, the run's directory above its work folder included.
  const watcher = watch ? watchReads(resolve(local, "..")) : undefined;
  try {
    spec = await build(launch, { harness: harnessRun, registry, setModels: (given) => (models = given) }, deps, claim);
    await use(spec);
  } finally {
    watcher?.off();
  }
  return { spec, disk, control, outbound: guard.outbound, localReads: watcher?.seen ?? [] };
}

/** Every request the control plane saw (the fake is a function the claim alone holds, so each is the claim's), as method
 *  and path (the disk's id kept). */
const callsOf = (control) => control.requests.map((request) => `${request.method} ${request.path}${request.query.identifier ? `?identifier=${request.query.identifier}` : ""}`);

/** The disk's reads of `key`: a get of the file, or a listing of the folder. */
const readsOf = (disk, key) => disk.calls.filter((call) => (call.key ?? call.prefix ?? call.directory ?? "").startsWith(key));
/** A reflect turn's write under .learning/, as the adapter loop asks the spec's gate about it. */
const reflectWrite = { callId: "c1", tool: "write", args: { path: ".learning/notes.md", content: "kept" } };

for (const [name, harness, build] of [["pi's spec", undefined, adapterRunSpecFromLaunch], ["the CLI spec (opencode)", "opencode", cliRunSpecFromLaunch]]) {
  test(`${name} in Mode 2: the first message names the run's inputs on its disk, never the local folder's`, async (t) => {
    const { spec, disk } = await mode2Spec(t, { harness, build });
    assert.ok(spec.input.includes("from-disk.txt"), `the manifest names the disk's input: ${spec.input}`);
    assert.ok(!spec.input.includes("decoy.txt"), "nothing from the local folder's inputs/");
    assert.ok(readsOf(disk, `${KEY}/inputs`).length > 0, "inputs/ was listed on the disk, under the run's key");
  });

  test(`${name} in Mode 2: the gate's turn-origin check reads the disk: a reflect turn's write under .learning/ is refused`, async (t) => {
    const { spec, disk } = await mode2Spec(t, { harness, build });
    // The gate's own refusal of a reflect turn's write under .learning/: the one text the model reads (NOTE_ONLY_TEXT).
    assert.equal((await spec.gate(reflectWrite))?.deny, NOTE_ONLY_TEXT, "the disk says the turn is the end-of-run reflect turn, whose writes under .learning/ are refused in the note-only words");
    assert.ok(readsOf(disk, `${KEY}/turn-origin.json`).length > 0, "the turn's origin was read on the disk, under the run's key");
  });

  test(`${name} in Mode 2: nothing is read under the run's local folder path while its spec is built and used`, async (t) => {
    const { localReads } = await mode2Spec(t, { harness, build, watch: true, use: async (spec) => void (await spec.gate(reflectWrite)) });
    assert.deepEqual(localReads, [], `local reads in Mode 2:\n${localReads.join("\n")}`);
  });

  test(`${name} in Mode 2 with no computer: the run's mount credential is never minted, so Archil's control plane hears nothing, from its build to its end`, async (t) => {
    const { spec, control, outbound } = await mode2Spec(t, { harness, build, use: async (built) => void (await built.gate(reflectWrite)) });
    await spec.release();
    assert.deepEqual(callsOf(control), [], "no list, no mint, no remove");
    assert.deepEqual(outbound, [], "and nothing left this machine");
  });

  test(`${name} in Mode 2 with a computer that mounts the folder: one mount credential minted at the claim, named for the run and its epoch, and removed at the run's end`, async (t) => {
    const { spec, control, outbound } = await mode2Spec(t, { harness, build, computer: mountingComputer });
    const disk = `/api/disks/${ARCHIL_SETTINGS.diskId}`;
    assert.deepEqual(callsOf(control), [`GET ${disk}`, `POST ${disk}/users`], "an earlier claim's credentials looked for, then one minted");
    assert.equal(control.requests[1].authorization, "Bearer fake-test-key-api-0001", "minted with the account key");
    assert.match(control.requests[1].body?.nickname ?? "", new RegExp(RUN), "named for the run");
    assert.equal(control.requests[1].body?.ttl, "604800s", "its safety-net lifetime, MOUNT_TTL_MS (7 days), in case the removal never comes");
    await spec.release();
    assert.deepEqual(callsOf(control).slice(2), [`DELETE ${disk}/users/token?identifier=tok-1`, `GET ${disk}`], "removed once at the end (the computer's release and the run's end revoke it, idempotently), then the run's earlier epochs looked for");
    assert.deepEqual(outbound, [], "nothing left this machine");
  });
}
