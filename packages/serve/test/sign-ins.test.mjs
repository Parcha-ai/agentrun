// An agent's browser stays signed in: the cookies stay at the browser's vendor (a Browserbase context, a Kernel profile),
// this server keeps one sealed pointer per agent and vendor in the agent's home, and a run's process gets the pointer
// over its secrets' pipe, never its environment. The first run of an agent to start with the browser holds the save
// lease; one started meanwhile starts signed in and saves nothing; the lease ends with its run. GET /agents/{id} lists
// the sign-ins, never a pointer; DELETE forgets one at the vendor and here, refused while held. No network: the
// vendors are the tests' fakes.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { homeOf, writeDurable } from "../dist/files.js";
import { BROWSERBASE_SETTLE_MS, GONE_LEASE_MS, SIGN_IN_SAVED, SignIns, vendorOf, vendorsOver } from "../dist/sign-ins.js";
import { keptContexts, keptProfile, savedOnRelease } from "../dist/tools.js";
import { openapiDocument } from "../dist/openapi.js";
import { calls as bbCalls, contexts, KEY as BB_KEY } from "./fixtures/faux-browserbase-check.mjs";
import { KEY as KERNEL_KEY } from "./fixtures/faux-kernel-check.mjs";
import { agent, client, FAUX, follow, scratch, serve, withEnv } from "./support.mjs";

const FAUX_BROWSER = new URL("./fixtures/faux-browser.mjs", import.meta.url).pathname;
const FAUX_BROWSERBASE = new URL("./fixtures/faux-browserbase-check.mjs", import.meta.url).pathname;
const FAUX_KERNEL = new URL("./fixtures/faux-kernel-check.mjs", import.meta.url).pathname;
const KEYS = ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID", "BROWSERBASE_BASE_URL", "BROWSERBASE_CONNECT_BASE_URL", "KERNEL_API_KEY", "AGENTRUN_SEAL_KEY", "FAUX_BROWSER_LOG", "FAUX_BROWSER_DIE_WITH_REF", "FAUX_BROWSER_REFUSE_WITH_REF"];

/** A store over `data` with fake vendors: each made object named in turn, each removal recorded (or refused). */
function fakeStore(data, { key = randomBytes(32), running = new Set(), refuseRemove = false, now } = {}) {
  const made = [];
  const removed = [];
  const vendors = {
    create: async (vendor) => (made.push(`${vendor === "kernel" ? "agentrun-kernel" : "ctx"}-${made.length + 1}`), made.at(-1)),
    remove: async (vendor, ref) => {
      if (refuseRemove) throw new Error(`${vendor} answered 500`);
      removed.push([vendor, ref]);
    },
  };
  return { store: new SignIns(data, key, vendors, async (run) => running.has(run), now ? { now } : {}), made, removed, running, key };
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
  for (const shown of [rows, (await api("GET", `/runs/${first}`)).body, await readFile(join(data, "runs", first, "serve.json"), "utf8")]) assert.ok(!JSON.stringify(shown).includes(handed.ref), "no pointer in its timeline, its view or its record");
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
  for (const shown of [JSON.stringify(view), JSON.stringify((await api("GET", "/runs")).body), await readFile(join(data, "runs", started.body.run_id, "serve.json"), "utf8")]) assert.ok(!shown.includes(ref), shown);
});

test("verified_at counts only a session that saved: one let go by the run on the profile, never one the vendor had lost or never made; and an agent's queue goes once it is empty", async (t) => {
  const row = (releaseReason, { profile = "default", resourceId = "sess-1" } = {}) => ({ session: { resourceId, releaseReason, settings: { profile } } });
  for (const reason of ["tool", "idle", "relaunch", "close", "ended"]) assert.equal(savedOnRelease(row(reason), "released"), true, reason);
  for (const reason of ["lost", "create_failed", null]) assert.equal(savedOnRelease(row(reason), "released"), false, String(reason));
  assert.equal(savedOnRelease(row("close", { profile: null }), "released"), false, "no profile");
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
  const files = (await readdir(join(data, "runs", started.body.run_id), { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
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
  const { holder } = JSON.parse(await readFile(join(data, "runs", runId, "run.json"), "utf8"));
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
