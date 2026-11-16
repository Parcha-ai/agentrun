// A template's feed trigger. Its `urls` take parameters, filled at apply: a placeholder inside a literal URL (pr-alert's
// `https://api.github.com/repos/${parameters.owner}/${parameters.repo}/pulls`), or the whole list as one placeholder
// naming an array-of-strings parameter (vendor-outage-watch's `"${parameters.status_feeds}"`), each parameter required or
// with a default, and each filled value an http(s) URL, refused at apply otherwise. An array given empty skips the
// trigger with a warning, never the apply.
// Its accept rules' where `in` values take a parameter as a github, webhook or composio trigger's do. Its every_s, items
// and id are the package's own, and a feed has no key in a package.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { PackageError, readPackage } from "../dist/templates.js";
import { scratch, serve } from "./support.mjs";
import { feed, incident, pull } from "./feed-support.mjs";

/** pr-alert's list of the repository's open pull requests, newest first, by its parameters. */
const PULLS = "https://api.github.com/repos/${parameters.owner}/${parameters.repo}/pulls?state=open&sort=created&direction=desc";
/** The owner's repository as two parameters, required unless `optional` names one, with no default unless `defaults`
 *  gives it one. */
const REPO_PARAMETERS = ({ optional = [], defaults = {} } = {}) => ["owner", "repo"].map((name) => `${name}: { type: string${optional.includes(name) || name in defaults ? ", required: false" : ""}${name in defaults ? `, default: ${defaults[name]}` : ""}, description: "the repository's ${name}" }`);
/** vendor-outage-watch's status feeds as one parameter: required, unless `fallback` gives it a default. */
const FEEDS_PARAMETER = (fallback) => `status_feeds: { type: array, items: { type: string }${fallback ? `, required: false, default: ${JSON.stringify(fallback)}` : ""}, description: "each vendor's Statuspage history.atom" }`;

const MANIFEST = ({ urls = `["${PULLS}"]`, every = "14400", extra = [], parameters = REPO_PARAMETERS() } = {}) => `---
name: pulls
version: 0.1.0
description: Says who opened each new pull request in one repository.
budget: { per_run_usd: 0.25 }
${parameters.length ? `parameters:\n${parameters.map((line) => `  ${line}`).join("\n")}\n` : ""}triggers:
  - name: new-pr
    source:
      kind: feed
      urls: ${urls}
      every_s: ${every}
${extra.map((line) => `      ${line}`).join("\n")}
    target: { kind: start_run, input: { content: "Say who opened it." } }
---
Say who opened the pull request, and what it is about.
`;

/** The package under a fresh templates folder: that folder (`root`) and the package's own (`dir`). */
async function packageWith(t, options) {
  const root = join(await scratch(t), "templates");
  const dir = join(root, "pulls");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "agent.md"), MANIFEST(options));
  return { root, dir };
}

/** readPackage's problems for the package (none: []). */
async function problemsOf(t, options = {}) {
  const { dir } = await packageWith(t, options);
  try {
    readPackage(dir);
    return [];
  } catch (error) {
    assert.ok(error instanceof PackageError, String(error));
    return error.problems;
  }
}

/** A server serving the package, every feed URL it reads answered by `faux` (the eval's route, ServeOptions feedsAt):
 *  nothing reaches GitHub. */
async function served(t, options, faux) {
  const { root } = await packageWith(t, options);
  return serve(t, { templates: root, runner: false, feedsAt: () => faux.url });
}

/** The apply's one trigger, as GET /triggers/{id} reads it. */
async function madeTrigger(api, applied) {
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  assert.equal(applied.body.trigger_ids.length, 1, JSON.stringify(applied.body));
  const read = await api("GET", `/triggers/${applied.body.trigger_ids[0]}`);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  return read.body;
}

test("pr-alert's feed: a placeholder inside a url fills from owner and repo at apply, and the trigger's first check takes its start", { timeout: 60_000 }, async (t) => {
  assert.deepEqual(await problemsOf(t), [], "the package reads");
  const pulls = await feed(t, { format: "json-list", items: [pull(2, "Two"), pull(1, "One")] });
  const { api } = await served(t, {}, pulls);
  const trigger = await madeTrigger(api, await api("POST", "/templates/pulls/apply", { parameters: { owner: "acme", repo: "web" } }));
  assert.deepEqual(trigger.source, { kind: "feed", urls: ["https://api.github.com/repos/acme/web/pulls?state=open&sort=created&direction=desc"], every_s: 14400 });
  // A JSON list has no title of its own: the feed is named by its URL, as the trigger names it (never the route's).
  const firings = (await api("GET", `/triggers/${trigger.id}/firings`)).body.firings;
  assert.deepEqual(firings.map((f) => [f.status, f.reason]), [["skipped", "Watching https://api.github.com/repos/acme/web/pulls?state=open&sort=created&direction=desc from now: the 2 items already there won't start runs."]]);
});

