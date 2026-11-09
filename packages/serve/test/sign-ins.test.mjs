// An agent's browser stays signed in: the cookies stay at the browser's vendor (a Browserbase context, a Kernel profile),
// this server keeps one sealed pointer per agent and vendor in the agent's home, and a run's process gets the pointer
// over its secrets' pipe, never its environment. The first run of an agent to start with the browser holds the save
// lease; one started meanwhile starts signed in and saves nothing; the lease ends with its run. GET /agents/{id} lists
// the sign-ins, never a pointer; DELETE forgets one at the vendor and here, refused while held. No network: the
// vendors are the tests' fakes.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { chmod, cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { homeOf, writeDurable } from "../dist/files.js";
import { BROWSERBASE_SETTLE_MS, GONE_LEASE_MS, MAX_FORGOTTEN, SIGN_IN_SAVED, SignIns, vendorOf, vendorsOver } from "../dist/sign-ins.js";
import { keptContexts, keptProfile, savedOnRelease } from "../dist/tools.js";
import { openapiDocument } from "../dist/openapi.js";
import { WITHHELD_SIGN_IN } from "../dist/runs.js";
import { learningTestHooks } from "../dist/learning.js";
import { calls as bbCalls, contexts, KEY as BB_KEY } from "./fixtures/faux-browserbase-check.mjs";
import { KEY as KERNEL_KEY } from "./fixtures/faux-kernel-check.mjs";
import { agent, answerFlow, client, FAUX, flowAgent, follow, runDir, runRecordOf, scratch, serve, storeRun, withEnv } from "./support.mjs";
import { ended, LEARN, learner, made, objects, repoOf, started } from "./learn-support.mjs";
import { note } from "./fixtures/faux-learn.mjs";
import { saveSignIn, signInsOverStore } from "../dist/sign-ins-store.js";
import { agentWithRevision, storeOn } from "./store-helpers.mjs";

const FAUX_BROWSER = new URL("./fixtures/faux-browser.mjs", import.meta.url).pathname;
const FAUX_BROWSERBASE = new URL("./fixtures/faux-browserbase-check.mjs", import.meta.url).pathname;
const FAUX_KERNEL = new URL("./fixtures/faux-kernel-check.mjs", import.meta.url).pathname;
const KEYS = ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID", "BROWSERBASE_BASE_URL", "BROWSERBASE_CONNECT_BASE_URL", "KERNEL_API_KEY", "AGENTRUN_SEAL_KEY", "FAUX_BROWSER_LOG", "FAUX_BROWSER_DIE_WITH_REF", "FAUX_BROWSER_REFUSE_WITH_REF", "AGENTRUN_TEST_FAUX_BROWSERBASE_CONTEXTS_DOWN"];

/** A store over `data` with fake vendors: each made object named in turn, each removal recorded (or refused). */
function fakeStore(data, { key = randomBytes(32), running = new Set(), refuseRemove = false, now, handedTo } = {}) {
  const made = [];
  const removed = [];
  const vendors = {
    create: async (vendor) => (made.push(`${vendor === "kernel" ? "agentrun-kernel" : "ctx"}-${made.length + 1}`), made.at(-1)),
    remove: async (vendor, ref) => {
      if (refuseRemove) throw new Error(`${vendor} answered 500`);
      removed.push([vendor, ref]);
    },
  };
  return { store: new SignIns(data, key, vendors, async (run) => running.has(run), { ...(now ? { now } : {}), ...(handedTo ? { handedTo } : {}) }), made, removed, running, key };
}

test("the save lease: the first run takes it, a run started while it holds gets the same sign-in with save false, and it ends with its run (released, or its run ended without a release)", async (t) => {
  const data = await scratch(t);
  const clock = { now: Date.parse("2026-11-05T02:00:00.000Z") };
  const { store, made, running } = fakeStore(data, { now: () => clock.now });
  running.add("run-1");
  const one = await store.forRun("alpha", "run-1", "browserbase");
  running.add("run-2");
  const two = await store.forRun("alpha", "run-2", "browserbase");
  assert.deepEqual([one.save, two.save, two.ref], [true, false, one.ref], "the second starts signed in and saves nothing");
  assert.deepEqual(await store.view("alpha"), [{ key: "default", provider: "browserbase", state: "held", held_by: "run-1", verified_at: null }]);
  // The holder launched again (its process went and came back) keeps saving.
  assert.equal((await store.forRun("alpha", "run-1", "browserbase")).save, true);
  // A release by a run that holds nothing changes nothing.
  const dir2 = await scratch(t);
  await store.release("alpha", "run-2", dir2);
  assert.equal((await store.view("alpha"))[0].held_by, "run-1");
  // The holder's release, after a session that saved: verified at that time, and, Browserbase writing the context back
  // after its session ends, held for the run that saved until that is done; then ready.
  const dir1 = await scratch(t);
  await writeFile(join(dir1, SIGN_IN_SAVED), "2026-11-05T01:02:03.000Z");
  await store.release("alpha", "run-1", dir1);
  assert.deepEqual(await store.view("alpha"), [{ key: "default", provider: "browserbase", state: "held", held_by: "run-1", verified_at: "2026-11-05T01:02:03.000Z" }]);
  running.add("run-9");
  assert.equal((await store.forRun("alpha", "run-9", "browserbase")).save, false, "a run started while it is written back saves nothing over it");
  clock.now += BROWSERBASE_SETTLE_MS;
  assert.deepEqual(await store.view("alpha"), [{ key: "default", provider: "browserbase", state: "ready", held_by: null, verified_at: "2026-11-05T01:02:03.000Z" }]);
  await assert.rejects(readFile(join(dir1, SIGN_IN_SAVED)), "the mark is taken");
  // A lease whose run ended with no release (a server that went down first) is stale: the next run takes it.
  running.add("run-3");
  assert.equal((await store.forRun("alpha", "run-3", "browserbase")).save, true);
  running.delete("run-3");
  assert.equal((await store.view("alpha"))[0].state, "ready");
  assert.equal((await store.forRun("alpha", "run-4", "browserbase")).save, true);
  // Kernel: its own sign-in beside Browserbase's, a profile of its own made at Kernel.
  const kernel = await store.forRun("alpha", "run-4", "kernel");
  assert.deepEqual(kernel, { provider: "kernel", ref: made[1], save: true });
  assert.equal(made.length, 2);
  assert.deepEqual((await store.view("alpha")).map((s) => s.provider), ["browserbase", "kernel"]);
  // Kernel saves as its browser ends: its saver's lease goes with the run, Browserbase's after its write-back.
  const dir4 = await scratch(t);
  await writeFile(join(dir4, SIGN_IN_SAVED), "2026-11-05T03:00:00.000Z");
  await store.release("alpha", "run-4", dir4);
  assert.deepEqual((await store.view("alpha")).map((s) => [s.provider, s.state]), [["browserbase", "held"], ["kernel", "ready"]]);
});

