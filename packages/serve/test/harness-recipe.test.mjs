// Bring your own harness, door 1: a recipe file (harness-recipe.ts), its owner's install (`install-harness --recipe`) and
// `harness-check` (harness-check.ts).
//   - The loader holds five rules, each refused by its own code before anything is downloaded or started: own keys only
//     (RECIPE_KEY_NOT_OWN), a binary from a registry archive pinned by sha256 (RECIPE_BINARY_UNPINNED), files and state in
//     the private HOME (RECIPE_PATH_OUTSIDE), only the owner's command installs it (RECIPE_INSTALLS_ITSELF, and a check
//     of one not installed says that command: HARNESS_NOT_INSTALLED), an allowlist environment (RECIPE_ENV_NOT_ALLOWLIST).
//   - The owner's install takes the recipe's archive, its sha256 checked, and records the binary's first sha256 where the
//     recipe pins none: a binary that differs later is refused, by the check (ACP_BINARY_DRIFT) and by a reinstall.
//   - harness-check runs the installed agent for real (here a stand-in ACP agent whose model is a scripted Anthropic
//     origin on loopback: test/fixtures/model-acp-agent.mjs) and passes it through stages 2 and 3, printing the three facts.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { scratch } from "./support.mjs";

const [{ installRecipe, loadRecipe, parseRecipe, RECIPE_CODES, RecipeRefused, firstSeenOf }, { archivePlatform, ArchiveInstallFailed }] = await Promise.all([
  import("../dist/harness-recipe.js"), import("../dist/harness-archive.js"),
]);
const { fakeAnthropic } = await import(new URL("../../run-adapters-acp/test/fake-anthropic.mjs", import.meta.url).href);

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const AGENT = new URL("./fixtures/model-acp-agent.mjs", import.meta.url).pathname;
const PLATFORM = archivePlatform();
const URL_OF = "https://releases.example.invalid/model-agent-1.0.0.tar.bz2";
const MODEL = "anthropic/claude-haiku-4-5";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const linux = process.platform === "linux" ? false : "the agent's environment and its kill are read from /proc";

/** A release of the stand-in agent: `./agent`, a script that runs it, packed in a .tar.bz2. `extra` changes its bytes. */
async function release(t, extra = "") {
  const dir = await scratch(t);
  const tree = join(dir, "tree");
  mkdirSync(tree);
  const body = `#!/bin/sh\n${extra}exec '${process.execPath}' '${AGENT}' "$@"\n`;
  writeFileSync(join(tree, "agent"), body);
  chmodSync(join(tree, "agent"), 0o755);
  const archive = join(dir, "agent.tar.bz2");
  const packed = spawnSync("tar", ["-cjf", archive, "-C", tree, "./agent"], { encoding: "utf8" });
  assert.equal(packed.status, 0, packed.stderr);
  const bytes = readFileSync(archive);
  return { bytes, archiveSha: sha256(bytes), binarySha: sha256(Buffer.from(body)) };
}

/** A recipe for the stand-in agent, `over` merged over it. */
const recipeOf = (archiveSha = "0".repeat(64), over = {}) => ({
  id: "model-agent",
  label: "Model Agent",
  release: { registry: "model-agent", version: "1.0.0", archives: { [PLATFORM]: { url: URL_OF, format: "tar.bz2", sha256: archiveSha, cmd: "./agent" } } },
  env: { MODEL_AGENT_MODE: "good" },
  model: { billing: "proxy", wire: "anthropic-messages", env: "MODEL_AGENT_MODEL" },
  files: { ".config/model-agent/settings.json": "{\"telemetry\": false}\n" },
  state: [".model-agent/sessions"],
  declares: { load: true, mcp: "http" },
  ...over,
});

/** The recipe written to a file of its own. */
async function recipeFile(t, recipe) {
  const file = join(await scratch(t), "recipe.json");
  writeFileSync(file, `${JSON.stringify(recipe, null, 2)}\n`);
  return file;
}

