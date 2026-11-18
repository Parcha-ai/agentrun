// A template applied again onto the agent it made: POST /templates/{name}/apply with `agent_id` writes a new revision of
// that agent (same id, its runs and its learned notes kept), its parameters and grants checked as a fresh apply checks
// them (the same code: the same 422 fields), and its triggers reconciled by name: one of the same name is changed in place
// (a feed trigger keeps its seen items), one the package dropped is removed, a new one is made. The agent must have been
// made from that template: one made otherwise, or from another template, is refused under `agent_id`, and an unknown id
// is 404. A fresh apply (no agent_id) of a template whose same parameters already made a live agent still makes another,
// with a warning naming the one there.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { agent, scratch, serve, withEnv } from "./support.mjs";
import { fakeClock, firings } from "./trigger-support.mjs";
import { feed, pull, T0 } from "./feed-support.mjs";

/** The repository's open pull requests, by its parameters (every feed URL is answered by the test's fake feed). */
const PULLS = "https://api.github.com/repos/${parameters.owner}/${parameters.repo}/pulls";
const NEW_PR = (input = "Say who opened it.") => `  - name: new-pr
    source: { kind: feed, urls: ["${PULLS}"], every_s: 14400 }
    target: { kind: start_run, input: { content: "${input}" } }`;
const SCHEDULE = (name, cron) => `  - name: ${name}
    source: { kind: schedule, cron: "${cron}", timezone: UTC }
    target: { kind: start_run, input: { content: "Today's note on \${parameters.topic}." } }`;
/** digest 0.1.0: a feed trigger and a daily schedule. */
const V1 = { version: "0.1.0", triggers: [NEW_PR(), SCHEDULE("daily", "0 9 * * *")] };
/** digest 0.2.0: the feed trigger's input changed, the daily schedule dropped, a weekly one added. */
const V2 = { version: "0.2.0", instructions: "Write a short piece about ${parameters.topic}.", triggers: [NEW_PR("Say who opened it, and what it changes."), SCHEDULE("weekly", "0 9 * * 1")] };

const manifest = ({ name = "digest", version, instructions = "Write about ${parameters.topic}.", triggers = [] }) => `---
name: ${name}
version: ${version}
description: Writes about a topic and watches a repository.
budget: { per_run_usd: 0.25 }
parameters:
  topic: { type: string, description: "the topic" }
  owner: { type: string, required: false, default: acme, description: "the repository's owner" }
  repo: { type: string, required: false, default: web, description: "the repository" }
${triggers.length ? `triggers:\n${triggers.join("\n")}\n` : ""}---
${instructions}
`;

/** digest 0.3.0: its daily trigger a feed now, of another kind than 0.1.0's schedule. */
const V3 = { version: "0.3.0", triggers: [NEW_PR(), `  - name: daily
    source: { kind: feed, urls: ["${PULLS}"], every_s: 14400 }
    target: { kind: start_run, input: { content: "Today's pull requests." } }`] };

/** bare: a package that names its tools, none. */
const BARE = `---
name: bare
version: 1.0.0
description: Answers from what it is told alone.
tools: []
---
Answer from what you are told.
`;

/** keyed: one credential-named parameter, which the agent's own words never hold. */
const KEYED = `---
name: keyed
version: 1.0.0
description: Calls a service with the owner's token.
parameters:
  api_token: { type: string, description: "the service's token" }
---
Call the service with the token you are given.
`;
/** shaped 1.0.0: a typed input, a budget and learning; shaped 2.0.0 has none of them. */
const shaped = (v1) => `---
name: shaped
version: ${v1 ? "1.0.0" : "2.0.0"}
description: Answers about a project.
${v1 ? `inputs:
  project: { type: string, description: "the project" }
budget: { per_run_usd: 0.40 }
learning: true
` : ""}---
Answer about the project.
`;

/** A templates folder holding digest at `digest`, the plain package `other`, keyed, shaped (1.0.0, or 2.0.0 with `v1`
 *  false), bare, and each of `extra` (its name, its agent.md). */
async function templates(t, digest, { v1 = true, extra = {} } = {}) {
  const root = join(await scratch(t), "templates");
  for (const [name, text] of [["digest", manifest(digest)], ["other", manifest({ name: "other", version: "1.0.0" })], ["keyed", KEYED], ["shaped", shaped(v1)], ["bare", BARE], ...Object.entries(extra)]) {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(join(root, name, "agent.md"), text);
  }
  return root;
}

/** A server serving digest 0.1.0 and other, with no runner; every feed URL answered by an empty fake feed, so nothing
 *  reaches GitHub. */