test("a parameter left out of the apply fills a feed's url with its default", { timeout: 60_000 }, async (t) => {
  const pulls = await feed(t, { format: "json-list", items: [] });
  const { api } = await served(t, { parameters: REPO_PARAMETERS({ defaults: { repo: "web" } }) }, pulls);
  const trigger = await madeTrigger(api, await api("POST", "/templates/pulls/apply", { parameters: { owner: "acme" } }));
  assert.deepEqual(trigger.source.urls, ["https://api.github.com/repos/acme/web/pulls?state=open&sort=created&direction=desc"]);
});

test("a feed url naming an optional parameter with no default is refused when it is read: the trigger would fill it empty", async (t) => {
  const problems = await problemsOf(t, { parameters: REPO_PARAMETERS({ optional: ["repo"] }) });
  assert.ok(problems.some((one) => /^agent\.md: parameters\.repo is used in triggers\[0\]\.source\.urls/.test(one) && /required or has a default/.test(one)), JSON.stringify(problems));
  assert.ok(!problems.some((one) => /parameters\.owner/.test(one)), `the required one is fine: ${JSON.stringify(problems)}`);
});

test("vendor-outage-watch's feeds: urls as one placeholder naming an array-of-strings parameter, required or with a default, filled whole at apply; a value that isn't an http(s) URL refuses the apply", { timeout: 60_000 }, async (t) => {
  const status = await feed(t, { format: "atom", title: "Faux Status - Incident History", items: [incident(1, "Old outage", "2026-05-10T10:00:00Z")] });
  const urls = '"${parameters.status_feeds}"';
  const feeds = ["https://www.githubstatus.com/history.atom", "https://status.openai.com/history.atom"];
  assert.deepEqual(await problemsOf(t, { urls, parameters: [FEEDS_PARAMETER()] }), [], "required, no default: it reads");
  assert.deepEqual(await problemsOf(t, { urls, parameters: [FEEDS_PARAMETER(feeds)] }), [], "with a default: it reads");
  const { api } = await served(t, { urls, parameters: [FEEDS_PARAMETER()] }, status);
  const trigger = await madeTrigger(api, await api("POST", "/templates/pulls/apply", { parameters: { status_feeds: feeds } }));
  assert.deepEqual(trigger.source.urls, feeds);
  const [watching] = (await api("GET", `/triggers/${trigger.id}/firings`)).body.firings;
  assert.equal(watching?.reason, "Watching 2 feeds from now: the 2 items already there won't start runs.");

  const refused = await api("POST", "/templates/pulls/apply", { parameters: { status_feeds: ["https://status.example.com/history.atom", "status.example.com/history.atom"] } });
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.deepEqual(refused.body.error.fields.map((f) => f.field), ["triggers.0.source.urls[1]"]);
  const defaulted = await served(t, { urls, parameters: [FEEDS_PARAMETER(feeds)] }, status);
  assert.deepEqual((await madeTrigger(defaulted.api, await defaulted.api("POST", "/templates/pulls/apply", { parameters: {} }))).source.urls, feeds);
});

test("a url filled from a required parameter is checked at apply, not with the sample a read fills it with: an http(s) one applies, another is refused under its field", { timeout: 60_000 }, async (t) => {
  const status = await feed(t, { format: "rss", items: [] });
  const options = { urls: '["${parameters.page}/history.atom"]', parameters: ['page: { type: string, description: "the status page, https://..." }'] };
  assert.deepEqual(await problemsOf(t, options), [], "the read fills it with a sample, which is no URL: the apply checks it");
  const { api } = await served(t, options, status);
  const refused = await api("POST", "/templates/pulls/apply", { parameters: { page: "ftp://status.example.com" } });
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.deepEqual(refused.body.error.fields.map((f) => f.field), ["triggers.0.source.urls[0]"]);
  assert.deepEqual((await madeTrigger(api, await api("POST", "/templates/pulls/apply", { parameters: { page: "https://status.example.com" } }))).source.urls, ["https://status.example.com/history.atom"]);
});

test("urls as one placeholder names an array-of-strings parameter that is required or has a default: a string one, or an optional one with none, is refused when it is read", async (t) => {
  const urls = '"${parameters.status_feeds}"';
  const text = await problemsOf(t, { urls, parameters: ['status_feeds: { type: string, description: "one feed" }'] });
  assert.ok(text.some((one) => /^agent\.md: triggers\[0\]\.source\.urls/.test(one) && /array/.test(one)), JSON.stringify(text));
  const optional = await problemsOf(t, { urls, parameters: ['status_feeds: { type: array, items: { type: string }, required: false, description: "feeds" }'] });
  assert.ok(optional.some((one) => /^agent\.md: parameters\.status_feeds is used in triggers\[0\]\.source\.urls/.test(one) && /required or has a default/.test(one)), JSON.stringify(optional));
});

