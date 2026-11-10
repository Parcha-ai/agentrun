// A Mode 2 run's spec reads the run's own files through the run's Workspace, on its Archil disk, and never touches a
// folder of this machine. Both spec builders, pi's (adapter-run-spec.ts adapterRunSpecFromLaunch) and the CLI
// harnesses' (cli-run-spec.ts cliRunSpecFromLaunch), are built for a claimed run with the server's Archil settings
// saved, over the Archil fake. The run's folder on the disk holds the real files; the run's local folder path holds
// decoys:
//   - the first message's file manifest (firstMessage) lists the run's inputs/ on the disk;
//   - the gate's file checks (runGate) read the turn's origin, turn-origin.json, on the disk: a reflect turn's write under
//     .learning/ is refused;
//   - a monid answer too long for the model is filed in the run's evidence/monid/ on the disk, where the run's read finds
//     it, never in the local folder;
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
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
const { CLIP, MONID_KEY_ENV } = await import("../dist/monid.js");
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
 *  reach Archil's control plane (or anything else). `monid`: an answer monid's API gives every request, faked here, so a
 *  run's monid call never leaves this machine either. `off()` puts fetch back. */
function guardFetch(monid) {
  const original = globalThis.fetch;
  const outbound = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url ?? String(input));
    if (monid && url.hostname === "api.monid.ai") return new Response(JSON.stringify(monid), { status: 200, headers: { "content-type": "application/json" } });
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
 *  fake as a fetch function (`control`: no port), and every other outbound fetch is refused (`outbound`). `tools`: the
 *  revision's grant; `monid`: the answer monid's faked API gives (its key then in the runner's environment). `routeOf`: the
 *  run's model route (the stub by default). `fails`: the build is expected to throw, and its error is answered.
 *  `controlFetch`: the claim's fetch to the control fake, given the fake's own (a test that loses an answer wraps it).
 *  `existing`: token users the disk holds before the claim (another claim's, another run's). */
async function mode2Spec(t, { harness, build, watch = false, use = async () => {}, computer = async () => ({ release: async () => {} }), signal, phase, tools = ["read", "write"], monid, routeOf = stubRoute, fails = false, controlFetch = (fetch) => fetch, existing = [] }) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-mode2-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  const control = archilControlFetch({ existing });
  const guard = guardFetch(monid);
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
  await server.agents.create({ id: AGENT, name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", ...(harness ? { harness } : {}), tools } });
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
  const env = { AGENT_MODEL_BASE_URL: "http://127.0.0.1:9", AGENT_MODEL_API_KEY: `not-a-secret-${"gateway"}`, [OPENCODE_STANDIN_ENV]: JSON.stringify({ command: process.execPath, args: [STAND_IN] }), ...(monid ? { [MONID_KEY_ENV]: `not-a-secret-${"monid"}` } : {}) };
  const deps = {
    env, data: dir, journal: (c) => store.journal(c), store, sealKey: SEAL_KEY, routeOf,
    // The run's Archil disk is the fake (Mode 2's disk, for both builders), and its control plane the fake's fetch.
    makeArchilDisk: () => disk,
    mountControl: { baseUrl: control.baseUrl, fetch: controlFetch(control.fetch) },
    computerForClaim: computer,
  };
  // The run's whole local folder path, the run's directory above its work folder included.
  const watcher = watch ? watchReads(resolve(local, "..")) : undefined;
  let error;
  try {
    // `signal`: the claim's, as the adapter loop hands the run (AdapterRun.signal: aborted on a lost claim or a shutdown).
    // `phase`: the loop's AdapterRun.phase, a host step said on the run's timeline.
    spec = await build(launch, { harness: harnessRun, registry, setModels: (given) => (models = given), ...(signal ? { signal } : {}), ...(phase ? { phase } : {}) }, deps, claim);
    await use(spec);
  } catch (thrown) {
    // `fails`: the build is expected to throw; its error is answered, with what the control plane saw by then.
    if (!fails) throw thrown;
    error = thrown;
  } finally {
    watcher?.off();
  }
  if (fails && error === undefined) throw new Error("the spec's build did not throw");
  return { spec, error, disk, control, outbound: guard.outbound, localReads: watcher?.seen ?? [], local };
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

  test(`${name} in Mode 2: a monid answer too long for the model is filed on the run's disk, where the run's read finds it, never in the local folder`, async (t) => {
    // A monid discover answer past CLIP: the model reads it cut, and the whole goes to the run's evidence/monid/.
    const long = { results: [{ slug: "widgets", note: `${"w".repeat(CLIP)}-the-end` }] };
    const { spec, disk, local, outbound } = await mode2Spec(t, { harness, build, tools: ["read", "monid.discover"], monid: long });
    const toolOf = (name) => spec.session.tools.find((one) => one.name === name);
    const call = (name, args) => toolOf(name).call(args, { callId: `c-${name}`, signal: new AbortController().signal });
    assert.ok(toolOf("monid_discover"), `monid's discover is the run's tool: ${spec.session.tools.map((one) => one.name)}`);
    const answer = await call("monid_discover", { query: "widgets" });
    const saved = /the whole answer is in the run's files at (evidence\/monid\/\S+\.json)\]$/.exec(answer.text)?.[1];
    assert.ok(saved, `the cut answer names where the whole is: ${answer.text.slice(-200)}`);
    const filed = disk.files.get(`${KEY}/${saved}`);
    assert.equal(filed && Buffer.from(filed).toString("utf8"), JSON.stringify(long), "the whole answer is on the run's disk, under the run's key");
    assert.equal(existsSync(join(local, saved)), false, "and not in the run's local folder on this machine");
    // The run's read opens the file (one line past its page, so it shows the line's start and says how to read on).
    const back = await call("read", { path: saved });
    assert.notEqual(back.isError, true, `the run's read finds it: ${back.text.slice(0, 200)}`);
    assert.match(back.text, /^\{"results":\[\{"slug":"widgets"/, `the run's read finds it: ${back.text.slice(0, 120)}`);
    assert.deepEqual(outbound, [], "nothing left this machine");
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
    assert.equal(control.requests[1].body?.ttl, "86400s", "its safety-net lifetime, MOUNT_TTL_MS: no longer than its computer can live (COMPUTER_LIFETIME_MS, 24 h), in case the removal never comes");
    await spec.release();
    assert.deepEqual(callsOf(control).slice(2), [`DELETE ${disk}/users/token?identifier=tok-1`, `GET ${disk}`], "removed once at the end (the computer's release and the run's end revoke it, idempotently), then the run's earlier epochs looked for");
    assert.deepEqual(outbound, [], "nothing left this machine");
  });

  test(`${name} in Mode 2: a lost claim (its signal aborted) removes the run's mount credential at once, before the run's release`, async (t) => {
    const claimSignal = new AbortController();
    const { control } = await mode2Spec(t, { harness, build, computer: mountingComputer, signal: claimSignal.signal });
    const disk = `/api/disks/${ARCHIL_SETTINGS.diskId}`;
    assert.deepEqual(callsOf(control), [`GET ${disk}`, `POST ${disk}/users`], "minted at the claim");
    claimSignal.abort(new Error("claim lost (fenced)"));
    // The lost claim's revoke settles with its list read for an earlier epoch's, after its remove: awaited, then read.
    const swept = control.seen((one, index, all) => one.method === "GET" && all.slice(0, index).some((before) => before.method === "DELETE"));
    let timer;
    const bound = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`the lost claim's token was never removed: ${JSON.stringify(callsOf(control))}`)), 20_000); });
    await Promise.race([swept, bound]).finally(() => clearTimeout(timer));
    assert.deepEqual(callsOf(control).slice(2), [`DELETE ${disk}/users/token?identifier=tok-1`, `GET ${disk}`], "removed when the claim was lost, with no release yet, then the run's earlier epochs looked for");
  });

  test(`${name}: a claim that waits on its computer's image says one phase on the run's timeline, in main's words with the computer's noun`, async (t) => {
    const { DOCKER_RECIPE_HAS } = await import("@parcha/agentrun-computer");
    for (const [making, tag, words] of [
      ["build", "agentrun-computer:0123456789ab", `Preparing the computer's image: building it (${DOCKER_RECIPE_HAS})…`],
      ["pull", "registry.example/library/base:22.04", "Preparing the computer's image: pulling registry.example/library/base:22.04…"],
    ]) {
      const said = [];
      // The claim's computer waits on its image once (the provider's onWait), as on a host that lacks it.
      const waiting = async (_launch, _store, given) => (given.onImageWait?.(making, tag), { release: async () => {} });
      await mode2Spec(t, { harness, build, computer: waiting, phase: (summary) => void said.push(summary) });
      assert.deepEqual(said, [words], `${making}: one phase, in its words`);
    }
    // A claim with no image to wait on says nothing.
    const said = [];
    await mode2Spec(t, { harness, build, phase: (summary) => void said.push(summary) });
    assert.deepEqual(said, []);
  });
}

