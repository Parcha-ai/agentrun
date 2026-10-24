// A run reaches nothing outside its own work/: real run processes, a faux model that makes the hostile calls, and the
// disk checked after. File confinement is pi-durable-disk's, in the run's process; no path offers a shell.
import assert from "node:assert/strict";
import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { answerFlow, follow, serve } from "./support.mjs";

const PROBE = new URL("./fixtures/faux-probe.mjs", import.meta.url).pathname;
const OUTSIDE = /^<harness>\n\[error\] .*: outside the workspace /;
const NO_SHELL = "<harness>\n[error] Tool bash is not available\n</harness>";
const exists = (path) => stat(path).then(() => true, () => false);

/** What each tool call of run `runId` was answered, in order, from its released store. */
function answers(data, runId) {
  const db = new DatabaseSync(join(data, "runs", runId, "store", "run.sqlite"), { readOnly: true });
  try {
    return db.prepare("SELECT record FROM entries ORDER BY id").all()
      .flatMap((row) => JSON.parse(row.record).model ?? [])
      .filter((message) => message.role === "toolResult")
      .map((message) => ({ tool: message.toolName, error: message.isError, text: (message.content ?? []).map((c) => c.text ?? "").join("") }));
  } finally {
    db.close();
  }
}

/** Run `agent` once with `probe` as its input (an agentic run's content, a workflow's question) and its answers. */
async function probed(api, data, agent, probe, workflow = false) {
  const input = workflow ? { question: JSON.stringify({ probe }) } : { content: JSON.stringify({ probe }) };
  const run = await api("POST", `/agents/${agent}/runs`, { input });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  return { runId: run.body.run_id, done: async () => (await follow(api, run.body.run_id, ["completed"]), answers(data, run.body.run_id)) };
}

