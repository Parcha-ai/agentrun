// Where runs' harness tools would run, as capabilities say it (box/1): the box's mode as its probe proved it, never what
// was hoped. A missing box or a failed probe is `unavailable` with a stable error code and words a person can act on;
// `unsandboxed` is only the operator's AGENTRUN_BOX=unsandboxed, and loud. A shared server's cgroup subtree that is not
// delegated stops the start. The box's probe is scripted here (a fake factory, in tests only); the real one is 4a's.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { BOX_UNAVAILABLE, boxConfig, cgroupDelegation, UNSANDBOXED_BANNER, UNSANDBOXED_RUN_LINE } from "../dist/box/config.js";
import { schemaProblems } from "./schema-support.mjs";
import { agent, follow, serve, withEnv } from "./support.mjs";

const BOX_ENV = ["AGENTRUN_BOX", "AGENTRUN_BOX_CGROUP", "AGENTRUN_BOX_EGRESS"];
/** A private address the probe's own words name, which capabilities must never carry. */
const PLANTED_ADDRESS = "10.1.2.3"; // key-gate: denylist a planted private address the box detail must never carry

/** A box whose probe proved `isolation` (a scripted factory: in tests only). */
const factory = (isolation, seen = []) => async (config) => {
  seen.push(config);
  return { isolation, start: () => { throw new Error("not in these tests"); }, reap: async () => ({ empty: true, left: 0, by: "pidns" }) };
};

/** What this process writes to stderr while `fn` runs. */
async function stderrOf(t, fn) {
  const real = process.stderr.write;
  let text = "";
  process.stderr.write = function (chunk, ...rest) {
    text += String(chunk);
    return real.call(this, chunk, ...rest);
  };
  t.after(() => (process.stderr.write = real));
  try {
    const result = await fn();
    return { result, text };
  } finally {
    process.stderr.write = real;
  }
}