// A spec whose build throws part-way never reaches the loop, so the loop never calls its release: the build itself lets
// go what it made by then (spec-holds.ts), in the release's order, each once, and throws its own error unchanged. Here the
// run's mount credential is minted at the claim (its computer's mount asks for it), then something throws: the control
// plane must see that credential removed, once, and a computer that was made must be let go, once.
const DISK_PATH = `/api/disks/${ARCHIL_SETTINGS.diskId}`;
/** How many times each request was made, by method and path. */
const deletesOf = (control) => callsOf(control).filter((call) => call.startsWith("DELETE "));

for (const [name, harness, build] of [["pi's spec", undefined, adapterRunSpecFromLaunch], ["the CLI spec (opencode)", "opencode", cliRunSpecFromLaunch]]) {
  test(`${name} in Mode 2: a claim whose computer step mints the run's mount credential and then throws, making no computer, has the credential removed once and throws its own error`, async (t) => {
    const refused = Object.assign(new Error("the computer could not be started: the provider said no"), { code: "computer_unavailable" });
    // The computer step mints (its mount asks for the credential), then fails without letting it go itself.
    const failing = async (_launch, _store, given) => {
      await given.workspace.mountSpec();
      throw refused;
    };
    const { error, control, outbound } = await mode2Spec(t, { harness, build, computer: failing, fails: true });
    assert.equal(error, refused, "the build throws the computer step's own error, unchanged");
    assert.deepEqual(callsOf(control).slice(0, 2), [`GET ${DISK_PATH}`, `POST ${DISK_PATH}/users`], "minted at the claim");
    assert.deepEqual(deletesOf(control), [`DELETE ${DISK_PATH}/users/token?identifier=tok-1`], "the credential removed, once, though no spec was handed to the loop");
    assert.deepEqual(outbound, []);
  });

  test(`${name} in Mode 2: a build that throws after its computer is made lets the computer go once and removes the run's mount credential once, then throws its own error`, async (t) => {
    let released = 0;
    // A computer that mounts the folder (minting the credential) and is made, but whose read-back of its mount fails: the
    // tools' attach of the folder throws, after the computer exists. Its release revokes, as computerForClaim's does.
    const unreadable = async (_launch, _store, given) => {
      await given.workspace.mountSpec();
      return {
        computer: { kind: "sandbox", computer: { id: "computer-1", client: {}, readBack: async () => ({ ok: false, error: { code: "unavailable", message: "the read-back did not answer" } }) }, check: { readBackOf: () => ({ kind: "archil" }) } },
        release: async () => {
          released += 1;
          await given.revokeMount?.();
        },
      };
    };
    const { error, control, outbound } = await mode2Spec(t, { harness, build, computer: unreadable, fails: true });
    assert.match(error.message, /the computer computer-1 did not say what it mounts at \/workspace: the read-back did not answer/, "the attach's own words");
    assert.equal(released, 1, "the computer made for the run is let go, once");
    assert.deepEqual(deletesOf(control), [`DELETE ${DISK_PATH}/users/token?identifier=tok-1`], "the credential removed once (the computer's release and the build's revoke, idempotently)");
    assert.deepEqual(outbound, []);
  });
}

