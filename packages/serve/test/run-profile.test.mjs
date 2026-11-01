// A run that names a profile pack and an output type (`profile`, `output`): the pack is resolved when the run is made
// and pinned in its serve.json, its skills come from the agent's revision first and else from the shipped pack, staged
// into the run's workspace beside the revision's, and the run's system prompt carries the ordered mandate, at the pack's
// thinking level. A body with neither is today's run, byte for byte. Faux model and faux harness: no key, no network.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { shippedPacks } from "../dist/packs.js";
import { agent, flowAgent, follow, serve } from "./support.mjs";

const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;

/** A SKILL.md with front matter naming `name`, and a line of body. */
const md = (name, body = `Do ${name}.`) => `---\nname: ${name}\ndescription: The ${name} skill.\n---\n${body}\n`;
/** A pack whose every effort loads `effort-x`, low at thinking high, and whose report output loads `writer-x` into report.md. */
const pack = (extra = {}) => ({
  version: 1, name: "inline",
  effort: { low: { skills: ["effort-x"], thinking: "high" }, medium: { skills: ["effort-x"] }, high: { skills: ["effort-x"] } },
  outputs: { report: { skills: ["writer-x"], file: "report.md" }, answer: { skills: [] } },
  ...extra,
});
const SKILLS = { "effort-x/SKILL.md": md("effort-x", "EFFORT-X-BODY"), "writer-x/SKILL.md": md("writer-x", "WRITER-X-BODY") };
const metaOf = async (data, runId) => JSON.parse(await readFile(join(data, "runs", runId, "serve.json"), "utf8"));

/** Agent `id` with `skills` on its revision. */
async function made(api, id, extra = {}, skills = SKILLS) {
  const answer = await api("POST", "/agents", { ...agent(id, { skills: Object.keys(skills).map((path) => path.split("/")[0]).filter((name, i, all) => all.indexOf(name) === i), ...extra }), skills });
  assert.equal(answer.status, 201, JSON.stringify(answer.body));
}

