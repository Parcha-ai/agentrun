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
import { agent, client, FAUX, follow, runDir, runRecordOf, scratch, serve, storeRun, withEnv } from "./support.mjs";
import { ended, LEARN, learner, made, objects, repoOf, started } from "./learn-support.mjs";
import { note } from "./fixtures/faux-learn.mjs";

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

test("a pointer is sealed at rest, bound to its agent, and opens again for that agent alone; the view never holds it", async (t) => {
  const data = await scratch(t);
  const { store, made, key } = fakeStore(data);
  const first = await store.forRun("alpha", "run-1", "browserbase");
  assert.deepEqual(first, { provider: "browserbase", ref: made[0], save: true });
  const file = join(homeOf(data, "alpha"), "sign-ins", "sign-ins.json");
  const text = await readFile(file, "utf8");
  assert.ok(!text.includes(made[0]), "sealed on disk");
  assert.equal(JSON.parse(text).format, "sign-ins/1");
  // Opened again, under the same seal key, by another store: the same pointer, nothing made.
  const again = new SignIns(data, key, { create: async () => assert.fail("made again") }, async () => false);
  assert.equal((await again.forRun("alpha", "run-2", "browserbase")).ref, made[0]);
  assert.equal(made.length, 1);
  // Copied into another agent's home, it does not open there.
  await mkdir(join(homeOf(data, "beta"), "sign-ins"), { recursive: true });
  await cp(file, join(homeOf(data, "beta"), "sign-ins", "sign-ins.json"));
  await assert.rejects(again.forRun("beta", "run-3", "browserbase"));
  // Nor under another seal key.
  await assert.rejects(new SignIns(data, randomBytes(32), { create: async () => "x" }, async () => false).forRun("alpha", "run-4", "browserbase"));
  const view = await store.view("alpha");
  assert.deepEqual(view, [{ key: "default", provider: "browserbase", state: "ready", held_by: null, verified_at: null }], "run-2's lease: run-2 is not running");
  assert.ok(!JSON.stringify(view).includes(made[0]));
  // With no seal key nothing is kept, never in the clear.
  const none = new SignIns(data, undefined, { create: async () => assert.fail("made with no seal key") }, async () => false);
  assert.equal(none.available, false);
  assert.equal(await none.forRun("gamma", "run-5", "browserbase"), undefined);
});

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