async function served(t, extra = {}) {
  const quiet = await feed(t, { format: "json-list", items: [] });
  return serve(t, { templates: await templates(t, V1), runner: false, feedsAt: () => quiet.url, ...extra });
}

/** Every file under `dir`, recursively. */
const filesUnder = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? filesUnder(path) : [path];
});

/** A hold on the first update's read of its agent (ServeOptions templateApplyRead): `held` settles once the update has
 *  read the agent and waits there, `release` lets it go on. */
function readHold() {
  let release, held;
  const gate = new Promise((resolve) => (release = resolve));
  const reached = new Promise((resolve) => (held = resolve));
  let armed = true;
  const seam = async () => {
    if (!armed) return;
    armed = false;
    held();
    await gate;
  };
  return { seam, reached, release: () => release() };
}
const after = (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms));

/** A fresh apply of `name`: 201, its answer. */
async function applied(api, name, body) {
  const res = await api("POST", `/templates/${name}/apply`, body);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

/** An update in place (apply with agent_id): 200, its answer. `why` names what the update is for. */
async function updated(api, name, body, why) {
  const res = await api("POST", `/templates/${name}/apply`, body);
  assert.equal(res.status, 200, `${why}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

/** The agent's triggers by name, as GET /triggers reads them. */
async function triggersOf(api, agentId) {
  const all = (await api("GET", "/triggers")).body.triggers.filter((one) => one.target?.agent_id === agentId);
  return Object.fromEntries(all.map((one) => [one.name, one]));
}

test("an apply with agent_id writes a new revision of that agent: the same id, its runs kept, no second agent", { timeout: 60_000 }, async (t) => {
  const { api } = await served(t);
  const first = await applied(api, "digest", { parameters: { topic: "cats" } });
  const run = await api("POST", `/agents/${first.agent_id}/runs`, { input: { content: "Go." } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  assert.equal((await api("GET", `/agents/${first.agent_id}`)).body.revisions, 1);

  const again = await updated(api, "digest", { parameters: { topic: "dogs" }, agent_id: first.agent_id }, "an apply with agent_id updates that agent in place");
  assert.equal(again.agent_id, first.agent_id, "the same agent");
  const read = (await api("GET", `/agents/${first.agent_id}`)).body;
  assert.equal(read.revisions, 2, "a new revision of it");
  assert.match(read.definition.instructions, /dogs/, "the new revision is the package with the new parameters");
  assert.equal(read.template?.id, "digest");
  assert.deepEqual((await api("GET", "/agents")).body.agents.map((one) => one.agent_id), [first.agent_id], "no second agent");
  const runs = (await api("GET", `/agents/${first.agent_id}/runs`)).body.runs.map((one) => one.run_id ?? one.id);
  assert.ok(runs.includes(run.body.run_id), `its run history is kept: ${JSON.stringify(runs)}`);
});

test("an agent not made from the template is refused under agent_id, in words that say why; an unknown agent_id is 404; nothing changes", { timeout: 60_000 }, async (t) => {
  const { api } = await served(t);
  assert.equal((await api("POST", "/agents", agent("plain"))).status, 201);
  const plain = await api("POST", "/templates/digest/apply", { parameters: { topic: "cats" }, agent_id: "plain" });
  assert.equal(plain.status, 422, JSON.stringify(plain.body));
  assert.deepEqual(plain.body.error.fields.map((f) => f.field), ["agent_id"], JSON.stringify(plain.body));
  assert.match(plain.body.error.fields[0].message, /plain was not made from a template/, "says the agent was made otherwise");

  const other = await applied(api, "other", { parameters: { topic: "cats" } });
  const crossed = await api("POST", "/templates/digest/apply", { parameters: { topic: "cats" }, agent_id: other.agent_id });
  assert.equal(crossed.status, 422, JSON.stringify(crossed.body));
  assert.deepEqual(crossed.body.error.fields.map((f) => f.field), ["agent_id"], JSON.stringify(crossed.body));
  assert.match(crossed.body.error.fields[0].message, /was made from the other template, not digest/, "names the template it was made from");

  const unknown = await api("POST", "/templates/digest/apply", { parameters: { topic: "cats" }, agent_id: "no-such-agent" });
  assert.equal(unknown.status, 404, `an unknown agent_id is 404: ${JSON.stringify(unknown.body)}`);
  assert.equal(unknown.body.error.code, "not_found");
  for (const id of ["plain", other.agent_id]) assert.equal((await api("GET", `/agents/${id}`)).body.revisions, 1, `${id} is as it was`);
  assert.equal((await api("GET", "/agents")).body.agents.length, 2, "nothing made");
});

test("an update's parameters are checked as a fresh apply's, by the same code: the same 422 fields, and the agent as it was", { timeout: 60_000 }, async (t) => {
  const { api } = await served(t);
  const first = await applied(api, "digest", { parameters: { topic: "cats" } });
  const fresh = await api("POST", "/templates/digest/apply", { parameters: { repo: 5 } });
  assert.equal(fresh.status, 422, JSON.stringify(fresh.body));
  const update = await api("POST", "/templates/digest/apply", { parameters: { repo: 5 }, agent_id: first.agent_id });
  assert.equal(update.status, 422, JSON.stringify(update.body));
  assert.deepEqual(update.body.error.fields, fresh.body.error.fields, "an update's parameters are refused as a fresh apply's, by the same fields");
  assert.equal((await api("GET", `/agents/${first.agent_id}`)).body.revisions, 1, "the agent is as it was");
});

test("an update reconciles triggers by name: the same name changed in place (a feed keeps its seen items), a dropped one removed, a new one made", { timeout: 120_000 }, async (t) => {
  const pulls = await feed(t, { format: "json-list", items: [pull(2, "Two"), pull(1, "One")] });
  const clock = fakeClock(T0);
  const first = await serve(t, { templates: await templates(t, V1), runner: false, triggerClock: clock, feedsAt: () => pulls.url });
  const made = await applied(first.api, "digest", { parameters: { topic: "cats" } });
  const before = await triggersOf(first.api, made.agent_id);
  assert.deepEqual(Object.keys(before).sort(), ["daily", "new-pr"]);
  const [watching] = await firings(first.api, before["new-pr"].id, 1);
  assert.match(watching.reason, /^Watching .* from now: the 2 items already there won't start runs\.$/);
  await first.stop();

  // digest 0.2.0 on the same data; a pull request opened meanwhile.
  pulls.add(pull(3, "Three"));
  const second = await serve(t, { data: first.data, templates: await templates(t, V2), runner: false, triggerClock: clock, feedsAt: () => pulls.url });
  const again = await updated(second.api, "digest", { parameters: { topic: "cats" }, agent_id: made.agent_id }, "an apply with agent_id reconciles the agent's triggers");
  const after = await triggersOf(second.api, made.agent_id);
  assert.deepEqual(Object.keys(after).sort(), ["new-pr", "weekly"], "daily, dropped from the package, is removed; weekly is made");
  assert.equal(after["new-pr"].id, before["new-pr"].id, "new-pr is the same trigger, changed in place");
  assert.equal(after["new-pr"].target.input.content, "Say who opened it, and what it changes.", "new-pr has 0.2.0's input");
  assert.equal((await second.api("GET", `/triggers/${before.daily.id}`)).status, 404, "daily is gone");
  assert.deepEqual(again.trigger_ids, [after["new-pr"].id, after.weekly.id], "the answer lists its triggers in the package's order");
  // Its seen items held: the one new pull request fires, and there is no second "watching from now".
  const shown = await firings(second.api, before["new-pr"].id, 2);
  assert.equal(shown.filter((f) => /from now/.test(f.reason ?? "")).length, 1, `new-pr kept its seen items: ${JSON.stringify(shown)}`);
  assert.equal(shown[0].status, "started", JSON.stringify(shown));
});

test("an update keeps the agent's learned notes", { timeout: 60_000 }, async (t) => {
  const { api } = await served(t);
  const first = await applied(api, "digest", { parameters: { topic: "cats" } });
  const text = "---\nname: Kept\ndescription: Kept\ntype: reference\n---\nThe owner likes short pieces.\n";
  const put = await api("PUT", `/agents/${first.agent_id}/learning/files/kept.md`, { text }, { "if-none-match": "*" });
  assert.equal(put.status, 201, JSON.stringify(put.body));
  await updated(api, "digest", { parameters: { topic: "dogs" }, agent_id: first.agent_id }, "an update keeps the agent, and so its learned notes");
  const notes = (await api("GET", `/agents/${first.agent_id}/learning`)).body.notes.items.map((item) => item.file);
  assert.deepEqual(notes, ["kept.md"], "the learned note is kept");
});

test("a fresh apply of a template whose same parameters already made a live agent still makes one, with a warning naming the agent there", { timeout: 60_000 }, async (t) => {
  const { api } = await served(t);
  const first = await applied(api, "digest", { parameters: { topic: "cats" } });
  const second = await applied(api, "digest", { parameters: { topic: "cats" } });
  assert.notEqual(second.agent_id, first.agent_id, "it still makes a second agent");
  const said = second.warnings.filter((w) => w.field === "agent_id");
  assert.equal(said.length, 1, `a fresh apply warns of the live agent with the same parameters: ${JSON.stringify(second.warnings)}`);
  assert.equal(said[0].reason, "duplicate");
  assert.match(said[0].message, new RegExp(`${first.agent_id}`), "names the agent there");
  assert.match(said[0].message, /agent_id/, "says how to update it instead");
  const other = await applied(api, "digest", { parameters: { topic: "dogs" } });
  assert.deepEqual(other.warnings.filter((w) => w.field === "agent_id"), [], "other parameters: no warning");
  assert.equal((await api("POST", `/agents/${first.agent_id}/archive`)).status, 200);
  const third = await applied(api, "digest", { parameters: { topic: "cats" } });
  const named = third.warnings.filter((w) => w.field === "agent_id").map((w) => [w.message.includes(first.agent_id), w.message.includes(second.agent_id)]);
  assert.deepEqual(named, [[false, true]], "an archived one is not live: only the second is named");
});

test("an apply keeps no parameter in the store, only a keyed digest of them, and the duplicate warning still tells equal parameters from different ones", { timeout: 60_000 }, async (t) => {
  const server = await served(t);
  const { api } = server;
  const token = `tok-${"7f3a".repeat(8)}`;
  const first = await applied(api, "keyed", { parameters: { api_token: token } });
  const twin = await applied(api, "keyed", { parameters: { api_token: token } });
  assert.deepEqual(twin.warnings.filter((w) => w.field === "agent_id").map((w) => w.message.includes(first.agent_id)), [true], "the same parameters: the warning names the agent there");
  const other = await applied(api, "keyed", { parameters: { api_token: `tok-${"9c1d".repeat(8)}` } });
  assert.deepEqual(other.warnings.filter((w) => w.field === "agent_id"), [], "another token: no warning");
  const [row] = await server.store.agents.revisions(first.agent_id);
  assert.equal(row.package.parameters, undefined, `the revision keeps no parameter: ${JSON.stringify(row.package)}`);
  assert.match(row.package.parameters_digest ?? "", /^[A-Za-z0-9_-]{43}$/, "it keeps a digest of them");
  const holding = filesUnder(server.data).filter((path) => readFileSync(path).includes(token));
  assert.deepEqual(holding, [], "no file under the data directory holds the token");
});

test("an update replaces what the package owns: an input schema, a budget and learning the new version drops are gone from the agent", { timeout: 90_000 }, async (t) => {
  const quiet = await feed(t, { format: "json-list", items: [] });
  const first = await serve(t, { templates: await templates(t, V1), runner: false, feedsAt: () => quiet.url });
  const made = await applied(first.api, "shaped", { parameters: {} });
  const before = (await first.api("GET", `/agents/${made.agent_id}`)).body.definition;
  assert.ok(before.input_schema && before.max_cost_usd === 0.4 && before.learning === true, `1.0.0 has them: ${JSON.stringify(before)}`);
  await first.stop();
  const second = await serve(t, { data: first.data, templates: await templates(t, V1, { v1: false }), runner: false, feedsAt: () => quiet.url });
  await updated(second.api, "shaped", { parameters: {}, agent_id: made.agent_id }, "an apply with agent_id updates the agent");
  const now = (await second.api("GET", `/agents/${made.agent_id}`)).body.definition;
  assert.deepEqual([now.input_schema, now.max_cost_usd, now.learning], [undefined, undefined, undefined], `2.0.0 drops the input schema, the budget and learning, and the agent has none of them: ${JSON.stringify(now)}`);
});

test("a dropped trigger whose removal failed is removed by the next update", { timeout: 120_000 }, async (t) => {
  const quiet = await feed(t, { format: "json-list", items: [] });
  const first = await serve(t, { templates: await templates(t, V1), runner: false, feedsAt: () => quiet.url });
  const made = await applied(first.api, "digest", { parameters: { topic: "cats" } });
  const daily = (await triggersOf(first.api, made.agent_id)).daily;
  await first.stop();
  // A second handle on the store for the trigger engine, whose first removal fails before it removes anything.
  const { openSqliteStore } = await import("../dist/store/index.js");
  const store = await openSqliteStore({ dataDir: first.data, role: "runner" });
  t.after(() => store.close().catch(() => {}));
  let failNext = true;
  const triggers = new Proxy(store.triggers, {
    get(target, name) {
      const value = Reflect.get(target, name, target);
      if (typeof value !== "function") return value;
      if (name !== "remove") return value.bind(target);
      return async (...args) => {
        if (failNext) {
          failNext = false;
          throw new Error("the store failed the removal");
        }
        return value.apply(target, args);
      };
    },
  });
  const second = await serve(t, { data: first.data, templates: await templates(t, V2), runner: false, feedsAt: () => quiet.url, store: { agents: store.agents, runs: store.runs, triggers } });
  const failed = await second.api("POST", "/templates/digest/apply", { parameters: { topic: "cats" }, agent_id: made.agent_id });
  assert.ok(failed.status >= 500, `the removal failed, and the update with it: ${failed.status} ${JSON.stringify(failed.body)}`);
  assert.equal((await second.api("GET", `/triggers/${daily.id}`)).status, 200, "daily outlived the failed removal");
  await updated(second.api, "digest", { parameters: { topic: "cats" }, agent_id: made.agent_id }, "the update again");
  assert.equal((await second.api("GET", `/triggers/${daily.id}`)).status, 404, "the retry removes daily, which the package dropped");
  assert.deepEqual(Object.keys(await triggersOf(second.api, made.agent_id)).sort(), ["new-pr", "weekly"]);
});

test("overlapping updates of one agent run one after the other: the second waits, and the agent ends with one apply's revision and that apply's triggers", { timeout: 90_000 }, async (t) => {
  const hold = readHold();
  const { api } = await served(t, { templateApplyRead: hold.seam });
  const made = await applied(api, "digest", { parameters: { topic: "cats" } });
  const a = api("POST", "/templates/digest/apply", { parameters: { topic: "dogs" }, agent_id: made.agent_id });
  await Promise.race([hold.reached, a]);
  const b = api("POST", "/templates/digest/apply", { parameters: { topic: "birds" }, agent_id: made.agent_id });
  const early = await Promise.race([b.then(() => "done"), after(750, "waiting")]);
  hold.release();
  const [first, second] = await Promise.all([a, b]);
  assert.equal(early, "waiting", "the second update waits while the first holds the agent");
  assert.deepEqual([first.status, second.status], [200, 200], JSON.stringify([first.body, second.body]));
  const read = (await api("GET", `/agents/${made.agent_id}`)).body;
  assert.match(read.definition.instructions, /birds/, "the later apply's revision");
  assert.equal((await triggersOf(api, made.agent_id)).daily.target.input.content, "Today's note on birds.", "with that apply's triggers, never the other's");
});

test("an update whose read of the agent went stale before it wrote answers 412 and changes no trigger", { timeout: 90_000 }, async (t) => {
  const hold = readHold();
  const { api } = await served(t, { templateApplyRead: hold.seam });
  const made = await applied(api, "digest", { parameters: { topic: "cats" } });
  const a = api("POST", "/templates/digest/apply", { parameters: { topic: "dogs" }, agent_id: made.agent_id });
  await Promise.race([hold.reached, a]);
  const edit = await api("PUT", `/agents/${made.agent_id}/definition`, { definition: { instructions: "The owner's own words." } });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  hold.release();
  const stale = await a;
  assert.equal(stale.status, 412, `an update whose read went stale answers 412: ${stale.status} ${JSON.stringify(stale.body)}`);
  assert.equal(stale.body.error.code, "precondition_failed");
  assert.equal((await api("GET", `/agents/${made.agent_id}`)).body.definition.instructions, "The owner's own words.", "the owner's edit stands");
  assert.equal((await triggersOf(api, made.agent_id)).daily.target.input.content, "Today's note on cats.", "no trigger changed");
});

test("a trigger made again for a kind change keeps the owner's off: the package's daily, a schedule the owner turned off, made again as a feed, is off", { timeout: 120_000 }, async (t) => {
  const quiet = await feed(t, { format: "json-list", items: [] });
  const first = await serve(t, { templates: await templates(t, V1), runner: false, feedsAt: () => quiet.url });
  const made = await applied(first.api, "digest", { parameters: { topic: "cats" } });
  const daily = (await triggersOf(first.api, made.agent_id)).daily;
  assert.equal((await first.api("PATCH", `/triggers/${daily.id}`, { enabled: false })).status, 200, "the owner turns daily off");
  await first.stop();
  const second = await serve(t, { data: first.data, templates: await templates(t, V3), runner: false, feedsAt: () => quiet.url });
  await updated(second.api, "digest", { parameters: { topic: "cats" }, agent_id: made.agent_id }, "daily is a feed now");
  const now = (await triggersOf(second.api, made.agent_id)).daily;
  assert.equal(now.source.kind, "feed", "made again as a feed");
  assert.notEqual(now.id, daily.id);
  assert.equal(now.enabled, false, "the owner's off stays off");
});

/** A fake docker first on PATH and docker listed in AGENTRUN_BOXES (fixtures/fake-docker.mjs): this server offers the
 *  Docker box, so a new agent that names no tools is put in it with the shell tools. */
async function fakeDocker(t) {
  const dir = await scratch(t);
  const bin = join(dir, "bin");
  const state = join(dir, "state");
  mkdirSync(bin);
  mkdirSync(state);
  writeFileSync(join(bin, "docker"), `#!/bin/sh\nexec '${process.execPath}' '${new URL("./fixtures/fake-docker.mjs", import.meta.url).pathname}' "$@"\n`, { mode: 0o755 });
  withEnv(t, { PATH: `${bin}:${process.env.PATH}`, FAKE_DOCKER_STATE: state, AGENTRUN_BOXES: "docker" }, ["AGENTRUN_DOCKER_IMAGE", "AGENTRUN_BOX_ALLOW"]);
  assert.equal(spawnSync("sh", ["-c", "command -v docker"], { encoding: "utf8" }).stdout.trim(), join(bin, "docker"), "the fake is the docker on PATH");
}

test("an update of a package that names no tools keeps the shell tools a fresh apply gave the agent in the box; one that names none (tools: []) keeps none", { timeout: 90_000 }, async (t) => {
  await fakeDocker(t);
  const { NEW_AGENT_TOOLS } = await import("../dist/place.js");
  const { api } = await served(t);
  const made = await applied(api, "other", { parameters: { topic: "cats" } });
  const fresh = (await api("GET", `/agents/${made.agent_id}`)).body.definition;
  assert.deepEqual([fresh.place, fresh.tools], [{ mode: "sandbox", box: "docker" }, [...NEW_AGENT_TOOLS]], "a fresh apply puts the agent in the box, with its shell tools");
  await updated(api, "other", { parameters: { topic: "dogs" }, agent_id: made.agent_id }, "the same package again");
  const after = (await api("GET", `/agents/${made.agent_id}`)).body.definition;
  assert.deepEqual([after.place, after.tools], [fresh.place, fresh.tools], "the update keeps them, as a fresh apply would give them");
  const bare = await applied(api, "bare", {});
  await updated(api, "bare", { agent_id: bare.agent_id }, "bare again");
  assert.deepEqual((await api("GET", `/agents/${bare.agent_id}`)).body.definition.tools, [], "a package that names no tools keeps none");
});

// ---- the package's mark on its triggers (triggers.template_id) ---------------------------------------------------------

/** watch: a feed trigger whose feeds are an array parameter left empty by default, so a plain apply skips it. */
const WATCH = `---
name: watch
version: 1.0.0
description: Watches vendors' status feeds.
budget: { per_run_usd: 0.25 }
parameters:
  status_feeds: { type: array, items: { type: string }, required: false, default: [], description: "each vendor's status feed" }
triggers:
  - name: status
    source: { kind: feed, urls: "\${parameters.status_feeds}", every_s: 14400 }
    target: { kind: start_run, input: { content: "Say what changed." } }
---
Say what changed.
`;
/** claims: a package whose trigger names a package's mark of its own. */
const CLAIMS = `---
name: claims
version: 1.0.0
description: Names a mark on its trigger.
budget: { per_run_usd: 0.25 }
triggers:
  - name: claimed
    template_id: digest
    source: { kind: schedule, cron: "0 9 * * *", timezone: UTC }
    target: { kind: start_run, input: { content: "Go." } }
---
Go.
`;
/** A trigger the owner makes on `agentId` by POST /triggers: a noon schedule. */
const ownerTrigger = (name, agentId, content = "The owner's own note.") => ({ name, source: { kind: "schedule", cron: "0 12 * * *", timezone: "UTC" }, target: { kind: "start_run", agent_id: agentId, input: { content } } });
/** The package mark trigger `id`'s row holds (TriggerRow.templateId), read through the test's handle on the server's store. */
const markOf = async (server, id) => (await server.store.triggers.get(id))?.templateId;

test("a trigger's package mark is the apply's to set: each trigger an apply makes or keeps carries the package's id, a PATCH that moves it to another agent clears it, and moved back it is the owner's, which the next update leaves", { timeout: 120_000 }, async (t) => {
  const quiet = await feed(t, { format: "json-list", items: [] });
  const first = await serve(t, { templates: await templates(t, V1), runner: false, feedsAt: () => quiet.url });
  const made = await applied(first.api, "digest", { parameters: { topic: "cats" } });
  const other = await applied(first.api, "other", { parameters: { topic: "dogs" } });
  const { daily } = await triggersOf(first.api, made.agent_id);
  assert.equal(await markOf(first, daily.id), made.template, "the apply marks the trigger it made with the package's id");
  const away = await first.api("PATCH", `/triggers/${daily.id}`, { target: { ...daily.target, agent_id: other.agent_id } });
  assert.equal(away.status, 200, JSON.stringify(away.body));
  assert.equal(await markOf(first, daily.id), null, "the move to another agent clears the mark, in the same write");
  const back = await first.api("PATCH", `/triggers/${daily.id}`, { target: daily.target });
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.equal(await markOf(first, daily.id), null, "moved back, it is no package's");
  assert.ok(!JSON.stringify(back.body).includes("template_id"), "no answer shows the mark");
  await first.stop();
  const second = await serve(t, { data: first.data, templates: await templates(t, V2), runner: false, feedsAt: () => quiet.url });
  await updated(second.api, "digest", { parameters: { topic: "cats" }, agent_id: made.agent_id }, "0.2.0, which drops daily");
  const now = await triggersOf(second.api, made.agent_id);
  assert.equal(now.daily?.id, daily.id, "daily, moved away and back, is the owner's now: the update leaves it");
  assert.equal(await markOf(second, now["new-pr"].id), made.template, "new-pr, kept in place, is still the package's");
  assert.equal(await markOf(second, now.weekly.id), made.template, "weekly, made, is the package's");
});

test("no client writes a trigger's package mark: POST /triggers and PATCH /triggers/{id} naming template_id are refused 422, and so is a package whose trigger names it", { timeout: 90_000 }, async (t) => {
  const server = await served(t, { templates: await templates(t, V1, { extra: { claims: CLAIMS } }) });
  const made = await applied(server.api, "digest", { parameters: { topic: "cats" } });
  const posted = await server.api("POST", "/triggers", { ...ownerTrigger("mine", made.agent_id), template_id: made.template });
  assert.equal(posted.status, 422, `POST /triggers with template_id: ${JSON.stringify(posted.body)}`);
  assert.match(JSON.stringify(posted.body), /template_id/, "the refusal names the field");
  const { daily } = await triggersOf(server.api, made.agent_id);
  const patched = await server.api("PATCH", `/triggers/${daily.id}`, { template_id: "other" });
  assert.equal(patched.status, 422, `PATCH with template_id: ${JSON.stringify(patched.body)}`);
  assert.match(JSON.stringify(patched.body), /template_id/);
  assert.equal(await markOf(server, daily.id), made.template, "the mark is as the apply set it");
  const claims = await server.api("POST", "/templates/claims/apply", {});
  assert.equal(claims.status, 422, `a package's trigger naming template_id is refused: ${JSON.stringify(claims.body)}`);
  assert.match(JSON.stringify(claims.body), /template_id/);
  assert.deepEqual((await server.api("GET", "/triggers")).body.triggers.filter((one) => one.name === "claimed"), [], "no trigger made from it");
});

test("a trigger moved to another agent while an update holds its read of the agent is neither changed nor removed by it: the package's own is made again on its agent", { timeout: 120_000 }, async (t) => {
  const quiet = await feed(t, { format: "json-list", items: [] });
  const first = await serve(t, { templates: await templates(t, V1), runner: false, feedsAt: () => quiet.url });
  const made = await applied(first.api, "digest", { parameters: { topic: "cats" } });
  const other = await applied(first.api, "other", { parameters: { topic: "dogs" } });
  const before = await triggersOf(first.api, made.agent_id);
  await first.stop();
  // 0.2.0 changes new-pr's input (in place) and drops daily (removed): both moved to the other agent meanwhile.
  const hold = readHold();
  const second = await serve(t, { data: first.data, templates: await templates(t, V2), runner: false, feedsAt: () => quiet.url, templateApplyRead: hold.seam });
  const update = second.api("POST", "/templates/digest/apply", { parameters: { topic: "cats" }, agent_id: made.agent_id });
  await Promise.race([hold.reached, update]);
  for (const name of ["new-pr", "daily"]) {
    const moved = await second.api("PATCH", `/triggers/${before[name].id}`, { target: { ...before[name].target, agent_id: other.agent_id } });
    assert.equal(moved.status, 200, `${name} moved: ${JSON.stringify(moved.body)}`);
  }
  hold.release();
  const done = await update;
  assert.equal(done.status, 200, JSON.stringify(done.body));
  const theirs = await triggersOf(second.api, other.agent_id);
  assert.deepEqual(Object.keys(theirs).sort(), ["daily", "new-pr"], "both moved triggers are the other agent's still: the update removed neither");
  assert.equal(theirs["new-pr"].id, before["new-pr"].id);
  assert.equal(theirs["new-pr"].target.input.content, "Say who opened it.", "nor changed new-pr");
  assert.equal(theirs.daily.target.input.content, "Today's note on cats.", "nor daily");
  const ours = await triggersOf(second.api, made.agent_id);
  assert.deepEqual(Object.keys(ours).sort(), ["new-pr", "weekly"]);
  assert.notEqual(ours["new-pr"].id, before["new-pr"].id, "the package's new-pr made again on its agent");
  assert.equal(ours["new-pr"].target.input.content, "Say who opened it, and what it changes.");
});

test("a feed trigger an apply skipped (its feeds left empty) is no trigger of the package's: one the owner then makes by that name outlives the next update", { timeout: 90_000 }, async (t) => {
  const server = await served(t, { templates: await templates(t, V1, { extra: { watch: WATCH } }) });
  const made = await applied(server.api, "watch", {});
  assert.deepEqual(made.trigger_ids, [], "status, its feeds left empty, was skipped");
  const mine = await server.api("POST", "/triggers", ownerTrigger("status", made.agent_id));
  assert.equal(mine.status, 201, JSON.stringify(mine.body));
  await updated(server.api, "watch", { agent_id: made.agent_id }, "watch again, its feeds still empty");
  const kept = await server.api("GET", `/triggers/${mine.body.id}`);
  assert.equal(kept.status, 200, "the owner's status outlives the update");
  assert.equal(kept.body.source.kind, "schedule", "as the owner made it");
});

test("a trigger the owner made with the name of one the package then drops outlives the update", { timeout: 120_000 }, async (t) => {
  const quiet = await feed(t, { format: "json-list", items: [] });
  const first = await serve(t, { templates: await templates(t, V1), runner: false, feedsAt: () => quiet.url });
  const made = await applied(first.api, "digest", { parameters: { topic: "cats" } });
  const { daily } = await triggersOf(first.api, made.agent_id);
  assert.equal((await first.api("DELETE", `/triggers/${daily.id}`)).status < 300, true, "the owner removes the package's daily");
  const mine = await first.api("POST", "/triggers", ownerTrigger("daily", made.agent_id));
  assert.equal(mine.status, 201, JSON.stringify(mine.body));
  await first.stop();
  const second = await serve(t, { data: first.data, templates: await templates(t, V2), runner: false, feedsAt: () => quiet.url });
  await updated(second.api, "digest", { parameters: { topic: "cats" }, agent_id: made.agent_id }, "0.2.0, which drops daily");
  assert.equal((await second.api("GET", `/triggers/${mine.body.id}`)).status, 200, "the owner's daily outlives the update");
});

test("a store an earlier build made, with no triggers.template_id: the server adds it, its triggers read no package's mark, and an update leaves one the package dropped (it can't tell it from the owner's)", { timeout: 120_000 }, async (t) => {
  const quiet = await feed(t, { format: "json-list", items: [] });
  const first = await serve(t, { templates: await templates(t, V1), runner: false, feedsAt: () => quiet.url });
  const made = await applied(first.api, "digest", { parameters: { topic: "cats" } });
  const before = await triggersOf(first.api, made.agent_id);
  await first.stop();
  const file = join(first.data, "store.sqlite");
  const columnOf = () => {
    const check = new DatabaseSync(file, { readOnly: true });
    try {
      const column = check.prepare("SELECT name, type, \"notnull\" FROM pragma_table_info('triggers') WHERE name = 'template_id'").get();
      return column && { ...column };
    } finally {
      check.close();
    }
  };
  // The store as a build before the mark left it: its triggers table with no template_id column.
  if (columnOf()) {
    const db = new DatabaseSync(file);
    try {
      db.exec("ALTER TABLE triggers DROP COLUMN template_id");
    } finally {
      db.close();
    }
  }
  assert.equal(columnOf(), undefined);
  const second = await serve(t, { data: first.data, templates: await templates(t, V2), runner: false, feedsAt: () => quiet.url });
  assert.deepEqual(columnOf(), { name: "template_id", type: "TEXT", notnull: 0 }, "the server adds triggers.template_id, nullable");
  assert.equal(await markOf(second, before.daily.id), null, "a trigger made before reads no package's mark");
  await updated(second.api, "digest", { parameters: { topic: "cats" }, agent_id: made.agent_id }, "0.2.0, which drops daily");
  const now = await triggersOf(second.api, made.agent_id);
  assert.equal(now.daily?.id, before.daily.id, "daily, unmarked, is left: no mark says it is the package's");
  assert.equal(now["new-pr"].id, before["new-pr"].id, "new-pr kept in place by name");
  assert.equal(await markOf(second, now["new-pr"].id), made.template, "and marked from now");
});