/** A pack registered as shipped for this test, with its skills in a directory of their own. */
async function shipped(t, name, value, skills) {
  const dir = await mkdtemp(join(tmpdir(), "agentrun-serve-pack-"));
  for (const [path, text] of Object.entries(skills)) {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  const before = shippedPacks().get(name);
  shippedPacks().set(name, { pack: { ...value, name }, skillsDir: dir });
  t.after(async () => {
    if (before) shippedPacks().set(name, before);
    else shippedPacks().delete(name);
    await rm(dir, { recursive: true, force: true });
  });
}

/** No pack shipped for this test, as a server that ships none; the shipped ones are back after it. */
function noneShipped(t) {
  const kept = new Map(shippedPacks());
  shippedPacks().clear();
  t.after(() => { for (const [name, entry] of kept) shippedPacks().set(name, entry); });
}

test("a body with neither profile nor output is today's run: no profile in serve.json or on the run, and effort alone loads no pack", async (t) => {
  const { api, data } = await serve(t);
  await made(api, "plain");
  for (const [body, keys] of [[{ input: { content: "hi" } }, ["title", "created_at", "input"]], [{ input: { content: "hi" }, effort: "high" }, ["title", "created_at", "input", "effort"]]]) {
    const run = await api("POST", "/agents/plain/runs", body);
    assert.equal(run.status, 202, JSON.stringify(run.body));
    assert.deepEqual(Object.keys(await metaOf(data, run.body.run_id)), keys, "serve.json as before");
    assert.equal(run.body.profile, null);
  }
  assert.deepEqual((await api("GET", "/capabilities")).body.profiles.map((profile) => profile.name), ["default"], "the default pack is shipped, and loads only for a run that names profile or output");
});

test("an inline pack is resolved and pinned: its effort's skills, then the output's writers, its file, and the row's thinking", async (t) => {
  const { api, data } = await serve(t);
  await made(api, "pinned");
  const run = await api("POST", "/agents/pinned/runs", { input: { content: "hi" }, effort: "low", profile: pack(), output: "report" });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const pinned = { name: "inline", effort: "low", thinking: "high", skills: ["effort-x", "writer-x"], output: { type: "report", file: "report.md", skills: ["writer-x"] } };
  const meta = await metaOf(data, run.body.run_id);
  assert.deepEqual(meta.profile, pinned);
  assert.equal(meta.effort, "low");
  assert.deepEqual(run.body.profile, pinned);
  assert.deepEqual((await api("GET", `/runs/${run.body.run_id}`)).body.profile, pinned, "read back");
  // No effort: the pack's medium row, whose thinking is unset; the run's own effort stays unset, never medium.
  const plain = await api("POST", "/agents/pinned/runs", { input: { content: "hi" }, profile: pack(), output: "answer" });
  assert.equal(plain.status, 202, JSON.stringify(plain.body));
  const second = await metaOf(data, plain.body.run_id);
  assert.deepEqual(second.profile, { name: "inline", effort: "medium", skills: ["effort-x"], output: { type: "answer", skills: [] } });
  assert.equal("effort" in second, false, "the resolver's medium is never the run's effort");
});

test("a profile or output the server cannot use is refused by field, before anything starts", async (t) => {
  noneShipped(t);
  const { api } = await serve(t);
  await made(api, "refuses");
  assert.equal((await api("POST", "/agents", flowAgent("flow"))).status, 201);
  const refused = async (agentId, body) => {
    const answer = await api("POST", `/agents/${agentId}/runs`, { input: { content: "hi" }, ...body });
    assert.equal(answer.status, 422, JSON.stringify(answer.body));
    return answer.body.error.fields.map((f) => [f.field, f.reason, f.message]);
  };
  const [[field, reason, message]] = await refused("refuses", { profile: "nope" });
  assert.deepEqual([field, reason], ["profile", "not_an_option"]);
  assert.match(message, /ships no pack/);
  assert.deepEqual((await refused("refuses", { profile: pack(), output: "slides" })).map(([f, r]) => [f, r]), [["output", "not_an_option"]], "an output type the pack does not name");
  const missing = await refused("refuses", { profile: pack({ outputs: { report: { skills: ["writer-y"], file: "report.md" } } }), output: "report" });
  assert.deepEqual(missing.map(([f, r]) => [f, r]), [["profile", "missing"]]);
  assert.match(missing[0][2], /writer-y/, "naming the skill");
  assert.deepEqual((await refused("refuses", { profile: { ...pack(), version: 2 } })).map(([f, r]) => [f, r]), [["profile.version", "not_an_option"]], "the pack's own issues, under profile");
  assert.deepEqual((await refused("refuses", { output: "report" })).map(([f, r]) => [f, r]), [["output", "not_an_option"]], "no profile and no shipped default");
  assert.deepEqual((await refused("refuses", { profile: 7 })).map(([f, r]) => [f, r]), [["profile", "wrong_type"]]);
  assert.deepEqual((await refused("refuses", { profile: pack(), output: 7 })).map(([f, r]) => [f, r]), [["output", "wrong_type"]]);
  const flow = await api("POST", "/agents/flow/runs", { input: { question: "1+1?" }, profile: pack() });
  assert.equal(flow.status, 422, JSON.stringify(flow.body));
  assert.deepEqual(flow.body.error.fields.map((f) => [f.field, f.reason]), [["profile", "not_allowed"]], "a workflow run takes no profile");
});

test("a shipped pack: named by name, its bundled skills staged beside the revision's, a revision skill of the same name wins, and its default takes an output with no profile", async (t) => {
  // Registered before the server starts, as a shipped pack is: capabilities are the server's from its start.
  await shipped(t, "default", pack({ outputs: { report: { skills: ["bundled-x", "shared-x"], file: "report.md" } } }), {
    "effort-x/SKILL.md": md("effort-x", "BUNDLED-EFFORT"), "bundled-x/SKILL.md": md("bundled-x", "BUNDLED-BODY"), "bundled-x/reference/notes.md": "Bundled notes.\n", "shared-x/SKILL.md": md("shared-x", "BUNDLED-SHARED"),
  });
  const { api, data } = await serve(t);
  await made(api, "staged", {}, { "effort-x/SKILL.md": md("effort-x", "REVISION-EFFORT"), "shared-x/SKILL.md": md("shared-x", "REVISION-SHARED") });
  const caps = (await api("GET", "/capabilities")).body;
  assert.deepEqual(caps.profiles, [{ name: "default", efforts: ["low", "medium", "high"], outputs: [{ type: "report", file: "report.md" }] }]);
  const run = await api("POST", "/agents/staged/runs", { input: { content: "hi" }, output: "report" });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  assert.equal(run.body.profile.name, "default", "the shipped default");
  const skills = join(data, "runs", run.body.run_id, "work", ".agents", "skills");
  assert.equal(await readFile(join(skills, "bundled-x", "SKILL.md"), "utf8"), md("bundled-x", "BUNDLED-BODY"), "a bundled skill is staged");
  assert.equal(await readFile(join(skills, "bundled-x", "reference", "notes.md"), "utf8"), "Bundled notes.\n", "with its other files");
  assert.equal(await readFile(join(skills, "shared-x", "SKILL.md"), "utf8"), md("shared-x", "REVISION-SHARED"), "the revision's own skill of that name wins");
  assert.equal(await readFile(join(skills, "effort-x", "SKILL.md"), "utf8"), md("effort-x", "REVISION-EFFORT"));
  const named = await api("POST", "/agents/staged/runs", { input: { content: "hi" }, profile: "default", output: "report" });
  assert.equal(named.status, 202, JSON.stringify(named.body));
  assert.deepEqual(named.body.profile.skills, ["effort-x", "bundled-x", "shared-x"]);
});

test("the harness's session gets the ordered mandate and the pack's skills in its system prompt, at the pack's thinking level", { timeout: 90_000 }, async (t) => {
  const { api } = await serve(t, { fauxHarness: FAUX_HARNESS });
  await made(api, "mandated", { harness: "claude-agent", instructions: "Say your system.", thinking: "low" });
  const run = await api("POST", "/agents/mandated/runs", { input: { content: "hi" }, effort: "low", profile: pack(), output: "report" });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  await follow(api, run.body.run_id, ["completed"], { deadlineMs: 55_000 });
  const said = (await api("GET", `/runs/${run.body.run_id}`)).body.result?.final_answer ?? "";
  assert.match(said, /^Thinking high\./, "the pack's low row sets high, over the run's effort and the revision's thinking");
  const mandate = said.indexOf("first `effort-x`, then `writer-x`");
  assert.ok(mandate > said.indexOf("Say your system."), `the mandate follows the instructions, in order: ${said}`);
  assert.ok(said.includes("Write the deliverable to `report.md`"), said);
  // claude-agent's check takes both skills: its adapter loads them, and the prompt does not write them out.
  assert.match(said, /^Native: effort-x, writer-x$/m);
  assert.ok(!said.includes("EFFORT-X-BODY") && !said.includes("WRITER-X-BODY"), "the skills are the Skill tool's");
});

test("the shipped default pack on an agent with its own report-writer: the revision's skill of that name wins over the one the pack bundles, and a low-effort run thinks low", { timeout: 120_000 }, async (t) => {
  const { api, data } = await serve(t, { fauxHarness: FAUX_HARNESS });
  const ownWriter = md("report-writer", "THE CALLER'S OWN REPORT WRITER");
  await made(api, "caller-default", { harness: "claude-agent", instructions: "Say your system." }, { "report-writer/SKILL.md": ownWriter });
  const run = await api("POST", "/agents/caller-default/runs", { input: { content: "Write it up." }, effort: "low", profile: "default", output: "report" });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  assert.deepEqual(run.body.profile, { name: "default", effort: "low", skills: ["effort-low", "report-writer"], output: { type: "report", file: "report.md", skills: ["report-writer"] } });
  const skills = join(data, "runs", run.body.run_id, "work", ".agents", "skills");
  const shipped = shippedPacks().get("default").skillsDir;
  assert.equal(await readFile(join(skills, "report-writer", "SKILL.md"), "utf8"), ownWriter, "the revision's report-writer, not the default's");
  assert.notEqual(await readFile(join(shipped, "report-writer", "SKILL.md"), "utf8"), ownWriter);
  assert.equal(await readFile(join(skills, "effort-low", "SKILL.md"), "utf8"), await readFile(join(shipped, "effort-low", "SKILL.md"), "utf8"), "the default's own effort skill, staged");
  await follow(api, run.body.run_id, ["completed"], { deadlineMs: 55_000 });
  const said = (await api("GET", `/runs/${run.body.run_id}`)).body.result?.final_answer ?? "";
  assert.match(said, /^Thinking low\./, "the run's effort: the default pack sets no thinking");
  // Both go to the adapter from the run's workspace: report-writer as staged there, the caller's.
  assert.match(said, /^Native: effort-low, report-writer$/m, "the adapter loads both, the caller's report-writer among them");
  assert.ok(!said.includes("THE CALLER'S OWN REPORT WRITER"), "the Skill tool's, not written out");
});