/** A fetch that serves `bytes` at the recipe's URL, each request counted. */
const servedFetch = (bytes, asked = []) => async (url) => (asked.push(String(url)), String(url) === URL_OF ? new Response(bytes, { status: 200 }) : new Response("no", { status: 404 }));

/** The environment the CLI runs in: the scripted origin's, no other key. */
function cliEnv(extra = {}) {
  const env = { ...process.env, AGENTRUN_TELEMETRY: "0" };
  for (const name of Object.keys(env)) if (/_API_KEY$|_TOKEN$|^AGENT_MODEL|^ANTHROPIC_|^OPENAI_|^OPENROUTER_/.test(name)) delete env[name];
  return { ...env, ...extra };
}

/** `agentrun-serve <args>`, run to its end: status and output. */
function cli(args, env = cliEnv()) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

/** The check of `file` on `data`, its report read back. */
async function check(t, file, data, env = cliEnv(), extra = []) {
  const report = join(await scratch(t), "report.json");
  const run = await cli(["check-harness", "--recipe", file, "--data", data, "--model", MODEL, "--report", report, ...extra], env);
  return { ...run, report: existsSync(report) ? JSON.parse(readFileSync(report, "utf8")) : undefined };
}

/** The loader's refusal of `recipe`: its code, and every problem's. */
function refusalOf(recipe) {
  try {
    parseRecipe(JSON.stringify(recipe));
  } catch (error) {
    assert.ok(error instanceof RecipeRefused, String(error));
    return { code: error.code, codes: error.problems.map((p) => p.code), message: error.message };
  }
  assert.fail("the recipe was not refused");
}

// One recipe per rule, each breaking it alone, with the code it is refused by.
const BROKEN = [
  ["rule 1, own keys only: a key the server holds for a model provider", RECIPE_CODES.keys, () => recipeOf(undefined, { keys: ["OPENROUTER_API_KEY"] })],
  ["rule 1, own keys only: a key written into env", RECIPE_CODES.keys, () => recipeOf(undefined, { env: { MODEL_AGENT_API_KEY: "fake-test-key" } })],
  ["rule 2, a pinned binary: a command of its own", RECIPE_CODES.binary, () => recipeOf(undefined, { command: "/usr/local/bin/agent" })],
  ["rule 2, a pinned binary: an archive with no sha256", RECIPE_CODES.binary, () => {
    const r = recipeOf();
    delete r.release.archives[PLATFORM].sha256;
    return r;
  }],
  ["rule 2, a pinned binary: an archive over plain http", RECIPE_CODES.binary, () => {
    const r = recipeOf();
    r.release.archives[PLATFORM].url = "http://releases.example.invalid/agent.tar.bz2";
    return r;
  }],
  ["rule 3, private paths: a file outside HOME", RECIPE_CODES.paths, () => recipeOf(undefined, { files: { "/etc/model-agent.json": "{}" } })],
  ["rule 3, private paths: state that climbs out of HOME", RECIPE_CODES.paths, () => recipeOf(undefined, { state: ["../shared/sessions"] })],
  ["rule 4, the owner installs it: an install step of its own", RECIPE_CODES.install, () => recipeOf(undefined, { install: "curl -fsSL https://example.invalid/install.sh | sh" })],
  ["rule 5, an allowlist environment: the host's environment passed through", RECIPE_CODES.env, () => recipeOf(undefined, { passEnv: true })],
  ["rule 5, an allowlist environment: a value read from the host's environment", RECIPE_CODES.env, () => recipeOf(undefined, { env: { MODEL_AGENT_CACHE: "$HOME/.cache" } })],
  ["rule 5, an allowlist environment: a variable the adapter sets", RECIPE_CODES.env, () => recipeOf(undefined, { env: { HOME: "/root" } })],
];

