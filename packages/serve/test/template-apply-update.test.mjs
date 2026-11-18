// A template applied again onto the agent it made: POST /templates/{name}/apply with `agent_id` writes a new revision of
// that agent (same id, its runs and its learned notes kept), its parameters and grants checked as a fresh apply checks
// them (the same code: the same 422 fields), and its triggers reconciled by name: one of the same name is changed in place
// (a feed trigger keeps its seen items), one the package dropped is removed, a new one is made. The agent must have been
// made from that template: one made otherwise, or from another template, is refused under `agent_id`, and an unknown id
// is 404. A fresh apply (no agent_id) of a template whose same parameters already made a live agent still makes another,
// with a warning naming the one there.
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { agent, scratch, serve } from "./support.mjs";
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

/** A templates folder holding digest at `digest`, the plain package `other`, keyed, and shaped (1.0.0, or 2.0.0 with
 *  `v1` false). */
async function templates(t, digest, { v1 = true } = {}) {
  const root = join(await scratch(t), "templates");
  for (const [name, text] of [["digest", manifest(digest)], ["other", manifest({ name: "other", version: "1.0.0" })], ["keyed", KEYED], ["shaped", shaped(v1)]]) {
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
