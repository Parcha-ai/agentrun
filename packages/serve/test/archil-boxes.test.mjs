// A box on another machine keeps its run's work folder on the owner's Archil disk: the server's own mount of the disk
// (conditional, the operator's) is where every run's folder is, and the box mounts exactly its run's work/ at
// /workspace, exclusively, through the root helper. Nothing is copied in or out. On a fake Daytona on loopback and a
// fake Archil (fixtures/fake-daytona.mjs, fixtures/fake-archil.mjs): no provider call and no Archil call runs.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { DISK, fakeArchil, HELPER_PATH, REGION, TOKEN, TOOL_USER } from "./fixtures/fake-archil.mjs";
import { daytonaSandboxes } from "./fixtures/fake-daytona.mjs";
import { follow, runDir, scratch, serve, withEnv } from "./support.mjs";

const PROBE = new URL("./fixtures/faux-probe.mjs", import.meta.url).pathname;
const FAKE_VM = new URL("./fixtures/fake-vm.mjs", import.meta.url).pathname;
const DAYTONA = { mode: "sandbox", box: "daytona" };
const KEY = "planted-daytona-key-sentinel";
const ARCHIL_NAMES = ["AGENTRUN_ARCHIL_DISK", "AGENTRUN_ARCHIL_REGION", "AGENTRUN_ARCHIL_TOKEN", "AGENTRUN_ARCHIL_GID"];
/** The fix a remote place with no Archil is refused with, in capabilities, at a save and at a run. */
const NO_ARCHIL = "remote boxes keep their run folder on an Archil disk: configure AGENTRUN_ARCHIL_DISK, AGENTRUN_ARCHIL_REGION and AGENTRUN_ARCHIL_TOKEN, or use the docker box";

function answers(data, runId) {
  const db = new DatabaseSync(join(runDir(data, runId), "store", "run.sqlite"), { readOnly: true });
  try {
    return db.prepare("SELECT record FROM entries ORDER BY id").all()
      .flatMap((row) => JSON.parse(row.record).model ?? [])
      .filter((message) => message.role === "toolResult")
      .map((message) => ({ tool: message.toolName, error: message.isError, text: (message.content ?? []).map((c) => c.text ?? "").join("") }));
  } finally {
    db.close();
  }
}

/** Every file below `dir` (no link followed) whose bytes hold `needle`. */
function holding(dir, needle) {
  const found = [];
  const walk = (at) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && readFileSync(path).includes(needle)) found.push(path);
    }
  };
  walk(dir);
  return found;
}

/** A data directory, its fake Archil disk, a fake Daytona whose boxes ship the helper, and a server on them all. */
async function onArchil(t, { archil = true, daytona = {}, env = {} } = {}) {
  const data = join(await mkdtemp(join(await scratch(t), "data-")), "agents");
  const disk = await fakeArchil(t, { data });
  const fake = await daytonaSandboxes(t, { key: KEY, ...(archil ? { archil: disk } : {}), ...daytona });
  withEnv(t, { AGENTRUN_BOXES: "daytona", DAYTONA_API_KEY: KEY, DAYTONA_API_URL: fake.url, OPENAI_API_KEY: "fake-test-key", ...(archil ? disk.env : {}), ...env }, ARCHIL_NAMES);
  const server = await serve(t, { faux: PROBE, data, ...(archil ? { archilMounts: disk.serverMounts } : {}) });
  return { server, fake, disk };
}