for (const [name, code, make] of BROKEN) {
  test(`the loader refuses ${name}: ${code}`, () => {
    const refused = refusalOf(make());
    assert.equal(refused.code, code, refused.message);
    assert.deepEqual([...new Set(refused.codes)], [code], `that rule alone: ${refused.message}`);
  });
}

test("harness-check refuses a recipe that breaks each of the five rules, by the rule's code, and starts nothing", async (t) => {
  const data = join(await scratch(t), "agents");
  const rules = [BROKEN[0], BROKEN[2], BROKEN[5], BROKEN[7], BROKEN[8]];
  const runs = await Promise.all(rules.map(async ([, code, make]) => ({ code, run: await check(t, await recipeFile(t, make()), data) })));
  for (const { code, run } of runs) {
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stdout, new RegExp(`harness-check: refused: ${code}`), run.stdout);
    assert.equal(run.report.ok, false);
    assert.equal(run.report.refused.code, code);
    assert.equal(run.report.stage2, undefined, "no stage ran");
  }
  assert.equal(existsSync(join(data, "harnesses")), false, "nothing installed or downloaded");
});

test("rule 4: a check of a recipe its owner has not installed downloads nothing and says the install command", async (t) => {
  const data = join(await scratch(t), "agents");
  const file = await recipeFile(t, recipeOf());
  const run = await check(t, file, data);
  assert.equal(run.status, 1, run.stderr);
  assert.equal(run.report.refused.code, "HARNESS_NOT_INSTALLED");
  assert.ok(run.report.refused.message.includes(`agentrun harness install --recipe ${file} --data ${data}`), run.report.refused.message);
  assert.equal(existsSync(join(data, "harnesses")), false, "nothing downloaded");
  // The install command refuses a broken recipe before it downloads anything.
  const broken = await cli(["install-harness", "--recipe", await recipeFile(t, BROKEN[7][2]()), "--data", data]);
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /RECIPE_INSTALLS_ITSELF/);
  assert.equal(existsSync(join(data, "harnesses")), false);
});

test("the owner's install: the archive's sha256 checked, the binary's first sha256 recorded, a binary that differs later refused", async (t) => {
  const data = join(await scratch(t), "agents");
  const first = await release(t);
  const file = await recipeFile(t, recipeOf(first.archiveSha));
  const { recipe } = loadRecipe(file);
  const asked = [];
  const now = await installRecipe(recipe, file, data, { fetch: servedFetch(first.bytes, asked) });
  assert.equal(now.installed, "now");
  assert.equal(now.pinnedBy, "recorded");
  assert.equal(readFileSync(firstSeenOf(data, recipe, PLATFORM), "utf8").trim(), first.binarySha, "the first sha256 recorded");
  const again = await installRecipe(recipe, file, data, { fetch: servedFetch(first.bytes, asked) });
  assert.equal(again.installed, "already");
  assert.equal(again.pinnedBy, "first-seen");
  assert.equal(asked.length, 1, "a rerun with the binary in place downloads nothing");

  // An archive the recipe does not pin is refused before it unpacks.
  const other = await release(t, "# another build\n");
  await assert.rejects(installRecipe(recipe, file, join(await scratch(t), "agents"), { fetch: servedFetch(other.bytes) }), (error) => error instanceof ArchiveInstallFailed && error.code === "HARNESS_ARCHIVE_MISMATCH" && /agentrun harness install --recipe/.test(error.message));
  // The same version re-released with another binary: its archive matches a recipe that says so, its binary not the first.
  const moved = await recipeFile(t, recipeOf(other.archiveSha));
  const { recipe: movedRecipe } = loadRecipe(moved);
  chmodSync(join(data, "harnesses", "model-agent"), 0o755);
  chmodSync(join(data, "harnesses", "model-agent", "agent"), 0o755);
  writeFileSync(join(data, "harnesses", "model-agent", "agent"), "#!/bin/sh\necho swapped\n");
  await assert.rejects(installRecipe(movedRecipe, moved, data, { fetch: servedFetch(other.bytes) }), (error) => error instanceof ArchiveInstallFailed && error.code === "HARNESS_BINARY_MISMATCH" && error.message.includes(first.binarySha));
  // And the check refuses the swapped binary: drift from the first one seen.
  const run = await check(t, file, data);
  assert.equal(run.status, 1);
  assert.equal(run.report.refused.code, "ACP_BINARY_DRIFT", run.report.refused.message);
});