async function scratch(t) {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "agentrun-box-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A served /capabilities, and the served document it must meet. */
async function served(t, options) {
  const server = await serve(t, options);
  const caps = (await server.api("GET", "/capabilities")).body;
  const doc = await (await fetch(`${server.baseUrl}/openapi.json`)).json();
  return { ...server, caps, doc };
}
const meets = (doc, caps) => schemaProblems(doc, { $ref: "#/components/schemas/Capabilities" }, caps);

// ---- the settings ------------------------------------------------------------------------------------------------------

test("the box settings: local and open by default; a value this server does not know is refused by its setting's name", () => {
  assert.deepEqual(boxConfig({}), { provider: "local", egress: "open" });
  for (const provider of ["local", "unsandboxed", "daytona", "modal"]) assert.equal(boxConfig({ AGENTRUN_BOX: provider }).provider, provider);
  assert.equal(boxConfig({ AGENTRUN_BOX_CGROUP: "/sys/fs/cgroup/agentrun" }).cgroup, "/sys/fs/cgroup/agentrun");
  assert.throws(() => boxConfig({ AGENTRUN_BOX: "docker" }), /AGENTRUN_BOX is "docker"; it takes local, unsandboxed, daytona, modal/);
  assert.throws(() => boxConfig({ AGENTRUN_BOX_EGRESS: "model-only" }), /AGENTRUN_BOX_EGRESS is "model-only"; it takes open/);
});

test("an unknown AGENTRUN_BOX stops the server's start, by name", async (t) => {
  withEnv(t, { AGENTRUN_BOX: "docker" }, BOX_ENV);
  await assert.rejects(serve(t), /AGENTRUN_BOX is "docker"/);
});

// ---- what capabilities say ---------------------------------------------------------------------------------------------

test("a box whose probe passed: its mode as proved, no error, no detail; the answer meets the served document", async (t) => {
  withEnv(t, {}, BOX_ENV);
  const seen = [];
  const { caps, doc } = await served(t, { boxFactory: factory({ mode: "bwrap", cgroup: false }, seen) });
  assert.deepEqual(caps.box, { mode: "bwrap", cgroup: false, egress: "open" });
  assert.deepEqual(seen, [{ provider: "local", egress: "open" }], "the factory is given the settings");
  assert.deepEqual(meets(doc, caps), []);
  // In a box whose probe passed, a new claude-agent run gets its harness's own tools (native-tools.ts); pi's are pi's own,
  // and Codex's adapter takes no such option yet.
  assert.deepEqual(caps.harnesses.map((h) => [h.id, h.native_tools]), [["pi", false], ["claude-agent", true], ["codex", false]]);
});

test("a probe that failed reads as unavailable with its named error, never bwrap and never unsandboxed; native tools off on every harness", async (t) => {
  withEnv(t, {}, BOX_ENV);
  const { caps, doc } = await served(t, { boxFactory: factory({ mode: "unavailable", error: "bwrap_userns_denied", detail: "bwrap: setting up uid map: Permission denied" }) });
  assert.equal(caps.box.mode, "unavailable");
  assert.equal(caps.box.error, "bwrap_userns_denied");
  assert.match(caps.box.detail, /agentrun-box install/, "the detail names what to run");
  assert.equal(caps.box.cgroup, false);
  for (const h of caps.harnesses) assert.equal(h.native_tools, false, h.id);
  assert.deepEqual(meets(doc, caps), []);
});

test("no box at all (no factory), a factory that throws, or a box claiming unsandboxed: unavailable, box_probe_failed", async (t) => {
  withEnv(t, {}, BOX_ENV);
  const throwing = async () => { throw new Error("bwrap: No such file or directory: /usr/bin/bwrap"); };
  for (const boxFactory of [undefined, throwing, factory({ mode: "unsandboxed" })]) {
    const { caps, close } = await served(t, boxFactory ? { boxFactory } : {});
    assert.equal(caps.box.mode, "unavailable");
    assert.equal(caps.box.error, "box_probe_failed");
    await close();
  }
});

test("an unavailable box's cause goes to the operator's log, whole, while capabilities keep their fixed words", async (t) => {
  withEnv(t, {}, BOX_ENV);
  const thrown = await stderrOf(t, () => served(t, { boxFactory: async () => { throw new Error("bwrap exploded at /opt/odd/bwrap"); } }));
  assert.match(thrown.text, /agentrun-serve: the box is unavailable \(box_probe_failed\), so runs get no tools of their harness's own: making it failed: bwrap exploded at \/opt\/odd\/bwrap/);
  assert.doesNotMatch(thrown.result.caps.box.detail, /exploded|\/opt/);
  const probe = await stderrOf(t, () => served(t, { boxFactory: factory({ mode: "unavailable", error: "bwrap_userns_denied", detail: "bwrap: setting up uid map: Permission denied" }) }));
  assert.match(probe.text, /the box is unavailable \(bwrap_userns_denied\), so runs get no tools of their harness's own: its probe failed \(bwrap_userns_denied\): bwrap: setting up uid map: Permission denied/);
  assert.doesNotMatch(probe.result.caps.box.detail, /uid map/);
  const none = await stderrOf(t, () => served(t, {}));
  assert.match(none.text, /the box is unavailable \(box_probe_failed\), so runs get no tools of their harness's own: this server was given no box to make/);
});

test("error and detail appear only when the box is unavailable: the served document refuses either on a working box", async (t) => {
  withEnv(t, {}, BOX_ENV);
  const { caps, doc } = await served(t, { boxFactory: factory({ mode: "bwrap", cgroup: false }) });
  assert.notDeepEqual(meets(doc, { ...caps, box: { ...caps.box, error: "box_probe_failed", detail: "x" } }), [], "an error with mode bwrap");
  assert.notDeepEqual(meets(doc, { ...caps, box: { mode: "unavailable", cgroup: false, egress: "open" } }), [], "unavailable without its error");
  assert.notDeepEqual(meets(doc, { ...caps, box: { ...caps.box, mode: "docker" } }), [], "a mode the document does not name");
  assert.notDeepEqual(meets(doc, { ...caps, box: { ...caps.box, unheard_of: 1 } }), [], "a field the document does not name");
});

test("the error codes are stable, and every detail is words only: no host path, user name or address", async (t) => {
  assert.deepEqual([...BOX_UNAVAILABLE], ["bwrap_missing", "bwrap_setuid", "bwrap_userns_denied", "box_probe_failed", "box_refused", "box_start_failed"]);
  withEnv(t, {}, BOX_ENV);
  const user = process.env.USER ?? process.env.LOGNAME ?? "nobody-here";
  for (const error of BOX_UNAVAILABLE) {
    // The probe's own words name a path, a user and an address; none of them may reach capabilities.
    const { caps, close } = await served(t, { boxFactory: factory({ mode: "unavailable", error, detail: `/usr/bin/bwrap as ${user} at ${PLANTED_ADDRESS}: failed` }) });
    assert.equal(caps.box.error, error);
    const { detail } = caps.box;
    assert.doesNotMatch(detail, /\/[A-Za-z0-9._-]+/, `${error}: a path in "${detail}"`);
    assert.doesNotMatch(detail, /\b\d{1,3}(\.\d{1,3}){3}\b|[0-9a-f]{1,4}(:[0-9a-f]{0,4}){2,}/i, `${error}: an address in "${detail}"`);
    assert.ok(!detail.includes(user), `${error}: the user name in "${detail}"`);
    await close();
  }
});

test("the box is this server's own field (box/1), and the contract it vendors is unchanged", async (t) => {
  withEnv(t, {}, BOX_ENV);
  const { doc } = await served(t, { boxFactory: factory({ mode: "bwrap", cgroup: false }) });
  const box = doc.components.schemas.Capabilities.properties.box;
  assert.equal(box["x-agentrun-serve"], "box/1");
  assert.ok(!doc.components.schemas.Capabilities.required.includes("box"), "the contract's own required list is not touched");
  const vendored = JSON.parse(await readFile(new URL("../src/openapi/agentrun-v2.openapi.json", import.meta.url), "utf8"));
  assert.equal(vendored.components.schemas.Capabilities.properties.box, undefined, "the vendored contract has no box");
});

// ---- unsandboxed: only the operator's word, and loud -----------------------------------------------------------------

test("unsandboxed only from the setting: the banner at start, a line at each run's log start, and the mode in the run's record and capabilities", async (t) => {
  withEnv(t, { AGENTRUN_BOX: "unsandboxed" }, BOX_ENV);
  const seen = [];
  const { result: server, text } = await stderrOf(t, () => served(t, { boxFactory: factory({ mode: "bwrap", cgroup: false }, seen) }));
  assert.ok(text.includes(UNSANDBOXED_BANNER), "the banner, at start");
  assert.deepEqual(seen, [], "no box is made or probed");
  assert.deepEqual(server.caps.box, { mode: "unsandboxed", cgroup: false, egress: "open" });
  // No box is no harness tools: UNSANDBOXED_NATIVE_TOOLS (native-tools.ts) keeps them off until that is decided otherwise.
  for (const h of server.caps.harnesses) assert.equal(h.native_tools, false, `${h.id}: no native tools unsandboxed`);
  assert.equal((await server.api("POST", "/agents", agent("plain"))).status, 201);
  const id = (await server.api("POST", "/agents/plain/runs", { input: { content: "What is 2 + 2?" } })).body.run_id;
  await follow(server.api, id, ["completed"]);
  const meta = JSON.parse(await readFile(join(server.data, "runs", id, "serve.json"), "utf8"));
  assert.equal(meta.box.mode, "unsandboxed", "the run's record");
  assert.equal((await readFile(join(server.data, "runs", id, "process.log"), "utf8")).split("\n")[0], UNSANDBOXED_RUN_LINE, "the run's log starts with it");
});

test("without the setting, none of it: no banner, no line in a run's log, and the run records the box it saw", async (t) => {
  withEnv(t, {}, BOX_ENV);
  const { result: server, text } = await stderrOf(t, () => served(t, { boxFactory: factory({ mode: "bwrap", cgroup: false }) }));
  assert.ok(!text.includes("AGENTRUN_BOX=unsandboxed"), "no banner");
  assert.notEqual(server.caps.box.mode, "unsandboxed");
  assert.equal((await server.api("POST", "/agents", agent("plain"))).status, 201);
  const id = (await server.api("POST", "/agents/plain/runs", { input: { content: "What is 2 + 2?" } })).body.run_id;
  await follow(server.api, id, ["completed"]);
  const meta = JSON.parse(await readFile(join(server.data, "runs", id, "serve.json"), "utf8"));
  assert.deepEqual(meta.box, { mode: "bwrap", cgroup: false, egress: "open" });
  assert.ok(!(await readFile(join(server.data, "runs", id, "process.log"), "utf8")).includes(UNSANDBOXED_RUN_LINE), "no unsandboxed line");
});

// ---- shared and single-user ----------------------------------------------------------------------------------------------

/** A stand-in for a cgroup v2 subtree (never the host's /sys/fs/cgroup): a directory with the two files delegation needs. */
async function fakeCgroup(t, { writable = true } = {}) {
  const root = join(await scratch(t), "agentrun");
  await mkdir(root);
  for (const file of ["cgroup.procs", "cgroup.subtree_control"]) {
    await writeFile(join(root, file), "");
    if (!writable) await chmod(join(root, file), 0o444);
  }
  return root;
}

test("a cgroup subtree is delegated when this server's user owns it and may write its cgroup.procs and cgroup.subtree_control", { skip: process.getuid?.() === 0 && "root writes a file of mode 444" }, async (t) => {
  assert.equal(await cgroupDelegation(await fakeCgroup(t)), undefined);
  assert.match(await cgroupDelegation(await fakeCgroup(t, { writable: false })), /cgroup\.procs is not writable/);
  assert.match(await cgroupDelegation(join(await scratch(t), "missing")), /not a directory/);
});

test("shared mode: AGENTRUN_BOX_CGROUP naming a subtree not delegated stops the start, by name; unset, the server is single-user and starts", { skip: process.getuid?.() === 0 && "root writes a file of mode 444" }, async (t) => {
  withEnv(t, { AGENTRUN_BOX_CGROUP: await fakeCgroup(t, { writable: false }) }, BOX_ENV);
  await assert.rejects(serve(t, { boxFactory: factory({ mode: "bwrap", cgroup: true }) }), /AGENTRUN_BOX_CGROUP names a cgroup subtree this server cannot use \(its cgroup\.procs is not writable/);
  withEnv(t, { AGENTRUN_BOX_CGROUP: await fakeCgroup(t) }, BOX_ENV);
  const shared = await served(t, { boxFactory: factory({ mode: "bwrap", cgroup: true }) });
  assert.equal(shared.caps.box.cgroup, true, "delegated: each run gets its cgroup");
  await shared.close();
  withEnv(t, {}, BOX_ENV);
  const single = await served(t, { boxFactory: factory({ mode: "bwrap", cgroup: true }) });
  assert.equal(single.caps.box.cgroup, false, "no subtree named: single-user, and it starts");
});

// ---- a run opened again after the operator changed AGENTRUN_BOX ------------------------------------------------------

/** A run waiting for the person, left with its process killed by a server started under `env` (and `options`). */
async function leftWaiting(t, env, options = {}) {
  withEnv(t, env, BOX_ENV);
  const first = await serve(t, options);
  assert.equal((await first.api("POST", "/agents", agent("asks", { tools: ["ask_person"] }))).status, 201);
  const id = (await first.api("POST", "/agents/asks/runs", { input: { content: "Pick a region." } })).body.run_id;
  await follow(first.api, id, ["input_required"]);
  const pid = JSON.parse(await readFile(join(first.data, "runs", id, "run.json"), "utf8")).holder.pid;
  process.kill(pid, "SIGKILL");
  await first.close();
  const record = async () => JSON.parse(await readFile(join(first.data, "runs", id, "serve.json"), "utf8")).box;
  return { data: first.data, id, record };
}

test("a run that started in a box never continues unsandboxed: refused by name, its record untouched", async (t) => {
  const { data, id, record } = await leftWaiting(t, {}, { boxFactory: factory({ mode: "bwrap", cgroup: false }) });
  assert.equal((await record()).mode, "bwrap");
  withEnv(t, { AGENTRUN_BOX: "unsandboxed" }, BOX_ENV);
  const second = await serve(t, { data });
  // The message would open it again: it is refused there, the run ends, and both say why, by name.
  const answer = await second.api("POST", `/runs/${id}/messages`, { content: "eu" });
  assert.deepEqual([answer.status, answer.body.error.message], [409, "box_downgrade: this run started in a box; start a new run to run it unsandboxed"], JSON.stringify(answer.body));
  await follow(second.api, id, ["failed"]);
  const { error } = (await second.api("GET", `/runs/${id}`)).body;
  assert.deepEqual([error.code, error.message], ["box_downgrade", "box_downgrade: this run started in a box; start a new run to run it unsandboxed"]);
  assert.equal((await record()).mode, "bwrap", "nothing opened, so nothing recorded");
});

test("a boxed run waiting for the person ends box_downgrade when a server restarts unsandboxed, with no message sent: it never waits on a box it lost", async (t) => {
  const { data, id, record } = await leftWaiting(t, {}, { boxFactory: factory({ mode: "bwrap", cgroup: false }) });
  withEnv(t, { AGENTRUN_BOX: "unsandboxed" }, BOX_ENV);
  const second = await serve(t, { data });
  await follow(second.api, id, ["failed"]);
  const { error } = (await second.api("GET", `/runs/${id}`)).body;
  assert.deepEqual([error.code, error.message], ["box_downgrade", "box_downgrade: this run started in a box; start a new run to run it unsandboxed"]);
  assert.equal((await record()).mode, "bwrap", "nothing opened, so nothing recorded");
});

test("a run that had a box is held by a server whose box is unavailable: never opened, refused by name; the next server with a box opens it", async (t) => {
  const { data, id, record } = await leftWaiting(t, {}, { boxFactory: factory({ mode: "bwrap", cgroup: false }) });
  withEnv(t, {}, BOX_ENV);
  const held = await serve(t, { data });
  const answer = await held.api("POST", `/runs/${id}/messages`, { content: "eu" });
  assert.equal(answer.status, 409, JSON.stringify(answer.body));
  assert.match(answer.body.error.message, /^box_unavailable: this run ran with a bwrap box, and this server has no box \(box_probe_failed\); it is held/);
  const view = (await held.api("GET", `/runs/${id}`)).body;
  assert.notEqual(view.status, "failed", "held, never failed");
  assert.equal(view.error ?? null, null);
  assert.equal((await record()).mode, "bwrap", "never opened here, so nothing recorded");
  await held.close();
  const boxed = await serve(t, { data, boxFactory: factory({ mode: "bwrap", cgroup: false }) });
  assert.equal((await boxed.api("POST", `/runs/${id}/messages`, { content: "eu" })).status, 202);
  await follow(boxed.api, id, ["completed"]);
  assert.equal((await record()).mode, "bwrap");
});

test("a run that ran unsandboxed opens again in a box, and records the box it now runs in", async (t) => {
  const { data, id, record } = await leftWaiting(t, { AGENTRUN_BOX: "unsandboxed" });
  assert.equal((await record()).mode, "unsandboxed");
  withEnv(t, {}, BOX_ENV);
  const second = await serve(t, { data, boxFactory: factory({ mode: "bwrap", cgroup: false }) });
  assert.equal((await second.api("POST", `/runs/${id}/messages`, { content: "eu" })).status, 202);
  await follow(second.api, id, ["completed"]);
  assert.deepEqual(await record(), { mode: "bwrap", cgroup: false, egress: "open" }, "the open it describes, not the first");
});

test("one kind of box may follow another: a run opened again in a provider's box proceeds, and records it", async (t) => {
  const { data, id, record } = await leftWaiting(t, {}, { boxFactory: factory({ mode: "bwrap", cgroup: false }) });
  withEnv(t, {}, BOX_ENV);
  const second = await serve(t, { data, boxFactory: factory({ mode: "provider", cgroup: false }) });
  assert.equal((await second.api("POST", `/runs/${id}/messages`, { content: "eu" })).status, 202);
  await follow(second.api, id, ["completed"]);
  assert.equal((await record()).mode, "provider");
});

test("a follow-up to a completed run that ran in a box is refused unsandboxed, by name, and the run stays completed", async (t) => {
  withEnv(t, {}, BOX_ENV);
  const first = await serve(t, { boxFactory: factory({ mode: "bwrap", cgroup: false }) });
  assert.equal((await first.api("POST", "/agents", agent("plain"))).status, 201);
  const id = (await first.api("POST", "/agents/plain/runs", { input: { content: "What is 2 + 2?" } })).body.run_id;
  await follow(first.api, id, ["completed"]);
  await first.close();
  withEnv(t, { AGENTRUN_BOX: "unsandboxed" }, BOX_ENV);
  const second = await serve(t, { data: first.data });
  const answer = await second.api("POST", `/runs/${id}/messages`, { content: "And 3 + 3?" });
  assert.deepEqual([answer.status, answer.body.error.message], [409, "box_downgrade: this run started in a box; start a new run to run it unsandboxed"], JSON.stringify(answer.body));
  assert.equal((await second.api("GET", `/runs/${id}`)).body.status, "completed", "never opened again");
});

test("a provider's box is a box: a run that ran in one is refused unsandboxed, by name", async (t) => {
  const { data, id, record } = await leftWaiting(t, {}, { boxFactory: factory({ mode: "provider", cgroup: false }) });
  assert.equal((await record()).mode, "provider");
  withEnv(t, { AGENTRUN_BOX: "unsandboxed" }, BOX_ENV);
  const second = await serve(t, { data });
  const answer = await second.api("POST", `/runs/${id}/messages`, { content: "eu" });
  assert.equal(answer.status, 409);
  assert.match(answer.body.error.message, /^box_downgrade: /);
  assert.equal((await record()).mode, "provider");
});
