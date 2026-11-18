// A template applied again onto the agent it made: POST /templates/{name}/apply with `agent_id` writes a new revision of
// that agent (same id, its runs and its learned notes kept), its parameters and grants checked as a fresh apply checks
// them (the same code: the same 422 fields), and its triggers reconciled by name: one of the same name is changed in place
// (a feed trigger keeps its seen items), one the package dropped is removed, a new one is made. The agent must have been
// made from that template: one made otherwise, or from another template, is refused under `agent_id`, and an unknown id
// is 404. A fresh apply (no agent_id) of a template whose same parameters already made a live agent still makes another,
// with a warning naming the one there.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
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

/** A templates folder holding digest at `digest` and the plain package `other`. */
async function templates(t, digest) {
  const root = join(await scratch(t), "templates");
  for (const [name, text] of [["digest", manifest(digest)], ["other", manifest({ name: "other", version: "1.0.0" })]]) {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(join(root, name, "agent.md"), text);
  }
  return root;
}

/** A server serving digest 0.1.0 and other, with no runner; every feed URL answered by an empty fake feed, so nothing
 *  reaches GitHub. */
async function served(t) {
  const quiet = await feed(t, { format: "json-list", items: [] });
  return serve(t, { templates: await templates(t, V1), runner: false, feedsAt: () => quiet.url });
}

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