/** The stand-in agent installed from `recipe` (or `recipe(origin)`) into a fresh data directory, and a scripted origin
 *  for its model. */
async function installed(t, recipe) {
  const origin = await fakeAnthropic({ step: checkStep });
  t.after(() => origin.close());
  if (typeof recipe === "function") recipe = recipe(origin);
  const data = join(await scratch(t), "agents");
  const built = await release(t);
  const file = await recipeFile(t, { ...recipe, release: { ...recipe.release, archives: { [PLATFORM]: { ...recipe.release.archives[PLATFORM], sha256: built.archiveSha } } } });
  await installRecipe(loadRecipe(file).recipe, file, data, { fetch: servedFetch(built.bytes) });
  return { data, file, origin, env: cliEnv({ ANTHROPIC_BASE_URL: origin.url, ANTHROPIC_API_KEY: "fake-test-key" }) };
}

/** The scripted model for the check's turns: it calls the tool a prompt names, with the text the prompt gives, and
 *  answers a tool's result with it. */
function checkStep(body) {
  const last = body.messages.at(-1);
  const tools = (body.tools ?? []).map((tool) => tool.name);
  const results = Array.isArray(last?.content) ? last.content.filter((b) => b.type === "tool_result") : [];
  if (results.length) return { text: `RESULT ${JSON.stringify(results[0].content).slice(0, 80)}` };
  const prompt = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
  // The last ask in the prompt: a restarted agent's prompt holds the conversation's note before it.
  const use = [...prompt.matchAll(/Use the (check_\w+) tool once, with the text argument set to (\w+)/g)].at(-1);
  if (use) {
    const tool = tools.find((name) => name.endsWith(use[1]));
    return tool ? { tool, input: { text: use[2] } } : { text: `NO ${use[1]} among ${tools}` };
  }
  return { text: "ready" };
}