const agent = async (api, id, tools = ["read", "write", "bash"]) => {
  const made = await api("POST", "/agents", { definition: { id, name: id, instructions: "Probe.", place: DAYTONA, tools } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  return made.body;
};

test("with no Archil, capabilities say a remote box is unavailable and how to fix it, before anyone saves one", async (t) => {
  const { server } = await onArchil(t, { archil: false });
  const boxes = (await server.api("GET", "/capabilities")).body.places.boxes;
  assert.deepEqual(boxes.find((box) => box.id === "daytona"), { id: "daytona", available: false, state: "unavailable", reason: NO_ARCHIL });
});

test("with no Archil, a save of a Daytona or a Modal sandbox place is refused, in the same words", async (t) => {
  const { server } = await onArchil(t, { archil: false });
  for (const box of ["daytona", "modal"]) {
    const made = await server.api("POST", "/agents", { definition: { id: `on-${box}`, name: box, instructions: "Probe.", place: { mode: "sandbox", box }, tools: ["bash"] } });
    assert.equal(made.status, 422, JSON.stringify(made.body));
    const issue = made.body.error.fields.find((i) => i.field === "definition.place");
    assert.ok(issue?.message.includes(NO_ARCHIL), JSON.stringify(made.body));
  }
});

test("a run of a remote place saved while Archil was there is refused 409 once it is gone, saying why and how to fix it", async (t) => {
  const data = join(await mkdtemp(join(await scratch(t), "data-")), "agents");
  const disk = await fakeArchil(t, { data });
  const fake = await daytonaSandboxes(t, { key: KEY, archil: disk });
  withEnv(t, { AGENTRUN_BOXES: "daytona", DAYTONA_API_KEY: KEY, DAYTONA_API_URL: fake.url, OPENAI_API_KEY: "fake-test-key", ...disk.env }, ARCHIL_NAMES);
  const first = await serve(t, { faux: PROBE, data, archilMounts: disk.serverMounts });
  await agent(first.api, "remote");
  await first.close();
  for (const name of ARCHIL_NAMES) delete process.env[name];
  const second = await serve(t, { faux: PROBE, data });
  const run = await second.api("POST", "/agents/remote/runs", { input: { content: "{}" } });
  assert.equal(run.status, 409, JSON.stringify(run.body));
  assert.equal(run.body.error.code, "agent_not_runnable");
  assert.ok(run.body.error.message.includes(NO_ARCHIL), run.body.error.message);
  assert.equal(fake.sandboxes.size, 0, "no box was made");
});

test("Archil set but the disk not mounted at the data directory: remote boxes are unavailable, saying to mount it", async (t) => {
  const data = join(await mkdtemp(join(await scratch(t), "data-")), "agents");
  const disk = await fakeArchil(t, { data });
  const fake = await daytonaSandboxes(t, { key: KEY, archil: disk });
  withEnv(t, { AGENTRUN_BOXES: "daytona", DAYTONA_API_KEY: KEY, DAYTONA_API_URL: fake.url, ...disk.env }, ARCHIL_NAMES);
  const server = await serve(t, { faux: PROBE, data, archilMounts: join(disk.root, "no-such-table") });
  const daytona = (await server.api("GET", "/capabilities")).body.places.boxes.find((box) => box.id === "daytona");
  assert.equal(daytona.available, false);
  assert.match(daytona.reason, /is not mounted at .*disk: mount it there with --conditional/);
});

test("with Archil but no image that ships the helper, a remote box is unavailable, saying which setting names one", async (t) => {
  const { server } = await onArchil(t, { env: { AGENTRUN_DAYTONA_SNAPSHOT: "" } });
  const daytona = (await server.api("GET", "/capabilities")).body.places.boxes.find((box) => box.id === "daytona");
  assert.deepEqual(daytona, { id: "daytona", available: false, state: "unavailable", reason: "remote boxes need an image that ships the Archil helper: set AGENTRUN_DAYTONA_SNAPSHOT to a Daytona snapshot that has the archil client, the helper and the agentrun-tool user (see the README)" });
});

test("demo: a Daytona run mounts exactly its run's work/ through the helper; nothing is seeded, pulled or mirrored; its end syncs and checks the folder in, then destroys the box", { timeout: 180_000 }, async (t) => {
  const { server, fake, disk } = await onArchil(t);
  const { api, data } = server;
  assert.deepEqual((await api("GET", "/capabilities")).body.places.boxes.find((b) => b.id === "daytona"), { id: "daytona", available: true, state: "ready", network: "allowlist" });
  await agent(api, "remote");
  const plan = [
    { tool: "bash", args: { command: "pwd; printf 'hello from the box\\n' > out.txt" } },
    { tool: "write", args: { path: "note.txt", content: "written in the box" } },
    { tool: "read", args: { path: "note.txt" } },
  ];
  const started = await api("POST", "/agents/remote/runs", { input: { content: JSON.stringify({ probe: plan }) } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const run = started.body;
  await follow(api, run.run_id, ["completed"], { deadlineMs: 120_000 });
  const said = answers(data, run.run_id);
  assert.deepEqual(said.map((a) => [a.tool, a.error]), plan.map((step) => [step.tool, false]), JSON.stringify(said));
  assert.match(said[0].text, /\/workspace\n?$/m);
  const dir = runDir(data, run.run_id);
  const folder = relative(join(data, "disk"), join(dir, "work"));
  assert.match(folder, new RegExp(`^agents/remote-[0-9a-f]+/runs/${run.run_id}/work$`), "the run's folder is on the disk");
  // What the box wrote is in the run's folder on the disk itself: no copy.
  assert.equal(readFileSync(join(dir, "work", "out.txt"), "utf8"), "hello from the box\n");
  assert.equal(readFileSync(join(dir, "work", "note.txt"), "utf8"), "written in the box");
  // Exactly its folder, mounted once; a sync at a turn's end; at the end, a sync, then the checkin, then the destroy.
  const calls = disk.calls();
  assert.deepEqual(calls.filter((c) => c.verb === "mount" || c.verb === "revoke").map((c) => [c.verb, c.folder, c.region]), [["mount", folder, REGION]]);
  assert.deepEqual(calls.slice(-2).map((c) => c.verb), ["sync", "checkin"]);
  assert.deepEqual(disk.holds(), {}, "the folder is checked in");
  assert.equal(fake.sandboxes.size, 0, "the box is destroyed");
  // No copy in or out: no seed or pull script reached the box, and no mark of one is beside the run.
  const commands = fake.requests.filter((r) => r.path.endsWith("/process/execute")).map((r) => JSON.parse(r.body).command);
  assert.deepEqual(commands.filter((c) => /tar -c|tar -x|-mindepth 1 -printf/.test(c)), []);
  for (const left of ["box-sync.json", "box-mirrored.jsonl"]) assert.equal(existsSync(join(dir, left)), false, left);
  // The helper ran through sudo, by its fixed path, with the disk, the region and the folder: nothing else.
  assert.ok(commands.some((c) => c.includes(`sudo -n ${HELPER_PATH} mount ${DISK} ${REGION} ${folder}`) || (c.includes(HELPER_PATH) && c.includes(folder))), commands.join("\n"));
  // The box's mount is work/ alone: the run's store is never in a box.
  assert.ok(calls.every((c) => !c.folder || c.folder.endsWith("/work")));
  // work/ is the shared group's (the box's tool user is in it: Archil keeps ids as they are), setgid so what is made in
  // it stays the group's, and no one else's; every folder above it, up to the agent's, is this server's user's alone.
  const work = statSync(join(dir, "work"));
  assert.equal(work.mode & 0o7777, 0o2770);
  assert.equal(work.gid, Number(disk.env.AGENTRUN_ARCHIL_GID));
  for (const above of [dir, join(dir, ".."), join(dir, "..", "..")]) assert.equal(statSync(above).mode & 0o7777, 0o700, relative(data, above));
});

test("the disk token never reaches a box's arguments, its environment, its files or a run's process: it travels on the helper's fd 0, its file unlinked before archil starts", { timeout: 180_000 }, async (t) => {
  const { server, fake, disk } = await onArchil(t);
  const { api, data } = server;
  await agent(api, "remote");
  const plan = [{ tool: "bash", args: { command: "env; cat /proc/self/environ 2>/dev/null | tr '\\0' '\\n'; ls -la /tmp" } }];
  const run = (await api("POST", "/agents/remote/runs", { input: { content: JSON.stringify({ probe: plan }) } })).body;
  await follow(api, run.run_id, ["completed"], { deadlineMs: 120_000 });
  const [mount] = disk.calls().filter((c) => c.verb === "mount");
  assert.equal(mount.tokenInEnv, true, "archil had the token, in its environment");
  assert.equal(mount.psWithToken, 0, "no process showed the token in its arguments while archil mounted");
  assert.deepEqual(mount.filesWithToken, [], "no file of the box held the token while archil mounted: its file was gone before");
  assert.ok(!mount.argv.some((arg) => arg.includes(TOKEN)));
  // Not in any request to Daytona (a command, a create's environment), only in an upload's bytes.
  for (const request of fake.requests) assert.ok(!request.body.includes(TOKEN), `${request.method} ${request.path}`);
  assert.ok(!answers(data, run.run_id)[0].text.includes(TOKEN), "a tool's environment");
  assert.deepEqual(holding(data, TOKEN), [], "no file of the data directory");
  assert.ok(!readFileSync(join(runDir(data, run.run_id), "process.log"), "utf8").includes(TOKEN));
});

test("takeover: a box lost while it held the folder is replaced, and the new box takes the folder back by a revoke, never a plain mount", { timeout: 180_000 }, async (t) => {
  const { server, fake, disk } = await onArchil(t);
  const { api, data } = server;
  await agent(api, "remote");
  fake.state.crashAfter = "crash-marker";
  const plan = [
    { tool: "bash", args: { command: "echo one > one.txt" } },
    { tool: "bash", args: { command: "echo crash-marker" } },
    { tool: "bash", args: { command: "echo two > two.txt" } },
    { tool: "bash", args: { command: "cat one.txt two.txt" } },
  ];
  const run = (await api("POST", "/agents/remote/runs", { input: { content: JSON.stringify({ probe: plan }) } })).body;
  await follow(api, run.run_id, ["completed"], { deadlineMs: 120_000 });
  const said = answers(data, run.run_id);
  assert.equal(said.at(-1).text.trim(), "one\ntwo", JSON.stringify(said));
  const folder = relative(join(data, "disk"), join(runDir(data, run.run_id), "work"));
  const takes = disk.calls().filter((c) => c.verb === "mount" || c.verb === "revoke");
  const boxes = [...new Set(takes.map((c) => c.box))];
  assert.equal(boxes.length, 2, "a second box");
  const second = takes.filter((c) => c.box === boxes[1]);
  // Its plain mount is refused (the lost box holds the folder); the revoke forces that hold off, and it is the mount.
  assert.deepEqual(second.map((c) => [c.verb, c.refused ?? c.revoked]), [["mount", "held"], ["revoke", boxes[0]]]);
  assert.ok(second.every((c) => c.folder === folder));
  assert.deepEqual(disk.holds(), {});
});

test("a box whose /proc lets its tool user see the root archil client's processes (no hidepid) keeps no run folder: the call is refused, saying why, and nothing is mounted", { timeout: 180_000 }, async (t) => {
  const { server, fake, disk } = await onArchil(t);
  const { api, data } = server;
  disk.noHidepid();
  await agent(api, "remote");
  const run = (await api("POST", "/agents/remote/runs", { input: { content: JSON.stringify({ probe: [{ tool: "bash", args: { command: "echo never" } }] }) } })).body;
  await follow(api, run.run_id, ["completed"], { deadlineMs: 120_000 });
  const [said] = answers(data, run.run_id);
  assert.equal(said.error, true);
  assert.match(said.text, /\/proc is not mounted with hidepid=2 \(or invisible\), so its tools could see the root archil client's processes/);
  assert.deepEqual(disk.calls(), [], "archil was never run");
  assert.deepEqual(disk.holds(), {});
  assert.equal(fake.sandboxes.size, 0, "the box that could not have the folder is destroyed");
});

test("two users: every tool command runs as the tool user, which has no sudo, and the helper is the only root the box's own user runs", { timeout: 180_000 }, async (t) => {
  const { server, fake } = await onArchil(t, { daytona: { sudoProbe: true } });
  const { api, data } = server;
  await agent(api, "remote");
  const plan = [
    { tool: "bash", args: { command: "sudo -n true; echo sudo=$?" } },
    { tool: "bash", args: { command: `sudo -n ${HELPER_PATH} checkin; echo helper=$?` } },
    { tool: "bash", args: { command: "touch made-by-tool && echo writable" } },
    { tool: "bash", args: { command: "echo home=$HOME lang=$LANG" } },
  ];
  const run = (await api("POST", "/agents/remote/runs", { input: { content: JSON.stringify({ probe: plan }) } })).body;
  await follow(api, run.run_id, ["completed"], { deadlineMs: 120_000 });
  const said = answers(data, run.run_id);
  assert.match(said[0].text, /sudo=97/, "a tool's sudo is refused");
  assert.match(said[1].text, /helper=97/, "a tool cannot run the helper");
  assert.match(said[2].text, /writable/, "/workspace stays writable for the tool user");
  assert.match(said[3].text, /home=\/tmp lang=C\.UTF-8/, "the box's fixed environment reaches the tool user's programs past sudo's reset");
  assert.deepEqual(fake.sudoCalls(), ["-n true", `-n ${HELPER_PATH} checkin`], "the refusing stand-in met both, so neither ran");
  // Every command a tool ran went through `sudo -n -u agentrun-tool --`, noted by the box's sudo.
  const commands = fake.requests.filter((r) => r.path.endsWith("/process/execute")).map((r) => JSON.parse(r.body).command);
  assert.ok(commands.length > 0 && commands.filter((c) => c.includes(TOOL_USER)).length > 0, commands.join("\n"));
});
