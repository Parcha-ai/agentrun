// A Mode 2 run with a skill, on the path a staging run takes: a server started with its runner apart (--no-runner, the
// image's server-and-runner), one runner of its own on the same data (support.mjs startInProcessRunner, its Archil disk
// the fake), and each run in a process of its own (run-child.ts), which reaches its folder on the disk through the
// runner's Workspace across the run channel. The agent is saved as a host saves an agent with a skill: the skill's name in
// `definition.skills` and its file in the body's `skills` map, at `expert-<slug>/SKILL.md`. v0.1.0-beta.50 failed every
// such run at its claim, before its first turn, with `".agents/skills" is not there` (cost 0): the run's process got
// the folder's NOT_FOUND as a plain Error, and the skills lay rethrew it. A run with no skill never lists the folder,
// which is why a built-in expert passed beside it.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { agent, client, FAUX, follow, startInProcessRunner, startServe, whenFree, withEnv, writableTree } from "./support.mjs";
import { FakeArchilDisk } from "./fixtures/archil-fake.mjs";
import { archilControlFetch } from "./archil-control-fake.mjs";

const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
const { saveArchilSettings } = await import("../dist/archil-settings.js");

const REGION = "aws-us-east-1";
const FAKE_ARCHIL = "fake-test-key-archil-m2-skills-0001";
const KEYS = { ARCHIL_API_KEY: FAKE_ARCHIL };
const UNSET = ["AGENTRUN_ARCHIL_REGION", "AGENTRUN_ARCHIL_S3_URL", "AGENTRUN_ARCHIL_IMAGE", "AGENTRUN_SEAL_KEY"];
const SKILL = "---\nname: expert-acme\ndescription: How the acme expert researches a company.\n---\n# Acme expert\n\nPrimary sources first.\n";

async function apart(t) {
  withEnv(t, KEYS, [...Object.keys(KEYS), ...UNSET]);
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-apart-mode2-skills-"));
  const data = join(dir, "agents");
  const server = await startServe({ data, port: 0, faux: FAUX, runnerApart: true, mcpLoopback: true, drainTimeout: "5s" });
  const store = await openSqliteStore({ dataDir: data, role: "runner" });
  let runner;
  t.after(async () => {
    await runner?.();
    await store.close().catch(() => {});
    await server.close();
    await writableTree(dir).then(() => rm(dir, { recursive: true, force: true }));
  });
  await saveArchilSettings(store, { region: REGION, s3Url: "https://s3.green.us-east-1.aws.prod.archil.com" });
  const disk = new FakeArchilDisk();
  const control = archilControlFetch({ region: REGION });
  const lines = [];
  runner = await startInProcessRunner(data, {
    faux: FAUX,
    mcpOwn: server.own,
    childRuns: { log: (line) => void lines.push(line) },
    archil: { makeDisk: () => disk, control: { baseUrl: control.baseUrl, fetch: control.fetch } },
  });
  const api = client(server.baseUrl, server.token);
  const save = async (body) => {
    const saved = await whenFree(() => api("POST", "/agents", body));
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
  };
  const start = async (id) => {
    const started = await whenFree(() => api("POST", `/agents/${id}/runs`, { input: { content: "Answer." } }));
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const runId = started.body.run_id;
    await follow(api, runId, ["completed", "failed"], { deadlineMs: 90_000 });
    return { runId, run: (await api("GET", `/runs/${runId}`)).body };
  };
  const runOf = async (body) => {
    await save(body);
    return start(body.definition.id);
  };
  return { disk, lines, runOf, start };
}

test("runner apart, the run in its own process, Mode 2: an agent with a skill, saved as a host saves an agent with a skill, has it laid on its fresh folder and completes", { timeout: 180_000 }, async (t) => {
  const { disk, lines, runOf } = await apart(t);
  const { runId, run } = await runOf({ ...agent("acme-expert", { skills: ["expert-acme"], tools: ["read", "write"] }), skills: { "expert-acme/SKILL.md": SKILL } });
  const said = `${JSON.stringify(run)}\n${lines.join("\n")}`;
  assert.doesNotMatch(said, /is not there/, said);
  assert.equal(run.status, "completed", said);
  const laid = [...disk.files.keys()].find((key) => key.includes(runId) && key.endsWith("/.agents/skills/expert-acme/SKILL.md"));
  assert.ok(laid, `the skill is in the run's folder on the disk: ${[...disk.files.keys()].join(", ")}`);
  assert.equal(new TextDecoder().decode(disk.files.get(laid)), SKILL);
});

test("runner apart, the run in its own process, Mode 2: a second run of the same agent on the same disk (its first run's folder there) completes too", { timeout: 180_000 }, async (t) => {
  const { disk, lines, runOf, start } = await apart(t);
  const body = { ...agent("acme-again", { skills: ["expert-acme"], tools: ["read"] }), skills: { "expert-acme/SKILL.md": SKILL } };
  const first = await runOf(body);
  assert.equal(first.run.status, "completed", `${JSON.stringify(first.run)}\n${lines.join("\n")}`);
  const second = await start("acme-again");
  assert.equal(second.run.status, "completed", `${JSON.stringify(second.run)}\n${lines.join("\n")}`);
  const folders = new Set([...disk.files.keys()].filter((key) => key.endsWith("/.agents/skills/expert-acme/SKILL.md")).map((key) => key.split("/runs/")[1]?.split("/")[0]));
  assert.deepEqual(folders, new Set([first.runId, second.runId]), "each run laid the skill in its own folder");
});