test("harness-check passes an agent that keeps the rules: stages 2 and 3, and the three facts printed", { skip: linux, timeout: 120_000 }, async (t) => {
  const { data, file, origin, env } = await installed(t, recipeOf());
  const run = await check(t, file, data, env);
  t.diagnostic(run.stdout);
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}\n${JSON.stringify(run.report?.stage2)}`);
  for (const line of ["resume: load", "tool_gate: permission", "billing: proxy", "harness-check: passed"]) assert.ok(run.stdout.split("\n").includes(line), `${line} in:\n${run.stdout}`);
  const { report } = run;
  assert.deepEqual(report.facts, { resume: "load", tool_gate: "permission", billing: "proxy" });
  assert.deepEqual(report.stage2.tools_off.firstRequest.sort(), ["agentrun__check_denied", "agentrun__check_echo"]);
  assert.deepEqual(report.stage2.env_allowlist.beyondAllowlist, []);
  assert.deepEqual(report.stage2.env_allowlist.hostSecretsSeen, []);
  assert.equal(report.stage2.limits.refusedUnsent, true);
  assert.equal(report.stage2.pins.pinnedBy, "first-seen");
  assert.deepEqual(report.stage2.side_requests.toProvider, ["POST /v1/messages"]);
  assert.equal(report.stage3.resume.killed, true);
  assert.equal(report.stage3.resume.loaded, true);
  assert.equal(report.stage3.denied_call.ran, 0);
  assert.equal(report.stage3.mcp_tool.calls, 1);
  assert.equal(report.stage3.other_runner.loaded, true);
  assert.ok(report.spendUsd > 0, "the turns were booked");
  // The provider got the turns' requests alone, each with the server's key, never the agent's.
  assert.ok(origin.messages().length >= 5);
  assert.ok(origin.messages().every((r) => r.headers["x-api-key"] === "fake-test-key"));
  assert.ok(origin.requests.every((r) => r.method === "POST" && r.path === "/v1/messages"));
});

test("harness-check says resume: restart for an agent with no session/load, and still carries the conversation; the proxy's address under the recipe's hostEnv", { skip: linux, timeout: 120_000 }, async (t) => {
  const model = { billing: "proxy", wire: "anthropic-messages", env: "MODEL_AGENT_MODEL", hostEnv: "ANTHROPIC_BASE_URL" };
  const { data, file, env } = await installed(t, recipeOf(undefined, { env: { MODEL_AGENT_MODE: "no-load" }, declares: { load: false, mcp: "http" }, model }));
  const run = await check(t, file, data, env);
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.equal(run.report.facts.resume, "restart");
  assert.equal(run.report.stage3.resume.conversationCarried, true);
  assert.ok(run.report.stage2.env_allowlist.names.includes("ANTHROPIC_BASE_URL"));
  assert.ok(!run.report.stage2.env_allowlist.names.includes("ANTHROPIC_HOST"));
  // A recipe may not name another variable for it.
  assert.equal(refusalOf(recipeOf(undefined, { model: { ...model, hostEnv: "MY_PROXY" } })).code, RECIPE_CODES.env);
});

test("harness-check fails an agent whose own tools are on: its model request is refused and stage 2's tools_off fails", { skip: linux, timeout: 120_000 }, async (t) => {
  const { data, file, origin, env } = await installed(t, recipeOf(undefined, { env: { MODEL_AGENT_MODE: "own-tools" } }));
  const run = await check(t, file, data, env);
  t.diagnostic(run.stdout);
  assert.equal(run.status, 1);
  assert.match(run.stdout, /stage 2 tools_off: FAIL/);
  assert.equal(origin.messages().length, 0, "no request offering its own tools reached the provider");
  assert.match(run.stdout, /harness-check: FAILED/);
});

test("harness-check gates an agent that titles our tool its own way (Goose's `agentrun: check echo`) by the tool its title names", { skip: linux, timeout: 120_000 }, async (t) => {
  const { data, file, env } = await installed(t, recipeOf(undefined, { env: { MODEL_AGENT_MODE: "goose-title" } }));
  const run = await check(t, file, data, env);
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}\n${JSON.stringify(run.report?.gate)}`);
  const asked = run.report.gate.asked;
  assert.ok(asked.some((g) => g.tool === "acp_other" && g.about === "check_echo" && g.answer === "allow"), JSON.stringify(asked));
  assert.ok(asked.some((g) => g.tool === "acp_other" && g.about === "check_denied" && g.answer === "deny"), JSON.stringify(asked));
  assert.equal(run.report.stage3.mcp_tool.calls, 1);
  assert.equal(run.report.stage3.denied_call.ran, 0);
  assert.equal(run.report.facts.tool_gate, "permission");
});

test("harness-check lists what the agent reaches for beyond loopback, refused by its own proxy", { skip: linux, timeout: 120_000 }, async (t) => {
  const { data, file, env } = await installed(t, recipeOf(undefined, { env: { MODEL_AGENT_MODE: "side" } }));
  const run = await check(t, file, data, env);
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.ok(run.report.stage2.side_requests.beyondLoopbackRefused.includes("CONNECT telemetry.invalid:443"), JSON.stringify(run.report.stage2.side_requests));
});

