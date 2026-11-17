// A harness module's entry is what the server and its runners read of that harness (harness-table.ts): its runner's
// adapter runs its runs, its runMib is what admission weighs, a runner apart from the server refuses a bad module at
// its start, and its id is one the API can carry. A test table's stand-in for a built-in never changes a built-in's weight.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { follow, scratch, serve, startRun } from "./support.mjs";

const MiB = 2 ** 20;
const RUNNER_INDEX = pathToFileURL(fileURLToPath(new URL("../dist/runner/adapters/index.js", import.meta.url))).href;
const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

/** A harness module adding `id` with only the members a module's entry must give: pi's model choice and checks, `runMib`
 *  of its own, and a runner whose adapter notes each call in `marker` and runs pi's adapter. No facts, no adapter, no
 *  route: a module that gives none of the optional members. */
let made = 0;
function ownModule(dir, id, { runMib = 64, marker } = {}) {
  // Its file's name never holds the id, so a refusal that names the id is not read off its path.
  const path = join(dir, `module-${++made}.mjs`);
  writeFileSync(path, `import { writeFileSync } from "node:fs";
import { RUNNER_HARNESSES } from ${JSON.stringify(RUNNER_INDEX)};
export const entries = (builtins) => ({ ${JSON.stringify(id)}: {
  label: "Own", steer: false, runMib: ${runMib}, oneAlwaysFits: false,
  runs: () => true, onWire: () => false,
  model: (env, ref, available) => builtins.pi.model(env, ref, available),
  priceModel: (_env, model) => model,
  refusal: async () => undefined,
  runner: { adapter: async (launch, extra) => {
    ${marker ? `writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ model: launch.model, sessionsDir: typeof launch.sessionsDir }));` : ""}
    return RUNNER_HARNESSES.pi.adapter(launch, extra);
  } },
} });\n`);
  return path;
}

test("a module's harness with only the required members runs its runs through its own runner's adapter", async (t) => {
  const dir = await scratch(t);
  const marker = join(dir, "adapter-called.json");
  const { api } = await serve(t, { harnessModules: [ownModule(dir, "own", { marker })] });
  const started = await startRun(api, "own-agent", "Hello.", { harness: "own" });
  const { last } = await follow(api, started.run_id, ["completed", "failed"], { deadlineMs: 60_000 });
  assert.equal(last.status, "completed", JSON.stringify(last));
  assert.ok(existsSync(marker), "the module's runner made the run's adapter");
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(marker, "utf8"))).sort(), ["model", "sessionsDir"]);
  assert.equal(JSON.parse(readFileSync(marker, "utf8")).sessionsDir, "string", "the launch lends it a sessions directory");
});

test("admission reads a module's runMib: a small one fits a 512 MiB host, a large one reserves what it declares, and a test table's stand-in never changes a built-in's weight", async (t) => {
  const [{ HARNESS_MODULES_ENV, HARNESS_TABLE_ENV }, { neverFits, runMibOf, runsThatFit }, { claimMibOf, runnerMemory }] = await Promise.all([
    import("../dist/harness-table.js"), import("../dist/host.js"), import("../dist/runner/memory-claim.js"),
  ]);
  const dir = await scratch(t);
  const env = { [HARNESS_MODULES_ENV]: JSON.stringify([ownModule(dir, "small", { runMib: 64 }), ownModule(dir, "large", { runMib: 4000 })]) };
  assert.equal(runMibOf("small", env), 64);
  assert.equal(neverFits("small", 512 * MiB, env), undefined, "64 MiB fits in the 384 MiB a 512 MiB host has for runs");
  assert.equal(runsThatFit("small", 512 * MiB, env), 6);
  assert.equal(claimMibOf("small", env), 64);
  assert.equal(claimMibOf("large", env), 4000, "a runner weighs a large module's run at what it declares");
  assert.equal(runMibOf("large", env), 4000);
  assert.match(neverFits("large", 2048 * MiB, env) ?? "", /a large run needs about 4000 MB more/);
  const weighed = await runnerMemory({ runs: { launch: async (runId) => ({ body: { harness: runId } }) } }, 2048 * MiB, env).weigh(["small", "large", "pi"]);
  assert.deepEqual([...weighed], [["small", 64], ["large", 4000], ["pi", 128]]);

  // A test table (under a test runner) stands in for pi with another runMib: pi's weight stays the built-in one.
  const table = join(dir, "test-table.mjs");
  writeFileSync(table, "export const entries = () => ({ pi: { runMib: 1 } });\n");
  const tested = { ...env, NODE_TEST_CONTEXT: "child-v8", [HARNESS_TABLE_ENV]: table };
  assert.equal((await import("../dist/harness-table.js")).harnessOf(tested, "pi").runMib, 1, "the test table's entry is in the table");
  assert.deepEqual([runMibOf("pi", tested), claimMibOf("pi", tested), runsThatFit("pi", 512 * MiB, tested)], [128, 128, 3], "the built-in weight");
  assert.equal(claimMibOf("small", tested), 64);
});

