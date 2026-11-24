// A package's triggers are capped when it has a budget (per_run_usd, each run's cap), or when every trigger carries a
// spend cap of its own (target.max_cost_usd, a number above 0). One trigger without one, with no budget, refuses the
// package, naming that trigger; a cap of 0, below 0, NaN or Infinity is none. The export holds to the same rule: an
// agent with no max_cost_usd whose triggers each have their own cap exports a package that reads, an upload and an apply
// make its trigger, and a run it fires is capped at the trigger's cap. A run its person starts on that agent takes no
// cap, as one on an agent applied from a package with neither triggers nor a budget does.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { PackageError, readPackage } from "../dist/templates.js";
import { follow, scratch, serve } from "./support.mjs";
import { fakeClock, firings, made, schedule } from "./trigger-support.mjs";

const enc = encodeURIComponent;

/** A package's agent.md with these trigger lines (and `extra` front matter lines), no budget unless `extra` gives one. */
const agentMd = (name, triggers, extra = []) => `---
name: ${name}
version: 1.0.0
description: Writes a digest.
${extra.join("\n")}
${triggers.length ? ["triggers:", ...triggers].join("\n") : ""}
---
Write the digest.
`;
/** A schedule trigger's lines, its target capped at `cap` (YAML, as written) when given. */
const trigger = (name, cap) => [
  `  - name: ${name}`,
  "    source: { kind: schedule, cron: \"0 9 * * *\", timezone: UTC }",
  `    target: { kind: start_run, input: { content: "Write the ${name} digest." }${cap === undefined ? "" : `, max_cost_usd: ${cap}`} }`,
];

/** A folder named `name` holding these files (path -> text). */
async function folderOf(t, name, files) {
  const dir = join(await scratch(t), name);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}
/** The problems readPackage names for a package of these files; [] when it reads. */
async function problemsOf(t, name, files) {
  const dir = await folderOf(t, name, files);
  try {
    readPackage(dir);
  } catch (error) {
    assert.ok(error instanceof PackageError, error.stack);
    return error.problems;
  }
  return [];
}
/** An export's files (GET /agents/{id}/package) as path -> text. */
const textOf = (files) => Object.fromEntries(files.map((file) => [file.path, Buffer.from(file.content, file.encoding).toString("utf8")]));

test("a package with triggers and no budget reads when every trigger has its own cap; one trigger without one is refused, named, and a cap of 0, below 0, NaN or Infinity is none", async (t) => {
  const capped = await problemsOf(t, "digest", { "agent.md": agentMd("digest", [...trigger("morning", 1), ...trigger("evening", 0.25)]) });
  assert.deepEqual(capped, [], "every trigger capped: no budget needed");
  const mixed = await problemsOf(t, "digest", { "agent.md": agentMd("digest", [...trigger("morning", 1), ...trigger("evening")]) });
  assert.equal(mixed.length, 1, JSON.stringify(mixed));
  assert.match(mixed[0], /triggers\[1\] \(evening\) has no max_cost_usd of its own/);
  assert.ok(!mixed[0].includes("morning"), "the capped trigger is not named");
  for (const cap of ["0", "-1", ".nan", ".inf", "1e999"]) {
    const problems = await problemsOf(t, "digest", { "agent.md": agentMd("digest", trigger("morning", cap)) });
    assert.ok(problems.some((p) => /triggers\[0\] \(morning\) has no max_cost_usd of its own/.test(p)), `${cap}: ${JSON.stringify(problems)}`);
  }
  // The package's budget still caps every trigger as before.
  assert.deepEqual(await problemsOf(t, "digest", { "agent.md": agentMd("digest", [...trigger("morning", 1), ...trigger("evening")], ["budget: { per_run_usd: 0.5 }"]) }), []);
});