test("harness-check passes a plan-billed agent that reaches its vendor through HTTPS_PROXY: the hosts its recipe names are tunneled, the rest refused", { skip: linux, timeout: 120_000 }, async (t) => {
  const planned = (origin) => {
    const vendor = new URL(origin.url).host;
    return recipeOf(undefined, { keys: ["MODEL_AGENT_API_KEY"], env: { MODEL_AGENT_MODE: "plan", MODEL_AGENT_VENDOR: vendor, MODEL_AGENT_MODEL: "vendor-model" }, model: { billing: "plan", maxTurns: 8, maxToolCalls: 8, hosts: [vendor] } });
  };
  const { data, file, origin } = await installed(t, planned);
  const run = await check(t, file, data, cliEnv({ MODEL_AGENT_API_KEY: "fake-test-key" }));
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}\n${JSON.stringify(run.report?.stage2)}`);
  assert.equal(run.report.facts.billing, "plan");
  assert.deepEqual(run.report.stage2.side_requests.toVendor, [new URL(origin.url).host]);
  assert.deepEqual(run.report.stage2.side_requests.beyondLoopbackRefused, []);
  assert.equal(run.report.stage3.mcp_tool.calls, 1);
  assert.equal(run.report.stage3.denied_call.ran, 0);
  // The vendor got the agent's requests, each on the agent's own key.
  assert.ok(origin.messages().length >= 4);
  assert.ok(origin.messages().every((r) => r.headers["x-api-key"] === "fake-test-key"));
  // A host the recipe does not name is refused: the same agent, its vendor left out of model.hosts.
  const unnamed = await installed(t, (o) => ({ ...planned(o), model: { billing: "plan", maxTurns: 8, maxToolCalls: 8, hosts: ["vendor.example.invalid"] } }));
  const refused = await check(t, unnamed.file, unnamed.data, cliEnv({ MODEL_AGENT_API_KEY: "fake-test-key" }));
  assert.equal(refused.status, 1);
  assert.equal(unnamed.origin.messages().length, 0);
  assert.ok(refused.report.stage2.side_requests.beyondLoopbackRefused.includes(`CONNECT ${new URL(unnamed.origin.url).host}`), JSON.stringify(refused.report.stage2.side_requests));
  // model.hosts are host names with an optional port, and only plan billing names them.
  assert.equal(refusalOf(recipeOf(undefined, { keys: ["MODEL_AGENT_API_KEY"], model: { billing: "plan", maxTurns: 8, maxToolCalls: 8, hosts: ["https://vendor.example/"] } })).code, RECIPE_CODES.invalid);
  assert.equal(refusalOf(recipeOf(undefined, { keys: ["MODEL_AGENT_API_KEY"], model: { billing: "plan", maxTurns: 8, maxToolCalls: 8, hosts: ["vendor.example:65536"] } })).code, RECIPE_CODES.invalid);
  assert.equal(parseRecipe(JSON.stringify(recipeOf(undefined, { keys: ["MODEL_AGENT_API_KEY"], model: { billing: "plan", maxTurns: 8, maxToolCalls: 8, hosts: ["vendor.example:65535", "api.vendor.example"] } }))).model.hosts.length, 2);
  assert.equal(refusalOf(recipeOf(undefined, { model: { billing: "proxy", wire: "anthropic-messages", env: "MODEL_AGENT_MODEL", hosts: ["vendor.example"] } })).code, RECIPE_CODES.invalid);
});

test("harness-check finds a host key the recipe copied under another name, though the server keeps its keys off the environment's enumeration", { skip: linux, timeout: 120_000 }, async (t) => {
  const { data, file, env } = await installed(t, recipeOf(undefined, { env: { MODEL_AGENT_MODE: "good", DEBUG_VALUE: "fake-test-key" } }));
  const run = await check(t, file, data, env);
  assert.equal(run.status, 1, `${run.stdout}\n${run.stderr}`);
  assert.deepEqual(run.report.stage2.env_allowlist.hostSecretsSeen, ["DEBUG_VALUE"]);
  assert.match(run.stdout, /stage 2 env_allowlist: FAIL/);
});
