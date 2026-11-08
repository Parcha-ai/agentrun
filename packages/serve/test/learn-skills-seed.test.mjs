// The skills an agent wrote reach its runs. Its learning folder keeps each under `skills/<name>/`; a run gets
// those of the commit it starts from beside its revision's own, in `work/.agents/skills/`, and its pin names their
// files: pi and codex find each SKILL.md in their prompt, claude-agent loads the ones its adapter takes itself. A skill
// named like one of the revision's is the revision's. The learned ones fit their own budget, within what the revision's
// leave of the adapters' 1 MiB cap on a run's skills, so they never push the revision's back into the prompt; one that
// does not fit is left out, and the pin names it. A link at `skills/` or under it is never followed: the run starts
// with nothing learned.
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fakeAnthropic } from "@parcha/agentrun-harness-claude/testing";
import { builtinHarness } from "../dist/harness-table.js";
import { agentFolderOf } from "../dist/files.js";
// One namespace, so each test reads what it needs of it as it runs.
import * as learning from "../dist/learning.js";
import { systemOf } from "../dist/skills.js";
import { localWorkspace } from "../dist/workspace/index.js";
import { ended, git } from "./learn-support.mjs";
import { agent, follow, runDir, scratch, serve, withEnv } from "./support.mjs";
import { fauxTable } from "./fixtures/faux-table.mjs";

const SYSTEM = new URL("./fixtures/faux-system.mjs", import.meta.url).pathname;
const KIB = 1024;
const CANARY = `not-a-secret-canary-${process.pid}`;
/** A SKILL.md naming `name`, described, with `body`. */
const skillMd = (name, body) => `---\nname: ${name}\ndescription: What ${name} is for.\n---\n${body}\n`;
/** `bytes` bytes of plain lines. */
const filler = (bytes) => "Keep each figure as the source gives it.\n".repeat(Math.ceil(bytes / 40)).slice(0, bytes);
const UNITS = skillMd("check-units", "Convert every amount to one unit before comparing. Read reference/units.md for the table.");
const UNITS_TABLE = "cents = dollars x 100\n";
const CITE = skillMd("cite", "Cite every source you read.");
const { dropSeed, layPinnedSkills, learningTestHooks, pinSeed, readPin, secretsShown, seedOf, skillsAt, withLearned } = learning;
const PLAIN = { budget: 8000, read: false, shown: secretsShown([]) };

/** `skills` ({name: {path: text}}) as the learning folder keeps them, under `skills/`. */
const asLearned = (skills) => Object.fromEntries(Object.entries(skills).flatMap(([name, files]) => Object.entries(files).map(([path, text]) => [`skills/${name}/${path}`, text])));

/** Agent `id`'s learning folder made as a first run makes it (seedOf), then `files` committed on main: the commit.
 *  `links` ({path: target}) are committed as symbolic links. */
async function folderWith(data, id, files, links = {}) {
  mkdirSync(data, { recursive: true });
  await seedOf(data, id);
  const repo = join(agentFolderOf(data, id), "learning");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  for (const [path, target] of Object.entries(links)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    symlinkSync(target, join(repo, path));
  }
  git(repo, ["add", "--", ...Object.keys(files), ...Object.keys(links)]);
  git(repo, ["commit", "-q", "-m", "learned"]);
  return git(repo, ["rev-parse", "main"]);
}

/** A run's directory, its work holding the revision's skill `files` (paths under `.agents/skills/` to text). */
async function runWith(t, files) {
  const runDir = join(await scratch(t), "run");
  const work = join(runDir, "work");
  mkdirSync(work, { recursive: true });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(work, ".agents", "skills", path)), { recursive: true });
    writeFileSync(join(work, ".agents", "skills", path), text);
  }
  return { runDir, work };
}

const skillsDir = (work) => join(work, ".agents", "skills");
const pinOf = (data, runId) => JSON.parse(readFileSync(join(runDir(data, runId), "learning.json"), "utf8"));
const workOf = (data, runId) => join(runDir(data, runId), "work");
const inlined = (prompt) => [...prompt.matchAll(/<skill name="([^"]+)">/g)].map((match) => match[1]);
/** A model request's system prompt, as text. */
const systemText = (body) => (typeof body?.system === "string" ? body.system : (body?.system ?? []).map((block) => block?.text ?? "").join("\n"));

/** Agent `id`, learning, on `harness`, with the revision's skill `cite`; its run made and ended: its id, its prompt as
 *  the faux model or harness says it, and its view. */