test("read, write and edit reach nothing outside work/: the tokens, the store, another run, /proc, a planted link, the data directory and /tmp", async (t) => {
  const { api, data } = await serve(t, { faux: PROBE });
  assert.equal((await api("POST", "/agents", { definition: { id: "probe", name: "probe", instructions: "Probe.", tools: ["read", "write", "edit"] } })).status, 201);
  // Another run of the same agent, with a secret in its own work/.
  const other = await probed(api, data, "probe", []);
  await other.done();
  const secret = join(data, "runs", other.runId, "work", "secret.txt");
  await writeFile(secret, "another run's secret");
  const outside = join(data, "..", "outside.txt");
  const go = join(data, "..", "go");
  const before = { token: await readFile(join(data, ".token"), "utf8"), door: await readFile(join(data, ".door-token"), "utf8") };
  const attempts = [
    ["read", { path: "../../.token" }],
    ["read", { path: "../../../.token" }],
    ["read", { path: join(data, ".token") }],
    ["read", { path: "../../../.door-token" }],
    ["read", { path: "../../../store.sqlite" }],
    ["read", { path: `../../${other.runId}/work/secret.txt` }],
    ["read", { path: secret }],
    ["read", { path: "/proc/self/environ" }],
    ["read", { path: "/proc/1/environ" }],
    ["read", { path: "link-to-token" }],
    ["write", { path: "../../../evil.txt", content: "evil" }],
    ["write", { path: outside, content: "evil" }],
    ["edit", { path: "../../../store.sqlite", edits: [{ oldText: "CREATE TABLE", newText: "CREATE TABLX" }] }],
  ];
  const control = [["write", { path: "inside.txt", content: "inside" }], ["read", { path: "inside.txt" }]];
  const run = await probed(api, data, "probe", [{ wait: go }, ...[...attempts, ...control].map(([tool, args]) => ({ tool, args }))]);
  // A link in the run's own work/ to the data directory's token, made before any call.
  await symlink(join(data, ".token"), join(data, "runs", run.runId, "work", "link-to-token"));
  await writeFile(go, "");
  const said = await run.done();
  assert.equal(said.length, attempts.length + control.length);
  attempts.forEach(([tool, args], i) => {
    assert.equal(said[i].tool, tool);
    assert.equal(said[i].error, true, `${tool} ${args.path} is refused`);
    assert.match(said[i].text, OUTSIDE, `${tool} ${args.path}`);
  });
  assert.deepEqual(said.slice(attempts.length).map((a) => [a.tool, a.error, a.text]), [["write", false, "Successfully wrote to inside.txt"], ["read", false, "inside"]], "the same run reads and writes inside work/");
  assert.equal(await readFile(join(data, "runs", run.runId, "work", "inside.txt"), "utf8"), "inside");
  // Nothing outside changed, and nothing was made there.
  assert.deepEqual({ token: await readFile(join(data, ".token"), "utf8"), door: await readFile(join(data, ".door-token"), "utf8") }, before);
  assert.equal(await readFile(secret, "utf8"), "another run's secret");
  assert.equal(await exists(join(data, "evil.txt")), false);
  assert.equal(await exists(outside), false);
  const store = new DatabaseSync(join(data, "store.sqlite"), { readOnly: true });
  t.after(() => store.close());
  assert.equal(store.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  assert.ok(store.prepare("SELECT sql FROM sqlite_master WHERE name = 'agents'").get().sql.startsWith("CREATE TABLE"), "the edit did not land");
});

test("no path offers a shell: an agentic revision naming bash is not runnable, and a run or a workflow node that calls bash anyway runs no command", async (t) => {
  const { api, data } = await serve(t, { faux: PROBE });
  const pwned = join(data, "pwned");
  const commands = ["cat ../../../.token", `ls ${data}`, "env", "cat /proc/1/environ", "touch ../../../pwned", `touch ${pwned}`];
  const calls = commands.map((command) => ({ tool: "bash", args: { command } }));
  assert.equal((await api("POST", "/agents", { definition: { id: "shell", name: "shell", instructions: "Probe.", tools: ["read", "bash"] } })).status, 201);
  const shell = await api("POST", "/agents/shell/runs", { input: { content: "x" } });
  assert.deepEqual([shell.status, shell.body.error.code, shell.body.error.details.unbound], [409, "agent_not_runnable", ["bash"]]);
  // An agent that does not name bash, whose model calls it by name.
  assert.equal((await api("POST", "/agents", { definition: { id: "quiet", name: "quiet", instructions: "Probe.", tools: ["read", "write", "edit"] } })).status, 201);
  const agentic = await (await probed(api, data, "quiet", calls)).done();
  assert.deepEqual(agentic.map((a) => [a.tool, a.error, a.text]), commands.map(() => ["bash", true, NO_SHELL]));
  // A workflow's model node with no tools, and one with read, whose model calls bash (and the file tools it was not given).
  for (const tools of [[], ["read"]]) {
    const flow = answerFlow();
    flow.root.steps[0].tools = tools;
    const id = `node-${tools.length}`;
    assert.equal((await api("POST", "/agents", { definition: { id, name: id, workflow: flow, tools } })).status, 201);
    const node = await (await probed(api, data, id, [...calls, { tool: "write", args: { path: "../../../evil.txt", content: "evil" } }], true)).done();
    assert.deepEqual(node.slice(0, commands.length).map((a) => [a.tool, a.error, a.text]), commands.map(() => ["bash", true, NO_SHELL]), `a node with tools ${JSON.stringify(tools)}`);
    assert.deepEqual([node[commands.length].tool, node[commands.length].error, node[commands.length].text], ["write", true, "<harness>\n[error] Tool write is not available\n</harness>"]);
    assert.equal(node.at(-1).tool, "submit", "the node still delivers its record");
  }
  // A workflow node that names bash is refused before anything starts.
  const flow = answerFlow();
  flow.root.steps[0].tools = ["bash"];
  assert.equal((await api("POST", "/agents", { definition: { id: "node-bash", name: "node-bash", workflow: flow, tools: ["bash"] } })).status, 201);
  const refused = await api("POST", "/agents/node-bash/runs", { input: { question: "x" } });
  assert.deepEqual([refused.status, refused.body.error.details.unbound], [409, ["bash"]]);
  assert.equal(await exists(pwned), false, "no command ran");
  assert.equal(await exists(join(data, "evil.txt")), false);
});