/** `node dist/cli.js runner` on `data` with `args`: its exit and its stderr, killed (and failed) if it runs past 30 s. */
async function runnerExit(t, data, args) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.AGENTRUN_SERVE_HARNESS_MODULES;
  const child = spawn(process.execPath, [CLI, "runner", "--data", data, "--name", "runner-bad-module", ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  });
  const err = [];
  createInterface({ input: child.stderr }).on("line", (line) => err.push(line));
  let timer;
  const ran = await Promise.race([exited, new Promise((resolve) => { timer = setTimeout(() => resolve("running"), 30_000); })]);
  clearTimeout(timer);
  if (ran === "running") child.kill("SIGTERM");
  await exited;
  return { ran, stderr: err.join("\n") };
}

test("a runner apart from the server refuses a bad harness module at its start, naming the module and the id, and claims nothing", async (t) => {
  const dir = await scratch(t);
  const { api, data } = await serve(t, { runner: false });
  const queued = await startRun(api, "waits", "Hello.");
  const builtin = join(dir, "first.mjs");
  writeFileSync(builtin, "export const entries = () => ({ codex: { runs: () => false } });\n");
  const half = join(dir, "second.mjs");
  writeFileSync(half, "export const entries = () => ({ half: { label: \"Half\", steer: false } });\n");
  for (const [module, id] of [[builtin, "codex"], [half, "half"]]) {
    const { ran, stderr } = await runnerExit(t, data, ["--harness-module", module]);
    assert.notEqual(ran, "running", `the runner started with ${module}: ${stderr}`);
    assert.ok(ran.code !== 0 && ran.code !== null, `exits non-zero: ${JSON.stringify(ran)}`);
    assert.ok(stderr.includes(module) && new RegExp(`\\b${id}\\b`).test(stderr), `names the module and the id: ${stderr}`);
  }
  assert.equal(existsSync(join(data, "runner-runner-bad-module.alive")), false, "no heartbeat: it never started claiming");
  assert.equal((await api("GET", `/runs/${queued.run_id}`)).body.status, "queued", "the queued run is untouched");
});

test("a harness module's id is one the API carries (^[a-z][a-z0-9-]{0,39}$): one that is not is refused, naming the module and the id", async (t) => {
  const [{ HARNESS_MODULES_ENV, harnessTable }, { HARNESS_ID_PATTERN }] = await Promise.all([import("../dist/harness-table.js"), import("../dist/harness.js")]);
  assert.equal(HARNESS_ID_PATTERN, "^[a-z][a-z0-9-]{0,39}$");
  const dir = await scratch(t);
  for (const id of ["My_Harness", "9lives", `a${"b".repeat(40)}`]) {
    const path = ownModule(dir, id);
    assert.throws(() => harnessTable({ [HARNESS_MODULES_ENV]: JSON.stringify([path]) }), (error) => error.message.includes(path) && error.message.includes(id) && error.message.includes(HARNESS_ID_PATTERN), id);
  }
  const { openapiDocument } = await import("../dist/openapi.js");
  assert.ok(JSON.stringify(openapiDocument(() => undefined)).includes(JSON.stringify(HARNESS_ID_PATTERN)), "the OpenAPI document's harness id pattern is the same one");
});

