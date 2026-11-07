// The VM box for sandbox runs, on a fake of the VM provider's SDK client (fixtures/fake-vm.mjs, loaded in place of the SDK
// under --faux): no provider call runs. The server holds the token and the client: it makes a run's box, seeds it with
// the run's work/, pulls work/ back at each turn's end and once more before the run's end is recorded, then ends it. The
// run's process holds no token: its calls to its box go through the server's box relay, which takes only the calls a run's
// tools make of that run's own box. The VM box has no network: the provider takes a host list, but the server cannot read
// a box's list back to check that it holds, so it never asks for one, and never leaves the provider's open default.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { VM_PROVIDER } from "../dist/boxes.js";
import { BOX_RELAY_FILE, startBoxRelay } from "../dist/box-relay.js";
import * as relayVm from "../dist/box-relay-vm.js";
import { BOX_ENV } from "../dist/run-box.js";
import { ModalClient as FakeClient, vm } from "./fixtures/fake-vm.mjs";
import { follow, runDir, scratch, serve, withEnv } from "./support.mjs";

const PROBE = new URL("./fixtures/faux-probe.mjs", import.meta.url).pathname;
const FAKE_VM = new URL("./fixtures/fake-vm.mjs", import.meta.url).pathname;
const VM = VM_PROVIDER.id;
const PLACE = { mode: "sandbox", box: VM };
const planted = (name) => `planted-${name}-sentinel`;
const TOKENS = Object.fromEntries(VM_PROVIDER.keys.map((name, i) => [name, planted(`vm-token-${i}`)]));
const NO_LIST = "the Modal sandbox takes a host list, but this server cannot read a sandbox's list back to check that it holds, so the Modal sandbox has no network";
const ENV_PROBE = "env; cat /proc/self/environ 2>/dev/null | tr '\\0' '\\n'";

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

/** A server with the VM box listed, its token planted (or `keys`), on the fake client and the probe model. */
async function onVm(t, { keys = TOKENS, env = {}, ...extra } = {}) {
  vm.reset();
  t.after(() => vm.reset());
  withEnv(t, { AGENTRUN_BOXES: VM, ...keys, OPENAI_API_KEY: planted("model"), ...env }, [...VM_PROVIDER.keys, "AGENTRUN_BOX_ALLOW"]);
  return serve(t, { faux: PROBE, fauxVm: FAKE_VM, ...extra });
}