test("pi's spec in Mode 2: a build that throws after its computer and tools are made (its model route) lets the computer go once and removes the run's mount credential once, then throws its own error", async (t) => {
  let released = 0;
  const counted = async (launch, store, given) => {
    const made = await mountingComputer(launch, store, given);
    return { release: async () => {
      released += 1;
      await made.release();
    } };
  };
  const unrouted = new Error("the run's model route could not be read");
  const { error, control, outbound } = await mode2Spec(t, { build: adapterRunSpecFromLaunch, computer: counted, routeOf: async () => { throw unrouted; }, fails: true });
  assert.equal(error, unrouted, "the build throws the route's own error, unchanged");
  assert.equal(released, 1, "the computer is let go, once");
  assert.deepEqual(deletesOf(control), [`DELETE ${DISK_PATH}/users/token?identifier=tok-1`], "the credential removed, once");
  assert.deepEqual(outbound, []);
});

// A mint whose answer is lost (Archil made the token user; the claim never heard of it) is still removed: the claim's
// revoke looks for the run's users by name, this epoch's too, once a mint was asked for.
for (const [name, harness, build] of [["pi's spec", undefined, adapterRunSpecFromLaunch], ["the CLI spec (opencode)", "opencode", cliRunSpecFromLaunch]]) {
  test(`${name} in Mode 2: a mint whose answer is lost (the user made at Archil, the claim never told) is removed by the run's name when the build throws`, async (t) => {
    // The fake makes the user, then the connection drops before its answer reaches the claim.
    const losing = (fetch) => async (input, init) => {
      const answer = await fetch(input, init);
      if ((init?.method ?? "GET") === "POST") throw new TypeError("fetch failed: the connection closed before the answer");
      return answer;
    };
    const failing = async (_launch, _store, given) => {
      await given.workspace.mountSpec();
      return { release: async () => {} };
    };
    const { error, control, outbound } = await mode2Spec(t, { harness, build, computer: failing, controlFetch: losing, fails: true });
    assert.match(error.message, /the connection closed before the answer/, "the build throws the mint's own failure");
    assert.equal(control.requests.filter((one) => one.method === "POST").length, 1, "one mint, made at Archil");
    assert.deepEqual(deletesOf(control), [`DELETE ${DISK_PATH}/users/token?identifier=tok-1`], "the user the claim never heard of, found by the run's name and removed once");
    assert.deepEqual([...control.users.values()].filter((user) => user.nickname?.includes(RUN)), [], "no user of the run is left");
    assert.deepEqual(outbound, []);
  });

  test(`${name} in Mode 2: a release step that fails (the computer's release rejects) skips none after it: the run's mount credential is still removed`, async (t) => {
    let tried = 0;
    // A computer that mints, is made, and whose release rejects without revoking: the spec's own revoke must still run.
    const stuck = async (_launch, _store, given) => {
      await given.workspace.mountSpec();
      return { release: async () => {
        tried += 1;
        throw new Error("the provider did not answer the delete");
      } };
    };
    const { spec, control, outbound } = await mode2Spec(t, { harness, build, computer: stuck });
    await spec.release();
    await spec.release();
    assert.equal(tried, 1, "the computer's release is tried once, though a second release is asked for");
    assert.deepEqual(deletesOf(control), [`DELETE ${DISK_PATH}/users/token?identifier=tok-1`], "the credential removed, once, after the computer's release failed");
    assert.deepEqual(outbound, []);
  });
}