test("a module that names an id the runner or serve keeps for its own runs (learning, sdk, workflow, an SDK runtime's) refuses the start, naming the module and the id", async (t) => {
  const [{ HARNESS_MODULES_ENV, harnessTable }, { RESERVED_HARNESS_IDS }, { LEARNING_HARNESS }, { SDK_BINDING }] = await Promise.all([
    import("../dist/harness-table.js"), import("../dist/harness.js"), import("../dist/runner/learning-factory.js"), import("../dist/sdk/schema.js"),
  ]);
  // The names serve's own runs carry as a launch's harness or a run's harness in analytics: a learning run's (the runner's
  // loop choice keys on it), an SDK run's, a workflow revision's, and each SDK runtime's.
  for (const id of [LEARNING_HARNESS, "sdk", "workflow", ...SDK_BINDING.properties.runtime.enum]) assert.ok(RESERVED_HARNESS_IDS.includes(id), id);
  const dir = await scratch(t);
  for (const id of RESERVED_HARNESS_IDS) {
    const path = ownModule(dir, id);
    assert.throws(() => harnessTable({ [HARNESS_MODULES_ENV]: JSON.stringify([path]) }), (error) => error.message.includes(path) && error.message.includes(` ${id},`) && /serve's own/.test(error.message), id);
  }
});

test("a module may not take a name every plain object already has (constructor): serve looks harnesses up by id in plain objects, so the start is refused, naming the module and the id", async (t) => {
  const [{ HARNESS_MODULES_ENV, harnessTable }, { HARNESS_ID_PATTERN, RESERVED_HARNESS_IDS }] = await Promise.all([import("../dist/harness-table.js"), import("../dist/harness.js")]);
  const inherited = Object.getOwnPropertyNames(Object.prototype).filter((name) => new RegExp(HARNESS_ID_PATTERN).test(name));
  assert.ok(inherited.includes("constructor"), inherited.join(", "));
  for (const id of inherited) assert.ok(RESERVED_HARNESS_IDS.includes(id), id);
  const dir = await scratch(t);
  const path = ownModule(dir, "constructor");
  assert.throws(() => harnessTable({ [HARNESS_MODULES_ENV]: JSON.stringify([path]) }), (error) => error.message.includes(path) && error.message.includes(" constructor,"), "constructor");
});

test("capabilities offer a module's harness every tool pi runs, the meta tools and MCP grants, so its tool choices stay; a built-in's offers do not change", async (t) => {
  const dir = await scratch(t);
  const { api } = await serve(t, { harnessModules: [ownModule(dir, "own")] });
  const caps = (await api("GET", "/capabilities")).body;
  const onPi = caps.tools.filter((tool) => tool.harnesses.includes("pi")).map((tool) => tool.name);
  const onOwn = caps.tools.filter((tool) => tool.harnesses.includes("own")).map((tool) => tool.name);
  assert.ok(onPi.includes("browser") && onPi.includes("read"), onPi.join(", "));
  assert.deepEqual(onOwn, onPi, "a module's harness runs on the general spec, with pi's tools");
  const onClaude = caps.tools.filter((tool) => tool.harnesses.includes("claude-agent")).map((tool) => tool.name);
  assert.ok(onClaude.includes("read") && !onClaude.includes("browser"), "claude-agent keeps the host tools only");
  assert.ok(caps.features.mcp_client.harnesses.includes("own"), "MCP grants run on it, as the save check takes them");
});