async function ranWithCite(api, id, harness, tools = []) {
  const created = await api("POST", "/agents", { ...agent(id, { learning: true, harness, instructions: "Answer the question.", skills: ["cite"], tools }), skills: { "cite/SKILL.md": CITE } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const run = await api("POST", `/agents/${id}/runs`, { input: { content: "hi" } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const { view } = await ended(api, run.body.run_id);
  return { runId: run.body.run_id, prompt: view.result?.final_answer ?? "", view };
}

test("with claude-agent's own check: 900 KiB of the revision's skills and a 200 KiB learned one, the revision's stay the adapter's and the learned one is left out, named in the pin; a learned one that fits what is left joins them", { timeout: 60_000 }, async (t) => {
  const data = join(await scratch(t), "agents");
  const big = skillMd("big-notes", filler(200 * KIB));
  const sha = await folderWith(data, "big", asLearned({ "big-notes": { "SKILL.md": big }, "check-units": { "SKILL.md": UNITS } }));
  const seed = await seedOf(data, "big");
  assert.equal(seed.sha, sha);
  const revision = { "cite/SKILL.md": CITE, "cite/reference/data.md": filler(900 * KIB) };
  const { runDir, work } = await runWith(t, revision);
  const pin = await pinSeed(runDir, work, seed, { ...PLAIN, own: Object.keys(revision) });
  const check = await builtinHarness("claude-agent").skillCheck();
  assert.ok(check, "the installed claude-agent adapter's own check");
  const learned = await withLearned(runDir, work, "Answer.", Object.keys(revision));
  const { system, native } = await systemOf(learned.instructions, learned.skills, localWorkspace(work), check);
  assert.deepEqual(native.map(({ name }) => name), ["check-units", "cite"], "the revision's and the learned one that fit are the adapter's own");
  assert.deepEqual(inlined(system), [], "none is in the prompt");
  // A run with a pin learns, so it is told so under # Learned (#1542), here with nothing learned yet but its skills.
  assert.match(learned.instructions, /^Answer\.\n\n# Learned\n\nYou learn from your runs\.[^\n]*\n\nNothing learned yet\.$/);
  assert.deepEqual(learned.skills, ["cite/SKILL.md", "cite/reference/data.md", "check-units/SKILL.md"]);
  assert.deepEqual(pin, { seed: sha, skills: ["check-units/SKILL.md"], skills_left_out: ["big-notes"] });
  assert.deepEqual(await readPin(runDir), pin);
  assert.deepEqual(readdirSync(skillsDir(work)).sort(), ["check-units", "cite"], "the one left out is not laid");
  assert.equal(readFileSync(join(skillsDir(work), "check-units", "SKILL.md"), "utf8"), UNITS);

  // Without the budget the 200 KiB one would be laid too: the set is over the adapter's 1 MiB, and every skill, the
  // revision's among them, goes back in the prompt.
  mkdirSync(join(skillsDir(work), "big-notes"));
  writeFileSync(join(skillsDir(work), "big-notes", "SKILL.md"), big);
  const unbudgeted = await systemOf("Answer.", [...learned.skills, "big-notes/SKILL.md"], localWorkspace(work), check);
  assert.deepEqual([unbudgeted.native, inlined(unbudgeted.system)], [[], ["big-notes", "check-units", "cite"]]);
});

test("on claude-agent's real adapter: with 900 KiB of the revision's skills, the learned one that fits is loaded through the Skill tool beside them, the 200 KiB one is left out, and no skill is inlined", { timeout: 180_000, skip: !existsSync("/usr/bin/setpriv") && "no setpriv here" }, async (t) => {
  const fake = await fakeAnthropic({ reply: () => ({ text: "Claude answered." }) });
  t.after(() => fake.close());
  withEnv(t, { ANTHROPIC_API_KEY: `not-a-secret-${"anthropic"}`, ANTHROPIC_BASE_URL: fake.url, AGENT_MODEL: "anthropic/claude-haiku-4-5" }, ["AGENT_MODEL_BASE_URL"]);
  const { api, data } = await serve(t, { faux: undefined });
  const sha = await folderWith(data, "native", asLearned({ "big-notes": { "SKILL.md": skillMd("big-notes", filler(200 * KIB)) }, "check-units": { "SKILL.md": UNITS } }));
  const skills = { "cite/SKILL.md": CITE, "cite/reference/data.md": filler(900 * KIB) };
  const created = await api("POST", "/agents", { ...agent("native", { learning: true, harness: "claude-agent", model: "anthropic/claude-haiku-4-5", instructions: "Answer the question.", skills: ["cite"] }), skills });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const run = await api("POST", "/agents/native/runs", { input: { content: "Answer." } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  await follow(api, run.body.run_id, ["completed"], { deadlineMs: 120_000 });
  const first = fake.messages().find((m) => m.tools.includes("Skill"));
  assert.deepEqual(inlined(systemText(first?.body ?? fake.messages()[0]?.body)), [], "no skill is inlined");
  assert.ok(first, `the Skill tool is offered: ${JSON.stringify(fake.messages().map((m) => m.tools))}`);
  const body = JSON.stringify(first.body);
  assert.ok(body.includes("agentrun:cite") && body.includes("agentrun:check-units"), "the revision's skill and the learned one that fits are the CLI's own");
  assert.ok(!body.includes("big-notes"), "the one left out is nowhere");
  assert.deepEqual(pinOf(data, run.body.run_id), { seed: sha, skills: ["check-units/SKILL.md"], skills_left_out: ["big-notes"] });
});

test("the learned skills' budget is 256 KiB, whatever room the revision's leave: the newest that fit, whole, and the rest named as left out", { timeout: 60_000 }, async (t) => {
  const data = join(await scratch(t), "agents");
  assert.equal(learning.LEARNED_SKILLS_BUDGET, 256 * KIB);
  await folderWith(data, "many", asLearned({ "first-big": { "SKILL.md": skillMd("first-big", filler(150 * KIB)) } }));
  await folderWith(data, "many", asLearned({ "second-big": { "SKILL.md": skillMd("second-big", filler(150 * KIB)) }, "small-one": { "SKILL.md": skillMd("small-one", "Short.") } }));
  const { runDir, work } = await runWith(t, {});
  const pin = await pinSeed(runDir, work, await seedOf(data, "many"), { ...PLAIN, own: [] });
  assert.deepEqual([pin.skills, pin.skills_left_out], [["second-big/SKILL.md", "small-one/SKILL.md"], ["first-big"]], "changed last first, each while it fits");
});

test("a learned skill named like one of the revision's is the revision's: its SKILL.md and files stay, in the prompt and the work, and the pin names only the others", { timeout: 120_000 }, async (t) => {
  const { api, data } = await serve(t, { faux: SYSTEM, harnessTable: fauxTable(SYSTEM) });
  const sha = await folderWith(data, "same", asLearned({ cite: { "SKILL.md": skillMd("cite", CANARY), "extra.md": CANARY }, "check-units": { "SKILL.md": UNITS } }));
  const { runId, prompt } = await ranWithCite(api, "same", "pi");
  assert.ok(!prompt.includes(CANARY), prompt);
  assert.ok(prompt.includes(`<skill name="cite">\n${CITE.trim()}\n</skill>`), prompt);
  assert.deepEqual(inlined(prompt), ["check-units", "cite"]);
  assert.equal(readFileSync(join(skillsDir(workOf(data, runId)), "cite", "SKILL.md"), "utf8"), CITE);
  assert.equal(existsSync(join(skillsDir(workOf(data, runId)), "cite", "extra.md")), false, "nothing of the learned one is laid in the revision's folder");
  assert.deepEqual(pinOf(data, runId), { seed: sha, skills: ["check-units/SKILL.md"] });
});

for (const harness of ["pi", "codex"]) {
  test(`a ${harness} run gets the skills its agent learned beside its revision's: each SKILL.md in its prompt, every file in work/.agents/skills/, named in its pin; one held for its owner's OK is not served`, { timeout: 120_000 }, async (t) => {
    const { api, data } = await serve(t, { faux: SYSTEM, harnessTable: fauxTable(SYSTEM) });
    const id = `skilled-${harness}`;
    const waiting = `---\nname: waiting-skill\ndescription: ${CANARY}\nstatus: pending\n---\nNot approved yet.\n`;
    const sha = await folderWith(data, id, asLearned({ "check-units": { "SKILL.md": UNITS, "reference/units.md": UNITS_TABLE }, "waiting-skill": { "SKILL.md": waiting } }));
    const { runId, prompt, view } = await ranWithCite(api, id, harness);
    assert.ok(!prompt.includes(CANARY) && !prompt.includes("waiting-skill"), `a skill held for its owner's OK is not served: ${prompt}`);
    assert.equal(existsSync(join(skillsDir(workOf(data, runId)), "waiting-skill")), false);
    assert.notEqual(view.learning?.reason, "seed_failed", JSON.stringify(view.learning));
    assert.ok(prompt.includes(`<skill name="check-units">\n${UNITS.trim()}\n</skill>`), prompt);
    assert.ok(prompt.includes(`<skill name="cite">\n${CITE.trim()}\n</skill>`), prompt);
    assert.deepEqual(inlined(prompt), ["check-units", "cite"]);
    const work = workOf(data, runId);
    assert.equal(readFileSync(join(skillsDir(work), "check-units", "SKILL.md"), "utf8"), UNITS);
    assert.equal(readFileSync(join(skillsDir(work), "check-units", "reference", "units.md"), "utf8"), UNITS_TABLE);
    assert.deepEqual(pinOf(data, runId), { seed: sha, skills: ["check-units/SKILL.md", "check-units/reference/units.md"] });
  });
}

for (const harness of ["pi", "codex"]) {
  test(`a ${harness} run that reads its files gets its skills on demand: each one's name, what it is for and its SKILL.md's path, the revision's and the learned ones alike, no skill's text; the file is there to read`, { timeout: 120_000 }, async (t) => {
    const { api, data } = await serve(t, { faux: SYSTEM, harnessTable: fauxTable(SYSTEM) });
    const id = `ondemand-${harness}`;
    await folderWith(data, id, asLearned({ "check-units": { "SKILL.md": UNITS, "reference/units.md": UNITS_TABLE } }));
    const { runId, prompt } = await ranWithCite(api, id, harness, ["read"]);
    assert.deepEqual(inlined(prompt), [], prompt);
    assert.ok(!prompt.includes("Convert every amount to one unit") && !prompt.includes(CITE.trim()), `no skill's text in the prompt: ${prompt}`);
    assert.match(prompt, /- check-units: What check-units is for\. \(\.agents\/skills\/check-units\/SKILL\.md\)/, prompt);
    assert.match(prompt, /- cite: [^\n]+ \(\.agents\/skills\/cite\/SKILL\.md\)/, prompt);
    const work = workOf(data, runId);
    for (const name of ["check-units", "cite"]) assert.ok(existsSync(join(work, ".agents", "skills", name, "SKILL.md")), `${name}'s SKILL.md is where the prompt says`);
  });
}

for (const [where, links] of [["a SKILL.md", { "skills/evil/SKILL.md": "OUTSIDE" }], ["a skill's folder", { "skills/evil": "OUTSIDE_DIR" }], ["the skills folder", { skills: "OUTSIDE_DIR" }]]) {
  test(`a symbolic link at ${where} in the learning folder's skills/: the run starts with nothing learned (seed_failed), no pin, and nothing laid or read through it`, { timeout: 120_000 }, async (t) => {
    const { api, data } = await serve(t, { faux: SYSTEM });
    const outside = await scratch(t);
    writeFileSync(join(outside, "SKILL.md"), skillMd("evil", CANARY));
    const targets = { OUTSIDE: join(outside, "SKILL.md"), OUTSIDE_DIR: outside };
    const id = `linked-${Object.keys(links)[0].split("/").length}`;
    await folderWith(data, id, where === "the skills folder" ? {} : asLearned({ "check-units": { "SKILL.md": UNITS } }), Object.fromEntries(Object.entries(links).map(([path, target]) => [path, targets[target]])));
    const { runId, prompt, view } = await ranWithCite(api, id, "pi");
    assert.deepEqual([view.learning?.state, view.learning?.reason], ["dropped", "seed_failed"], JSON.stringify(view.learning));
    assert.equal(existsSync(join(runDir(data, runId), "learning.json")), false, "no pin");
    assert.ok(!prompt.includes(CANARY) && !prompt.includes("# Learned"), prompt);
    assert.deepEqual(inlined(prompt), ["cite"], "the revision's skill alone");
    assert.deepEqual(readdirSync(skillsDir(workOf(data, runId))), ["cite"]);
  });
}

test("a learned skill's copy is the host's: a copy that fails takes it back with the pin, a server gone mid-copy has it taken back (dropSeed), and a reopened run gets it laid again fresh, never through a link", { timeout: 60_000 }, async (t) => {
  const data = join(await scratch(t), "agents");
  const sha = await folderWith(data, "copied", asLearned({ "check-units": { "SKILL.md": UNITS, "reference/units.md": UNITS_TABLE } }));
  const seed = await seedOf(data, "copied");
  const { runDir, work } = await runWith(t, { "cite/SKILL.md": CITE });
  const own = ["cite/SKILL.md"];

  learningTestHooks.afterPin = () => {
    throw new Error("the run's directory could not be synced");
  };
  t.after(() => void (learningTestHooks.afterPin = undefined));
  await assert.rejects(pinSeed(runDir, work, seed, { ...PLAIN, own }), /could not be synced/);
  learningTestHooks.afterPin = undefined;
  assert.equal(existsSync(join(runDir, "learning.json")), false);
  assert.deepEqual(readdirSync(skillsDir(work)), ["cite"], "the learned one goes, the revision's stays");

  const pin = await pinSeed(runDir, work, seed, { ...PLAIN, own });
  assert.equal(await dropSeed(runDir, work), true);
  assert.deepEqual(readdirSync(skillsDir(work)), ["cite"], "taken back with the pin");
  assert.equal(existsSync(join(runDir, "learning.json")), false);

  // Reopened: what the run took away or wrote over is laid again from the commit it was pinned to.
  await pinSeed(runDir, work, seed, { ...PLAIN, own });
  rmSync(join(skillsDir(work), "check-units", "reference"), { recursive: true });
  writeFileSync(join(skillsDir(work), "check-units", "SKILL.md"), "written by the run\n");
  writeFileSync(join(skillsDir(work), "check-units", "scratch.md"), "written by the run\n");
  await layPinnedSkills(work, pin, () => skillsAt(data, "copied", sha));
  assert.equal(readFileSync(join(skillsDir(work), "check-units", "SKILL.md"), "utf8"), UNITS);
  assert.equal(readFileSync(join(skillsDir(work), "check-units", "reference", "units.md"), "utf8"), UNITS_TABLE);
  assert.equal(existsSync(join(skillsDir(work), "check-units", "scratch.md")), false);
  assert.equal(readFileSync(join(skillsDir(work), "cite", "SKILL.md"), "utf8"), CITE, "the revision's is not touched");

  // The skills folder swapped for a link out of the work: refused, and nothing is written or removed through it.
  const outside = await scratch(t);
  mkdirSync(join(outside, "check-units"));
  writeFileSync(join(outside, "check-units", "kept.md"), "kept\n");
  rmSync(skillsDir(work), { recursive: true });
  symlinkSync(outside, skillsDir(work));
  await assert.rejects(layPinnedSkills(work, pin, () => skillsAt(data, "copied", sha)), /not a folder/);
  assert.deepEqual(readdirSync(join(outside, "check-units")), ["kept.md"]);
  assert.ok(lstatSync(skillsDir(work)).isSymbolicLink());
});

test("a learned skill the run's work no longer holds whole is left out of what its process gets, and the run goes on: a file taken away, or a link put in its place", { timeout: 60_000 }, async (t) => {
  const data = join(await scratch(t), "agents");
  await folderWith(data, "kept", asLearned({ "check-units": { "SKILL.md": UNITS, "reference/units.md": UNITS_TABLE }, "keep-dates": { "SKILL.md": skillMd("keep-dates", "Write dates as YYYY-MM-DD.") } }));
  const seed = await seedOf(data, "kept");
  const { runDir, work } = await runWith(t, { "cite/SKILL.md": CITE });
  await pinSeed(runDir, work, seed, { ...PLAIN, own: ["cite/SKILL.md"] });
  const all = ["cite/SKILL.md", "check-units/SKILL.md", "check-units/reference/units.md", "keep-dates/SKILL.md"];
  assert.deepEqual((await withLearned(runDir, work, "Answer.", ["cite/SKILL.md"])).skills, all);

  rmSync(join(skillsDir(work), "check-units", "reference", "units.md"));
  const outside = join(await scratch(t), "SKILL.md");
  writeFileSync(outside, skillMd("keep-dates", CANARY));
  rmSync(join(skillsDir(work), "keep-dates", "SKILL.md"));
  symlinkSync(outside, join(skillsDir(work), "keep-dates", "SKILL.md"));
  const learned = await withLearned(runDir, work, "Answer.", ["cite/SKILL.md"]);
  assert.deepEqual(learned.skills, ["cite/SKILL.md"], "the revision's alone");
  const { system } = await systemOf(learned.instructions, learned.skills, localWorkspace(work));
  assert.deepEqual(inlined(system), ["cite"]);
  assert.ok(!system.includes(CANARY));
});