test("a feed trigger's every_s, items and id take no parameter, and the refusal lists where a placeholder goes; a feed in a package has no key", async (t) => {
  const parameters = [...REPO_PARAMETERS(), 'n: { type: integer, required: false, default: 900, description: "seconds" }', 'at: { type: string, required: false, default: /data, description: "a pointer" }'];
  for (const [field, options] of [["every_s", { every: '"${parameters.n}"' }], ["items", { extra: ['items: "${parameters.at}"'] }], ["id", { extra: ['id: "${parameters.at}/id"'] }]]) {
    const problems = await problemsOf(t, { parameters, ...options });
    const refusal = problems.find((one) => one.startsWith(`agent.md: triggers[0].source.${field} holds \${parameters.`));
    assert.ok(refusal, `${field}: ${JSON.stringify(problems)}`);
    assert.match(refusal, /a feed trigger's urls/);
    assert.match(refusal, /where in values/);
  }
  const keyed = await problemsOf(t, { extra: ["key: GITHUB_TOKEN"] });
  assert.ok(keyed.some((one) => /^agent\.md: triggers\[0\]\.source\.key/.test(one)), JSON.stringify(keyed));
});

test("a feed trigger's accept rules take a parameter in a where condition's in values, filled at apply, required or with a default", { timeout: 60_000 }, async (t) => {
  const accept = ['accept: [{ event: item, where: [{ pointer: /item/user/login, in: ["${parameters.owner}"] }] }]'];
  const pulls = await feed(t, { format: "json-list", items: [] });
  const { api } = await served(t, { extra: accept }, pulls);
  const trigger = await madeTrigger(api, await api("POST", "/templates/pulls/apply", { parameters: { owner: "acme", repo: "web" } }));
  assert.deepEqual(trigger.source.accept, [{ event: "item", where: [{ pointer: "/item/user/login", in: ["acme"] }] }]);
  const problems = await problemsOf(t, { parameters: REPO_PARAMETERS({ optional: ["owner"] }), extra: accept });
  assert.ok(problems.some((one) => /^agent\.md: parameters\.owner is used in triggers\[0\]\.source\.accept/.test(one) && /required or has a default/.test(one)), JSON.stringify(problems));
});

test("vendor-outage-watch applied with its feeds left empty: the feed trigger is skipped with a warning under triggers.0, never the apply, and the agent stands", { timeout: 60_000 }, async (t) => {
  const status = await feed(t, { format: "atom", title: "Faux Status - Incident History", items: [incident(1, "Old outage", "2026-05-10T10:00:00Z")] });
  const urls = '"${parameters.status_feeds}"';
  const words = "The pulls template's feed trigger new-pr was not made: no feeds given in status_feeds. Apply again with status_feeds set to the feeds it should read.";
  for (const parameters of [[FEEDS_PARAMETER()], [FEEDS_PARAMETER(["https://www.githubstatus.com/history.atom"])]]) {
    const { api } = await served(t, { urls, parameters }, status);
    const applied = await api("POST", "/templates/pulls/apply", { parameters: { status_feeds: [] } });
    assert.equal(applied.status, 201, JSON.stringify(applied.body));
    assert.deepEqual(applied.body.trigger_ids, []);
    assert.deepEqual(applied.body.warnings.filter((w) => w.field === "triggers.0"), [{ field: "triggers.0", reason: "not_set_up_here", message: words }]);
    assert.equal((await api("GET", `/agents/${applied.body.agent_id}`)).status, 200);
    assert.deepEqual((await api("GET", "/triggers")).body.triggers, []);
  }
});

test("a feed's urls as one array parameter whose default is []: the package reads, and its apply skips the trigger as not set up here, so validate and apply agree", { timeout: 60_000 }, async (t) => {
  const status = await feed(t, { format: "atom", title: "Faux Status - Incident History", items: [incident(1, "Old outage", "2026-05-10T10:00:00Z")] });
  const options = { urls: '"${parameters.status_feeds}"', parameters: [FEEDS_PARAMETER([])] };
  assert.deepEqual(await problemsOf(t, options), [], "the empty default reads");
  const { api } = await served(t, options, status);
  const applied = await api("POST", "/templates/pulls/apply", { parameters: {} });
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  assert.deepEqual(applied.body.trigger_ids, []);
  assert.deepEqual(applied.body.warnings.filter((w) => w.field === "triggers.0").map((w) => w.reason), ["not_set_up_here"]);
});