async function probe(api, agent, plan) {
  const run = await api("POST", `/agents/${agent}/runs`, { input: { content: JSON.stringify({ probe: plan }) } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  return run.body;
}
const fileList = async (api, runId) => (await api("GET", `/runs/${runId}/files`)).body.files.map((file) => file.path).sort();
const vmOffer = async (api) => (await api("GET", "/capabilities")).body.places.boxes.find((box) => box.id === VM);
const until = async (done, what, ms = 30_000) => {
  const end = Date.now() + ms;
  while (!(await done())) {
    assert.ok(Date.now() < end, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

test("demo: a VM place runs bash, write, edit and read in the run's VM box: work/ seeded in, bash's out.txt back in the run's files, no network, no token in the box, the box ended at the run's end", { timeout: 180_000 }, async (t) => {
  const server = await onVm(t);
  const { api, data } = server;
  assert.deepEqual(await vmOffer(api), { id: VM, available: true, state: "ready", reason: "configured; not probed at start", network: "none", network_reason: NO_LIST });
  const made = await api("POST", "/agents", { definition: { id: "remote", name: "remote", instructions: "Probe.", place: PLACE, tools: ["read", "write", "edit", "bash"] } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.deepEqual(made.body.warnings, []);
  const plan = [
    { tool: "bash", args: { command: "pwd" } },
    { tool: "bash", args: { command: "printf 'hello from the box\\n' > out.txt" } },
    { tool: "write", args: { path: "note.txt", content: "written in the box" } },
    { tool: "edit", args: { path: "note.txt", edits: [{ oldText: "written", newText: "edited" }] } },
    { tool: "read", args: { path: "note.txt" } },
    { tool: "bash", args: { command: ENV_PROBE } },
  ];
  const run = await probe(api, "remote", plan);
  assert.deepEqual(run.place, PLACE);
  await follow(api, run.run_id, ["completed"], { deadlineMs: 120_000 });
  const said = answers(data, run.run_id);
  assert.deepEqual(said.map((a) => [a.tool, a.error]), plan.map((step) => [step.tool, false]), JSON.stringify(said));
  assert.match(said[0].text.trim(), /\/workspace$/, "bash starts in the box's work/");
  assert.equal(said[4].text, "edited in the box");
  // The run's files: what the box wrote, pulled back.
  assert.deepEqual(await fileList(api, run.run_id), ["note.txt", "out.txt"]);
  assert.equal((await api("GET", `/runs/${run.run_id}/files/out.txt`)).body, "hello from the box\n");
  // The box the provider was asked for: the network blocked, never a list; the fixed environment; the run's labels.
  assert.equal(vm.sandboxes.length, 1);
  const params = vm.sandboxes[0].params;
  assert.deepEqual([params.blockNetwork, params.outboundDomainAllowlist, params.outboundCidrAllowlist], [true, undefined, undefined]);
  assert.deepEqual(params.env, BOX_ENV);
  assert.equal(params.tags["agentrun.run"], run.run_id);
  // The client was made with the server's token, which reached neither the box nor the run's process.
  assert.deepEqual(vm.clients.map((client) => client.params), [{ tokenId: TOKENS[VM_PROVIDER.keys[0]], tokenSecret: TOKENS[VM_PROVIDER.keys[1]] }]);
  const door = (await readFile(join(data, ".door-token"), "utf8")).trim();
  for (const [name, value] of Object.entries({ ...TOKENS, model: planted("model"), token: server.token, door })) assert.ok(!said[5].text.includes(value), `${name} reached the box`);
  const log = readFileSync(join(runDir(data, run.run_id), "process.log"), "utf8");
  for (const value of Object.values(TOKENS)) assert.ok(!log.includes(value), "the token is in no line of the run's process");
  // The run's end ended its box.
  assert.deepEqual(vm.running(), [], "the box is ended at the run's end");
});

test("a run's box that is gone is made again: the call that met it fails saying so, and the next call runs in a new box seeded with the run's work/", { timeout: 180_000 }, async (t) => {
  const { api, data } = await onVm(t);
  assert.equal((await api("POST", "/agents", { definition: { id: "asker", name: "asker", instructions: "Probe.", place: PLACE, tools: ["bash", "ask_person"] } })).status, 201);
  const plan = [
    { tool: "bash", args: { command: "printf one > turn1.txt" } },
    { tool: "ask_person", args: { question: "Go on?" } },
    { tool: "bash", args: { command: "cat turn1.txt" } },
    { tool: "bash", args: { command: "cat turn1.txt > turn2.txt" } },
  ];
  const run = await probe(api, "asker", plan);
  await follow(api, run.run_id, ["input_required"], { deadlineMs: 120_000 });
  assert.deepEqual(await fileList(api, run.run_id), ["turn1.txt"], "the turn's end pulled what its box wrote");
  assert.equal(vm.running().length, 1, "the box lives while the run waits");
  const first = vm.running()[0].sandboxId;
  await vm.end(first);
  assert.equal((await api("POST", `/runs/${run.run_id}/messages`, { content: "Yes." })).status, 202);
  await follow(api, run.run_id, ["completed"], { deadlineMs: 120_000 });
  const said = answers(data, run.run_id);
  assert.deepEqual(said.map((a) => [a.tool, a.error]), [["bash", false], ["ask_person", false], ["bash", true], ["bash", false]], JSON.stringify(said));
  assert.match(said[2].text, /gone|ended/, "the call that met the gone box says so");
  assert.equal(vm.sandboxes.length, 2, "made again, once");
  assert.equal((await api("GET", `/runs/${run.run_id}/files/turn2.txt`)).body, "one", "the new box was seeded with what the run had");
  assert.deepEqual(vm.running(), [], "and the new one is ended at the run's end");
});

test("a cancel ends the run's box", { timeout: 180_000 }, async (t) => {
  const { api } = await onVm(t);
  assert.equal((await api("POST", "/agents", { definition: { id: "asker", name: "asker", instructions: "Probe.", place: PLACE, tools: ["bash", "ask_person"] } })).status, 201);
  const run = await probe(api, "asker", [{ tool: "bash", args: { command: "printf one > kept.txt" } }, { tool: "ask_person", args: { question: "Go on?" } }]);
  await follow(api, run.run_id, ["input_required"], { deadlineMs: 120_000 });
  assert.equal(vm.running().length, 1);
  // The turn's end copied it back already (a files read waits for that copy): what the cancel then keeps is that.
  assert.deepEqual(await fileList(api, run.run_id), ["kept.txt"], "the turn's end brought it back");
  const boxes = () => JSON.stringify(vm.sandboxes.map((sandbox) => [sandbox.sandboxId, sandbox.exitCode, sandbox.params.tags["agentrun.run"]]));
  assert.equal((await api("POST", `/runs/${run.run_id}/cancel`)).status, 202);
  await follow(api, run.run_id, ["cancelled"], { deadlineMs: 60_000 });
  await until(() => vm.running().length === 0, "the box's end");
  assert.deepEqual(await fileList(api, run.run_id), ["kept.txt"], `what the box wrote is kept through the cancel; boxes: ${boxes()}`);
});

test("a run's end lets the relay's hold on its programs go even when its box is kept: a program it holds is no longer read", { timeout: 180_000 }, async (t) => {
  const { api, data } = await onVm(t);
  assert.equal((await api("POST", "/agents", { definition: { id: "asker", name: "asker", instructions: "Probe.", place: PLACE, tools: ["bash", "ask_person"] } })).status, 201);
  const run = await probe(api, "asker", [{ tool: "bash", args: { command: "true" } }, { tool: "ask_person", args: { question: "Go on?" } }]);
  await follow(api, run.run_id, ["input_required"], { deadlineMs: 120_000 });
  const [box] = vm.running();
  // A program the relay holds and nobody reads: as one a run's process started just before it went.
  const { url } = JSON.parse(readFileSync(join(data, BOX_RELAY_FILE), "utf8"));
  const door = readFileSync(join(runDir(data, run.run_id), "door-token"), "utf8").trim();
  const started = await fetch(`${url}/runs/${run.run_id}/vm/sandbox/${box.sandboxId}/exec`, { method: "POST", headers: { authorization: `Bearer ${door}`, "content-type": "application/json" }, body: JSON.stringify({ command: ["sleep", "30"] }) });
  assert.equal(started.status, 200);
  const held = box.execs.find((exec) => exec.command[0] === "sleep");
  assert.deepEqual(held.released, []);
  // Its last copy back cannot be read (a file changed in the box since the turn's pull, and its archive is no archive),
  // so the box is kept at the run's end.
  writeFileSync(join(box.dir, "workspace", "late.txt"), "changed in the box");
  vm.hostileTar = Buffer.from("this is not an archive ".repeat(64));
  assert.equal((await api("POST", `/runs/${run.run_id}/cancel`)).status, 202);
  await follow(api, run.run_id, ["cancelled"], { deadlineMs: 120_000 });
  assert.deepEqual(vm.running().map((sandbox) => sandbox.sandboxId), [box.sandboxId], "the box is kept");
  await until(() => held.released.length === 2, "the relay letting the program's output go");
  assert.deepEqual([...held.released].sort(), ["stderr", "stdout"]);
});

test("a program that is still starting when its run ends is let go as it lands, never held", { timeout: 180_000 }, async (t) => {
  const { api, data } = await onVm(t);
  assert.equal((await api("POST", "/agents", { definition: { id: "asker", name: "asker", instructions: "Probe.", place: PLACE, tools: ["bash", "ask_person"] } })).status, 201);
  const run = await probe(api, "asker", [{ tool: "bash", args: { command: "true" } }, { tool: "ask_person", args: { question: "Go on?" } }]);
  await follow(api, run.run_id, ["input_required"], { deadlineMs: 120_000 });
  const [box] = vm.running();
  const { url } = JSON.parse(readFileSync(join(data, BOX_RELAY_FILE), "utf8"));
  const door = readFileSync(join(runDir(data, run.run_id), "door-token"), "utf8").trim();
  // Its start takes a while; the run ends meanwhile, its box kept (its last copy back cannot be read).
  vm.execDelayMs = (command) => (command[0] === "sleep" ? 20_000 : 0);
  const starting = fetch(`${url}/runs/${run.run_id}/vm/sandbox/${box.sandboxId}/exec`, { method: "POST", headers: { authorization: `Bearer ${door}`, "content-type": "application/json" }, body: JSON.stringify({ command: ["sleep", "30"] }) });
  await until(() => box.execs.some((exec) => exec.command[0] === "sleep"), "the start under way");
  writeFileSync(join(box.dir, "workspace", "late.txt"), "changed in the box");
  vm.hostileTar = Buffer.from("this is not an archive ".repeat(64));
  assert.equal((await api("POST", `/runs/${run.run_id}/cancel`)).status, 202);
  await follow(api, run.run_id, ["cancelled"], { deadlineMs: 120_000 });
  assert.equal(box.execs.find((exec) => exec.command[0] === "sleep").released, undefined, "the run ended before the start landed");
  const late = await starting;
  vm.execDelayMs = 0;
  assert.equal(late.status, 410, await late.text());
  const held = box.execs.find((exec) => exec.command[0] === "sleep");
  await until(() => held.released?.length === 2, "the late program's output let go");
  assert.deepEqual(vm.running().map((sandbox) => sandbox.sandboxId), [box.sandboxId], "the box is kept");
});

test("the VM box never gets a network: with AGENTRUN_BOX_ALLOW set, capabilities and the banner say none and why, and the box is made blocked; with it none, none and no reason", { timeout: 120_000 }, async (t) => {
  const server = await onVm(t, { env: { AGENTRUN_BOX_ALLOW: "pypi.org,*.pythonhosted.org" } });
  const { api, data } = server;
  assert.deepEqual((await api("GET", "/capabilities")).body.places.allow, ["pypi.org", "*.pythonhosted.org"]);
  assert.deepEqual(await vmOffer(api), { id: VM, available: true, state: "ready", reason: "configured; not probed at start", network: "none", network_reason: NO_LIST });
  assert.match(server.boxesLine, new RegExp(`${VM} boxes have no network: ${NO_LIST}\\.`));
  assert.equal((await api("POST", "/agents", { definition: { id: "py", name: "py", instructions: "Probe.", place: PLACE, tools: ["bash"] } })).status, 201);
  const run = await probe(api, "py", [{ tool: "bash", args: { command: "true" } }]);
  await follow(api, run.run_id, ["completed"], { deadlineMs: 90_000 });
  assert.deepEqual(answers(data, run.run_id).map((a) => a.error), [false]);
  assert.deepEqual(vm.sandboxes.map(({ params }) => [params.blockNetwork, params.outboundDomainAllowlist, params.outboundCidrAllowlist]), [[true, undefined, undefined]]);
});

test("AGENTRUN_BOX_ALLOW=none: the VM box has no network, and capabilities give no reason", { timeout: 60_000 }, async (t) => {
  const { api } = await onVm(t, { env: { AGENTRUN_BOX_ALLOW: "none" } });
  assert.deepEqual(await vmOffer(api), { id: VM, available: true, state: "ready", reason: "configured; not probed at start", network: "none" });
});

test("a missing token keeps the VM box unavailable with today's reason, and its client is never made", async (t) => {
  const none = await onVm(t, { keys: {} });
  assert.deepEqual(await vmOffer(none.api), { id: VM, available: false, state: "unavailable", reason: `needs ${VM_PROVIDER.keys.join(" and ")}` });
  const half = await onVm(t, { keys: { [VM_PROVIDER.keys[0]]: TOKENS[VM_PROVIDER.keys[0]] } });
  assert.deepEqual(await vmOffer(half.api), { id: VM, available: false, state: "unavailable", reason: `needs ${VM_PROVIDER.keys[1]}` });
  assert.deepEqual(vm.clients, []);
  const made = await half.api("POST", "/agents", { definition: { id: "remote", name: "remote", instructions: "Probe.", place: PLACE, tools: ["bash"] } });
  assert.equal(made.status, 201);
  assert.match(made.body.warnings[0].message, new RegExp(`needs ${VM_PROVIDER.keys[1]}`));
});

test("the relay takes a run's VM calls only for that run's own box, and never one that ends, tags or makes a box", { timeout: 180_000 }, async (t) => {
  const { api, data } = await onVm(t);
  assert.equal((await api("POST", "/agents", { definition: { id: "asker", name: "asker", instructions: "Probe.", place: PLACE, tools: ["bash", "ask_person"] } })).status, 201);
  const plan = [{ tool: "bash", args: { command: "true" } }, { tool: "ask_person", args: { question: "Go on?" } }];
  const a = await probe(api, "asker", plan);
  const b = await probe(api, "asker", plan);
  for (const run of [a, b]) await follow(api, run.run_id, ["input_required"], { deadlineMs: 120_000 });
  const boxOf = (runId) => vm.running().find((sandbox) => sandbox.params.tags["agentrun.run"] === runId).sandboxId;
  const { url } = JSON.parse(readFileSync(join(data, BOX_RELAY_FILE), "utf8"));
  const tokenOf = (runId) => readFileSync(join(runDir(data, runId), "door-token"), "utf8").trim();
  const call = (runId, path, body, token = tokenOf(runId), signal) => fetch(`${url}/runs/${runId}/vm/${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body ?? {}), ...(signal ? { signal } : {}) });
  assert.equal((await call(a.run_id, `sandbox/${boxOf(a.run_id)}/poll`)).status, 200, "its own box");
  assert.equal((await call(a.run_id, `sandbox/${boxOf(b.run_id)}/poll`)).status, 404, "another run's box is not there for it");
  assert.equal((await call(a.run_id, `sandbox/${boxOf(a.run_id)}/poll`, {}, tokenOf(b.run_id))).status, 401, "another run's token");
  for (const op of ["terminate", "tags/set", "create", "list"]) assert.equal((await call(a.run_id, `sandbox/${boxOf(a.run_id)}/${op}`)).status, 403, op);
  assert.equal(vm.running().length, 2, "nothing was ended");
  // Programs started at once are counted as they start, each start taking a while: past the limit (64 a run), the rest
  // are refused.
  vm.execDelayMs = 200;
  const starts = await Promise.all(Array.from({ length: 70 }, () => call(a.run_id, `sandbox/${boxOf(a.run_id)}/exec`, { command: ["sleep", "1"] })));
  assert.deepEqual([starts.filter((r) => r.status === 200).length, starts.filter((r) => r.status === 429).length], [64, 6]);
  vm.execDelayMs = 0;
  // A program that exits while its output is still on its way is held until that output is delivered whole: its exit
  // read and its other stream done never cut the rest short.
  const big = await (await call(b.run_id, `sandbox/${boxOf(b.run_id)}/exec`, { command: ["head", "-c", "4000000", "/dev/zero"] })).json();
  const slow = await call(b.run_id, `exec/${big.exec}/stdout`);
  assert.equal(await (await call(b.run_id, `exec/${big.exec}/stderr`)).text(), "");
  assert.deepEqual(await (await call(b.run_id, `exec/${big.exec}/wait`)).json(), { code: 0 });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal((await slow.arrayBuffer()).byteLength, 4_000_000, "the whole output, read after the exit");
  await until(async () => (await (await call(b.run_id, `exec/${big.exec}/stdin-close`)).json()).ended === true, "the delivered program let go");
  assert.equal((await call(a.run_id, `exec/${big.exec}/stdin-close`)).status, 404, "another run's ended program is not there for it");
  // A program whose output stream broke has its reply broken, and is let go once its exit is read: it holds no slot.
  vm.failStdout = true;
  const broken = await (await call(b.run_id, `sandbox/${boxOf(b.run_id)}/exec`, { command: ["sh", "-c", "echo one; sleep 0.2; echo two"] })).json();
  vm.failStdout = false;
  await assert.rejects(async () => (await call(b.run_id, `exec/${broken.exec}/stdout`)).arrayBuffer(), "a broken stream is a broken reply, never a short one");
  assert.equal(await (await call(b.run_id, `exec/${broken.exec}/stderr`)).text(), "");
  assert.equal(typeof (await (await call(b.run_id, `exec/${broken.exec}/wait`)).json()).code, "number", "its exit is read");
  await until(async () => (await (await call(b.run_id, `exec/${broken.exec}/stdin-close`)).json()).ended === true, "the broken program let go");
  // What the provider says in an error reaches the run's process cut of every value the server holds: the VM token too.
  vm.failExec = new Error(`permission denied for token ${TOKENS[VM_PROVIDER.keys[1]]} (id ${TOKENS[VM_PROVIDER.keys[0]]})`);
  const refusedStart = await call(b.run_id, `sandbox/${boxOf(b.run_id)}/exec`, { command: ["true"] });
  vm.failExec = undefined;
  const said = await refusedStart.text();
  assert.equal(refusedStart.status, 502, said);
  assert.match(said, /permission denied for token \[redacted\]/);
  for (const value of Object.values(TOKENS)) assert.ok(!said.includes(value), "a held value in the provider's error reached the reply");
  // A program whose exit cannot be read (the provider lost it) is let go once that failure is answered and its output
  // replies ended.
  vm.failWait = true;
  const lost = await (await call(b.run_id, `sandbox/${boxOf(b.run_id)}/exec`, { command: ["true"] })).json();
  vm.failWait = false;
  assert.equal(await (await call(b.run_id, `exec/${lost.exec}/stdout`)).text(), "");
  assert.equal(await (await call(b.run_id, `exec/${lost.exec}/stderr`)).text(), "");
  assert.equal((await call(b.run_id, `exec/${lost.exec}/wait`)).status, 502, "the exit's failure is answered");
  await until(async () => (await (await call(b.run_id, `exec/${lost.exec}/stdin-close`)).json()).ended === true, "the lost program let go");
  const lateExit = await call(b.run_id, `exec/${lost.exec}/wait`);
  assert.equal(lateExit.status, 502, "an exit that could not be read still fails once its program was let go, never a code");
  assert.ok((await lateExit.json()).failure, "with the provider's failure");
  // A reader that goes away lets its program go: what it held is dropped, and the program is no longer the run's to ask.
  const started = await call(b.run_id, `sandbox/${boxOf(b.run_id)}/exec`, { command: ["yes"] });
  assert.equal(started.status, 200);
  const { exec } = await started.json();
  const reading = new AbortController();
  const reader = (await call(b.run_id, `exec/${exec}/stdout`, undefined, undefined, reading.signal)).body.getReader();
  assert.ok((await reader.read()).value.length > 0, "its output flows");
  reading.abort();
  await reader.cancel().catch(() => undefined);
  await until(async () => (await call(b.run_id, `exec/${exec}/stdin-close`)).status === 404, "the program let go");
  for (const run of [a, b]) assert.equal((await api("POST", `/runs/${run.run_id}/cancel`)).status, 202);
});

test("a program's input closed after the relay let the ended program go is answered as already ended, and the run's call does not fail; a program it never had is still not there", { timeout: 180_000 }, async (t) => {
  const { api, data } = await onVm(t);
  assert.equal((await api("POST", "/agents", { definition: { id: "asker", name: "asker", instructions: "Probe.", place: PLACE, tools: ["bash", "ask_person"] } })).status, 201);
  const run = await probe(api, "asker", [{ tool: "bash", args: { command: "true" } }, { tool: "ask_person", args: { question: "Go on?" } }]);
  await follow(api, run.run_id, ["input_required"], { deadlineMs: 120_000 });
  const [box] = vm.running();
  // Through the run's own client (pi-transport's provider over the relay's client): the program's exit reaches the caller
  // only after its input's close was answered, as on a loaded machine, so the close lands after the relay let it go.
  const transport = await import(`@parcha/pi-transport/box/${VM}`);
  const sdk = relayVm.relayedVmSdk(data, runDir(data, run.run_id), run.run_id);
  let holding = false;
  let answered;
  const exitAnswered = new Promise((resolve) => (answered = resolve));
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const holdingSdk = { ...sdk, sandboxes: { ...sdk.sandboxes, fromId: async (id) => {
    const sandbox = await sdk.sandboxes.fromId(id);
    return { ...sandbox, exec: async (command, params) => {
      const program = await sandbox.exec(command, params);
      return holding ? { ...program, wait: async () => {
        const code = await program.wait();
        answered();
        await held;
        return code;
      } } : program;
    } };
  } } };
  const attached = await transport.modalBoxes(holdingSdk, { appName: "relayed" }).attach(box.sandboxId, {});
  assert.ok(attached.ok && attached.value, attached.error?.message);
  holding = true;
  const started = await attached.value.exec(["sh", "-c", "exit 0"], undefined, {});
  assert.ok(started.ok, started.error?.message);
  const program = started.value;
  const drained = async (stream) => {
    for await (const _ of stream);
  };
  const exit = program.wait();
  // Its exit answered and both outputs read whole: the relay has let it go.
  await Promise.all([drained(program.stdout), drained(program.stderr), exitAnswered]);
  await program.stdin.close();
  release();
  const result = await exit;
  assert.equal(result.ok ? result.value : result.error.message, 0, "the call does not fail");
  // At the relay: a late call of a program let go after its exit is no error; one it never had is still not there.
  const { url } = JSON.parse(readFileSync(join(data, BOX_RELAY_FILE), "utf8"));
  const door = readFileSync(join(runDir(data, run.run_id), "door-token"), "utf8").trim();
  const call = (path, body = {}) => fetch(`${url}/runs/${run.run_id}/vm/${path}`, { method: "POST", headers: { authorization: `Bearer ${door}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const { exec } = await (await call(`sandbox/${box.sandboxId}/exec`, { command: ["sh", "-c", "exit 3"] })).json();
  assert.deepEqual([await (await call(`exec/${exec}/stdout`)).text(), await (await call(`exec/${exec}/stderr`)).text(), await (await call(`exec/${exec}/wait`)).json()], ["", "", { code: 3 }]);
  const late = await call(`exec/${exec}/stdin-close`);
  assert.deepEqual([late.status, await late.json()], [200, { ended: true }], "its input's close, after it was let go");
  assert.deepEqual(await (await call(`exec/${exec}/wait`)).json(), { code: 3, ended: true }, "its exit is still its exit");
  assert.equal((await call(`exec/${exec}/stdout`)).status, 410, "its output is no longer held: a read fails, never comes back short");
  const unknown = await call("exec/no-such-program/stdin-close");
  assert.deepEqual([unknown.status, await unknown.json()], [404, { message: "no such program" }], "a program it never had");
  assert.equal((await api("POST", `/runs/${run.run_id}/cancel`)).status, 202);
});

test("the run's relay client waits on a program as long as it runs: its exit and its output have no clock of their own, where a client with one fails the call", { timeout: 60_000 }, async (t) => {
  vm.reset();
  t.after(() => vm.reset());
  const root = await scratch(t);
  const runDir = join(root, "runs", "r1");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "door-token"), "door-of-r1\n");
  const client = new FakeClient({});
  const box = await client.sandboxes.create({}, {}, { tags: { "agentrun.run": "r1" }, timeoutMs: 60_000 });
  const relay = await startBoxRelay({ root, tokenOf: (id) => (id === "r1" ? "door-of-r1" : undefined), vm: relayVm.vmRelay(client), serves: () => true, ensure: async () => ({ id: box.sandboxId, made: false }) });
  t.after(() => relay.close());
  const read = async (stream) => {
    let text = "";
    for await (const chunk of stream) text += new TextDecoder().decode(chunk);
    return text;
  };
  const run = async (sdk) => {
    const sandbox = await sdk.sandboxes.fromId(box.sandboxId);
    const program = await sandbox.exec(["sh", "-c", "echo a; sleep 2; echo b"], { mode: "binary" });
    return Promise.all([read(program.stdout), read(program.stderr), program.wait()]);
  };
  // Node's fetch gives up after 300 s with no answer (headers) or no bytes (body): shrunk here to 1 s, the same failure.
  const clocked = await run(relayVm.relayedVmSdk(root, runDir, "r1", { headersTimeout: 1000, bodyTimeout: 1000 })).catch((error) => error);
  assert.ok(clocked instanceof Error, "a client with a clock fails a program that outlasts it");
  assert.match(String(clocked.cause?.code ?? clocked.code), /^UND_ERR_(HEADERS|BODY)_TIMEOUT$/);
  // The relay's own client has none: the program's caller bounds it.
  assert.deepEqual({ ...relayVm.RELAY_AGENT_OPTIONS }, { headersTimeout: 0, bodyTimeout: 0 });
  assert.deepEqual(await run(relayVm.relayedVmSdk(root, runDir, "r1")), ["a\nb\n", "", 0]);
});

test("a start whose run ends while its sandbox is still looked up is let go as it lands; an ended run leaves the relay nothing", { timeout: 60_000 }, async (t) => {
  vm.reset();
  t.after(() => vm.reset());
  const root = await scratch(t);
  const runDir = join(root, "runs", "r1");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "door-token"), "door-of-r1\n");
  const client = new FakeClient({});
  const box = await client.sandboxes.create({}, {}, { tags: { "agentrun.run": "r1" }, timeoutMs: 60_000 });
  const relayVmHalf = relayVm.vmRelay(client);
  const relay = await startBoxRelay({ root, tokenOf: (id) => (id === "r1" ? "door-of-r1" : undefined), vm: relayVmHalf, serves: () => true, ensure: async () => ({ id: box.sandboxId, made: false }) });
  t.after(() => relay.close());
  // The relay has not looked this sandbox up yet, and the lookup takes a while: the run ends meanwhile.
  vm.lookupDelayMs = 1500;
  const starting = fetch(`${relay.url}/runs/r1/vm/sandbox/${box.sandboxId}/exec`, { method: "POST", headers: { authorization: "Bearer door-of-r1", "content-type": "application/json" }, body: JSON.stringify({ command: ["sleep", "30"] }) });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const during = relayVmHalf.footprint?.();
  relayVmHalf.drop("r1");
  const late = await starting;
  assert.equal(late.status, 410, await late.text());
  const held = box.execs.find((exec) => exec.command[0] === "sleep");
  await until(() => held.released?.length === 2, "the late program's output let go");
  assert.deepEqual(during, { programs: 0, starting: 1 }, "the start was under way from its request");
  // Runs that end, many of them, leave the relay holding nothing for them.
  vm.lookupDelayMs = 0;
  for (let i = 0; i < 50; i++) relayVmHalf.drop(`ended-${i}`);
  assert.deepEqual(relayVmHalf.footprint(), { programs: 0, starting: 0 });
});

// So the fixture's directory exists before any box writes its spool there.
mkdirSync(vm.root, { recursive: true });
writeFileSync(join(vm.root, ".keep"), "");