test("an export blocks an agent with no max_cost_usd only for a trigger with no cap of its own, naming it; with every trigger capped the package reads with no budget", { timeout: 120_000 }, async (t) => {
  const { api } = await serve(t, { runner: false });
  // Mixed: one trigger capped, one capped only by the agent's default, which is then cleared.
  await made(api, "mixed", { name: "Mixed digest", max_cost_usd: 0.5 });
  assert.equal((await api("POST", "/triggers", { ...schedule("mixed", { cron: "0 9 * * *" }), name: "morning", target: { ...schedule("mixed", {}).target, max_cost_usd: 1 } })).status, 201);
  const { max_cost_usd: _, ...uncapped } = schedule("mixed", {}).target;
  assert.equal((await api("POST", "/triggers", { ...schedule("mixed", { cron: "0 18 * * *" }), name: "evening", target: uncapped })).status, 201);
  const { version: __, ...definition } = (await api("GET", "/agents/mixed")).body.definition;
  assert.equal((await api("PUT", "/agents/mixed/definition", { definition: { ...definition, max_cost_usd: 0 } })).status, 200);
  const mixed = (await api("GET", "/agents/mixed/package")).body;
  const notes = mixed.report.blocked.filter((note) => /max_cost_usd/.test(note.reason));
  assert.deepEqual(notes.map((note) => [note.kind, note.name]), [["trigger", "evening"]], JSON.stringify(mixed.report));
  assert.ok(!mixed.report.blocked.some((note) => note.name.includes("morning")), JSON.stringify(mixed.report.blocked));

  // Every trigger capped: nothing blocked, no budget, the trigger's cap kept, and the files read as a package.
  await made(api, "solo", { name: "Solo digest" });
  assert.equal((await api("POST", "/triggers", { ...schedule("solo", { cron: "0 9 * * *" }), name: "morning", target: { ...schedule("solo", {}).target, max_cost_usd: 1 } })).status, 201);
  const solo = (await api("GET", "/agents/solo/package")).body;
  assert.deepEqual(solo.report.blocked, [], JSON.stringify(solo.report));
  const files = textOf(solo.files);
  assert.doesNotMatch(files["agent.md"], /^budget:/m);
  const pkg = readPackage(await folderOf(t, solo.name, files));
  assert.equal(pkg.budget, undefined);
  assert.deepEqual(pkg.triggers.map((one) => [one.name, one.target.max_cost_usd]), [["morning", 1]]);
});

test("an exported package with no budget and a $1 trigger applies: the trigger is made with its cap, a run it fires is capped at $1, and a run its person starts has no cap, as on an agent from a package with neither", { timeout: 180_000 }, async (t) => {
  const clock = fakeClock("2026-06-01T00:00:00Z");
  const { api } = await serve(t, { triggerClock: clock });
  await made(api, "source", { name: "Ten minute digest" });
  const target = { ...schedule("source", {}).target, max_cost_usd: 1 };
  const sourceTrigger = await api("POST", "/triggers", { ...schedule("source", { every_s: 600, start_at: "2026-06-01T00:10:00Z" }), name: "every-ten", target });
  assert.equal(sourceTrigger.status, 201, JSON.stringify(sourceTrigger.body));
  const exported = (await api("GET", "/agents/source/package")).body;
  assert.deepEqual(exported.report.blocked, [], JSON.stringify(exported.report));
  // The source's own trigger off, so the firings counted below are the applied agent's.
  assert.equal((await api("PATCH", `/triggers/${sourceTrigger.body.id}`, { enabled: false })).status, 200);

  const stored = await api("POST", "/templates/import", { files: exported.files });
  assert.equal(stored.status, 201, JSON.stringify(stored.body));
  const applied = await api("POST", `/templates/${enc(`upload:${exported.name}`)}/apply`, { parameters: {} });
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  assert.equal((await api("GET", `/agents/${applied.body.agent_id}`)).body.definition.max_cost_usd, undefined, "no agent cap");
  const [one] = applied.body.triggers;
  assert.equal(one.name, "every-ten");
  const read = (await api("GET", `/triggers/${one.trigger_id}`)).body;
  assert.equal(read.target.max_cost_usd, 1, "the trigger keeps its cap");

  clock.to("2026-06-01T00:10:00Z");
  const [fired] = await firings(api, one.trigger_id, 1);
  assert.ok(fired.run_id, JSON.stringify(fired));
  assert.equal((await api("GET", `/runs/${fired.run_id}`)).body.cost.cap_usd, 1, "the trigger's cap");
  await follow(api, fired.run_id, ["completed"]);

  // A run its person starts: no cap of its own and none on the agent, so none (today's rule for any agent without one).
  const manual = (await api("POST", `/agents/${applied.body.agent_id}/runs`, { input: { content: "Write it now." } })).body;
  assert.equal(manual.cost.cap_usd, null, JSON.stringify(manual.cost));
  await follow(api, manual.run_id, ["completed"]);
  // The same as an agent applied from a package with no triggers and no budget.
  const plain = { "agent.md": agentMd("plain", []) };
  const storedPlain = await api("POST", "/templates/import", { files: Object.entries(plain).map(([path, content]) => ({ path, encoding: "utf8", content })) });
  assert.equal(storedPlain.status, 201, JSON.stringify(storedPlain.body));
  const appliedPlain = await api("POST", `/templates/${enc("upload:plain")}/apply`, { parameters: {} });
  assert.equal(appliedPlain.status, 201, JSON.stringify(appliedPlain.body));
  const plainRun = (await api("POST", `/agents/${appliedPlain.body.agent_id}/runs`, { input: { content: "Write it now." } })).body;
  assert.equal(plainRun.cost.cap_usd, null, JSON.stringify(plainRun.cost));
  await follow(api, plainRun.run_id, ["completed"]);
});
