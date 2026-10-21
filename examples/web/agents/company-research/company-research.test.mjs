// The company-research agent's prompts, its companies, the edit tool and the config page, offline: no key, no network, no
// model. The tool and the page run against a fake of the home's prompt functions, and, where the built package has them,
// against the real ones.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import * as real from "@parcha/pi-durable-agent";
import { main as page, renderPage, where } from "./config-page.mjs";
import { listing, main as edit } from "./edit-prompts.mjs";
import { checkPrompts, normalizePrompts, questionOf, questionRow, readQuestion, ruleText, variantsOf, withQuestion } from "./prompts-lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const json = (name) => JSON.parse(readFileSync(join(HERE, name), "utf8"));
const PROMPTS = json("prompts.json").variants;
const QUESTION = await readQuestion(join(HERE, "question.json"));
const COMPANIES = json("companies.json");
const SITE_WORDS = /EDGAR|10-K|ProPublica|Nonprofit Explorer|Form 990|Google Maps|Yelp/i;

let tmp;
const root = async () => (tmp ??= await mkdtemp(join(tmpdir(), "company-research-")));
after(() => tmp && rm(tmp, { recursive: true, force: true }));
const fresh = async (name) => {
  const dir = join(await root(), `${name}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

/** The home's prompt functions, in memory: a home is a directory with an agent.sqlite file and a record here. */
function fakeApi({ withSetPrompts = true } = {}) {
  const homes = new Map();
  const calls = [];
  const api = {
    calls,
    homes,
    async createAgentHome(dir, files) {
      calls.push(["createAgentHome", dir, Object.keys(files.skills)]);
      writeFileSync(join(dir, "agent.sqlite"), "");
      homes.set(dir, { definition: files.definition, prompts: undefined });
      return { dir, identity: { id: files.definition.id, name: files.definition.name, formatVersion: 1 } };
    },
    async openAgentHome(dir) {
      calls.push(["openAgentHome", dir]);
      if (!homes.has(dir)) homes.set(dir, { definition: json("agent.json"), prompts: undefined });
      const { definition } = homes.get(dir);
      return { dir, identity: { id: definition.id, name: definition.name, formatVersion: 1 } };
    },
    async readAgentHome(home) {
      const { definition, prompts } = homes.get(home.dir);
      return { identity: home.identity, definition, prompts, runs: {}, skills: {}, profiles: {}, leases: {}, aliases: {}, bindings: {} };
    },
    async setPrompts(home, variants) {
      calls.push(["setPrompts", variants]);
      const next = Object.fromEntries(variants.map(({ id, ...rest }) => [id, structuredClone(rest)]));
      const same = JSON.stringify(homes.get(home.dir).prompts) === JSON.stringify(next);
      homes.get(home.dir).prompts = next;
      return { changed: !same };
    },
  };
  if (!withSetPrompts) delete api.setPrompts;
  return api;
}
/** A home as a directory the tool will accept. */
const homeDir = async (name) => {
  const dir = await fresh(name);
  writeFileSync(join(dir, "agent.sqlite"), "");
  return dir;
};
const run = async (tool, argv, api, extra = {}) => {
  const out = [];
  const err = [];
  const code = await tool(argv, { api, out: (line) => out.push(line), err: (line) => err.push(line), ...extra });
  return { code, out: out.join("\n"), err: err.join("\n") };
};

// ---- the content ----------------------------------------------------------------------------------------------------

test("the prompts: a base, four overlays that each name their own sources, a generic, and each overlay's rule is 0.8 on its Jev option", () => {
  assert.deepEqual(checkPrompts(PROMPTS, QUESTION), []);
  assert.deepEqual(PROMPTS.map((v) => v.id), PROMPTS.map((v) => v.label), "each variant's id is its label");
  assert.deepEqual(PROMPTS.map((v) => [v.role, v.label]), [["base", "base"], ["overlay", "public"], ["overlay", "nonprofit"], ["overlay", "small_retail"], ["overlay", "ecommerce"], ["generic", "generic"]]);
  for (const v of PROMPTS.filter((p) => p.role === "overlay")) assert.deepEqual(v.when, { question: "company_kind", option: v.label, threshold: 0.8 }, v.label);
  const text = Object.fromEntries(PROMPTS.map((v) => [v.label, v.text]));
  assert.match(text.public, /EDGAR/);
  assert.match(text.public, /10-K/);
  assert.match(text.public, /10-Q/);
  assert.match(text.public, /8-K/);
  assert.match(text.public, /earnings release/);
  assert.match(text.nonprofit, /Nonprofit Explorer/);
  assert.match(text.nonprofit, /propublica\.org\/nonprofits\/api\/v2/);
  assert.match(text.nonprofit, /needs no key/);
  assert.match(text.nonprofit, /Form 990/);
  assert.match(text.small_retail, /Google Maps/);
  assert.match(text.small_retail, /Yelp/);
  assert.match(text.small_retail, /refuse an automated fetch/);
  assert.match(text.small_retail, /local news/);
  assert.match(text.ecommerce, /its own site|own site/i);
  assert.match(text.ecommerce, /shipping/);
  assert.match(text.ecommerce, /returns/);
  assert.doesNotMatch(text.base, SITE_WORDS, "the base names no site");
  assert.doesNotMatch(text.generic, SITE_WORDS, "the generic names no site");
  assert.match(text.generic, /assume nothing/);
  assert.match(text.generic, /Search for the name with web_search/);
  assert.doesNotMatch(text.generic, /search results page|HTML page/, "the generic no longer sends the agent to fetch a search page");
  assert.match(text.base, /cited|address/);
});

test("the skill and the definition name no site, and the definition is one a home keeps", async () => {
  const skill = readFileSync(join(HERE, "skills", "research-brief", "SKILL.md"), "utf8");
  assert.doesNotMatch(skill, SITE_WORDS);
  assert.match(skill, /Cite every fact to the address/);
  assert.match(skill, /web_search[\s\S]*A search result is a lead, not a source/);
  const definition = json("agent.json");
  assert.match(definition.instructions, /web_search to find pages and web_fetch to read them/);
  assert.deepEqual([definition.name, definition.tools, definition.skills], ["Desk", ["web_search", "web_fetch", "write", "read"], ["research-brief"]]);
  const dir = join(await fresh("definition"), "home");
  const home = await real.createAgentHome(dir, { definition, skills: { "research-brief/SKILL.md": skill } });
  const state = await real.readAgentHome(home);
  assert.deepEqual([state.definition.id, state.definition.name], ["company-research", "Desk"]);
  assert.equal(state.skills["research-brief/SKILL.md"].content, skill);
});

test("the Jev question is a choice over public, nonprofit, small_retail, ecommerce and other, one line each", () => {
  const question = json("question.json");
  assert.deepEqual([question.id, question.label, question.type], ["company_kind", "Company kind", "choice"]);
  assert.deepEqual(Object.keys(question.criteria), ["public", "nonprofit", "small_retail", "ecommerce", "other"]);
  for (const [option, line] of Object.entries(question.criteria)) assert.ok(line.length > 20 && !line.includes("\n"), option);
  assert.ok(question.instructions.length > 10);
});

test("eight companies: one clear case of each kind and four ambiguous, each with its expected kind and why", () => {
  assert.equal(COMPANIES.length, 8);
  assert.equal(new Set(COMPANIES.map((c) => c.input)).size, 8);
  const clear = COMPANIES.filter((c) => c.case === "clear");
  const ambiguous = COMPANIES.filter((c) => c.case === "ambiguous");
  assert.deepEqual(clear.map((c) => c.expected).sort(), ["ecommerce", "nonprofit", "public", "small_retail"]);
  assert.equal(ambiguous.length, 4);
  for (const c of COMPANIES) assert.ok(c.why.length > 30 && c.input.length > 1, c.input);
  for (const c of COMPANIES) for (const option of c.expected.split(" or ")) assert.ok(Object.hasOwn(QUESTION.criteria, option), `${c.input}: ${option}`);
});

// ---- the check ------------------------------------------------------------------------------------------------------

test("a prompts file is refused, with the reason, when it has no base, two bases, a bad rule, a repeated label or an option the question lacks", () => {
  const ok = structuredClone(PROMPTS);
  const without = (f) => ok.filter(f);
  const edited = (label, change) => ok.map((v) => (v.label === label ? change(structuredClone(v)) : v));
  const cases = [
    ["no base", without((v) => v.role !== "base"), /exactly one base \(found 0\)/],
    ["two bases", [...ok, { id: "base2", role: "base", label: "base2", text: "x" }], /exactly one base \(found 2\)/],
    ["two generics", [...ok, { id: "generic2", role: "generic", label: "generic2", text: "x" }], /exactly one generic \(found 2\)/],
    ["no generic", without((v) => v.role !== "generic"), /exactly one generic \(found 0\)/],
    ["an overlay with no rule", edited("public", (v) => (delete v.when, v)), /public: an overlay needs a when/],
    ["a base with a rule", edited("base", (v) => ((v.when = { question: "company_kind", option: "public", threshold: 0.5 }), v)), /base: only an overlay has a when/],
    ["a threshold below 0", edited("public", (v) => ((v.when.threshold = -0.1), v)), /threshold is a number from 0 to 1/],
    ["a threshold above 1", edited("public", (v) => ((v.when.threshold = 1.2), v)), /threshold is a number from 0 to 1/],
    ["a threshold as text", edited("public", (v) => ((v.when.threshold = "0.8"), v)), /threshold is a number from 0 to 1/],
    ["an unknown option", edited("public", (v) => ((v.when.option = "listed"), v)), /"listed" is not an option of company_kind/],
    ["another question", edited("public", (v) => ((v.when.question = "other_question"), v)), /not "company_kind"/],
    ["two overlays on one option", edited("ecommerce", (v) => ((v.when.option = "public"), v)), /another overlay already takes public/],
    ["a repeated id", edited("ecommerce", (v) => ((v.id = "public"), v)), /the id is used twice/],
    ["no id", edited("ecommerce", (v) => (delete v.id, v)), /id is 1 to 128/],
    ["a field it does not keep", edited("public", (v) => ((v.priority = 1), v)), /public: has a field it does not keep \(priority\)/],
    ["an empty text", edited("generic", (v) => ((v.text = "  "), v)), /generic: text is empty/],
    ["a bad role", edited("generic", (v) => ((v.role = "fallback"), v)), /role is one of base, overlay, generic/],
    ["the question as a variant", [...ok, { id: "company_kind", role: "question", label: "q", text: "x", criteria: {} }], /company_kind: the question is question\.json, not a variant/],
    ["an overlay on other", edited("ecommerce", (v) => ((v.when.option = "other"), v)), /ecommerce: "other" is the option for an input no overlay fits, so no overlay takes it/],
    ["a variant with the question's id", edited("generic", (v) => ((v.id = "company_kind"), v)), /question\.json: the id company_kind is also a variant's/],
    ["an id that is not a URL segment", edited("generic", (v) => ((v.id = "has space"), v)), /generic|has space: id is 1 to 128/],
    ["an empty label", edited("generic", (v) => ((v.label = " "), v)), /generic: label is empty/],
  ];
  for (const [name, variants, pattern] of cases) assert.match(checkPrompts(variants, QUESTION).join("\n"), pattern, name);
  assert.deepEqual(checkPrompts([], QUESTION), ["there are no variants"]);
  assert.deepEqual(checkPrompts("no", QUESTION), ["there are no variants"]);
  const withoutEcommerce = ok.filter((v) => v.label !== "ecommerce");
  const { ecommerce, ...fewer } = QUESTION.criteria;
  assert.deepEqual(checkPrompts(withoutEcommerce, { ...QUESTION, criteria: fewer }), [], "fewer overlays is fine when the question stops describing the option too");
  assert.match(checkPrompts(withoutEcommerce, QUESTION).join("\n"), /question\.json: ecommerce is described but no overlay needs it: take it out of question\.json, or add an overlay for it/, "the home refuses a criterion no overlay needs, and so does the check");
  const { other, ...noOther } = QUESTION.criteria;
  assert.deepEqual(checkPrompts(ok, { ...QUESTION, criteria: noOther }), [], "other is implicit: a question need not describe it");
  const questionCases = [
    ["an id that is not a URL segment", { ...QUESTION, id: "has space" }, /question\.json: id is 1 to 128/],
    ["no instructions", { ...QUESTION, instructions: " " }, /question\.json: instructions is empty/],
    ["criteria that are not options to lines", { ...QUESTION, criteria: ["public"] }, /question\.json: criteria is option names to descriptions/],
    ["an empty criterion", { ...QUESTION, criteria: { ...QUESTION.criteria, nonprofit: " " } }, /question\.json: the criterion for nonprofit is empty/],
  ];
  for (const [name, question, pattern] of questionCases) assert.match(checkPrompts(ok, question).join("\n"), pattern, name);
  assert.match(checkPrompts(ok, { ...QUESTION, criteria: undefined }).join("\n"), /question\.json: criteria is option names to descriptions/, "a question with no criteria is refused, not a crash");
  assert.deepEqual(checkPrompts(edited("public", (v) => ((v.when.threshold = 0), v)), QUESTION), [], "a threshold of 0 is one the home keeps");
  assert.equal(ruleText(PROMPTS[1].when), "company_kind is public at 0.8 or more");
  assert.deepEqual(variantsOf({ variants: [1] }), [1]);
  assert.deepEqual(variantsOf([2]), [2]);
  assert.throws(() => variantsOf({ nope: 1 }), /prompts file is/);
  assert.deepEqual(normalizePrompts({ g: { role: "generic", text: "g" }, a: { role: "base", text: "t" } }), [{ id: "a", role: "base", text: "t" }, { id: "g", role: "generic", text: "g" }], "a record by id becomes a list, the base first");
  assert.deepEqual(normalizePrompts({ q: { role: "question", text: "q" }, g: { role: "generic", text: "g" }, a: { role: "base", text: "t" } }).map((v) => v.id), ["a", "g", "q"], "the question comes last");
  assert.deepEqual(questionRow(QUESTION), { id: "company_kind", role: "question", label: "Company kind", text: QUESTION.instructions, criteria: QUESTION.criteria });
  assert.notEqual(questionRow(QUESTION).criteria, QUESTION.criteria, "the row holds a copy of the options");
  const set = withQuestion(PROMPTS, QUESTION);
  assert.deepEqual(set.map((v) => v.role), ["base", "overlay", "overlay", "overlay", "overlay", "generic", "question"]);
  assert.deepEqual(questionOf(Object.fromEntries(set.map(({ id, ...rest }) => [id, rest]))), QUESTION, "the question a home holds is the one question.json has");
  assert.deepEqual(questionOf(set), QUESTION);
  assert.equal(questionOf(PROMPTS), undefined);
  assert.equal(questionOf(undefined), undefined);
});

// ---- the edit tool --------------------------------------------------------------------------------------------------

test("edit-prompts saves the file's variants with setPrompts, replacing what the home held, and says what it saved", async () => {
  const api = fakeApi();
  const home = await homeDir("save");
  await api.setPrompts(await api.openAgentHome(home), [{ id: "old", role: "base", label: "old", text: "x" }, { id: "generic", role: "generic", label: "generic", text: "y" }]);
  api.calls.length = 0;
  const first = await run(edit, ["--home", home], api);
  assert.equal(first.code, 0, first.err);
  const [, saved] = api.calls.find(([name]) => name === "setPrompts");
  assert.deepEqual(saved, [...PROMPTS, questionRow(QUESTION)], "the file's six variants and, last, the question as its own row");
  assert.match(first.out, /^saved 6 prompt variants and the question company_kind in /);
  assert.match(first.out, /overlay\s+nonprofit\s+company_kind is nonprofit at 0\.8 or more/);
  assert.match(first.out, /question\s+company_kind\s+options: public, nonprofit, small_retail, ecommerce, other\s+\d+ chars\s+What kind of organisation/);
  assert.doesNotMatch(first.out, new RegExp(home.replaceAll(/[/\\^$.*+?()[\]{}|]/g, "\\$&")), "the path of the home is not printed");

  const afterFirst = normalizePrompts((await api.readAgentHome(await api.openAgentHome(home))).prompts).map((v) => v.id);
  assert.deepEqual(afterFirst, ["base", "public", "nonprofit", "small_retail", "ecommerce", "generic", "company_kind"], "what the home held before is gone");
  const changed = join(await fresh("file"), "changed.json");
  writeFileSync(changed, JSON.stringify(PROMPTS.map((v) => (v.role === "base" ? { ...v, text: "Research it." } : v))));
  const second = await run(edit, ["--home", home, "--file", changed], api);
  assert.equal(second.code, 0, second.err);
  const held = normalizePrompts((await api.readAgentHome(await api.openAgentHome(home))).prompts);
  assert.equal(held.length, 7, "the second save replaced the first, and the question stayed");
  assert.equal(held[0].text, "Research it.");
  const again = await run(edit, ["--home", home, "--file", changed], api);
  assert.equal(again.code, 0, again.err);
  assert.match(again.out, /^the 6 prompt variants and the question company_kind were already saved in .*: nothing changed/, "a save of what is there says so");
});

test("edit-prompts --show prints what the home holds, as a table or as JSON", async () => {
  const api = fakeApi();
  const home = await homeDir("show");
  const empty = await run(edit, ["--home", home, "--show"], api);
  assert.equal(empty.code, 0);
  assert.match(empty.out, /^Desk \(company-research\): 0 prompt variants$/);
  assert.doesNotMatch(empty.out, /question/, "a home with no prompts has no question either");
  await run(edit, ["--home", home], api);
  const shown = await run(edit, ["--home", home, "--show"], api);
  assert.match(shown.out, /^Desk \(company-research\): 6 prompt variants and a question\n/);
  assert.match(shown.out, /question\s+company_kind\s+options: public, nonprofit, small_retail, ecommerce, other\s/);
  assert.match(shown.out, /base\s+base\s+-\s+\d+ chars\s+You research one company/);
  assert.match(shown.out, /overlay\s+small_retail\s+company_kind is small_retail at 0\.8 or more/);
  assert.match(shown.out, /generic\s+generic\s+-/);
  const asJson = JSON.parse((await run(edit, ["--home", home, "--show", "--json"], api)).out);
  assert.deepEqual([asJson.agent, asJson.prompts], [{ id: "company-research", name: "Desk" }, [...PROMPTS, questionRow(QUESTION)]]);
});

test("edit-prompts refuses a bad file with every problem and saves nothing; --check needs no home", async () => {
  const api = fakeApi();
  const home = await homeDir("bad");
  const file = join(await fresh("bad-file"), "bad.json");
  writeFileSync(file, JSON.stringify({ variants: [{ role: "overlay", label: "public", text: "x" }] }));
  const refused = await run(edit, ["--home", home, "--file", file], api);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /bad\.json is not saved: \d+ problems/);
  writeFileSync(file, JSON.stringify({ variants: [{ id: "a", role: "overlay", label: "public", text: "x" }, { id: "a", role: "overlay", label: "public", text: "y", when: { question: "company_kind", option: "listed", threshold: 2 } }] }));
  const refusedAgain = await run(edit, ["--home", home, "--file", file], api);
  for (const reason of [/exactly one base \(found 0\)/, /exactly one generic \(found 0\)/, /an overlay needs a when/, /the id is used twice/, /"listed" is not an option/, /threshold is a number from 0 to 1/]) assert.match(refusedAgain.err, reason);
  assert.equal(api.calls.some(([name]) => name === "setPrompts"), false, "setPrompts was never called");
  writeFileSync(file, JSON.stringify(PROMPTS.filter((v) => v.label !== "ecommerce")));
  const fewer = await run(edit, ["--home", home, "--file", file], api);
  assert.equal(fewer.code, 1);
  assert.match(fewer.err, /question\.json: ecommerce is described but no overlay needs it/, "the question must follow the overlays");
  assert.equal(api.calls.some(([name]) => name === "setPrompts"), false, "nothing was saved");
  const bare = await fresh("no-question");
  writeFileSync(join(bare, "prompts.json"), JSON.stringify(PROMPTS));
  const noQuestion = await run(edit, ["--home", home], api, { dir: bare });
  assert.equal(noQuestion.code, 1);
  assert.match(noQuestion.err, /question\.json is missing or is not JSON/, "overlays with no question are refused, never saved without their question row");
  assert.equal(api.calls.some(([name]) => name === "setPrompts"), false, "nothing was saved");
  const checked = await run(edit, ["--check", "--file", file], api);
  assert.equal(checked.code, 1);
  const good = await run(edit, ["--check"], api);
  assert.equal(good.code, 0, good.err);
  assert.match(good.out, /^prompts\.json is valid: 6 variants, and the question company_kind\n/);
  assert.match(good.out, /question\s+company_kind\s+options: /);
  assert.equal(api.calls.length, 0, "--check opens no home");

  const notJson = join(await fresh("not-json"), "x.json");
  writeFileSync(notJson, "{ nope");
  assert.match((await run(edit, ["--check", "--file", notJson], api)).err, /x\.json: /);
  assert.match((await run(edit, ["--check", "--file", join(HERE, "absent.json")], api)).err, /cannot read .*absent\.json: ENOENT/);
});

test("edit-prompts needs a home: --init makes one from agent.json and its skill first; without it the tool says how", async () => {
  const api = fakeApi();
  const dir = join(await fresh("init"), "desk-home");
  const without = await run(edit, ["--home", dir], api);
  assert.equal(without.code, 1);
  assert.match(without.err, /desk-home is not an agent home; add --init/);
  assert.equal(existsSync(dir), false, "nothing was made");
  const made = await run(edit, ["--home", dir, "--init"], api);
  assert.equal(made.code, 0, made.err);
  assert.match(made.out, /^made the agent home desk-home\nsaved 6 prompt variants and the question company_kind/);
  assert.deepEqual(api.calls[0], ["createAgentHome", dir, ["research-brief/SKILL.md"]]);
  assert.equal(readdirSync(dir).includes("agent.sqlite"), true);
});

test("edit-prompts: a usage error is exit 2, and a build with no setPrompts is said plainly", async () => {
  const api = fakeApi();
  for (const argv of [[], ["--show"], ["--home", "x", "--show", "--file", "f"], ["--home", "x", "--json"], ["--check", "--home", "x"], ["--nope"]]) assert.equal((await run(edit, argv, api)).code, 2, argv.join(" "));
  const home = await homeDir("old-build");
  const old = await run(edit, ["--home", home], fakeApi({ withSetPrompts: false }));
  assert.equal(old.code, 1);
  assert.match(old.err, /has no setPrompts/);
  assert.match(listing([{ role: "base", label: "base", text: "A line\nanother" }]), /^base\s+base\s+-\s+14 chars\s+A line$/);
});

// ---- the config page ------------------------------------------------------------------------------------------------

const PROBS = { public: 0.93, nonprofit: 0.02, small_retail: 0.01, ecommerce: 0.02, other: 0.02 };
const RUNS = [
  { id: "run-a", title: "", index: { startedAt: "2026-10-20T04:10:00.000Z", endedAt: "2026-10-20T04:12:30.000Z", outcome: "completed", cost: 0.0421 }, briefHref: "runs/run-a/work/brief.md",
    record: { version: 1, question: "company_kind", input: "Caterpillar Inc.", variant: "public", passes: [{ choice: "public", confidence: 0.93, probabilities: PROBS, model: "jev-latest", cost_usd: 0.00001, latency_ms: 412 }], lookup: { used: false, sources: [] }, reason: "Jev: public at 93%" } },
  { id: "run-b", title: "", index: { startedAt: "2026-10-20T04:20:00.000Z", endedAt: "2026-10-20T04:23:00.000Z", outcome: "completed", cost: 0.05 }, briefHref: null,
    record: { version: 1, question: "company_kind", input: "Habitat", variant: "generic", passes: [
      { choice: "other", confidence: 0.41, probabilities: { public: 0.1, nonprofit: 0.35, small_retail: 0.1, ecommerce: 0.04, other: 0.41 } },
      { choice: "nonprofit", confidence: 0.62, probabilities: { public: 0.02, nonprofit: 0.62, small_retail: 0.1, ecommerce: 0.06, other: 0.2 } },
    ], lookup: { used: true, sources: [{ via: "browserbase_search", url: "https://example.org/about?utm=1#top", title: "About Habitat" }, { via: "wikipedia", url: "https://en.wikipedia.org/wiki/Habitat_(disambiguation)", title: "Habitat" }] }, reason: "Jev: other at 41%; after the lookup, Jev: nonprofit at 62%, under 80%; so the generic prompt" } },
  { id: "run-c", title: "Powell's Books", index: { startedAt: "2026-10-20T04:30:00.000Z", prompt: { id: "small-retail-v2", reason: "from the index" } }, record: null, briefHref: null },
  { id: "run-d", title: "", index: { startedAt: "2026-10-20T04:40:00.000Z", endedAt: "2026-10-20T04:41:00.000Z", outcome: "failed" }, briefHref: null,
    record: { version: 1, input: "<script>alert(1)</script> & \"Co\"", passes: [{ pass: 1, lookup: null, choice: "<img src=x onerror=alert(2)>", confidence: 0.5, probabilities: {} }], lookup_used: false, chosen: { label: "<b>x</b>", role: "overlay", reason: "<i>why</i>" } } },
];
const DATA = { agent: { id: "company-research", name: "Desk", description: "Researches one company." }, prompts: [...PROMPTS.map((v) => (v.id === "small_retail" ? { ...v, id: "small-retail-v2" } : v)), questionRow(QUESTION)], runs: RUNS, generatedAt: "2026-10-20T05:00:00.000Z" };

test("the page shows the base, each overlay with its Jev rule, the generic, and a row for each run: both passes, the lookup, the prompt loaded, the outcome and the result", () => {
  const html = renderPage(DATA);
  for (const v of PROMPTS) assert.ok(html.includes(`<b>${v.label}</b> <span class="role">${v.role}</span>`), v.label);
  for (const v of PROMPTS.filter((p) => p.when)) assert.ok(html.includes(`loads when company_kind is ${v.label} at 0.8 or more`), v.label);
  assert.match(html, /loads when no overlay reaches its threshold, even after a lookup/);
  assert.match(html, /always part of the prompt/);
  assert.ok(html.includes("EDGAR") && html.includes("Nonprofit Explorer"), "each prompt's text is on the page");
  assert.match(html, /<li><b>nonprofit<\/b>: A charity/);
  assert.match(html, /Before its first turn the host asks Jev one question[\s\S]*company_kind[\s\S]*0\.8 or more/);
  assert.ok(html.includes(QUESTION.instructions), "the question's text is the home's row's text");
  assert.doesNotMatch(html, /<span class="role">question<\/span>/, "the question is not shown as a prompt that loads");
  const without = renderPage({ ...DATA, prompts: DATA.prompts.filter((v) => v.role !== "question") });
  assert.match(without, /No question is configured\./, "a home with no question row says so");
  assert.ok(without.includes('<b>nonprofit</b> <span class="role">overlay</span>'), "and still shows its prompts");
  const rows = html.match(/<tr><td>[\s\S]*?<\/tr>/g);
  assert.equal(rows.length, 4);
  const byId = (id) => rows.find((row) => row.includes(`class="id">${id}<`));
  assert.ok(rows[0].includes('class="id">run-d<') && rows[3].includes('class="id">run-a<'), "newest first");
  const a = byId("run-a");
  assert.ok(a.includes("Caterpillar Inc."));
  assert.ok(a.includes("<b>public</b> at 0.93"));
  assert.ok(a.includes("public 0.93 · nonprofit 0.02"), "probabilities, largest first");
  assert.ok(a.includes("$0.000010") && a.includes("412 ms"));
  assert.ok(a.includes("<td>no</td>"), "no lookup");
  assert.ok(a.includes('<b>public</b> <span class="role">overlay</span><small>Jev: public at 93%</small>'), "the variant by its label, its role from the home, the host's reason");
  assert.ok(a.includes("completed<small>$0.0421</small>"));
  assert.ok(a.includes('<a href="runs/run-a/work/brief.md">brief.md</a>'));
  const b = byId("run-b");
  assert.ok(b.includes("<b>other</b> at 0.41") && b.includes("<b>nonprofit</b> at 0.62"), "both passes");
  assert.ok(b.includes("other 0.41 · nonprofit 0.35 · "), "the probabilities, largest first, whatever order they came in");
  assert.ok(b.includes("yes<small>browserbase_search · About Habitat · example.org/about<br>wikipedia · Habitat · en.wikipedia.org/wiki/Habitat_(disambiguation)</small>"), "each source the lookup read, its address with no scheme, query or fragment");
  assert.ok(b.includes("so the generic prompt</small>"), "the host's reason is shown as it wrote it");
  const first = { choice: "other", confidence: 0.41, probabilities: { other: 0.41, nonprofit: 0.35 } };
  const oldShape = renderPage({ ...DATA, runs: [{ id: "run-old", title: "", index: {}, briefHref: null, record: { version: 1, input: "Habitat", passes: [{ pass: 1, lookup: null, ...first }, { pass: 2, lookup: { query: "q", url: "https://example.org/x?y=1", title: "T" }, choice: "nonprofit", confidence: 0.62, probabilities: {} }], lookup_used: true, chosen: { label: "generic", role: "generic", reason: "first-shape reason" } } }] });
  assert.ok(oldShape.includes('<b>generic</b> <span class="role">generic</span><small>first-shape reason</small>'), "the first prompt.json shape (chosen, lookup_used) still shows");
  const flagged = renderPage({ ...DATA, runs: [{ id: "run-flag", title: "", index: {}, briefHref: null, record: { input: "X", passes: [first], lookup_used: true, chosen: { label: "generic", role: "generic", reason: "r" } } }] });
  assert.ok(flagged.includes("yes<small>no source recorded</small>"), "the first shape's lookup_used, with no lookup recorded, still says a lookup ran");
  const unnamed = renderPage({ ...DATA, runs: [{ id: "run-n", title: "", index: {}, briefHref: null, record: { input: "X", variant: { id: "nonprofit", label: "Charity", role: "overlay" }, passes: [first], lookup: { used: true, sources: [] }, reason: "r" } }] });
  assert.ok(unnamed.includes('<b>Charity</b> <span class="role">overlay</span><small>r</small>') && unnamed.includes("yes<small>no source recorded</small>"), "a variant as { id, label, role }, and a lookup that recorded no source");
  assert.ok(oldShape.includes("yes<small>T · example.org/x<br>search: q</small>"), "a lookup of one page, as `{ url, title }`, still shows");
  assert.ok(b.includes('<b>generic</b> <span class="role">generic</span>'));
  assert.ok(b.includes("no brief"));
  const c = byId("run-c");
  assert.ok(c.includes("Powell&#39;s Books"), "the input falls back to the run's title");
  assert.ok(c.includes("<b>small_retail</b>") && c.includes("from the index"), "the runs index's prompt (an id) is shown by its variant's label when there is no prompt.json");
  assert.ok(c.includes("not recorded") && c.includes(">running<"));
  assert.equal(where("https://example.org/about?utm=1#top"), "example.org/about");
  assert.equal(where("nonsense"), "");
});

test("a pass shows its choice at the probability the threshold is compared with, and its confidence when that is a different number", () => {
  const habitat = { version: 1, input: "Habitat", variant: "generic", passes: [{ choice: "nonprofit", confidence: 0.37, probabilities: { nonprofit: 0.5, other: 0.36, public: 0.13 }, cost_usd: 0.00002, latency_ms: 344 }, { choice: "nonprofit", confidence: 0.46, probabilities: { nonprofit: 0.46, other: 0.4 } }], lookup: { used: true, sources: [] }, reason: "r" };
  const html = renderPage({ ...DATA, runs: [{ id: "run-h", title: "", index: {}, briefHref: null, record: habitat }] });
  const [first, second] = html.match(/<td class="num"><b>nonprofit<\/b>[\s\S]*?<\/td>/g);
  assert.ok(first.startsWith("<td class=\"num\"><b>nonprofit</b> at 0.50<small>nonprofit 0.50 · other 0.36 · public 0.13</small><small>confidence 0.37 · $0.000020 · 344 ms</small>"), first);
  assert.ok(second.startsWith("<td class=\"num\"><b>nonprofit</b> at 0.46<small>nonprofit 0.46 · other 0.40</small>"), "the same number twice is shown once");
  assert.doesNotMatch(second, /confidence/);
  const bare = renderPage({ ...DATA, runs: [{ id: "run-i", title: "", index: {}, briefHref: null, record: { version: 1, input: "x", passes: [{ choice: "public", confidence: 0.5, probabilities: {} }] } }] });
  assert.ok(bare.includes("<td class=\"num\"><b>public</b> at 0.50</td>"), "with no probability for the choice, the confidence is the number shown");
  const noConfidence = renderPage({ ...DATA, runs: [{ id: "run-j", title: "", index: {}, briefHref: null, record: { version: 1, input: "x", passes: [{ choice: "public", probabilities: { public: 0.7 } }, { choice: "other" }] } }] });
  assert.ok(noConfidence.includes("<td class=\"num\"><b>public</b> at 0.70<small>public 0.70</small></td>"), "with no confidence, the probability is shown alone");
  assert.ok(noConfidence.includes("<td class=\"num\"><b>other</b></td>"), "with neither, only the choice");
});

test("the page wears the agentrun.ai tokens: dark only, square corners, hairlines, a mono and a sans stack, the dotted grid, and no font or file loaded", () => {
  const html = renderPage(DATA);
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)[1];
  const tokens = { bg: "#080809", panel: "#111113", line: "#2c2c30", ink: "#f2f2f2", muted: "#a4a4ad", accent: "#ff8700", purple: "#b4a0ff", green: "#8ec9ac" };
  for (const [name, value] of Object.entries(tokens)) assert.ok(style.includes(`--${name}:${value};`) || style.includes(`--${name}:${value}}`), name);
  assert.deepEqual([...new Set(style.match(/#[0-9a-f]{3,8}\b/gi).map((color) => color.toLowerCase()))].sort(), [...Object.values(tokens), "#303036"].sort(), "no colour but the eight tokens and the grid's dot");
  assert.match(style, /^:root\{color-scheme:dark;/);
  assert.doesNotMatch(style, /border-radius|prefers-color-scheme|color-scheme:[^;}]*light/i, "no rounded corner and no light theme");
  assert.match(style, /--mono:"JetBrains Mono",ui-monospace,[^;]*monospace;/);
  assert.match(style, /--sans:Inter,system-ui,[^;}]*sans-serif[;}]/);
  assert.match(style, /radial-gradient\(#303036 1px,transparent 1px\);background-size:22px 22px/, "the dotted grid on a 22px pitch");
  assert.match(style, /h1\{font:600 28px\/1\.2 var\(--mono\)/, "titles are mono");
  assert.match(style, /body\{[^}]*font:15px\/1\.7 var\(--sans\)/, "the body is sans");
  assert.match(style, /td\.num\{font:[^}]*var\(--mono\)/, "numbers are mono");
  assert.doesNotMatch(style, /@font-face|url\(|@import|https?:/i, "the fonts are the system's or the reader's own: nothing is loaded");
  assert.match(html, /<td class="num"><b>public<\/b> at 0\.93/, "a pass's numbers sit in the mono cell");
});

test("the page has no script, no network address to load and nothing unescaped from a run", () => {
  const html = renderPage(DATA);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<[a-z][^>]*\son[a-z]+\s*=/i, "no event attribute on any real tag");
  assert.doesNotMatch(html, /<(iframe|object|embed|form|base|link|img|svg|video|audio)\b/i);
  assert.doesNotMatch(html, /<[a-z][^>]*\b(src|srcset|action|formaction)\s*=/i, "no attribute that loads or submits");
  assert.doesNotMatch(html, /url\(|@import/i);
  assert.deepEqual([...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]), ["runs/run-a/work/brief.md"], "the one link is relative");
  assert.match(html, /content="default-src 'none'; style-src 'unsafe-inline'/);
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;Co&quot;"), "an input is escaped");
  assert.ok(html.includes("&lt;img src=x onerror=alert(2)&gt;") && html.includes("&lt;b&gt;x&lt;/b&gt;") && html.includes("&lt;i&gt;why&lt;/i&gt;"));
  assert.doesNotMatch(html, /\/home\/|\/tmp\//);
  assert.match(renderPage({ agent: { name: "A" }, prompts: undefined, runs: [], generatedAt: "t" }), /No prompts are saved in this home\.[\s\S]*No runs yet\./);
  assert.equal(renderPage(DATA), renderPage(structuredClone(DATA)), "the same data gives the same page");
});

/** A real home with two runs started, one of them carried back with a brief and a prompt.json. */
async function homeWithRuns() {
  const dir = join(await fresh("page-home"), "home");
  const definition = json("agent.json");
  const home = await real.createAgentHome(dir, { definition, skills: { "research-brief/SKILL.md": readFileSync(join(HERE, "skills", "research-brief", "SKILL.md"), "utf8") } });
  const one = await real.startRun(home, { runId: "r1", host: "test" });
  mkdirSync(one.workspace, { recursive: true });
  writeFileSync(join(one.workspace, "brief.md"), "# Caterpillar\n");
  writeFileSync(join(one.dir, "prompt.json"), JSON.stringify(RUNS[0].record));
  await real.carryBack(home, one, { outcome: "completed", cost: 0.02 });
  await real.startRun(home, { runId: "r2", host: "test" });
  return { dir, home };
}

test("config-page reads a real agent home and its runs' prompt.json, links the brief by a relative path and writes the page whole", async () => {
  const { dir } = await homeWithRuns();
  const out = join(await fresh("page-out"), "site", "config.html");
  const result = await run(page, ["--home", dir, "--out", out], undefined);
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /^wrote config\.html: \d+ prompt variants, 2 runs$/);
  const html = readFileSync(out, "utf8");
  assert.ok(html.includes("<h1>Desk</h1>"));
  assert.ok(html.includes("Caterpillar Inc.") && html.includes("<b>public</b> at 0.93"), "run r1's prompt.json is read");
  const link = /href="([^"]*)"/.exec(html)[1];
  assert.match(link, /^\.\.\/.*home\/runs\/r1\/work\/brief\.md$/, "the brief is linked by a path relative to the page, never an absolute one");
  assert.ok(html.includes("completed<small>$0.0200</small>"), "the outcome and cost come from the runs index");
  assert.equal([...html.matchAll(/href="([^"]*)"/g)].length, 1, "r2 has no brief and so no link");
  assert.equal(readdirSync(dirname(out)).filter((name) => name.endsWith(".tmp")).length, 0, "no temporary file is left");
  assert.equal(typeof (await real.readAgentHome(await real.openAgentHome(dir))).runs.r1.endedAt, "string");
});

test("config-page shows the prompts the home holds and the question's rule, through the home's own readAgentHome", async () => {
  const { dir } = await homeWithRuns();
  const wrapped = { ...real, readAgentHome: async (home) => ({ ...(await real.readAgentHome(home)), prompts: withQuestion(PROMPTS, QUESTION) }) };
  const out = join(await fresh("page-prompts"), "config.html");
  const result = await run(page, ["--home", dir, "--out", out], wrapped);
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /6 prompt variants, 2 runs/);
  const html = readFileSync(out, "utf8");
  assert.ok(html.includes("loads when company_kind is public at 0.8 or more"));
  assert.ok(html.includes("0.8 or more) is added to the base"));
  assert.ok(html.includes(QUESTION.instructions), "the question is read from the home's prompts");
});

/** Homes made with the fake api, each with runs on disk (a prompt.json, a brief for some): { name, dir, api }. */
async function fakeHomes(specs, base) {
  const api = fakeApi();
  const byDir = new Map();
  const homes = [];
  for (const { name, prompts = withQuestion(PROMPTS, QUESTION), definition, runs = [] } of specs) {
    const dir = join(base, name, "agent-home");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "agent.sqlite"), "");
    api.homes.set(dir, { definition: definition ?? json("agent.json"), prompts: Object.fromEntries(prompts.map(({ id, ...rest }) => [id, rest])) });
    const index = {};
    for (const { id, input, variant, brief, startedAt } of runs) {
      mkdirSync(join(dir, "runs", id, "work"), { recursive: true });
      writeFileSync(join(dir, "runs", id, "prompt.json"), JSON.stringify({ version: 1, question: "company_kind", input, variant, passes: [{ choice: variant, confidence: 0.9, probabilities: { [variant]: 0.9 } }], lookup: { used: false, sources: [] }, reason: "r" }));
      if (brief) writeFileSync(join(dir, "runs", id, "work", "brief.md"), "# brief\n");
      index[id] = { path: `runs/${id}`, startedAt, endedAt: startedAt, outcome: "completed", cost: 0.01 };
    }
    byDir.set(dir, index);
    homes.push({ name, dir });
  }
  const read = api.readAgentHome;
  api.readAgentHome = async (home) => ({ ...(await read(home)), runs: byDir.get(home.dir) });
  return { homes, api };
}

test("config-page takes several homes: the first one's configuration, every home's runs, briefs linked by relative paths, and a note when a home differs", async () => {
  const base = await fresh("many");
  const generic = (text) => withQuestion(PROMPTS, QUESTION).map((v) => (v.id === "generic" ? { ...v, text } : v));
  const { homes, api } = await fakeHomes([
    { name: "a-take", runs: [{ id: "run-a", input: "Caterpillar Inc.", variant: "public", brief: true, startedAt: "2026-10-20T04:07:00Z" }] },
    { name: "b-take", runs: [{ id: "run-b", input: "Habitat", variant: "generic", brief: false, startedAt: "2026-10-20T04:09:00Z" }] },
    { name: "c-take", runs: [{ id: "run-c", input: "Cargill", variant: "generic", brief: true, startedAt: "2026-10-20T04:11:00Z" }] },
  ], base);
  const [a, b, c] = homes.map((h) => h.dir);
  const out = join(base, "report", "config.html");
  const same = await run(page, ["--home", a, "--home", b, "--home", c, "--out", out], api);
  assert.equal(same.code, 0, same.err);
  assert.equal(same.err, "", "identical homes raise no warning");
  assert.match(same.out, /^wrote config\.html: 6 prompt variants, 3 runs from 3 homes$/);
  const html = readFileSync(out, "utf8");
  assert.match(html, /company-research · 6 prompt variants · 3 runs in 3 homes · read /);
  for (const input of ["Caterpillar Inc.", "Habitat", "Cargill"]) assert.ok(html.includes(input), input);
  assert.doesNotMatch(html, /class="warn"/);
  assert.equal(html.match(/<h2>How a prompt is picked<\/h2>/g).length, 1, "one configuration section");
  assert.deepEqual([...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]), ["../c-take/agent-home/runs/run-c/work/brief.md", "../a-take/agent-home/runs/run-a/work/brief.md"], "each brief is linked from the page by its own relative path, and a run with none has no link");
  assert.ok(html.indexOf("run-c") < html.indexOf("run-b") && html.indexOf("run-b") < html.indexOf("run-a"), "newest first, across homes");

  const { homes: more, api: moreApi } = await fakeHomes([
    { name: "first", runs: [{ id: "r1", input: "One", variant: "public", startedAt: "2026-10-20T05:00:00Z" }] },
    { name: "old-generic", prompts: generic("an older generic"), runs: [{ id: "r2", input: "Two", variant: "generic", startedAt: "2026-10-20T05:01:00Z" }] },
    { name: "fewer", prompts: withQuestion(PROMPTS, QUESTION).filter((v) => v.id !== "ecommerce"), runs: [] },
    { name: "other-definition", definition: { ...json("agent.json"), description: "Something else." }, runs: [] },
    { name: "other-agent", definition: json("agent.json"), runs: [] },
    { name: "extra", prompts: [...withQuestion(PROMPTS, QUESTION), { id: "zzz", role: "overlay", label: "zzz", text: "x" }], runs: [] },
    { name: "reordered", prompts: withQuestion(PROMPTS, QUESTION).map((v) => Object.fromEntries(Object.entries(v).reverse())).reverse(), runs: [] },
  ], await fresh("differ"));
  const original = moreApi.readAgentHome;
  moreApi.readAgentHome = async (home) => {
    const state = await original(home);
    return home.dir === more[4].dir ? { ...state, identity: { ...state.identity, id: "other-agent" } } : state;
  };
  const differ = join(await fresh("differ-out"), "config.html");
  const result = await run(page, [...more.flatMap((h) => ["--home", h.dir]), "--out", differ], moreApi);
  assert.equal(result.code, 0, result.err);
  for (const line of [
    "warning: old-generic/agent-home: prompts differ: generic (changed)",
    "warning: fewer/agent-home: prompts differ: ecommerce (missing)",
    "warning: other-definition/agent-home: the definition differs",
    "warning: other-agent/agent-home: the agent is other-agent, not company-research",
    "warning: extra/agent-home: prompts differ: zzz (extra)",
  ]) assert.ok(result.err.split("\n").includes(line), line);
  const note = readFileSync(differ, "utf8");
  assert.match(note, /<div class="warn"><b>These homes do not hold the same configuration\.<\/b> The prompts above are the first home's\.<ul><li>old-generic\/agent-home: prompts differ: generic \(changed\)<\/li>/);
  assert.equal(note.match(/<li>[^<]*(differ|agent is)[^<]*<\/li>/g).length, 5, "one line per difference, and none for the home that holds the same prompts in another order");
  assert.equal(result.err.split("\n").filter((line) => line.startsWith("warning: reordered")).length, 0);
  const extra = await run(page, ["--home", more[0].dir, "--home", join(await fresh("nothome"), "x"), "--out", join(await fresh("never"), "config.html")], moreApi);
  assert.equal(extra.code, 1);
  assert.match(extra.err, /no page written: x is not an agent home/, "one home that is not a home refuses the page");
  assert.equal((await run(page, ["--home", a, "--home", b], api)).code, 2, "--out is still needed");
});

test("config-page: a missing argument is exit 2, a directory that is not a home is exit 1 and writes no page", async () => {
  assert.equal((await run(page, ["--home", "x"], undefined)).code, 2);
  assert.equal((await run(page, ["--out", "x"], undefined)).code, 2);
  const nothere = await fresh("not-a-home");
  const out = join(await fresh("no-page"), "config.html");
  const result = await run(page, ["--home", nothere, "--out", out], undefined);
  assert.equal(result.code, 1);
  assert.match(result.err, /no page written: .* is not an agent home/);
  assert.equal(existsSync(out), false);
});

test("with the built package's setPrompts, the edit tool and the page round-trip through a real home", { skip: typeof real.setPrompts === "function" ? false : "this build of @parcha/pi-durable-agent has no setPrompts yet (durable-agent/prompts)" }, async () => {
  const dir = join(await fresh("real-roundtrip"), "home");
  const saved = await run(edit, ["--home", dir, "--init"], real);
  assert.equal(saved.code, 0, saved.err);
  assert.match(saved.out, /saved 6 prompt variants and the question company_kind/);
  const shown = JSON.parse((await run(edit, ["--home", dir, "--show", "--json"], real)).out);
  assert.deepEqual(normalizePrompts(shown.prompts).map((v) => v.id), [...PROMPTS.map((v) => v.id), "company_kind"]);
  assert.deepEqual(questionOf(shown.prompts), QUESTION, "the home holds the question as question.json has it");
  const again = await run(edit, ["--home", dir], real);
  assert.match(again.out, /nothing changed/, "a second save of the same files writes nothing");
  const out = join(await fresh("real-page"), "config.html");
  assert.equal((await run(page, ["--home", dir, "--out", out], real)).code, 0);
  assert.ok(readFileSync(out, "utf8").includes("loads when company_kind is nonprofit at 0.8 or more"));
});

test("with the built package's prompts, a run started with a prompt shows its variant from the runs index, and its prompt.json beside it", { skip: typeof real.setPrompts === "function" ? false : "this build of @parcha/pi-durable-agent has no setPrompts yet (durable-agent/prompts)" }, async () => {
  const dir = join(await fresh("real-run"), "home");
  assert.equal((await run(edit, ["--home", dir, "--init"], real)).code, 0);
  const home = await real.openAgentHome(dir);
  const started = await real.startRun(home, { runId: "r1", host: "test", prompt: { id: "nonprofit", reason: "Jev: nonprofit at 91%" } });
  writeFileSync(join(started.dir, "prompt.json"), JSON.stringify({ version: 1, input: "American Red Cross", variant: "nonprofit", passes: [{ choice: "nonprofit", confidence: 0.91, probabilities: { nonprofit: 0.91, other: 0.09 } }], lookup: { used: false, sources: [] }, reason: "Jev: nonprofit at 91%" }));
  await real.startRun(home, { runId: "r2", host: "test", prompt: { id: "generic", reason: "no overlay was sure" } });
  assert.deepEqual((await real.readAgentHome(home)).runs.r2.prompt, { id: "generic", reason: "no overlay was sure" });
  await assert.rejects(real.startRun(home, { runId: "r3", host: "test", prompt: { id: "not-a-variant", reason: "x" } }), /not one of the agent's variants/);
  const out = join(await fresh("real-run-page"), "config.html");
  assert.equal((await run(page, ["--home", dir, "--out", out], real)).code, 0);
  const html = readFileSync(out, "utf8");
  assert.ok(html.includes("American Red Cross") && html.includes("<b>nonprofit</b> at 0.91"), "r1: its prompt.json");
  assert.ok(html.includes("<b>generic</b>") && html.includes("no overlay was sure"), "r2: no prompt.json, so the index's prompt, shown by its variant's label");
});

test("with the built package's choosePrompt, a home this tool saved is enough: the judge is asked the home's own question and the chosen overlay follows the home's rules", { skip: typeof real.choosePrompt === "function" && typeof real.setPrompts === "function" ? false : "this build of @parcha/pi-durable-agent has no choosePrompt yet (durable-agent/prompts)" }, async () => {
  const dir = join(await fresh("real-choose"), "home");
  assert.equal((await run(edit, ["--home", dir, "--init"], real)).code, 0);
  const { prompts } = await real.readAgentHome(await real.openAgentHome(dir));
  const asked = [];
  const judge = (answer) => async (params) => {
    asked.push(params);
    return { answers: { company_kind: { choice: answer.choice, probabilities: answer.probabilities, confidence: answer.confidence } }, model: "fake", cost_usd: 0 };
  };
  const probabilities = (top, rest = 0.02) => Object.fromEntries(Object.keys(QUESTION.criteria).map((option) => [option, option === top ? 0.93 : rest]));
  const clear = await real.choosePrompt(prompts, "American Red Cross", { judge: judge({ choice: "nonprofit", probabilities: probabilities("nonprofit"), confidence: 0.93 }) });
  assert.equal(clear.variant, "nonprofit");
  assert.ok(clear.instructions.startsWith(PROMPTS[0].text.trim()) && clear.instructions.includes("Nonprofit Explorer"), "the base, then the overlay");
  const [params] = asked;
  assert.equal(params.label, "company_kind");
  assert.equal(params.questions.company_kind.instructions, QUESTION.instructions, "the question's text is the home's");
  assert.deepEqual(params.questions.company_kind.criteria, QUESTION.criteria, "its options are the home's, other included");
  const unsure = await real.choosePrompt(prompts, "Habitat", { judge: judge({ choice: "other", probabilities: probabilities("other", 0.1), confidence: 0.4 }) });
  assert.equal(unsure.variant, "generic", "no overlay reaches 0.8 and there is no lookup");
  assert.ok(unsure.instructions.includes("assume nothing"));
});