// The sweep by name removes the run's users of this claim's epoch and earlier, never a later one: a run reclaimed at a
// higher epoch keeps its credential when an older claim's cleanup runs late. Here the old claim (epoch 1) loses its
// mint's answer and cleans up while the run's next claim (epoch 2) already holds a user, and another run holds one too.
test("pi's spec in Mode 2: the cleanup of a mint never heard of removes the run's users of its own epoch and earlier, never a later epoch's or another run's", async (t) => {
  const existing = [
    { identifier: "tok-newer", nickname: `agentrun:${RUN}:2`, token: "fake-test-key-newer" },
    { identifier: "tok-older", nickname: `agentrun:${RUN}:0`, token: "fake-test-key-older" },
    { identifier: "tok-other", nickname: "agentrun:run-other:1", token: "fake-test-key-other" },
  ];
  const losing = (fetch) => async (input, init) => {
    const answer = await fetch(input, init);
    if ((init?.method ?? "GET") === "POST") throw new TypeError("fetch failed: the connection closed before the answer");
    return answer;
  };
  const minting = async (_launch, _store, given) => {
    await given.workspace.mountSpec();
    return { release: async () => {} };
  };
  const { error, control } = await mode2Spec(t, { build: adapterRunSpecFromLaunch, computer: minting, controlFetch: losing, existing, fails: true });
  assert.match(error.message, /the connection closed before the answer/);
  const minted = control.requests.find((one) => one.method === "POST");
  assert.equal(minted?.body?.nickname, `agentrun:${RUN}:1`, "this claim is epoch 1");
  const left = [...control.users.values()].map((user) => user.identifier).sort();
  assert.deepEqual(left, ["tok-newer", "tok-other"], "the run's later epoch's user and another run's stay; this epoch's and the earlier one's are gone");
});
