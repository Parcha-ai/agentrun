// An agent's browser stays signed in: the cookies stay at the browser's vendor (a Browserbase context, a Kernel profile),
// this server keeps one sealed pointer per agent and vendor in the one store, and a run's runner reads it under the run's
// claim and hands it to its browser, never through an environment. The first run of an agent to bind the browser saves to
// it; one bound meanwhile starts signed in and saves nothing; a sign-in is held while a run it was handed is going. GET
// /agents/{id} lists the sign-ins, never a pointer; DELETE forgets one at the vendor and here, refused while held. No
// network: the vendors are the tests' fakes. The runner-path cases of the hand itself are sign-in-runner*.test.mjs's, the
// served cut and withhold sign-ins-reads.test.mjs's and run-custody-reads.test.mjs's, the store's sign-ins-store.test.mjs's.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { SignIns, vendorOf, vendorsOver } from "../dist/sign-ins.js";
import { keptContexts, keptProfile, savedOnRelease } from "../dist/tools.js";
import { openapiDocument } from "../dist/openapi.js";
import { calls as bbCalls, contexts, KEY as BB_KEY } from "./fixtures/faux-browserbase-check.mjs";
import { KEY as KERNEL_KEY } from "./fixtures/faux-kernel-check.mjs";
import { agent, follow, runDir, scratch, serve, storeRun, withEnv } from "./support.mjs";
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

/** The server's store files, every byte read as text (its rows, sealed sign-ins among them, and its write-ahead log). */
const storeBytes = (data) => ["store.sqlite", "store.sqlite-wal"].map((name) => { try { return readFileSync(join(data, name)).toString("latin1"); } catch { return ""; } }).join("\n");

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

  // alpha's first run holds the sign-in once its runner hands it (the run's bind writes its hand), and its session saves; it
  // waits on a file, its browser open.
  const gate = join(dir, "gate");
  const first = await start("alpha", `Browse the example page once ${gate} exists.`);
  const opened = await until(lines, (ops) => ops.some((op) => op.op === "profile"));
  const heldNow = await signIns("alpha");
  assert.deepEqual(heldNow.map(({ secret: _, ...rest }) => rest), [{ key: "default", provider: "browserbase", state: "held", held_by: first, verified_at: null }]);
  assert.deepEqual([heldNow[0].secret.name, heldNow[0].secret.set], ["sign-in:alpha:browserbase", true], "its secret's metadata, never its value");
  const handed = opened.find((op) => op.op === "sign-in");
  assert.deepEqual([handed.provider, handed.save, handed.ref_in_env], ["browserbase", true, false], "over its pipe, never in its environment");
  assert.deepEqual(opened.filter((op) => op.op === "profile"), [{ op: "profile", name: "default", save: true }], "the profile asked for by its name here, never the context");
  const forgetHeld = await api("DELETE", "/agents/alpha/sign-ins/default");
  // The store names the run it was handed to (details.handed_to, one of the 409's two documented forms; the lease's held_by
  // went with the lease): the run, never the pointer.
  assert.deepEqual([forgetHeld.status, forgetHeld.body.error.code, forgetHeld.body.error.details.handed_to], [409, "sign_in_held", first]);
  assert.ok(!JSON.stringify(forgetHeld.body).includes(handed.ref));

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
  for (const shown of [rows, (await api("GET", `/runs/${first}`)).body, storeRun(data, first)]) assert.ok(!JSON.stringify(shown).includes(handed.ref), "no pointer in its timeline, its view or its record");
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
  // Nor in the clear in the store's bytes at rest, where the sign-in is kept sealed (sign-ins-store.ts).
  assert.ok(!storeBytes(data).includes(handed.ref));

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
  // What the model was given, as the run's journal keeps it in the one store (before anything this server serves is cut),
  // and any file of the run's own folder.
  const folder = runDir(data, started.body.run_id);
  const files = existsSync(folder) ? (await readdir(folder, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name)) : [];
  const raw = [storeBytes(data), ...(await Promise.all(files.map((file) => readFile(file, "latin1"))))].join("\n");
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

test("a run's end keeps no line in the store that holds its browser sign-in's pointer, and its answer is served cut, as everything it serves is", { timeout: 120_000 }, async (t) => {
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
  // Its row in the one store keeps no line of a completed run's answer (that is the journal's, served cut): nothing of the
  // pointer is in it. Its answer reads cut, and the list holds none of it.
  const row = storeRun(data, runId);
  assert.equal(row.state, "completed", JSON.stringify(row));
  assert.ok(!JSON.stringify(row).includes(ref), JSON.stringify(row));
  assert.equal((await api("GET", `/runs/${runId}`)).body.result.final_answer, "I kept [redacted] for you.");
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
  for (const shown of [JSON.stringify(view), JSON.stringify((await api("GET", `/runs/${runId}/learning`)).body), JSON.stringify(storeRun(data, runId))]) assert.ok(!shown.includes(ref), shown);
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