test("local Chrome keeps no saved sign-in, refused by name; an unavailable browser has none", async (t) => {
  const { store } = fakeStore(await scratch(t));
  for (const name of ["chrome", "cdp"]) {
    assert.throws(() => vendorOf(name), /a local Chrome keeps no saved sign-in: its cookies would sit on this server's disk/);
    await assert.rejects(store.forRun("alpha", "run-1", name), /local Chrome keeps no saved sign-in/);
  }
  assert.equal(await store.forRun("alpha", "run-1", "unavailable: browserbase picked, no BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID"), undefined);
  assert.deepEqual(await store.view("alpha"), []);
});

test("the vendors' calls: Browserbase's context made with the project and deleted by id; Kernel's profile made under a random name, never one derived from the agent, and deleted by name", async () => {
  const asked = [];
  const fake = async (url, init) => (asked.push([init.method, String(url), init.headers, init.body ?? null]), init.method !== "POST" ? new Response(null, { status: 404 }) : String(url).endsWith("/profiles") ? Response.json({ id: "prof-1", name: JSON.parse(init.body).name }) : Response.json({ id: "ctx-9" }));
  const env = { BROWSERBASE_API_KEY: "bb-key", BROWSERBASE_PROJECT_ID: "proj-1", KERNEL_API_KEY: "k-key" };
  const vendors = vendorsOver(() => env, async () => fake);
  assert.equal(await vendors.create("browserbase"), "ctx-9");
  const [one, two] = [await vendors.create("kernel"), await vendors.create("kernel")];
  for (const name of [one, two]) assert.match(name, /^agentrun-[0-9a-f]{24}$/, "random, and well inside pi-browser's 64 characters");
  assert.notEqual(one, two);
  await vendors.remove("browserbase", "ctx-9");
  await vendors.remove("kernel", one);
  assert.deepEqual(asked.map(([method, url, headers, body]) => [method, url, headers["x-bb-api-key"] ?? headers.authorization, body]), [
    ["POST", "https://api.browserbase.com/v1/contexts", "bb-key", JSON.stringify({ projectId: "proj-1" })],
    ["POST", "https://api.onkernel.com/profiles", "Bearer k-key", JSON.stringify({ name: one })],
    ["POST", "https://api.onkernel.com/profiles", "Bearer k-key", JSON.stringify({ name: two })],
    ["DELETE", "https://api.browserbase.com/v1/contexts/ctx-9", "bb-key", null],
    ["DELETE", `https://api.onkernel.com/profiles/${one}`, "Bearer k-key", null],
  ], "a 404 on delete is gone already");
  const otherName = vendorsOver(() => env, async () => async () => Response.json({ id: "prof-2", name: "someone-else" }));
  await assert.rejects(otherName.create("kernel"), /another profile/);
  await assert.rejects(vendorsOver(() => env, async () => undefined).create("browserbase"), /no browserbase to call/);
});

test("in the run: Browserbase opens the agent's context as the profile `default` and never makes one; Kernel's create is asked for the agent's profile by its name at Kernel", async () => {
  const store = keptContexts("ctx-7");
  assert.equal(await store.resolve("acct|profile:default", () => assert.fail("made")), "ctx-7");
  await assert.rejects(store.resolve("acct|profile:other", () => "made"), /no saved sign-in/);
  await assert.rejects(keptContexts(undefined).resolve("acct|profile:default", () => "made"), /no saved sign-in/);
  const asked = [];
  const kernel = keptProfile({ name: "kernel", create: async (spec) => asked.push(spec.profile ?? null) }, "agentrun-0123456789abcdef01234567");
  await kernel.create({ profile: { name: "default", save: false } });
  await kernel.create({});
  assert.deepEqual(asked, [{ name: "agentrun-0123456789abcdef01234567", save: false }, null]);
  assert.equal(kernel.name, "kernel");
});

/** Polls `read` until `ok` holds of what it answers, for at most 20 s. */
async function until(read, ok) {
  for (const end = Date.now() + 20_000; ;) {
    const value = await read();
    if (ok(value)) return value;
    assert.ok(Date.now() < end, `never: ${JSON.stringify(value)}`);
    await new Promise((go) => setTimeout(go, 100));
  }
}

test("through the API: an agent's first run holds the sign-in and saves; one started meanwhile starts from it and saves nothing; later runs start from it; another agent never sees it; forget is refused while held, then deletes it", { timeout: 180_000 }, async (t) => {
  const dir = await scratch(t);
  const log = join(dir, "browser.jsonl");
  withEnv(t, { BROWSERBASE_API_KEY: BB_KEY, BROWSERBASE_PROJECT_ID: "proj-1", AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64"), FAUX_BROWSER_LOG: log }, KEYS);
  const { api, data } = await serve(t, { fauxBrowser: FAUX_BROWSER, fauxBrowserbase: FAUX_BROWSERBASE });
  const caps = (await api("GET", "/capabilities")).body;
  assert.equal(caps.features.sign_ins, true);
  assert.deepEqual(caps.home.host_owned, ["learning", "sign-ins"]);
  for (const id of ["alpha", "beta"]) assert.equal((await api("POST", "/agents", agent(id, { instructions: "Browse.", tools: ["browser"] }))).status, 201);
  assert.deepEqual((await api("GET", "/agents/alpha")).body.sign_ins, []);
  const made = bbCalls.length;
  const lines = async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const start = async (id, content) => {
    const started = await api("POST", `/agents/${id}/runs`, { input: { content } });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    return started.body.run_id;
  };
  const signIns = async (id) => (await api("GET", `/agents/${id}`)).body.sign_ins;

  // alpha's first run holds the lease from its start, and its session saves; it waits on a file, its browser open.
  const gate = join(dir, "gate");
  const first = await start("alpha", `Browse the example page once ${gate} exists.`);
  assert.deepEqual(await signIns("alpha"), [{ key: "default", provider: "browserbase", state: "held", held_by: first, verified_at: null }]);
  const opened = await until(lines, (ops) => ops.some((op) => op.op === "profile"));
  const handed = opened.find((op) => op.op === "sign-in");
  assert.deepEqual([handed.provider, handed.save, handed.ref_in_env], ["browserbase", true, false], "over its pipe, never in its environment");
  assert.deepEqual(opened.filter((op) => op.op === "profile"), [{ op: "profile", name: "default", save: true }], "the profile asked for by its name here, never the context");
  const forgetHeld = await api("DELETE", "/agents/alpha/sign-ins/default");
  assert.deepEqual([forgetHeld.status, forgetHeld.body.error.code, forgetHeld.body.error.details.held_by], [409, "sign_in_held", first]);

  // A second run of alpha meanwhile: the same sign-in, saving nothing.
  const before = opened.length;
  const second = await start("alpha", "Browse the example page.");
  await follow(api, second, ["completed"]);
  const during = (await lines()).slice(before);
  assert.deepEqual(during.filter((op) => op.op === "sign-in").map((op) => [op.ref, op.save, op.ref_in_env]), [[handed.ref, false, false]]);
  assert.deepEqual(during.filter((op) => op.op === "profile"), [{ op: "profile", name: "default", save: false }]);
  assert.equal((await signIns("alpha"))[0].held_by, first, "still the first run's");

  // The first run ends: the lease with it, and the sign-in verified when its saving session let go.
  await writeFile(gate, "");
  const { rows } = await follow(api, first, ["completed"], { deadlineMs: 60_000 });
  assert.ok(rows.some((row) => JSON.stringify(row).includes("snapshot")), "it browsed");
  for (const shown of [rows, (await api("GET", `/runs/${first}`)).body, await readFile(join(runDir(data, first), "serve.json"), "utf8")]) assert.ok(!JSON.stringify(shown).includes(handed.ref), "no pointer in its timeline, its view or its record");
  const ready = await until(() => signIns("alpha"), (list) => list[0]?.state === "ready");
  assert.equal(ready[0].held_by, null);
  assert.ok(Date.parse(ready[0].verified_at) > 0, JSON.stringify(ready));

  // alpha's next run starts from the same context and holds the lease now; beta gets a context of its own.
  const mark = (await lines()).length;
  await follow(api, await start("alpha", "Browse the example page."), ["completed"]);
  const third = (await lines()).slice(mark).filter((op) => op.op === "sign-in");
  assert.deepEqual(third.map((op) => [op.ref, op.save]), [[handed.ref, true]]);
  const betaMark = (await lines()).length;
  await follow(api, await start("beta", "Browse the example page."), ["completed"]);
  const beta = (await lines()).slice(betaMark).filter((op) => op.op === "sign-in");
  assert.equal(beta.length, 1);
  assert.notEqual(beta[0].ref, handed.ref, "beta never gets alpha's");
  assert.equal(beta[0].save, true);
  const contextsMade = bbCalls.slice(made).filter((call) => call.method === "POST" && call.path === "/v1/contexts");
  assert.deepEqual(contextsMade.map((call) => [call.authorized, call.body]), [[true, { projectId: "proj-1" }], [true, { projectId: "proj-1" }]], "one context per agent, made once");

  // Never a pointer through the API: not in the agent, nor through the home's files, nor in the clear on disk.
  for (const id of ["alpha", "beta"]) {
    const body = JSON.stringify((await api("GET", `/agents/${id}`)).body);
    assert.ok(!body.includes(handed.ref) && !body.includes(beta[0].ref), body);
    assert.ok(!JSON.stringify((await api("GET", "/agents")).body).includes(handed.ref));
    const listed = (await api("GET", `/agents/${id}/home/files`)).body.files;
    // Sign-ins are store rows: nothing of them sits in the home, so it lists no host-owned entry (the name stays reserved).
    assert.deepEqual(listed.filter((file) => file.host_owned).map((file) => file.path), []);
    const signInsFile = [`/agents/${id}`, "home", "files", "sign-ins", "sign-ins.json"].join("/");
    const read = await api("GET", signInsFile);
    assert.deepEqual([read.status, read.body.error.details.reason], [403, "host_owned"]);
    assert.match(read.body.error.message, new RegExp(`read it through /v2/agents/${id}$`));
    const written = await api("PUT", signInsFile, { format: "sign-ins/1", sign_ins: [] });
    assert.equal(written.status, 403);
  }
  const onDisk = await readFile(join(homeOf(data, "alpha"), "sign-ins", "sign-ins.json"), "utf8");
  assert.ok(!onDisk.includes(handed.ref));

  // Forgotten, once alpha's last saving run's context is written back: deleted at Browserbase, the pointer gone, beta's kept.
  assert.ok(contexts.has(handed.ref));
  await until(() => signIns("alpha"), (list) => list[0]?.state === "ready");
  const forgot = await api("DELETE", "/agents/alpha/sign-ins/default");
  assert.deepEqual([forgot.status, forgot.body], [200, { key: "default", removed: [{ provider: "browserbase", at_vendor: "deleted" }] }]);
  assert.ok(bbCalls.some((call) => call.method === "DELETE" && call.path === `/v1/contexts/${handed.ref}` && call.authorized));
  assert.ok(!contexts.has(handed.ref) && contexts.has(beta[0].ref));
  assert.deepEqual(await signIns("alpha"), []);
  assert.equal((await signIns("beta")).length, 1);
  assert.equal((await api("DELETE", "/agents/alpha/sign-ins/default")).status, 404);
  assert.equal((await api("DELETE", "/agents/nobody/sign-ins/default")).status, 404);
});

test("a run's save lease outlives its process until the run ends: a server that stops with it mid-browse leaves the lease with it, for its relaunch, never for another run to take while its session may still write back", { timeout: 120_000 }, async (t) => {
  const dir = await scratch(t);
  const log = join(dir, "browser.jsonl");
  const seal = randomBytes(32);
  withEnv(t, { BROWSERBASE_API_KEY: BB_KEY, BROWSERBASE_PROJECT_ID: "proj-1", AGENTRUN_SEAL_KEY: seal.toString("base64"), FAUX_BROWSER_LOG: log }, KEYS);
  const server = await serve(t, { fauxBrowser: FAUX_BROWSER, fauxBrowserbase: FAUX_BROWSERBASE });
  assert.equal((await server.api("POST", "/agents", agent("alpha", { instructions: "Browse.", tools: ["browser"] }))).status, 201);
  const started = await server.api("POST", "/agents/alpha/runs", { input: { content: `Browse the example page once ${join(dir, "never")} exists.` } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await until(async () => (await readFile(log, "utf8").catch(() => "")), (text) => text.includes('"op":"profile"'));
  await server.close();
  const view = await new SignIns(server.data, seal, {}, async () => true).view("alpha");
  assert.deepEqual(view.map((s) => [s.state, s.held_by]), [["held", started.body.run_id]]);
  const [entry] = JSON.parse(await readFile(join(homeOf(server.data, "alpha"), "sign-ins", "sign-ins.json"), "utf8")).sign_ins;
  assert.ok(Date.parse(entry.gone_at) > 0, "its process found gone, from when");
});

test("a lease whose holder's process is gone lasts no longer than a session it opened could: then another run takes it; a holder that comes back holds it again", async (t) => {
  const { DEFAULT_BROWSER_POLICY } = await import("@parcha/pi-browser");
  assert.equal(GONE_LEASE_MS, DEFAULT_BROWSER_POLICY.sessionTimeoutS * 1000, "pi-browser's session timeout");
  let now = Date.parse("2026-11-05T00:00:00.000Z");
  const data = await scratch(t);
  const made = [];
  const store = new SignIns(data, randomBytes(32), { create: async () => (made.push(`ctx-${made.length + 1}`), made.at(-1)) }, async () => true, { now: () => now });
  await store.forRun("alpha", "run-1", "browserbase");
  await store.markGone("alpha", "run-1");
  now += GONE_LEASE_MS - 1000;
  assert.equal((await store.forRun("alpha", "run-2", "browserbase")).save, false, "a session it opened may still write back");
  now += 1000 + BROWSERBASE_SETTLE_MS;
  assert.equal((await store.view("alpha"))[0].state, "ready");
  assert.equal((await store.forRun("alpha", "run-3", "browserbase")).save, true);
  // run-3's process goes and comes back (its relaunch): the lease is its again, with no clock on it.
  await store.markGone("alpha", "run-3");
  assert.equal((await store.forRun("alpha", "run-3", "browserbase")).save, true);
  now += 2 * GONE_LEASE_MS;
  assert.deepEqual((await store.view("alpha")).map((s) => [s.state, s.held_by]), [["held", "run-3"]]);
});

test("a pointer that does not open under this server's seal key reads unreadable, never ready: no run starts from it and none is made in its place until it is forgotten", async (t) => {
  const data = await scratch(t);
  const { store, made } = fakeStore(data);
  await store.forRun("alpha", "run-1", "browserbase");
  const vendors = { create: async () => assert.fail("made in its place"), remove: async () => assert.fail("no pointer to delete with") };
  for (const key of [randomBytes(32), undefined]) {
    const other = new SignIns(data, key, vendors, async () => true);
    assert.deepEqual(await other.view("alpha"), [{ key: "default", provider: "browserbase", state: "unreadable", held_by: "run-1", verified_at: null }], key ? "another seal key" : "none");
  }
  const rotated = new SignIns(data, randomBytes(32), vendors, async () => false);
  await assert.rejects(rotated.forRun("alpha", "run-2", "browserbase"), /does not open under this server's seal key: forget it \(DELETE \/v2\/agents\/alpha\/sign-ins\/default\)/);
  assert.equal(made.length, 1);
  const forgot = await rotated.forget("alpha", "default");
  assert.deepEqual(forgot.removed, [{ provider: "browserbase", at_vendor: "not_deleted", message: "Not deleted at browserbase: its pointer does not open under this server's seal key. This server no longer points to it." }]);
  assert.deepEqual(await rotated.view("alpha"), []);
  const state = openapiDocument(() => undefined).components.schemas.SignIn.properties.state;
  assert.deepEqual([state.enum, state["x-agentrun-serve"]], [["ready", "held", "unreadable"], "signins/1"]);
});

test("verified_at counts only a session that saved: one let go by the run, never one the vendor had lost or never made", () => {
  const row = (releaseReason, { profile = "default", resourceId = "sess-1" } = {}) => ({ session: { resourceId, releaseReason, settings: { profile } } });
  for (const reason of ["tool", "idle", "relaunch", "close", "ended"]) assert.equal(savedOnRelease(row(reason), "released"), true, reason);
  for (const reason of ["lost", "create_failed", null]) assert.equal(savedOnRelease(row(reason), "released"), false, String(reason));
  assert.equal(savedOnRelease(row("close", { profile: null }), "released"), true, "its record names no profile, yet it ran on the run's (asHanded)");
  assert.equal(savedOnRelease(row("close", { resourceId: null }), "released"), false, "never made");
  assert.equal(savedOnRelease(row("close"), "updated"), false, "not let go");
});

test("a Kernel saving run whose session is refused in words that name its profile never shows the model its pointer: the browser's own redaction knows it", { timeout: 120_000 }, async (t) => {
  const dir = await scratch(t);
  const log = join(dir, "browser.jsonl");
  withEnv(t, { KERNEL_API_KEY: KERNEL_KEY, AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64"), FAUX_BROWSER_LOG: log, FAUX_BROWSER_REFUSE_WITH_REF: "1" }, KEYS);
  const { api, data } = await serve(t, { fauxBrowser: FAUX_BROWSER, fauxKernel: FAUX_KERNEL });
  assert.equal((await api("POST", "/agents", agent("alpha", { instructions: "Browse.", tools: ["browser"] }))).status, 201);
  const started = await api("POST", "/agents/alpha/runs", { input: { content: "Browse the example page." } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["completed", "failed"], { deadlineMs: 60_000 });
  const handed = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line)).find((op) => op.op === "sign-in");
  assert.deepEqual([handed.provider, handed.save], ["kernel", true]);
  // What the model was given, as its run's own store keeps it (before anything this server serves is cut).
  const files = (await readdir(join(runDir(data, started.body.run_id)), { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
  const raw = Buffer.concat(await Promise.all(files.map((file) => readFile(file))));
  assert.ok(raw.includes("one session at a time may save to a profile"), "the refusal reached the model");
  assert.ok(!raw.includes(handed.ref), "with its pointer cut");
});

test("a vendor call that fails before an answer says only which vendor and the error's kind, never its URL, which holds the pointer: so DELETE's answer never carries it", async (t) => {
  const pointer = "agentrun-0123456789abcdef01234567";
  for (const [vendor, env] of [["kernel", { KERNEL_API_KEY: "k", KERNEL_BASE_URL: "kernel.example" }], ["browserbase", { BROWSERBASE_API_KEY: "b", BROWSERBASE_BASE_URL: "browserbase.example" }]]) {
    const vendors = vendorsOver(() => env, async () => fetch);
    await assert.rejects(vendors.remove(vendor, pointer), (error) => error.message === `${vendor} unreachable (TypeError)`);
  }
  // The forget over the store (the switch's signInsOverStore) with those vendors: its answer says the kind, never the URL.
  const { store } = await storeOn(t);
  await agentWithRevision(store, "alpha", "alpha-rev");
  const key = randomBytes(32);
  await saveSignIn(store, key, { agentId: "alpha", provider: "kernel", pointer });
  const answer = await signInsOverStore(store, key, vendorsOver(() => ({ KERNEL_API_KEY: "k", KERNEL_BASE_URL: "kernel.example" }), async () => fetch)).forget("alpha", "default");
  assert.deepEqual(answer.removed, [{ provider: "kernel", at_vendor: "not_deleted", message: "Not deleted at kernel: kernel unreachable (TypeError). This server no longer points to it." }]);
  assert.ok(!JSON.stringify(answer).includes(pointer));
});

test("a Browserbase lease whose holder's process is gone outlasts the longest session it could have opened by that session's write-back; Kernel's, which saves as its browser ends, does not", async (t) => {
  let now = Date.parse("2026-11-05T04:00:00.000Z");
  const store = new SignIns(await scratch(t), randomBytes(32), { create: async (vendor) => `${vendor}-pointer-1` }, async () => true, { now: () => now });
  for (const vendor of ["browserbase", "kernel"]) await store.forRun("alpha", "run-1", vendor);
  await store.markGone("alpha", "run-1");
  now += GONE_LEASE_MS;
  assert.deepEqual((await store.view("alpha")).map((s) => [s.provider, s.state]), [["browserbase", "held"], ["kernel", "ready"]]);
  now += BROWSERBASE_SETTLE_MS - 1;
  assert.equal((await store.forRun("alpha", "run-2", "browserbase")).save, false, "a second short of its write-back");
  now += 1;
  assert.equal((await store.forRun("alpha", "run-3", "browserbase")).save, true);
});

test("a Browserbase saver resumed while its own last save is still being written back waits that out before it saves again", async (t) => {
  let now = Date.parse("2026-11-05T05:00:00.000Z");
  const slept = [];
  const store = new SignIns(await scratch(t), randomBytes(32), { create: async () => "ctx-1" }, async () => true, { now: () => now, sleep: async (ms) => void (slept.push(ms), (now += ms)) });
  await store.forRun("alpha", "run-1", "browserbase");
  const dir = await scratch(t);
  await writeFile(join(dir, SIGN_IN_SAVED), new Date(now).toISOString());
  await store.release("alpha", "run-1", dir);
  now += 3_000;
  assert.deepEqual(await store.forRun("alpha", "run-1", "browserbase"), { provider: "browserbase", ref: "ctx-1", save: true });
  assert.deepEqual(slept, [BROWSERBASE_SETTLE_MS - 3_000], "the rest of its write-back, then saving");
  assert.deepEqual((await store.view("alpha")).map((s) => [s.state, s.held_by]), [["held", "run-1"]]);
  // Past it, nothing to wait for.
  await store.forRun("alpha", "run-1", "browserbase");
  assert.equal(slept.length, 1);
});

test("a run's end lets its lease go only when its process let its sessions go: after a crash the lease stays with it, by the gone rule", async (t) => {
  let now = Date.parse("2026-11-05T06:00:00.000Z");
  const store = new SignIns(await scratch(t), randomBytes(32), { create: async (vendor) => `${vendor}-pointer-1` }, async () => false, { now: () => now });
  for (const vendor of ["browserbase", "kernel"]) await store.forRun("alpha", "run-1", vendor);
  const dir = await scratch(t);
  await store.release("alpha", "run-1", dir, false);
  assert.deepEqual((await store.view("alpha")).map((s) => [s.provider, s.state, s.held_by]), [["browserbase", "held", "run-1"], ["kernel", "held", "run-1"]], "its run has ended, yet it holds");
  now += GONE_LEASE_MS;
  assert.deepEqual((await store.view("alpha")).map((s) => [s.provider, s.state]), [["browserbase", "held"], ["kernel", "ready"]]);
  now += BROWSERBASE_SETTLE_MS;
  assert.equal((await store.forRun("alpha", "run-2", "browserbase")).save, true);
});

test("a follow-up of a run that saved, opened while another run holds the lease, saves nothing: the save flag its sessions carry is its current launch's", { timeout: 180_000 }, async (t) => {
  const dir = await scratch(t);
  const log = join(dir, "browser.jsonl");
  withEnv(t, { BROWSERBASE_API_KEY: BB_KEY, BROWSERBASE_PROJECT_ID: "proj-1", AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64"), FAUX_BROWSER_LOG: log }, KEYS);
  const { api } = await serve(t, { fauxBrowser: FAUX_BROWSER, fauxBrowserbase: FAUX_BROWSERBASE });
  assert.equal((await api("POST", "/agents", agent("alpha", { instructions: "Browse.", tools: ["browser"] }))).status, 201);
  const lines = async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const signIns = async () => (await api("GET", "/agents/alpha")).body.sign_ins;
  const first = (await api("POST", "/agents/alpha/runs", { input: { content: "Browse the example page." } })).body.run_id;
  const { after } = await follow(api, first, ["completed"]);
  assert.deepEqual((await lines()).filter((op) => op.op === "profile").map((op) => op.save), [true], "it saved");
  await until(signIns, (list) => list[0]?.state === "ready");
  const gate = join(dir, "gate");
  const second = (await api("POST", "/agents/alpha/runs", { input: { content: `Browse the example page once ${gate} exists.` } })).body.run_id;
  await until(lines, (ops) => ops.filter((op) => op.op === "profile").length === 2);
  assert.equal((await signIns())[0].held_by, second);
  const mark = (await lines()).length;
  assert.equal((await api("POST", `/runs/${first}/messages`, { content: "Browse the example page again." })).status, 202);
  await follow(api, first, ["completed"], { after });
  const followUp = (await lines()).slice(mark);
  assert.deepEqual(followUp.filter((op) => op.op === "sign-in").map((op) => op.save), [false], "handed save false");
  assert.deepEqual(followUp.filter((op) => op.op === "profile").map((op) => [op.name, op.save]), [["default", false]], "and its session saves nothing, whatever its conversation was made with");
  await writeFile(gate, "");
  await follow(api, second, ["completed"], { deadlineMs: 60_000 });
});

test("a run's end keeps its line in the agent store cut of its browser sign-in's pointer, as everything it serves is", { timeout: 120_000 }, async (t) => {
  const dir = await scratch(t);
  const log = join(dir, "browser.jsonl");
  withEnv(t, { BROWSERBASE_API_KEY: BB_KEY, BROWSERBASE_PROJECT_ID: "proj-1", AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64"), FAUX_BROWSER_LOG: log }, KEYS);
  const { api, data } = await serve(t, { fauxBrowser: FAUX_BROWSER, fauxBrowserbase: FAUX_BROWSERBASE });
  assert.equal((await api("POST", "/agents", agent("alpha", { instructions: "Browse.", tools: ["browser"] }))).status, 201);
  const gate = join(dir, "gate");
  const runId = (await api("POST", "/agents/alpha/runs", { input: { content: `Browse the example page once ${gate} exists.` } })).body.run_id;
  const opened = await until(async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)), (ops) => ops.some((op) => op.op === "profile"));
  const { ref } = opened.find((op) => op.op === "sign-in");
  await writeFile(`${gate}.echo`, `I kept ${ref} for you.`);
  await writeFile(gate, "");
  await follow(api, runId, ["completed"], { deadlineMs: 60_000 });
  const row = storeRun(data, runId);
  assert.equal(row.summary, "I kept [redacted] for you.");
  assert.ok(!JSON.stringify((await api("GET", "/runs")).body).includes(ref));
});

test("a run's end-of-run learning never keeps its browser sign-in's pointer: a note that holds it is refused as a held value, and nothing of it reaches the agent's learning", { timeout: 180_000 }, async (t) => {
  const dir = await scratch(t);
  const log = join(dir, "browser.jsonl");
  withEnv(t, { BROWSERBASE_API_KEY: BB_KEY, BROWSERBASE_PROJECT_ID: "proj-1", AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64"), FAUX_BROWSER_LOG: log }, KEYS);
  const { api, data } = await serve(t, { learning: "on", faux: LEARN, fauxBrowser: FAUX_BROWSER, fauxBrowserbase: FAUX_BROWSERBASE });
  await made(api, learner("alpha", { tools: ["browser"] }));
  // Its first run makes its sign-in: the pointer, as the run's browser was handed it.
  await ended(api, await started(api, "alpha"));
  const { ref } = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line)).find((op) => op.op === "sign-in");
  // Its next run's end-of-run turn writes the pointer into a note (a model that repeats what it was given).
  const kept = note("The pointer", "What the browser opened", `It opened ${ref} for me.\n`);
  const { id: _, version: __, ...definition } = learner("alpha", { tools: ["browser"], plan: [["the-pointer.md", kept]] }).definition;
  const edited = await api("PUT", "/agents/alpha/definition", { definition });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  const runId = await started(api, "alpha");
  const { view } = await ended(api, runId);
  assert.deepEqual([view.learning.state, view.learning.reason], ["dropped", "checker"], JSON.stringify(view.learning));
  const notes = JSON.stringify((await api("GET", "/agents/alpha/learning/notes")).body);
  assert.ok(!notes.includes(ref), notes);
  assert.ok(!objects(repoOf(data, "alpha")).includes(ref), "nothing of it in the agent's learning, in any commit");
  for (const shown of [JSON.stringify(view), JSON.stringify((await api("GET", `/runs/${runId}/learning`)).body), await readFile(join(runDir(data, runId), "serve.json"), "utf8")]) assert.ok(!shown.includes(ref), shown);
});

test("a run's end-of-run learning left unchecked by a server that went is not checked while the next server cannot read its browser sign-in: nothing reaches the agent's learning, and the server that can read it refuses the note as a held value", { timeout: 240_000 }, async (t) => {
  const dir = await scratch(t);
  const log = join(dir, "browser.jsonl");
  const sealKey = randomBytes(32).toString("base64");
  withEnv(t, { BROWSERBASE_API_KEY: BB_KEY, BROWSERBASE_PROJECT_ID: "proj-1", AGENTRUN_SEAL_KEY: sealKey, FAUX_BROWSER_LOG: log }, KEYS);
  // Each run's serve.json as its server left it just before its check: what a server that went right then leaves.
  const before = new Map();
  learningTestHooks.beforePropose = async (folder) => void before.set(folder, await readFile(join(folder, "serve.json"), "utf8"));
  t.after(() => (learningTestHooks.beforePropose = undefined));
  const first = await serve(t, { learning: "on", faux: LEARN, fauxBrowser: FAUX_BROWSER, fauxBrowserbase: FAUX_BROWSERBASE });
  const { data } = first;
  await made(first.api, learner("alpha", { tools: ["browser"] }));
  // Its first run makes its sign-in: the pointer, as the run's browser was handed it.
  await ended(first.api, await started(first.api, "alpha"));
  const { ref } = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line)).find((op) => op.op === "sign-in");
  // Another agent's run, with no browser, left unchecked too: the next server's start checks it after alpha's (newest
  // first), so its end says that start has passed alpha's run.
  await made(first.api, learner("beta"));
  const betaId = await started(first.api, "beta");
  await ended(first.api, betaId);
  // Alpha's next run's end-of-run turn writes the pointer into a note (a model that repeats what it was given).
  const kept = note("The pointer", "What the browser opened", `It opened ${ref} for me.\n`);
  const { id: _, version: __, ...definition } = learner("alpha", { tools: ["browser"], plan: [["the-pointer.md", kept]] }).definition;
  assert.equal((await first.api("PUT", "/agents/alpha/definition", { definition })).status, 200);
  const runId = await started(first.api, "alpha");
  await ended(first.api, runId);
  await first.close();
  // The server went after both runs ended and before their notes were checked.
  for (const id of [runId, betaId]) {
    const folder = runDir(data, id);
    assert.equal(JSON.parse(before.get(folder)).learning.state, "reflecting");
    await writeFile(join(folder, "serve.json"), before.get(folder));
    await rm(join(folder, "learning-proposal.json"), { force: true });
  }
  // The next server holds another seal key: the sign-in no longer opens, so the pointer is not among the values its
  // check refuses. Alpha's run is not checked; beta's is.
  process.env.AGENTRUN_SEAL_KEY = randomBytes(32).toString("base64");
  const second = await serve(t, { data, learning: "on", faux: LEARN, fauxBrowser: FAUX_BROWSER, fauxBrowserbase: FAUX_BROWSERBASE });
  assert.deepEqual((await second.api("GET", "/agents/alpha")).body.sign_ins.map((s) => s.state), ["unreadable"]);
  assert.deepEqual([(await ended(second.api, betaId)).view.learning.state], ["dropped"], "the start's check passed alpha's run");
  const saved = JSON.parse(await readFile(join(runDir(data, runId), "serve.json"), "utf8"));
  assert.deepEqual([saved.learning.state, saved.unshown], ["reflecting", undefined], "left as it was, and never saved hidden");
  assert.ok(!existsSync(join(runDir(data, runId), "learning-proposal.json")), "nothing proposed");
  assert.ok(!objects(repoOf(data, "alpha")).includes(ref), "nothing of it in the agent's learning, in any commit");
  await second.close();
  // The right seal key back: the run is checked, and the note is refused as a held value.
  process.env.AGENTRUN_SEAL_KEY = sealKey;
  const third = await serve(t, { data, learning: "on", faux: LEARN, fauxBrowser: FAUX_BROWSER, fauxBrowserbase: FAUX_BROWSERBASE });
  const { view } = await ended(third.api, runId);
  assert.deepEqual([view.learning.state, view.learning.reason], ["dropped", "checker"], JSON.stringify(view.learning));
  assert.ok(!objects(repoOf(data, "alpha")).includes(ref), "nothing of it in the agent's learning, in any commit");
  assert.ok(!(await readFile(join(runDir(data, runId), "serve.json"), "utf8")).includes(ref));
});

test("a follow-up handed a sign-in starts signed in and saves, though its run's first launch had none and its conversation was made with no profile", { timeout: 180_000 }, async (t) => {
  const dir = await scratch(t);
  const log = join(dir, "browser.jsonl");
  withEnv(t, { BROWSERBASE_API_KEY: BB_KEY, BROWSERBASE_PROJECT_ID: "proj-1", AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64"), FAUX_BROWSER_LOG: log, AGENTRUN_TEST_FAUX_BROWSERBASE_CONTEXTS_DOWN: "1" }, KEYS);
  const { api } = await serve(t, { fauxBrowser: FAUX_BROWSER, fauxBrowserbase: FAUX_BROWSERBASE });
  assert.equal((await api("POST", "/agents", agent("alpha", { instructions: "Browse.", tools: ["browser"] }))).status, 201);
  const lines = async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  // Browserbase makes no context: the first launch is handed none, and browses signed out.
  const runId = (await api("POST", "/agents/alpha/runs", { input: { content: "Browse the example page." } })).body.run_id;
  const { after } = await follow(api, runId, ["completed"]);
  assert.deepEqual((await lines()).filter((op) => op.op === "sign-in" || op.op === "profile"), [], "signed out");
  assert.deepEqual((await api("GET", "/agents/alpha")).body.sign_ins, []);
  // Browserbase is back: the follow-up's launch is handed the agent's new sign-in, and its session opens on it, saving.
  delete process.env.AGENTRUN_TEST_FAUX_BROWSERBASE_CONTEXTS_DOWN;
  const mark = (await lines()).length;
  assert.equal((await api("POST", `/runs/${runId}/messages`, { content: "Browse the example page again." })).status, 202);
  await follow(api, runId, ["completed"], { after });
  const followUp = (await lines()).slice(mark);
  assert.deepEqual(followUp.filter((op) => op.op === "sign-in").map((op) => op.save), [true]);
  assert.deepEqual(followUp.filter((op) => op.op === "profile").map((op) => [op.name, op.save]), [["default", true]], "its session opens on the saved sign-in");
  const ready = await until(async () => (await api("GET", "/agents/alpha")).body.sign_ins, (list) => list[0]?.state === "ready");
  assert.ok(Date.parse(ready[0].verified_at) > 0, "and what it saved counts");
});

/** A server in a process of its own on `data` (fixtures/serve-signed-in.mjs), killed as a crash kills it: its client. */
async function crashable(t, data, { faux = FAUX, learning } = {}) {
  const fixture = new URL("./fixtures/serve-signed-in.mjs", import.meta.url).pathname;
  const child = spawn(process.execPath, [fixture, data, faux, FAUX_BROWSER, FAUX_BROWSERBASE, ...(learning ? [learning] : [])], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => child.kill("SIGKILL"));
  const base = await new Promise((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; const found = /AGENTRUN_BASE_URL=(\S+)/.exec(out); if (found) resolve(found[1]); });
    child.once("exit", (code) => reject(new Error(`the server exited (${code})`)));
  });
  return { child, api: client(base, (await readFile(join(data, ".token"), "utf8")).trim()) };
}

test("a run still going whose browser sign-in the next server cannot read (its seal key changed) is never taken up: it is stopped and ends failed, saying why, and nothing it says is served", { timeout: 180_000 }, async (t) => {
  const dir = await scratch(t);
  const data = join(dir, "agents");
  const log = join(dir, "browser.jsonl");
  withEnv(t, { BROWSERBASE_API_KEY: BB_KEY, BROWSERBASE_PROJECT_ID: "proj-1", AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64"), FAUX_BROWSER_LOG: log }, KEYS);
  const first = await crashable(t, data);
  assert.equal((await first.api("POST", "/agents", agent("alpha", { instructions: "Browse.", tools: ["browser"] }))).status, 201);
  const gate = join(dir, "gate");
  const runId = (await first.api("POST", "/agents/alpha/runs", { input: { content: `Browse the example page once ${gate} exists.` } })).body.run_id;
  const opened = await until(async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)), (ops) => ops.some((op) => op.op === "profile"));
  const { ref } = opened.find((op) => op.op === "sign-in");
  first.child.kill("SIGKILL");
  await new Promise((resolve) => first.child.once("exit", resolve));
  const { holder } = runRecordOf(data, runId);
  t.after(() => { try { process.kill(holder.pid, "SIGKILL"); } catch {} });
  // The next server holds another seal key: the agent's sign-in no longer opens.
  process.env.AGENTRUN_SEAL_KEY = randomBytes(32).toString("base64");
  await writeFile(`${gate}.echo`, `I kept ${ref} for you.`);
  const { api } = await serve(t, { data, fauxBrowser: FAUX_BROWSER, fauxBrowserbase: FAUX_BROWSERBASE });
  const { last } = await follow(api, runId, ["failed"], { deadlineMs: 60_000 });
  const view = (await api("GET", `/runs/${runId}`)).body;
  assert.equal(view.error.message, "This server can't read the run's browser sign-in (its seal key changed or is missing, or the sign-in is damaged): the run was stopped, so nothing it says can show it.");
  await until(async () => { try { process.kill(holder.pid, 0); return false; } catch { return true; } }, (gone) => gone);
  // Its gate opens now: a process still going would answer with the pointer.
  await writeFile(gate, "");
  await new Promise((go) => setTimeout(go, 1000));
  for (const shown of [JSON.stringify(last), JSON.stringify((await api("GET", `/runs/${runId}/timeline`)).body), JSON.stringify((await api("GET", `/runs/${runId}`)).body)]) {
    assert.ok(!shown.includes(ref), shown);
    assert.ok(!shown.includes("I kept"), shown);
  }
  assert.deepEqual((await api("GET", "/agents/alpha")).body.sign_ins.map((s) => s.state), ["unreadable"]);
});

test("a run whose process went with its server, and whose browser sign-in the next server cannot read, is not opened again: it ends failed, saying why, and nothing it said is served", { timeout: 180_000 }, async (t) => {
  const dir = await scratch(t);
  const data = join(dir, "agents");
  const log = join(dir, "browser.jsonl");
  const sealKey = randomBytes(32).toString("base64");
  withEnv(t, { BROWSERBASE_API_KEY: BB_KEY, BROWSERBASE_PROJECT_ID: "proj-1", AGENTRUN_SEAL_KEY: sealKey, FAUX_BROWSER_LOG: log }, KEYS);
  const first = await crashable(t, data);
  assert.equal((await first.api("POST", "/agents", agent("alpha", { instructions: "Browse.", tools: ["browser"] }))).status, 201);
  const gate = join(dir, "gate");
  const runId = (await first.api("POST", "/agents/alpha/runs", { input: { content: `Browse the example page once ${gate} exists.` } })).body.run_id;
  const opened = await until(async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)), (ops) => ops.some((op) => op.op === "profile"));
  const { ref } = opened.find((op) => op.op === "sign-in");
  // The server goes; the run's process answers with the pointer into its own store, then goes too.
  first.child.kill("SIGKILL");
  await new Promise((resolve) => first.child.once("exit", resolve));
  const { holder } = runRecordOf(data, runId);
  await writeFile(`${gate}.echo`, `I kept ${ref} for you.`);
  await writeFile(gate, "");
  const store = join(runDir(data, runId), "store");
  await until(async () => Buffer.concat(await Promise.all((await readdir(store)).map((name) => readFile(join(store, name)).catch(() => Buffer.alloc(0))))).includes(ref), (said) => said);
  process.kill(holder.pid, "SIGKILL");
  await until(async () => { try { process.kill(holder.pid, 0); return false; } catch { return true; } }, (gone) => gone);
  // The next server holds another seal key: the agent's sign-in no longer opens.
  process.env.AGENTRUN_SEAL_KEY = randomBytes(32).toString("base64");
  const second = await serve(t, { data, fauxBrowser: FAUX_BROWSER, fauxBrowserbase: FAUX_BROWSERBASE });
  const { api } = second;
  const { last } = await follow(api, runId, ["failed"], { deadlineMs: 60_000 });
  const view = (await api("GET", `/runs/${runId}`)).body;
  assert.equal(view.error.message, "This server can't read the run's browser sign-in (its seal key changed or is missing, or the sign-in is damaged): the run was stopped, so nothing it says can show it.");
  for (const shown of [JSON.stringify(last), JSON.stringify((await api("GET", `/runs/${runId}/timeline`)).body), JSON.stringify(view), JSON.stringify((await api("GET", "/runs")).body)]) {
    assert.ok(!shown.includes(ref), shown);
    assert.ok(!shown.includes("I kept"), shown);
  }
  assert.equal((await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line)).filter((op) => op.op === "vendor").length, 1, "never opened again");
  // The right seal key back: its rows are read and shown again, cut of the pointer, which opens now.
  await second.close();
  process.env.AGENTRUN_SEAL_KEY = sealKey;
  const third = await serve(t, { data, fauxBrowser: FAUX_BROWSER, fauxBrowserbase: FAUX_BROWSERBASE });
  const page = JSON.stringify((await third.api("GET", `/runs/${runId}/timeline`)).body);
  assert.ok(page.includes("I kept [redacted] for you."), page);
  assert.ok(!page.includes(ref) && !JSON.stringify((await third.api("GET", `/runs/${runId}`)).body).includes(ref));
  assert.equal(JSON.parse(await readFile(join(runDir(data, runId), "serve.json"), "utf8")).unshown, undefined, "no longer hidden");
});

test("after the seal key changed, a run that was never handed the sign-in (it browsed signed out) is taken up across a restart as any other run", { timeout: 180_000 }, async (t) => {
  const dir = await scratch(t);
  const data = join(dir, "agents");
  const log = join(dir, "browser.jsonl");
  withEnv(t, { BROWSERBASE_API_KEY: BB_KEY, BROWSERBASE_PROJECT_ID: "proj-1", AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64"), FAUX_BROWSER_LOG: log }, KEYS);
  // The agent's sign-in is made under one seal key.
  const before = await serve(t, { data, fauxBrowser: FAUX_BROWSER, fauxBrowserbase: FAUX_BROWSERBASE });
  assert.equal((await before.api("POST", "/agents", agent("alpha", { instructions: "Browse.", tools: ["browser"] }))).status, 201);
  await follow(before.api, (await before.api("POST", "/agents/alpha/runs", { input: { content: "Browse the example page." } })).body.run_id, ["completed"]);
  await before.close();
  // Under another, a run is launched signed out, and its server goes while it browses.
  process.env.AGENTRUN_SEAL_KEY = randomBytes(32).toString("base64");
  const first = await crashable(t, data);
  const gate = join(dir, "gate");
  const runId = (await first.api("POST", "/agents/alpha/runs", { input: { content: `Browse the example page once ${gate} exists.` } })).body.run_id;
  // Its browser open (signed out: a session made with no profile), so its first message has landed.
  await until(async () => (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line)), (ops) => ops.filter((op) => op.op === "vendor").length === 2 && ops.slice(ops.findLastIndex((op) => op.op === "vendor")).some((op) => op.op === "create"));
  first.child.kill("SIGKILL");
  await new Promise((resolve) => first.child.once("exit", resolve));
  const { holder } = runRecordOf(data, runId);
  t.after(() => { try { process.kill(holder.pid, "SIGKILL"); } catch {} });
  const { api } = await serve(t, { data, fauxBrowser: FAUX_BROWSER, fauxBrowserbase: FAUX_BROWSERBASE });
  assert.notEqual((await api("GET", `/runs/${runId}`)).body.status, "failed", "taken up, not stopped");
  process.kill(holder.pid, 0);
  await writeFile(gate, "");
  await follow(api, runId, ["completed"], { deadlineMs: 60_000 });
  assert.equal((await api("GET", `/runs/${runId}`)).body.error, null);
  assert.equal(JSON.parse(await readFile(join(runDir(data, runId), "serve.json"), "utf8")).unshown, undefined);
});

test("a launch that can't save that it was handed the sign-in hands none: the run browses signed out", { timeout: 180_000 }, async (t) => {
  const dir = await scratch(t);
  const log = join(dir, "browser.jsonl");
  withEnv(t, { BROWSERBASE_API_KEY: BB_KEY, BROWSERBASE_PROJECT_ID: "proj-1", AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64"), FAUX_BROWSER_LOG: log, AGENTRUN_TEST_FAUX_BROWSERBASE_CONTEXTS_DOWN: "1" }, KEYS);
  const { api, data } = await serve(t, { fauxBrowser: FAUX_BROWSER, fauxBrowserbase: FAUX_BROWSERBASE });
  assert.equal((await api("POST", "/agents", agent("alpha", { instructions: "Browse.", tools: ["browser"] }))).status, 201);
  const lines = async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  // Its first launch gets no sign-in (Browserbase makes no context), so it was never handed one.
  const runId = (await api("POST", "/agents/alpha/runs", { input: { content: "Browse the example page." } })).body.run_id;
  const { after } = await follow(api, runId, ["completed"]);
  // Its serve.json can't be written now (a folder where its temporary file goes); Browserbase is back.
  const blocked = join(runDir(data, runId), "serve.json.tmp");
  await mkdir(blocked);
  t.after(() => rm(blocked, { recursive: true, force: true }));
  delete process.env.AGENTRUN_TEST_FAUX_BROWSERBASE_CONTEXTS_DOWN;
  const mark = (await lines()).length;
  assert.equal((await api("POST", `/runs/${runId}/messages`, { content: "Browse the example page again." })).status, 202);
  const followUp = await until(async () => (await lines()).slice(mark), (ops) => ops.some((op) => op.op === "create"));
  assert.deepEqual(followUp.filter((op) => op.op === "sign-in" || op.op === "profile"), [], "handed nothing, so it browses signed out");
  await rm(blocked, { recursive: true, force: true });
  await follow(api, runId, ["completed"], { after, deadlineMs: 60_000 });
});

/** A run of agent `alpha` browsing signed in on a crashable server, its process then gone with the server after
 *  answering with the pointer into its own store: what a restarted server under another seal key hides. */
async function hiddenRun(t, dir, data, log) {
  const first = await crashable(t, data);
  assert.equal((await first.api("POST", "/agents", agent("alpha", { instructions: "Browse.", tools: ["browser"] }))).status, 201);
  const gate = join(dir, "gate");
  const runId = (await first.api("POST", "/agents/alpha/runs", { input: { content: `Browse the example page once ${gate} exists.` } })).body.run_id;
  const opened = await until(async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)), (ops) => ops.some((op) => op.op === "profile"));
  const { ref } = opened.find((op) => op.op === "sign-in");
  first.child.kill("SIGKILL");
  await new Promise((resolve) => first.child.once("exit", resolve));
  const { holder } = runRecordOf(data, runId);
  await writeFile(`${gate}.echo`, `I kept ${ref} for you.`);
  await writeFile(gate, "");
  const store = join(runDir(data, runId), "store");
  await until(async () => Buffer.concat(await Promise.all((await readdir(store)).map((name) => readFile(join(store, name)).catch(() => Buffer.alloc(0))))).includes(ref), (said) => said);
  process.kill(holder.pid, "SIGKILL");
  await until(async () => { try { process.kill(holder.pid, 0); return false; } catch { return true; } }, (gone) => gone);
  return { runId, ref };
}

test("a hidden run interrupted in its end-of-run learning turn still ends failed, saying why: its learning never turns it completed", { timeout: 240_000 }, async (t) => {
  const dir = await scratch(t);
  const data = join(dir, "agents");
  const log = join(dir, "browser.jsonl");
  withEnv(t, { BROWSERBASE_API_KEY: BB_KEY, BROWSERBASE_PROJECT_ID: "proj-1", AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64"), FAUX_BROWSER_LOG: log }, KEYS);
  const first = await crashable(t, data, { faux: LEARN, learning: "on" });
  const hold = join(dir, "reflect");
  await made(first.api, learner("alpha", { tools: ["browser"], instructions: `Answer the question.\nReflect once ${hold} exists.` }));
  const runId = await started(first.api, "alpha");
  await until(async () => (await first.api("GET", `/runs/${runId}`)).body.learning?.state, (state) => state === "reflecting");
  // Killed only once serve.json on disk holds the end-of-run turn (`reflect`): a kill before it was saved would leave a
  // run the next server never finds reflecting, and this would pass whatever learning does with a hidden run.
  const saved = await until(async () => JSON.parse(await readFile(join(runDir(data, runId), "serve.json"), "utf8").catch(() => "{}")).reflect, (reflect) => Boolean(reflect));
  assert.equal(saved.outcome, "completed", "its job's outcome, which a hidden run must never end with");
  first.child.kill("SIGKILL");
  await new Promise((resolve) => first.child.once("exit", resolve));
  const { holder } = runRecordOf(data, runId);
  process.kill(holder.pid, "SIGKILL");
  await until(async () => { try { process.kill(holder.pid, 0); return false; } catch { return true; } }, (gone) => gone);
  process.env.AGENTRUN_SEAL_KEY = randomBytes(32).toString("base64");
  const { api } = await serve(t, { data, learning: "on", faux: LEARN, fauxBrowser: FAUX_BROWSER, fauxBrowserbase: FAUX_BROWSERBASE });
  await follow(api, runId, ["failed", "completed"], { deadlineMs: 60_000 });
  const view = (await api("GET", `/runs/${runId}`)).body;
  assert.deepEqual([view.status, view.error?.message], ["failed", "This server can't read the run's browser sign-in (its seal key changed or is missing, or the sign-in is damaged): the run was stopped, so nothing it says can show it."]);
});

test("a forget never slips between a launch handing the sign-in and that run keeping it was handed: the launch keeps it under the lock forget asks under", { timeout: 20_000 }, async (t) => {
  const data = await scratch(t);
  // The runs still going and the hash each was handed, as serve.json keeps it (runs.ts handedTo).
  const handed = new Map();
  const { store } = fakeStore(data, { handedTo: async (agentId, hash) => [...handed].find(([, kept]) => hash === undefined || kept === hash)?.[0] });
  await store.forRun("alpha", "run-1", "browserbase");
  // run-2's launch is handed the sign-in (its lease free: run-1 is not running) and is slow to keep that it was.
  let entered;
  const keeping = new Promise((resolve) => (entered = resolve));
  let letKeep;
  const kept = new Promise((resolve) => (letKeep = resolve));
  const launch = store.forRun("alpha", "run-2", "browserbase", async (signIn) => {
    entered();
    await kept;
    handed.set("run-2", createHash("sha256").update(signIn.ref, "utf8").digest("hex"));
    return true;
  });
  await keeping;
  const forgetting = store.forget("alpha", "default").then((answer) => ({ answer }), (error) => ({ error }));
  letKeep();
  const signIn = await launch;
  assert.equal(signIn.save, true);
  const { error } = await forgetting;
  assert.deepEqual([error?.code, error?.extra.details.handed_to], ["sign_in_held", "run-2"], "it waited for the launch, then saw run-2");
  assert.ok(!error.message.includes(signIn.ref));
  // A launch that could not keep it was handed none: nothing it says can hold the pointer.
  assert.equal(await store.forRun("alpha", "run-3", "browserbase", async () => false), undefined);
  // run-2 ends: forgotten.
  handed.delete("run-2");
  assert.deepEqual((await store.forget("alpha", "default")).removed, [{ provider: "browserbase", at_vendor: "deleted" }]);
});

/** A run of agent `alpha` that browsed signed in and ended repeating its sign-in's pointer, then the sign-in forgotten
 *  (allowed: the run ended): the server, the run's id and the pointer. */
async function forgottenAfterEnd(t, dir, log) {
  const first = await serve(t, { fauxBrowser: FAUX_BROWSER, fauxBrowserbase: FAUX_BROWSERBASE });
  assert.equal((await first.api("POST", "/agents", agent("alpha", { instructions: "Browse.", tools: ["browser"] }))).status, 201);
  const gate = join(dir, "gate");
  const runId = (await first.api("POST", "/agents/alpha/runs", { input: { content: `Browse the example page once ${gate} exists.` } })).body.run_id;
  const opened = await until(async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)), (ops) => ops.some((op) => op.op === "profile"));
  const { ref } = opened.find((op) => op.op === "sign-in");
  await writeFile(`${gate}.echo`, `I kept ${ref} for you.`);
  await writeFile(gate, "");
  await follow(first.api, runId, ["completed"], { deadlineMs: 60_000 });
  await until(async () => (await first.api("GET", "/agents/alpha")).body.sign_ins, (list) => list[0]?.state === "ready");
  const forgot = await first.api("DELETE", "/agents/alpha/sign-ins/default");
  assert.equal(forgot.status, 200, JSON.stringify(forgot.body));
  return { ...first, runId, ref };
}

/** That nothing `api` serves of run `runId` (its timeline, its view, both lists) holds `ref`; its timeline's text. */
async function servedCut(api, runId, ref) {
  const timeline = JSON.stringify((await api("GET", `/runs/${runId}/timeline`)).body);
  for (const shown of [timeline, JSON.stringify((await api("GET", `/runs/${runId}`)).body), JSON.stringify((await api("GET", "/runs")).body), JSON.stringify((await api("GET", "/agents/alpha/runs")).body)]) assert.ok(!shown.includes(ref), shown);
  return timeline;
}

test("a forgotten sign-in is never a sign-in: GET /agents/{id} lists none, nothing serves it, no run is handed it, and forget finds none", { timeout: 240_000 }, async (t) => {
  const dir = await scratch(t);
  const log = join(dir, "browser.jsonl");
  withEnv(t, { BROWSERBASE_API_KEY: BB_KEY, BROWSERBASE_PROJECT_ID: "proj-1", AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64"), FAUX_BROWSER_LOG: log }, KEYS);
  const { api, data, ref } = await forgottenAfterEnd(t, dir, log);
  assert.deepEqual((await api("GET", "/agents/alpha")).body.sign_ins, []);
  assert.ok(!JSON.stringify((await api("GET", "/agents")).body).includes(ref));
  // Kept on disk, sealed: never in the clear, and the home's files never serve it.
  const onDisk = await readFile(join(homeOf(data, "alpha"), "sign-ins", "sign-ins.json"), "utf8");
  const kept = JSON.parse(onDisk);
  assert.deepEqual([kept.sign_ins, kept.forgotten.map((gone) => [gone.key, gone.provider])], [[], [["default", "browserbase"]]]);
  assert.ok(!onDisk.includes(ref));
  assert.deepEqual((await api("GET", "/agents/alpha/home/files")).body.files.filter((file) => file.host_owned).map((file) => file.path), []);
  assert.equal((await api("GET", ["/agents/alpha", "home", "files", "sign-ins", "sign-ins.json"].join("/"))).status, 403);
  assert.equal((await api("DELETE", "/agents/alpha/sign-ins/default")).status, 404, "nothing to forget");
  // The next run is handed a new sign-in, never the forgotten one; and that one, forgotten, is kept beside it.
  const mark = (await readFile(log, "utf8")).trim().split("\n").length;
  await follow(api, (await api("POST", "/agents/alpha/runs", { input: { content: "Browse the example page." } })).body.run_id, ["completed"], { deadlineMs: 60_000 });
  const handed = (await readFile(log, "utf8")).trim().split("\n").slice(mark).map((line) => JSON.parse(line)).filter((op) => op.op === "sign-in").map((op) => op.ref);
  assert.ok(handed.length === 1 && handed[0] !== ref, JSON.stringify(handed));
  assert.deepEqual((await api("GET", "/agents/alpha")).body.sign_ins.map((s) => s.key), ["default"]);
  await until(async () => (await api("GET", "/agents/alpha")).body.sign_ins, (list) => list[0]?.state === "ready");
  assert.equal((await api("DELETE", "/agents/alpha/sign-ins/default")).status, 200);
  assert.equal(JSON.parse(await readFile(join(homeOf(data, "alpha"), "sign-ins", "sign-ins.json"), "utf8")).forgotten.length, 2);
});

/** Marks run `runId` as handed `mark` and removes its agent's sign-ins file, as an incomplete restore or a damaged disk
 *  would leave them. */
async function signInsLost(data, runId, mark) {
  const metaFile = join(runDir(data, runId), "serve.json");
  const meta = JSON.parse(await readFile(metaFile, "utf8"));
  assert.ok(meta.sign_in_handed, "it was handed one");
  await writeFile(metaFile, `${JSON.stringify({ ...meta, ...(mark === undefined ? {} : { sign_in_handed: mark }) })}\n`);
  await rm(join(homeOf(data, "alpha"), "sign-ins", "sign-ins.json"));
}

test("a run still going handed several sign-ins whose agent's sign-ins file is gone is not taken up: it ends failed, saying why, and nothing it said is served", { timeout: 240_000 }, async (t) => {
  const dir = await scratch(t);
  const data = join(dir, "agents");
  const log = join(dir, "browser.jsonl");
  withEnv(t, { BROWSERBASE_API_KEY: BB_KEY, BROWSERBASE_PROJECT_ID: "proj-1", AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64"), FAUX_BROWSER_LOG: log }, KEYS);
  const { runId, ref } = await hiddenRun(t, dir, data, log);
  await signInsLost(data, runId, [hashOf(ref), "1".repeat(64)]);
  const { api } = await serve(t, { data, fauxBrowser: FAUX_BROWSER, fauxBrowserbase: FAUX_BROWSERBASE });
  const { last } = await follow(api, runId, ["failed", "completed"], { deadlineMs: 60_000 });
  for (const shown of [JSON.stringify(last), await servedCut(api, runId, ref)]) assert.ok(!shown.includes("I kept"), shown);
  const view = (await api("GET", `/runs/${runId}`)).body;
  assert.deepEqual([view.status, view.error?.message], ["failed", "This server can't read the run's browser sign-in (its seal key changed or is missing, or the sign-in is damaged): the run was stopped, so nothing it says can show it."]);
});

/** The SHA-256 a run's serve.json keeps of a pointer it was handed. */
const hashOf = (ref) => createHash("sha256").update(ref, "utf8").digest("hex");

test("a run still going handed several sign-ins, hidden while the seal key is missing, is shown again, cut, once the key is back", { timeout: 300_000 }, async (t) => {
  const dir = await scratch(t);
  const data = join(dir, "agents");
  const log = join(dir, "browser.jsonl");
  const seal = randomBytes(32);
  withEnv(t, { BROWSERBASE_API_KEY: BB_KEY, BROWSERBASE_PROJECT_ID: "proj-1", AGENTRUN_SEAL_KEY: seal.toString("base64"), FAUX_BROWSER_LOG: log }, KEYS);
  const { runId, ref } = await hiddenRun(t, dir, data, log);
  // It was handed that sign-in and, since, another (the first forgotten, the second the agent's live one).
  const store = new SignIns(data, seal, { create: async () => `ctx-later-${randomBytes(6).toString("hex")}`, remove: async () => {} }, async () => false);
  await store.forget("alpha", "default");
  const other = (await store.forRun("alpha", "other", "browserbase")).ref;
  const metaFile = join(runDir(data, runId), "serve.json");
  await writeFile(metaFile, `${JSON.stringify({ ...JSON.parse(await readFile(metaFile, "utf8")), sign_in_handed: [hashOf(ref), hashOf(other)] })}\n`);
  // No seal key: neither opens, so it is hidden, stopped and ended, and nothing it said is served.
  delete process.env.AGENTRUN_SEAL_KEY;
  const keyless = await serve(t, { data, fauxBrowser: FAUX_BROWSER, fauxBrowserbase: FAUX_BROWSERBASE });
  await follow(keyless.api, runId, ["failed", "completed"], { deadlineMs: 60_000 });
  const hidden = await servedCut(keyless.api, runId, ref);
  assert.ok(!hidden.includes("I kept"), hidden);
  await keyless.close();
  // The key back: both open again, and what it said is shown, cut.
  process.env.AGENTRUN_SEAL_KEY = seal.toString("base64");
  const { api } = await serve(t, { data, fauxBrowser: FAUX_BROWSER, fauxBrowserbase: FAUX_BROWSERBASE });
  assert.ok((await servedCut(api, runId, ref)).includes("I kept [redacted] for you."));
  assert.equal(JSON.parse(await readFile(metaFile, "utf8")).unshown, undefined, "shown again, and saved so");
});