test("forget: refused while held, then deleted at the vendor and here; a vendor that refuses is said, and the pointer goes all the same", async (t) => {
  const data = await scratch(t);
  const { store, removed, running } = fakeStore(data);
  running.add("run-1");
  const { ref } = await store.forRun("alpha", "run-1", "browserbase");
  await assert.rejects(store.forget("alpha", "default"), (error) => error.code === "sign_in_held" && error.extra.details.held_by === "run-1");
  running.delete("run-1");
  assert.deepEqual(await store.forget("alpha", "default"), { key: "default", removed: [{ provider: "browserbase", at_vendor: "deleted" }] });
  assert.deepEqual(removed, [["browserbase", ref]]);
  assert.deepEqual(await store.view("alpha"), []);
  await assert.rejects(store.forget("alpha", "default"), (error) => error.code === "not_found");
  const refusing = fakeStore(await scratch(t), { refuseRemove: true });
  await refusing.store.forRun("beta", "run-2", "kernel");
  const answer = await refusing.store.forget("beta", "default");
  assert.deepEqual(answer.removed, [{ provider: "kernel", at_vendor: "not_deleted", message: "Not deleted at kernel: kernel answered 500. This server no longer points to it." }]);
  assert.deepEqual(await refusing.store.view("beta"), []);
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
    assert.deepEqual(listed.filter((file) => file.host_owned).map((file) => file.path), ["sign-ins"]);
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

test("a pointer to an object just made that cannot be kept here is deleted at the vendor, never left there holding cookies", async (t) => {
  const data = await scratch(t);
  const { store, made, removed } = fakeStore(data);
  const dir = join(homeOf(data, "alpha"), "sign-ins");
  await mkdir(dir, { recursive: true });
  await chmod(dir, 0o500);
  t.after(() => chmod(dir, 0o700).catch(() => undefined));
  await assert.rejects(store.forRun("alpha", "run-1", "browserbase"), /EACCES/);
  assert.deepEqual(removed, [["browserbase", made[0]]]);
  await chmod(dir, 0o700);
  assert.deepEqual(await store.forRun("alpha", "run-2", "browserbase"), { provider: "browserbase", ref: made[1], save: true });
  assert.deepEqual(removed.length, 1, "one kept is never removed");
});

test("a run whose process dies naming its sign-in's pointer in its log fails without showing the pointer", { timeout: 120_000 }, async (t) => {
  const dir = await scratch(t);
  const log = join(dir, "browser.jsonl");
  withEnv(t, { BROWSERBASE_API_KEY: BB_KEY, BROWSERBASE_PROJECT_ID: "proj-1", AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64"), FAUX_BROWSER_LOG: log, FAUX_BROWSER_DIE_WITH_REF: "1" }, KEYS);
  const { api, data } = await serve(t, { fauxBrowser: FAUX_BROWSER, fauxBrowserbase: FAUX_BROWSERBASE });
  assert.equal((await api("POST", "/agents", agent("alpha", { instructions: "Browse.", tools: ["browser"] }))).status, 201);
  const started = await api("POST", "/agents/alpha/runs", { input: { content: "Browse the example page." } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["failed"], { deadlineMs: 60_000 });
  const { ref } = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line)).find((op) => op.op === "sign-in");
  const view = (await api("GET", `/runs/${started.body.run_id}`)).body;
  assert.match(view.error.message, /the browser died holding \[redacted\]/);
  // Its process never let its sessions go: its lease stays with it, by the gone rule, rather than end with the run.
  const kept = (await api("GET", "/agents/alpha")).body.sign_ins;
  assert.deepEqual(kept.map((s) => [s.state, s.held_by]), [["held", started.body.run_id]]);
  const [entry] = JSON.parse(await readFile(join(homeOf(data, "alpha"), "sign-ins", "sign-ins.json"), "utf8")).sign_ins;
  assert.ok(Date.parse(entry.gone_at) > 0);
  for (const shown of [JSON.stringify(view), JSON.stringify((await api("GET", "/runs")).body), await readFile(join(runDir(data, started.body.run_id), "serve.json"), "utf8")]) assert.ok(!shown.includes(ref), shown);
});

test("verified_at counts only a session that saved: one let go by the run, never one the vendor had lost or never made; and an agent's queue goes once it is empty", async (t) => {
  const row = (releaseReason, { profile = "default", resourceId = "sess-1" } = {}) => ({ session: { resourceId, releaseReason, settings: { profile } } });
  for (const reason of ["tool", "idle", "relaunch", "close", "ended"]) assert.equal(savedOnRelease(row(reason), "released"), true, reason);
  for (const reason of ["lost", "create_failed", null]) assert.equal(savedOnRelease(row(reason), "released"), false, String(reason));
  assert.equal(savedOnRelease(row("close", { profile: null }), "released"), true, "its record names no profile, yet it ran on the run's (asHanded)");
  assert.equal(savedOnRelease(row("close", { resourceId: null }), "released"), false, "never made");
  assert.equal(savedOnRelease(row("close"), "updated"), false, "not let go");
  const { store } = fakeStore(await scratch(t));
  await store.forRun("alpha", "run-1", "browserbase");
  await store.view("alpha");
  await new Promise((go) => setImmediate(go));
  assert.equal(store.chains.size, 0);
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
  const data = await scratch(t);
  const store = new SignIns(data, randomBytes(32), { ...vendorsOver(() => ({ KERNEL_API_KEY: "k", KERNEL_BASE_URL: "kernel.example" }), async () => fetch), create: async () => pointer }, async () => false);
  await store.forRun("alpha", "run-1", "kernel");
  const answer = await store.forget("alpha", "default");
  assert.deepEqual(answer.removed, [{ provider: "kernel", at_vendor: "not_deleted", message: "Not deleted at kernel: kernel unreachable (TypeError). This server no longer points to it." }]);
  assert.ok(!JSON.stringify(answer).includes(pointer));
});

test("a write that lands and then fails (the folder's sync) keeps both the pointer and the object it points to: the object is deleted at the vendor only when its pointer was not kept", async (t) => {
  const data = await scratch(t);
  const removed = [];
  const vendors = { create: async () => "ctx-landed", remove: async (vendor, ref) => void removed.push(ref) };
  const key = randomBytes(32);
  const store = new SignIns(data, key, vendors, async () => false, { write: async (path, text) => { await writeDurable(path, text); throw new Error("the folder's sync failed"); } });
  await assert.rejects(store.forRun("alpha", "run-1", "browserbase"), /sync failed/);
  assert.deepEqual(removed, [], "its pointer is on disk");
  const again = new SignIns(data, key, { create: async () => assert.fail("made again") }, async () => false);
  assert.equal((await again.forRun("alpha", "run-2", "browserbase")).ref, "ctx-landed");
});

test("an unreadable sign-in still names the run that holds its lease, which forget waits for; the served contract takes it", async (t) => {
  const data = await scratch(t);
  const vendors = { create: async () => "ctx-1", remove: async () => {} };
  await new SignIns(data, randomBytes(32), vendors, async () => true).forRun("alpha", "run-1", "browserbase");
  const rotated = new SignIns(data, randomBytes(32), vendors, async (run) => run === "run-1");
  assert.deepEqual(await rotated.view("alpha"), [{ key: "default", provider: "browserbase", state: "unreadable", held_by: "run-1", verified_at: null }]);
  await assert.rejects(rotated.forget("alpha", "default"), (error) => error.code === "sign_in_held");
  const signIn = openapiDocument(() => undefined).components.schemas.SignIn;
  const unreadable = signIn.else;
  assert.deepEqual([unreadable.if, unreadable.then.properties.held_by.oneOf.length, unreadable.else.properties.held_by, unreadable["x-agentrun-serve"]], [{ properties: { state: { const: "unreadable" } } }, 2, { type: "null" }, "signins/1"]);
  // forget's 409: the lease's holder, or a run still going it was handed, named in its details.
  const doc = openapiDocument(() => undefined);
  assert.match(doc.paths["/agents/{agent_id}/sign-ins/{key}"].delete.description, /`details\.handed_to`/);
  assert.deepEqual(Object.keys(doc.components.schemas.ErrorBody.properties.details["x-agentrun-serve-details"].sign_in_held.properties), ["held_by", "handed_to"]);
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

test("a run whose live process the next server adopts after a crash never shows its browser sign-in's pointer: the server reads it back, read-only, before it serves the run", { timeout: 180_000 }, async (t) => {
  const dir = await scratch(t);
  const data = join(dir, "agents");
  const log = join(dir, "browser.jsonl");
  withEnv(t, { BROWSERBASE_API_KEY: BB_KEY, BROWSERBASE_PROJECT_ID: "proj-1", AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64"), FAUX_BROWSER_LOG: log }, KEYS);
  // The first server, in a process of its own, killed as a crash kills it while the run's browser is open.
  const fixture = new URL("./fixtures/serve-signed-in.mjs", import.meta.url).pathname;
  const first = spawn(process.execPath, [fixture, data, FAUX, FAUX_BROWSER, FAUX_BROWSERBASE], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => first.kill("SIGKILL"));
  const base = await new Promise((resolve, reject) => {
    let out = "";
    first.stdout.on("data", (chunk) => { out += chunk; const found = /AGENTRUN_BASE_URL=(\S+)/.exec(out); if (found) resolve(found[1]); });
    first.once("exit", (code) => reject(new Error(`the first server exited (${code})`)));
  });
  const api1 = client(base, (await readFile(join(data, ".token"), "utf8")).trim());
  assert.equal((await api1("POST", "/agents", agent("alpha", { instructions: "Browse.", tools: ["browser"] }))).status, 201);
  const gate = join(dir, "gate");
  const runId = (await api1("POST", "/agents/alpha/runs", { input: { content: `Browse the example page once ${gate} exists.` } })).body.run_id;
  const opened = await until(async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)), (ops) => ops.some((op) => op.op === "profile"));
  const { ref } = opened.find((op) => op.op === "sign-in");
  first.kill("SIGKILL");
  await new Promise((resolve) => first.once("exit", resolve));
  const { holder } = runRecordOf(data, runId);
  t.after(() => { try { process.kill(holder.pid, "SIGKILL"); } catch {} });
  // The next server adopts the run's live process; then the run answers with its pointer in its text.
  const next = await serve(t, { data, fauxBrowser: FAUX_BROWSER, fauxBrowserbase: FAUX_BROWSERBASE });
  assert.equal((await next.api("GET", `/runs/${runId}`)).status, 200);
  await writeFile(`${gate}.echo`, `I kept ${ref} for you.`);
  await writeFile(gate, "");
  await follow(next.api, runId, ["completed"], { deadlineMs: 60_000 });
  const view = (await next.api("GET", `/runs/${runId}`)).body;
  assert.match(view.result.final_answer, /I kept \[redacted\] for you\./);
  for (const shown of [JSON.stringify(view), JSON.stringify((await next.api("GET", "/runs")).body), JSON.stringify((await next.api("GET", `/runs/${runId}/timeline`)).body)]) assert.ok(!shown.includes(ref), shown);
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

test("a run that ended repeating its browser sign-in's pointer has it cut in its timeline as soon as a restarted server serves it", { timeout: 180_000 }, async (t) => {
  const dir = await scratch(t);
  const log = join(dir, "browser.jsonl");
  withEnv(t, { BROWSERBASE_API_KEY: BB_KEY, BROWSERBASE_PROJECT_ID: "proj-1", AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64"), FAUX_BROWSER_LOG: log }, KEYS);
  const first = await serve(t, { fauxBrowser: FAUX_BROWSER, fauxBrowserbase: FAUX_BROWSERBASE });
  assert.equal((await first.api("POST", "/agents", agent("alpha", { instructions: "Browse.", tools: ["browser"] }))).status, 201);
  const gate = join(dir, "gate");
  const runId = (await first.api("POST", "/agents/alpha/runs", { input: { content: `Browse the example page once ${gate} exists.` } })).body.run_id;
  const opened = await until(async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)), (ops) => ops.some((op) => op.op === "profile"));
  const { ref } = opened.find((op) => op.op === "sign-in");
  await writeFile(`${gate}.echo`, `I kept ${ref} for you.`);
  await writeFile(gate, "");
  await follow(first.api, runId, ["completed"], { deadlineMs: 60_000 });
  await first.close();
  // The next server reads the run's conversation from its store: its first answer about it is already cut.
  const { api } = await serve(t, { data: first.data, fauxBrowser: FAUX_BROWSER, fauxBrowserbase: FAUX_BROWSERBASE });
  const page = (await api("GET", `/runs/${runId}/timeline`)).body;
  assert.ok(JSON.stringify(page).includes("I kept [redacted] for you."), JSON.stringify(page.rows.map((row) => row.text ?? row.summary)));
  for (const shown of [JSON.stringify(page), JSON.stringify((await api("GET", `/runs/${runId}`)).body)]) assert.ok(!shown.includes(ref), shown);
});

test("a run that ended repeating its browser sign-in's pointer serves none of what it said while the next server cannot read the sign-in, and is shown again, cut, once it can", { timeout: 180_000 }, async (t) => {
  const dir = await scratch(t);
  const log = join(dir, "browser.jsonl");
  const sealKey = randomBytes(32).toString("base64");
  withEnv(t, { BROWSERBASE_API_KEY: BB_KEY, BROWSERBASE_PROJECT_ID: "proj-1", AGENTRUN_SEAL_KEY: sealKey, FAUX_BROWSER_LOG: log }, KEYS);
  const first = await serve(t, { fauxBrowser: FAUX_BROWSER, fauxBrowserbase: FAUX_BROWSERBASE });
  assert.equal((await first.api("POST", "/agents", agent("alpha", { instructions: "Browse.", tools: ["browser"] }))).status, 201);
  const gate = join(dir, "gate");
  const runId = (await first.api("POST", "/agents/alpha/runs", { input: { content: `Browse the example page once ${gate} exists.` } })).body.run_id;
  const opened = await until(async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)), (ops) => ops.some((op) => op.op === "profile"));
  const { ref } = opened.find((op) => op.op === "sign-in");
  await writeFile(`${gate}.echo`, `I kept ${ref} for you.`);
  await writeFile(gate, "");
  await follow(first.api, runId, ["completed"], { deadlineMs: 60_000 });
  const cut = JSON.stringify((await first.api("GET", `/runs/${runId}`)).body);
  assert.ok(cut.includes("I kept [redacted] for you.") && !cut.includes(ref), cut);
  await first.close();
  // The next server holds another seal key: the agent's sign-in no longer opens, so nothing the run said can be cut.
  process.env.AGENTRUN_SEAL_KEY = randomBytes(32).toString("base64");
  const second = await serve(t, { data: first.data, fauxBrowser: FAUX_BROWSER, fauxBrowserbase: FAUX_BROWSERBASE });
  assert.deepEqual((await second.api("GET", "/agents/alpha")).body.sign_ins.map((s) => s.state), ["unreadable"]);
  const view = (await second.api("GET", `/runs/${runId}`)).body;
  assert.equal(view.status, "completed", "it ended as it ended: nothing is stopped or failed");
  for (const shown of [JSON.stringify(view), JSON.stringify((await second.api("GET", `/runs/${runId}/timeline`)).body), JSON.stringify((await second.api("GET", "/runs")).body)]) {
    assert.ok(!shown.includes(ref), shown);
    assert.ok(!shown.includes("I kept"), shown);
  }
  // Nothing it went on to say could be cut either: it is not opened again.
  const more = await second.api("POST", `/runs/${runId}/messages`, { content: "Once more." });
  assert.deepEqual([more.status, more.body.error?.code], [409, "not_continuable"], JSON.stringify(more.body));
  // The right seal key back: what it said is shown again, cut of the pointer, which opens now.
  await second.close();
  process.env.AGENTRUN_SEAL_KEY = sealKey;
  const third = await serve(t, { data: first.data, fauxBrowser: FAUX_BROWSER, fauxBrowserbase: FAUX_BROWSERBASE });
  const again = JSON.stringify((await third.api("GET", `/runs/${runId}`)).body);
  assert.ok(again.includes("I kept [redacted] for you.") && !again.includes(ref), again);
  assert.ok(!JSON.stringify((await third.api("GET", `/runs/${runId}/timeline`)).body).includes(ref));
});

test("a workflow run of an agent with a browser sign-in serves no graph while the next server cannot read the sign-in: what its nodes said could repeat the pointer; the right key back, it is served again, cut", { timeout: 180_000 }, async (t) => {
  const dir = await scratch(t);
  const log = join(dir, "browser.jsonl");
  const sealKey = randomBytes(32).toString("base64");
  withEnv(t, { BROWSERBASE_API_KEY: BB_KEY, BROWSERBASE_PROJECT_ID: "proj-1", AGENTRUN_SEAL_KEY: sealKey, FAUX_BROWSER_LOG: log }, KEYS);
  const first = await serve(t, { fauxBrowser: FAUX_BROWSER, fauxBrowserbase: FAUX_BROWSERBASE, allowCodeNodes: true });
  assert.equal((await first.api("POST", "/agents", agent("alpha", { instructions: "Browse.", tools: ["browser"] }))).status, 201);
  // Its agentic run makes the agent's sign-in: the pointer, as the run's browser was handed it.
  const browsed = (await first.api("POST", "/agents/alpha/runs", { input: { content: "Browse the example page." } })).body.run_id;
  await follow(first.api, browsed, ["completed"], { deadlineMs: 60_000 });
  const { ref } = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line)).find((op) => op.op === "sign-in");
  // The same agent made a workflow that repeats what it is given into a call: the pointer, in its graph's effects.
  const flow = {
    v: 2, name: "echo",
    schemas: {
      In: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
      Llm: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
      Out: { type: "object", required: ["said"], properties: { said: { type: "string" } } },
    },
    input: { schemaId: "In" },
    output: { schemaId: "Out", path: "result" },
    root: { node: "chain", steps: [
      { node: "code", label: "echo", code: "(s) => ({ echo: { prompt: 'I kept ' + s.text + ' for you.' } })" },
      { node: "call", label: "say", via: "tool", tool: "llm", args: { prompt: "{echo.prompt}" }, out: "Llm", as: "said", deadline_s: 120 },
      { node: "code", label: "result", code: "(s) => ({ result: { said: s.said.text } })" },
    ] },
  };
  const edited = await first.api("PUT", "/agents/alpha/definition", { definition: { id: "alpha", name: "alpha", workflow: flow, tools: ["llm"] } });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  const runId = (await first.api("POST", "/agents/alpha/runs", { input: { text: ref } })).body.run_id;
  await follow(first.api, runId, ["completed"], { deadlineMs: 60_000 });
  const held = JSON.stringify((await first.api("GET", `/runs/${runId}/graph`)).body);
  assert.ok(held.includes(`I kept ${ref}`), held);
  await first.close();
  // Marked as a run handed the sign-in is (its browser plane, and the SHA-256 of the pointer it was handed): a workflow
  // run is never handed one, but a run so marked is what load hides.
  const metaFile = join(runDir(first.data, runId), "serve.json");
  await writeFile(metaFile, `${JSON.stringify({ ...JSON.parse(await readFile(metaFile, "utf8")), tool_plane: { browser: "browserbase" }, sign_in_handed: createHash("sha256").update(ref, "utf8").digest("hex") })}\n`);
  // The next server holds another seal key: the sign-in no longer opens, so nothing the run said can be cut.
  process.env.AGENTRUN_SEAL_KEY = randomBytes(32).toString("base64");
  const second = await serve(t, { data: first.data, fauxBrowser: FAUX_BROWSER, fauxBrowserbase: FAUX_BROWSERBASE, allowCodeNodes: true });
  assert.deepEqual((await second.api("GET", "/agents/alpha")).body.sign_ins.map((s) => s.state), ["unreadable"]);
  const graph = await second.api("GET", `/runs/${runId}/graph`);
  assert.deepEqual([graph.status, graph.body.error?.code, graph.body.error?.message], [403, "forbidden", WITHHELD_SIGN_IN], JSON.stringify(graph.body));
  assert.ok(!JSON.stringify(graph.body).includes(ref));
  await second.close();
  // The right seal key back: its graph is served again, cut of the pointer, which opens now.
  process.env.AGENTRUN_SEAL_KEY = sealKey;
  const third = await serve(t, { data: first.data, fauxBrowser: FAUX_BROWSER, fauxBrowserbase: FAUX_BROWSERBASE, allowCodeNodes: true });
  const again = await third.api("GET", `/runs/${runId}/graph`);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.ok(JSON.stringify(again.body).includes("I kept [redacted] for you.") && !JSON.stringify(again.body).includes(ref), JSON.stringify(again.body.nodes));
});

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

test("a run still going whose browser sign-in the next server cannot read is still stopped and ended when the next server cannot save that it is hidden (a full disk)", { timeout: 180_000 }, async (t) => {
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
  process.env.AGENTRUN_SEAL_KEY = randomBytes(32).toString("base64");
  await writeFile(`${gate}.echo`, `I kept ${ref} for you.`);
  // Every save of the run's hidden mark fails, as a full disk's would.
  let refused = 0;
  const { api } = await serve(t, { data, fauxBrowser: FAUX_BROWSER, fauxBrowserbase: FAUX_BROWSERBASE, beforeMetaSave: (id, meta) => { if (id === runId && meta.unshown === true) { refused += 1; throw new Error("ENOSPC: no space left on device"); } } });
  const { last } = await follow(api, runId, ["failed"], { deadlineMs: 60_000 });
  assert.ok(refused >= 1, "the hidden mark's save was tried and failed");
  assert.equal((await api("GET", `/runs/${runId}`)).body.error.message, "This server can't read the run's browser sign-in (its seal key changed or is missing, or the sign-in is damaged): the run was stopped, so nothing it says can show it.");
  await until(async () => { try { process.kill(holder.pid, 0); return false; } catch { return true; } }, (gone) => gone);
  await writeFile(gate, "");
  await new Promise((go) => setTimeout(go, 1000));
  for (const shown of [JSON.stringify(last), JSON.stringify((await api("GET", `/runs/${runId}/timeline`)).body), JSON.stringify((await api("GET", `/runs/${runId}`)).body)]) {
    assert.ok(!shown.includes(ref), shown);
    assert.ok(!shown.includes("I kept"), shown);
  }
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

test("a sign-ins file that cannot be read or parsed reads back as unreadable, never as no sign-in", async (t) => {
  const data = await scratch(t);
  const store = new SignIns(data, randomBytes(32), { create: async () => "ctx-1" }, async () => false);
  await store.forRun("alpha", "run-1", "browserbase");
  assert.deepEqual(await store.peek("alpha", "browserbase"), { ref: "ctx-1" });
  const file = join(homeOf(data, "alpha"), "sign-ins", "sign-ins.json");
  await chmod(file, 0o000);
  t.after(() => chmod(file, 0o600).catch(() => undefined));
  assert.equal(await store.peek("alpha", "browserbase"), "unreadable", "a file this server may not read");
  await chmod(file, 0o600);
  await writeFile(file, "{ not json");
  assert.equal(await store.peek("alpha", "browserbase"), "unreadable", "a damaged file");
  assert.equal(await store.peek("beta", "browserbase"), undefined, "an agent with none at all");
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

test("a hidden run stays hidden when its agent's sign-in opens again only because it was replaced: its rows hold the old pointer, which the new one does not cut", { timeout: 240_000 }, async (t) => {
  const dir = await scratch(t);
  const data = join(dir, "agents");
  const log = join(dir, "browser.jsonl");
  withEnv(t, { BROWSERBASE_API_KEY: BB_KEY, BROWSERBASE_PROJECT_ID: "proj-1", AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64"), FAUX_BROWSER_LOG: log }, KEYS);
  const { runId, ref } = await hiddenRun(t, dir, data, log);
  // Another seal key: the run is hidden, failed.
  process.env.AGENTRUN_SEAL_KEY = randomBytes(32).toString("base64");
  const second = await serve(t, { data, fauxBrowser: FAUX_BROWSER, fauxBrowserbase: FAUX_BROWSERBASE });
  await follow(second.api, runId, ["failed"], { deadlineMs: 60_000 });
  // The unreadable sign-in forgotten (as its owner would once its lease is past), and a new one made by a new run.
  await rm(join(homeOf(data, "alpha"), "sign-ins", "sign-ins.json"));
  const mark = (await readFile(log, "utf8")).trim().split("\n").length;
  await follow(second.api, (await second.api("POST", "/agents/alpha/runs", { input: { content: "Browse the example page." } })).body.run_id, ["completed"]);
  const fresh = (await readFile(log, "utf8")).trim().split("\n").slice(mark).map((line) => JSON.parse(line)).find((op) => op.op === "sign-in");
  assert.notEqual(fresh.ref, ref, "a new sign-in");
  await second.close();
  // At the next start the agent's sign-in opens, but it is not the one the hidden run was handed: it stays hidden.
  const third = await serve(t, { data, fauxBrowser: FAUX_BROWSER, fauxBrowserbase: FAUX_BROWSERBASE });
  for (const shown of [JSON.stringify((await third.api("GET", `/runs/${runId}/timeline`)).body), JSON.stringify((await third.api("GET", `/runs/${runId}`)).body)]) {
    assert.ok(!shown.includes(ref), shown);
    assert.ok(!shown.includes("I kept"), shown);
  }
  const meta = JSON.parse(await readFile(join(runDir(data, runId), "serve.json"), "utf8"));
  assert.equal(meta.unshown, true, "still hidden");
  assert.match(meta.sign_in_handed, /^[0-9a-f]{64}$/, "which sign-in it was handed, as a hash: never the pointer");
  assert.ok(!JSON.stringify(meta).includes(ref));
});

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

/** A run of agent `alpha` that browses signed in on `api`, then asks its person a question that repeats its sign-in's
 *  pointer (a model that echoes what it was given): its id and the pointer, once it waits for its person. */
async function askingRun(api, dir, log) {
  assert.equal((await api("POST", "/agents", agent("alpha", { instructions: "Browse.", tools: ["browser", "ask_person"] }))).status, 201);
  const gate = join(dir, "gate");
  const runId = (await api("POST", "/agents/alpha/runs", { input: { content: `Browse the example page, then ask me once ${gate} exists.` } })).body.run_id;
  const opened = await until(async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)), (ops) => ops.some((op) => op.op === "profile"));
  const { ref } = opened.find((op) => op.op === "sign-in");
  await writeFile(`${gate}.echo`, `I kept ${ref} for you.`);
  await writeFile(gate, "");
  await follow(api, runId, ["input_required"], { deadlineMs: 60_000 });
  return { runId, ref };
}

/** An asking run whose server stopped while it waits for its person: its process let its sessions go and released the
 *  run as the server drained, so the next server, `api`, finds it waiting with the save lease let go. */
async function releasedAskingRun(t, dir, log) {
  const first = await serve(t, { fauxBrowser: FAUX_BROWSER, fauxBrowserbase: FAUX_BROWSERBASE });
  const { runId, ref } = await askingRun(first.api, dir, log);
  await first.close();
  const second = await serve(t, { data: first.data, fauxBrowser: FAUX_BROWSER, fauxBrowserbase: FAUX_BROWSERBASE });
  await follow(second.api, runId, ["input_required"], { deadlineMs: 60_000 });
  const [signIn] = await until(async () => (await second.api("GET", "/agents/alpha")).body.sign_ins, (list) => list[0]?.state === "ready");
  assert.equal(signIn.held_by, null, "its lease let go while it waits");
  return { ...second, runId, ref };
}

/** That forget's refusal names the run and when to forget, and never shows the pointer. */
function refusedFor(forgot, runId, ref) {
  assert.deepEqual([forgot.status, forgot.body.error?.code, forgot.body.error?.details?.handed_to], [409, "sign_in_held", runId], JSON.stringify(forgot.body));
  assert.match(forgot.body.error.message, new RegExp(`the run ${runId}`));
  assert.match(forgot.body.error.message, /once that run ends/);
  assert.ok(!JSON.stringify(forgot.body).includes(ref));
}

test("a sign-in handed to a run still going is not forgotten, though its lease is let go while the run waits for its person: forget waits for the run's end", { timeout: 240_000 }, async (t) => {
  const dir = await scratch(t);
  const log = join(dir, "browser.jsonl");
  withEnv(t, { BROWSERBASE_API_KEY: BB_KEY, BROWSERBASE_PROJECT_ID: "proj-1", AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64"), FAUX_BROWSER_LOG: log }, KEYS);
  const { api, runId, ref } = await releasedAskingRun(t, dir, log);
  refusedFor(await api("DELETE", "/agents/alpha/sign-ins/default"), runId, ref);
  assert.ok(contexts.has(ref), "nothing deleted at the vendor");
  assert.deepEqual((await api("GET", "/agents/alpha")).body.sign_ins.map((s) => s.state), ["ready"]);
  // Answered, the run ends: then the sign-in is forgotten.
  assert.equal((await api("POST", `/runs/${runId}/messages`, { content: "Thanks." })).status, 202);
  await follow(api, runId, ["completed"], { deadlineMs: 60_000 });
  await until(async () => (await api("GET", "/agents/alpha")).body.sign_ins, (list) => list[0]?.state === "ready");
  const forgot = await api("DELETE", "/agents/alpha/sign-ins/default");
  assert.deepEqual([forgot.status, forgot.body], [200, { key: "default", removed: [{ provider: "browserbase", at_vendor: "deleted" }] }]);
  assert.ok(!contexts.has(ref));
});

test("across a restart, a run still going that was handed its sign-in keeps the pointer cut from its timeline and its answer: the sign-in was not forgotten under it", { timeout: 300_000 }, async (t) => {
  const dir = await scratch(t);
  const log = join(dir, "browser.jsonl");
  withEnv(t, { BROWSERBASE_API_KEY: BB_KEY, BROWSERBASE_PROJECT_ID: "proj-1", AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64"), FAUX_BROWSER_LOG: log }, KEYS);
  const second = await releasedAskingRun(t, dir, log);
  const { runId, ref } = second;
  const forgot = await second.api("DELETE", "/agents/alpha/sign-ins/default");
  await second.close();
  const { api } = await serve(t, { data: second.data, fauxBrowser: FAUX_BROWSER, fauxBrowserbase: FAUX_BROWSERBASE });
  const waiting = await follow(api, runId, ["input_required"], { deadlineMs: 60_000 });
  assert.ok(JSON.stringify(waiting.rows).includes("I kept [redacted] for you."), JSON.stringify(waiting.rows.map((row) => row.summary)));
  for (const shown of [JSON.stringify(waiting.rows), JSON.stringify((await api("GET", `/runs/${runId}`)).body), JSON.stringify((await api("GET", "/runs")).body)]) assert.ok(!shown.includes(ref), shown);
  assert.equal((await api("POST", `/runs/${runId}/messages`, { content: "Thanks." })).status, 202);
  await follow(api, runId, ["completed"], { deadlineMs: 60_000 });
  const view = (await api("GET", `/runs/${runId}`)).body;
  assert.equal(view.result.final_answer, "Noted: I kept [redacted] for you.");
  for (const shown of [JSON.stringify((await api("GET", `/runs/${runId}/timeline`)).body), JSON.stringify(view), JSON.stringify((await api("GET", "/runs")).body)]) assert.ok(!shown.includes(ref), shown);
  refusedFor(forgot, runId, ref);
});

test("a run still going whose save lease lapsed (its process went with its server 30 minutes ago, its sessions not let go) still keeps its sign-in from being forgotten", { timeout: 240_000 }, async (t) => {
  const dir = await scratch(t);
  const data = join(dir, "agents");
  const log = join(dir, "browser.jsonl");
  withEnv(t, { BROWSERBASE_API_KEY: BB_KEY, BROWSERBASE_PROJECT_ID: "proj-1", AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64"), FAUX_BROWSER_LOG: log }, KEYS);
  const first = await crashable(t, data);
  const { runId, ref } = await askingRun(first.api, dir, log);
  // A crash: the server and the run's process killed while it waits for its person, its sessions never let go.
  first.child.kill("SIGKILL");
  await new Promise((resolve) => first.child.once("exit", resolve));
  const { holder } = runRecordOf(data, runId);
  process.kill(holder.pid, "SIGKILL");
  await until(async () => { try { process.kill(holder.pid, 0); return false; } catch { return true; } }, (gone) => gone);
  const { api } = await serve(t, { data, fauxBrowser: FAUX_BROWSER, fauxBrowserbase: FAUX_BROWSERBASE });
  await follow(api, runId, ["input_required"], { deadlineMs: 60_000 });
  // The next server found its process gone: the lease stays with it by the gone rule, from then.
  const file = join(homeOf(data, "alpha"), "sign-ins", "sign-ins.json");
  const [entry] = (await until(async () => JSON.parse(await readFile(file, "utf8")).sign_ins, (list) => Boolean(list[0]?.gone_at)));
  assert.equal(entry.held_by, runId);
  // That was 30 minutes ago (the gone rule's clock, set back on disk): the lease lapsed, while the run still waits.
  await writeFile(file, `${JSON.stringify({ format: "sign-ins/1", sign_ins: [{ ...entry, gone_at: new Date(Date.now() - GONE_LEASE_MS - BROWSERBASE_SETTLE_MS - 60_000).toISOString() }] })}\n`);
  assert.deepEqual((await api("GET", "/agents/alpha")).body.sign_ins.map((s) => [s.state, s.held_by]), [["ready", null]], "lapsed");
  assert.equal((await api("GET", `/runs/${runId}`)).body.status, "input_required", "its row still running");
  refusedFor(await api("DELETE", "/agents/alpha/sign-ins/default"), runId, ref);
  assert.equal((await api("GET", "/agents/alpha")).body.sign_ins.length, 1, "still kept");
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

test("a run's error that holds its browser sign-in's pointer is served cut, in its view and in the run lists alike", { timeout: 180_000 }, async (t) => {
  const dir = await scratch(t);
  const log = join(dir, "browser.jsonl");
  withEnv(t, { BROWSERBASE_API_KEY: BB_KEY, BROWSERBASE_PROJECT_ID: "proj-1", AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64"), FAUX_BROWSER_LOG: log, FAUX_BROWSER_DIE_WITH_REF: "1" }, KEYS);
  const first = await serve(t, { fauxBrowser: FAUX_BROWSER, fauxBrowserbase: FAUX_BROWSERBASE });
  assert.equal((await first.api("POST", "/agents", agent("alpha", { instructions: "Browse.", tools: ["browser"] }))).status, 201);
  const runId = (await first.api("POST", "/agents/alpha/runs", { input: { content: "Browse the example page." } })).body.run_id;
  await follow(first.api, runId, ["failed"], { deadlineMs: 60_000 });
  const { ref } = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line)).find((op) => op.op === "sign-in");
  await first.close();
  // Its error as a server that did not cut it kept it: the pointer in the clear.
  const metaFile = join(runDir(first.data, runId), "serve.json");
  const meta = JSON.parse(await readFile(metaFile, "utf8"));
  await writeFile(metaFile, `${JSON.stringify({ ...meta, error: { code: "run_failed", message: `The browser died holding ${ref}.` } })}\n`);
  const { api } = await serve(t, { data: first.data, fauxBrowser: FAUX_BROWSER, fauxBrowserbase: FAUX_BROWSERBASE });
  // The lists first, from the run's row and serve.json alone (the server holds no Run for it yet), then its view.
  const listed = [(await api("GET", "/runs")).body, (await api("GET", "/agents/alpha/runs")).body];
  const view = (await api("GET", `/runs/${runId}`)).body;
  assert.equal(view.error.message, "The browser died holding [redacted].");
  const relisted = [(await api("GET", "/runs")).body, (await api("GET", "/agents/alpha/runs")).body];
  for (const body of [...listed, ...relisted]) assert.equal(body.runs.find((r) => r.run_id === runId).error.message, "The browser died holding [redacted].");
  for (const shown of [...listed, view, ...relisted]) assert.ok(!JSON.stringify(shown).includes(ref), JSON.stringify(shown));
});

test("a run still going whose serve.json the next server cannot read, of an agent that browses, is never taken up: it is stopped and ends failed, saying why, and nothing it says is served", { timeout: 180_000 }, async (t) => {
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
  // Its serve.json damaged: which plane it ran on, and whether it was handed the sign-in, are lost with it.
  await writeFile(join(runDir(data, runId), "serve.json"), "{\"title\": \"Browse");
  // Its gate open: its process answers with the pointer as soon as it may.
  await writeFile(`${gate}.echo`, `I kept ${ref} for you.`);
  await writeFile(gate, "");
  const { api } = await serve(t, { data, fauxBrowser: FAUX_BROWSER, fauxBrowserbase: FAUX_BROWSERBASE });
  const { last } = await follow(api, runId, ["failed", "completed"], { deadlineMs: 60_000 });
  const unsaid = async (...more) => {
    for (const shown of [...more, JSON.stringify((await api("GET", `/runs/${runId}/timeline`)).body), JSON.stringify((await api("GET", `/runs/${runId}`)).body), JSON.stringify((await api("GET", "/runs")).body)]) {
      assert.ok(!shown.includes(ref), shown);
      assert.ok(!shown.includes("I kept"), shown);
    }
  };
  await unsaid(JSON.stringify(last));
  // Stopped: nothing it could still say is served either.
  await until(async () => { try { process.kill(holder.pid, 0); return false; } catch { return true; } }, (gone) => gone);
  await unsaid();
  const view = (await api("GET", `/runs/${runId}`)).body;
  assert.deepEqual([view.status, view.error?.message], ["failed", "This server can't read the run's record (its serve.json is damaged or can't be read), so it can't tell whether the run was handed its agent's browser sign-in: the run was stopped, so nothing it says can show it."]);
  // Its end wrote serve.json anew, hidden: a later server never reads its rows either.
  const meta = await until(async () => JSON.parse(await readFile(join(runDir(data, runId), "serve.json"), "utf8").catch(() => "{}")), (kept) => kept.unshown === true);
  assert.equal(meta.error.message, view.error.message);
});

test("an ended run a list reads from its row alone has its error withheld while its agent's sign-in does not open here, and served cut once it opens again", { timeout: 240_000 }, async (t) => {
  const dir = await scratch(t);
  const log = join(dir, "browser.jsonl");
  const seal = randomBytes(32).toString("base64");
  withEnv(t, { BROWSERBASE_API_KEY: BB_KEY, BROWSERBASE_PROJECT_ID: "proj-1", AGENTRUN_SEAL_KEY: seal, FAUX_BROWSER_LOG: log, FAUX_BROWSER_DIE_WITH_REF: "1" }, KEYS);
  const first = await serve(t, { fauxBrowser: FAUX_BROWSER, fauxBrowserbase: FAUX_BROWSERBASE });
  assert.equal((await first.api("POST", "/agents", agent("alpha", { instructions: "Browse.", tools: ["browser"] }))).status, 201);
  const runId = (await first.api("POST", "/agents/alpha/runs", { input: { content: "Browse the example page." } })).body.run_id;
  await follow(first.api, runId, ["failed"], { deadlineMs: 60_000 });
  const { ref } = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line)).find((op) => op.op === "sign-in");
  await first.close();
  // Its error as a server that did not cut it kept it: the pointer in the clear.
  const metaFile = join(runDir(first.data, runId), "serve.json");
  const meta = JSON.parse(await readFile(metaFile, "utf8"));
  await writeFile(metaFile, `${JSON.stringify({ ...meta, error: { code: "run_failed", message: `The browser died holding ${ref}.` } })}\n`);
  const listed = async (api) => {
    const bodies = [(await api("GET", "/runs")).body, (await api("GET", "/agents/alpha/runs")).body];
    for (const body of bodies) assert.ok(!JSON.stringify(body).includes(ref), JSON.stringify(body));
    return bodies.map((body) => body.runs.find((r) => r.run_id === runId).error);
  };
  // Another seal key: the sign-in does not open, so the pointer can't be cut: the error is withheld, saying why.
  process.env.AGENTRUN_SEAL_KEY = randomBytes(32).toString("base64");
  const rotated = await serve(t, { data: first.data, fauxBrowser: FAUX_BROWSER, fauxBrowserbase: FAUX_BROWSERBASE });
  for (const error of await listed(rotated.api)) assert.deepEqual([error.code, /can't read the run's browser sign-in/.test(error.message)], ["run_failed", true], JSON.stringify(error));
  await rotated.close();
  // The right key back: the error is shown, cut.
  process.env.AGENTRUN_SEAL_KEY = seal;
  const { api } = await serve(t, { data: first.data, fauxBrowser: FAUX_BROWSER, fauxBrowserbase: FAUX_BROWSERBASE });
  for (const error of await listed(api)) assert.equal(error.message, "The browser died holding [redacted].");
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

test("a sign-in forgotten after its run ended is still cut from what that run said, after a restart: its pointer is kept sealed for that alone", { timeout: 240_000 }, async (t) => {
  const dir = await scratch(t);
  const log = join(dir, "browser.jsonl");
  withEnv(t, { BROWSERBASE_API_KEY: BB_KEY, BROWSERBASE_PROJECT_ID: "proj-1", AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64"), FAUX_BROWSER_LOG: log }, KEYS);
  const first = await forgottenAfterEnd(t, dir, log);
  await first.close();
  const { api } = await serve(t, { data: first.data, fauxBrowser: FAUX_BROWSER, fauxBrowserbase: FAUX_BROWSERBASE });
  // The lists first (the run read from its row alone), then its timeline and view.
  for (const path of ["/runs", "/agents/alpha/runs"]) assert.ok(!JSON.stringify((await api("GET", path)).body).includes(first.ref));
  assert.ok((await servedCut(api, first.runId, first.ref)).includes("I kept [redacted] for you."));
  assert.equal((await api("GET", `/runs/${first.runId}`)).body.result.final_answer, "I kept [redacted] for you.");
});

test("a run reopened after its first sign-in was forgotten has the old pointer cut from its follow-up, though it was handed a new one", { timeout: 300_000 }, async (t) => {
  const dir = await scratch(t);
  const log = join(dir, "browser.jsonl");
  withEnv(t, { BROWSERBASE_API_KEY: BB_KEY, BROWSERBASE_PROJECT_ID: "proj-1", AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64"), FAUX_BROWSER_LOG: log }, KEYS);
  const first = await forgottenAfterEnd(t, dir, log);
  await first.close();
  const second = await serve(t, { data: first.data, fauxBrowser: FAUX_BROWSER, fauxBrowserbase: FAUX_BROWSERBASE });
  const mark = (await readFile(log, "utf8")).trim().split("\n").length;
  // A follow-up: the run opens again on a new sign-in, and its model repeats the old pointer.
  const { after } = await follow(second.api, first.runId, ["completed"]);
  assert.equal((await second.api("POST", `/runs/${first.runId}/messages`, { content: "Once more." })).status, 202);
  const done = await follow(second.api, first.runId, ["completed"], { after, deadlineMs: 60_000 });
  const fresh = (await readFile(log, "utf8")).trim().split("\n").slice(mark).map((line) => JSON.parse(line)).find((op) => op.op === "sign-in");
  assert.ok(fresh && fresh.ref !== first.ref, "handed a new sign-in");
  assert.ok(!JSON.stringify(done.rows).includes(first.ref), JSON.stringify(done.rows.map((row) => row.summary)));
  await servedCut(second.api, first.runId, first.ref);
  assert.equal((await second.api("GET", `/runs/${first.runId}`)).body.result.final_answer, "I kept [redacted] for you.");
  await second.close();
  // Handed two pointers now (its serve.json keeps `true`): a later server cuts every forgotten one, and the live one.
  const { api } = await serve(t, { data: first.data, fauxBrowser: FAUX_BROWSER, fauxBrowserbase: FAUX_BROWSERBASE });
  assert.ok((await servedCut(api, first.runId, first.ref)).includes("I kept [redacted] for you."));
});

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
  assert.deepEqual((await api("GET", "/agents/alpha/home/files")).body.files.filter((file) => file.host_owned).map((file) => file.path), ["sign-ins"]);
  assert.equal((await api("GET", "/agents/alpha/home/files/sign-ins/sign-ins.json")).status, 403);
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

test("an agent keeps its newest 32 forgotten pointers, sealed under their own binding: each opens only under this server's seal key, and only for cutting", async (t) => {
  const data = await scratch(t);
  const { store, made, key } = fakeStore(data);
  for (let i = 0; i < MAX_FORGOTTEN + 1; i++) {
    await store.forRun("alpha", `run-${i}`, "browserbase");
    await store.forget("alpha", "default");
  }
  assert.equal(MAX_FORGOTTEN, 32);
  const kept = await store.forgotten("alpha", "browserbase");
  assert.deepEqual(kept, { refs: made.slice(1), unreadable: false }, "the oldest dropped");
  assert.deepEqual(await store.forgotten("alpha", "kernel"), { refs: [], unreadable: false });
  assert.deepEqual(await store.view("alpha"), []);
  assert.equal(await store.peek("alpha", "browserbase"), undefined, "no sign-in");
  // Never another agent's, nor under another seal key.
  await mkdir(join(homeOf(data, "beta"), "sign-ins"), { recursive: true });
  await cp(join(homeOf(data, "alpha"), "sign-ins", "sign-ins.json"), join(homeOf(data, "beta"), "sign-ins", "sign-ins.json"));
  assert.deepEqual(await store.forgotten("beta", "browserbase"), { refs: [], unreadable: true });
  const rotated = new SignIns(data, randomBytes(32), {}, async () => false);
  assert.deepEqual(await rotated.forgotten("alpha", "browserbase"), { refs: [], unreadable: true });
  assert.deepEqual((await new SignIns(data, key, {}, async () => false).forgotten("alpha", "browserbase")).refs.length, MAX_FORGOTTEN);
});

test("a list row of an ended run that was never handed a sign-in (no mark in its serve.json) serves its error as any run's, though its agent's sign-in does not open here", { timeout: 240_000 }, async (t) => {
  const dir = await scratch(t);
  withEnv(t, { BROWSERBASE_API_KEY: BB_KEY, BROWSERBASE_PROJECT_ID: "proj-1", AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64"), FAUX_BROWSER_LOG: join(dir, "browser.jsonl"), FAUX_BROWSER_DIE_WITH_REF: "1" }, KEYS);
  const first = await serve(t, { fauxBrowser: FAUX_BROWSER, fauxBrowserbase: FAUX_BROWSERBASE });
  assert.equal((await first.api("POST", "/agents", agent("alpha", { instructions: "Browse.", tools: ["browser"] }))).status, 201);
  const runId = (await first.api("POST", "/agents/alpha/runs", { input: { content: "Browse the example page." } })).body.run_id;
  await follow(first.api, runId, ["failed"], { deadlineMs: 60_000 });
  await first.close();
  // As a run that browsed signed out keeps it: its plane, and no mark that it was handed a sign-in.
  const metaFile = join(runDir(first.data, runId), "serve.json");
  const { sign_in_handed: _, ...meta } = JSON.parse(await readFile(metaFile, "utf8"));
  assert.ok(meta.tool_plane.browser);
  await writeFile(metaFile, `${JSON.stringify({ ...meta, error: { code: "run_failed", message: "The browser died." } })}\n`);
  process.env.AGENTRUN_SEAL_KEY = randomBytes(32).toString("base64");
  const { api } = await serve(t, { data: first.data, fauxBrowser: FAUX_BROWSER, fauxBrowserbase: FAUX_BROWSERBASE });
  for (const path of ["/runs", "/agents/alpha/runs"]) assert.equal((await api("GET", path)).body.runs.find((r) => r.run_id === runId).error.message, "The browser died.", path);
});
