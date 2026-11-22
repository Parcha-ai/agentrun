// The five rules (HARNESS.md#the-five-rules), the owner's install and harness-check.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { scratch } from "./support.mjs";
import { zipOf } from "./fixtures/zip-of.mjs";

const [{ installRecipe, loadRecipe, parseRecipe, RECIPE_CODES, RecipeRefused, firstSeenOf }, { ARCHIVE_CODES, archivePlatform, ArchiveInstallFailed }] = await Promise.all([
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

/** A release of the stand-in agent: `./agent`, a script that runs it, packed in a .tar.bz2 (or a .tar.gz or a .zip: `pack`
 *  "gz" or "zip"). `extra` changes its bytes; `sidecar`, the text of a second executable beside it (`./sidecar`), as
 *  Antigravity's server ships its own beside it. */
async function release(t, extra = "", pack = "bz2", { sidecar } = {}) {
  const dir = await scratch(t);
  const tree = join(dir, "tree");
  mkdirSync(tree);
  const body = `#!/bin/sh\n${extra}exec '${process.execPath}' '${AGENT}' "$@"\n`;
  const files = { agent: body, ...(sidecar === undefined ? {} : { sidecar }) };
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(tree, name), text);
    chmodSync(join(tree, name), 0o755);
  }
  let bytes;
  if (pack === "zip") bytes = zipOf(Object.entries(files).map(([name, text]) => ({ name, bytes: Buffer.from(text), mode: 0o755 })));
  else {
    const archive = join(dir, `agent.tar.${pack}`);
    const packed = spawnSync("tar", [pack === "gz" ? "-czf" : "-cjf", archive, "-C", tree, ...Object.keys(files).map((name) => `./${name}`)], { encoding: "utf8" });
    assert.equal(packed.status, 0, packed.stderr);
    bytes = readFileSync(archive);
  }
  return { bytes, tree, archiveSha: sha256(bytes), binarySha: sha256(Buffer.from(body)) };
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

/** The check of `file` on `data`, its report read back (`written`: the file as it is on disk). */
async function check(t, file, data, env = cliEnv(), extra = []) {
  const report = join(await scratch(t), "report.json");
  const run = await cli(["check-harness", "--recipe", file, "--data", data, "--model", MODEL, "--report", report, ...extra], env);
  const written = existsSync(report) ? readFileSync(report, "utf8") : undefined;
  return { ...run, written, report: written === undefined ? undefined : JSON.parse(written) };
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
  ["its own id: an id the server's harness table already has (cursor)", RECIPE_CODES.invalid, () => recipeOf(undefined, { id: "cursor" })],
];

test("a recipe is refused under every id the server's harness table already has, and every reserved one", async () => {
  const { BUILTIN_HARNESS_IDS } = await import("../dist/harness-table.js");
  const { HARNESS_ID_PATTERN, RESERVED_HARNESS_IDS } = await import("../dist/harness.js");
  for (const id of ["cli", "codex-cli", "claude-code-cli"]) assert.ok(RESERVED_HARNESS_IDS.includes(id), `${id} is reserved for source CLI capture`);
  assert.ok(BUILTIN_HARNESS_IDS.includes("goose") && BUILTIN_HARNESS_IDS.includes("cursor"), BUILTIN_HARNESS_IDS.join(", "));
  for (const id of [...BUILTIN_HARNESS_IDS, ...RESERVED_HARNESS_IDS].filter((each) => new RegExp(HARNESS_ID_PATTERN).test(each))) {
    const refused = refusalOf(recipeOf(undefined, { id }));
    assert.equal(refused.code, RECIPE_CODES.invalid, `${id}: ${refused.message}`);
    assert.match(refused.message, new RegExp(`id ${id} `));
  }
});

test("HARNESS.md's `id` row names exactly the ids the server's harness table has and the names it reserves", async () => {
  const { BUILTIN_HARNESS_IDS } = await import("../dist/harness-table.js");
  const { HARNESS_ID_PATTERN, RESERVED_HARNESS_IDS } = await import("../dist/harness.js");
  const doc = readFileSync(new URL("../../../HARNESS.md", import.meta.url), "utf8");
  const rows = doc.split("\n").filter((line) => line.startsWith("| `id` |"));
  assert.equal(rows.length, 1, "one `id` row, the one list of these ids");
  // The row's two lists: the table's ids in the parentheses before " nor ", the reserved names in those after it.
  const [table, reserved] = rows[0].split(" nor ");
  assert.ok(reserved, `the row says which ids it refuses, then "nor" the names reserved: ${rows[0]}`);
  const named = (text) => [...text.matchAll(/\(([^)]*)\)/g)].flatMap((group) => [...group[1].matchAll(/`([^`]+)`/g)].map((id) => id[1])).sort();
  assert.deepEqual(named(table), [...BUILTIN_HARNESS_IDS].sort(), "the built-in ids");
  assert.deepEqual(named(reserved), RESERVED_HARNESS_IDS.filter((id) => new RegExp(HARNESS_ID_PATTERN).test(id)).sort(), "the reserved names an id could take");
});

for (const [name, code, make] of BROKEN) {
  test(`the loader refuses ${name}: ${code}`, () => {
    const refused = refusalOf(make());
    assert.equal(refused.code, code, refused.message);
    assert.deepEqual([...new Set(refused.codes)], [code], `that rule alone: ${refused.message}`);
  });
}

test("one list names the variables the adapter and the proxy set, by part, and its parts are the adapter's own", async () => {
  const { AGENT_VARS, PROXY_HOST_ENVS } = await import("../dist/harness-recipe.js");
  const [{ RESERVED_ENV }, { INHERITED_ENV }] = await Promise.all([import("@parcha/agentrun-harness-acp"), import(new URL("../../run-adapters-acp/dist/host/child.js", import.meta.url).href)]);
  assert.deepEqual(Object.keys(AGENT_VARS).sort(), ["inherited", "proxy", "reserved"]);
  assert.deepEqual([...AGENT_VARS.reserved].sort(), [...RESERVED_ENV].sort(), "the adapter's RESERVED_ENV");
  assert.deepEqual([...AGENT_VARS.inherited].sort(), [...INHERITED_ENV].sort(), "the adapter's INHERITED_ENV");
  assert.deepEqual([...AGENT_VARS.proxy].sort(), ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_HOST"]);
  assert.ok(PROXY_HOST_ENVS.every((name) => AGENT_VARS.proxy.includes(name)), "the proxy's address is one of its variables");
  // A recipe names none of them, in env or as its model's variable (the proxy's key is refused as a key first).
  for (const name of Object.values(AGENT_VARS).flat()) {
    assert.ok([RECIPE_CODES.env, RECIPE_CODES.keys].includes(refusalOf(recipeOf(undefined, { env: { [name]: "x" } })).code), name);
    assert.equal(refusalOf(recipeOf(undefined, { model: { billing: "proxy", wire: "anthropic-messages", env: name } })).code, RECIPE_CODES.env, name);
  }
});

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
  // And the check refuses the swapped binary by the installer's code: one pin, one code.
  const run = await check(t, file, data);
  assert.equal(run.status, 1);
  assert.equal(run.report.refused.code, "HARNESS_BINARY_MISMATCH", run.report.refused.message);
});

/** A recipe whose one archive is `bytes` in `format`, `extra` merged over the archive. */
const formatRecipe = (bytes, format, extra = {}) => recipeOf(undefined, { release: { registry: "model-agent", version: "1.0.0", archives: { [PLATFORM]: { url: URL_OF, format, sha256: sha256(bytes), cmd: "./agent", ...extra } } } });

test("a recipe's archive is in a format the installer unpacks: a .tar.gz installs, and a .zip (the registry's Antigravity release) with its executable bits", async (t) => {
  for (const [pack, format] of [["gz", "tar.gz"], ["zip", "zip"]]) {
    const data = join(await scratch(t), "agents");
    const built = await release(t, "", pack);
    const file = await recipeFile(t, formatRecipe(built.bytes, format));
    const { recipe } = loadRecipe(file);
    const now = await installRecipe(recipe, file, data, { fetch: servedFetch(built.bytes) });
    assert.equal(now.installed, "now", format);
    assert.equal(readFileSync(firstSeenOf(data, recipe, PLATFORM), "utf8").trim(), built.binarySha, format);
    assert.equal(statSync(join(data, "harnesses", "model-agent", "agent")).mode & 0o111, 0o111, `${format}: the binary is executable`);
  }
  // A format it does not unpack is the loader's refusal, by the one list the installer keeps.
  const refused = refusalOf(formatRecipe(Buffer.from("x"), "tar.xz"));
  assert.equal(refused.code, RECIPE_CODES.binary);
  assert.match(refused.message, /tar\.bz2, tar\.gz and zip/);
});

test("a .zip whose entry leaves the folder, or is a symbolic link, is refused unpacked and nothing lands", async (t) => {
  const agent = { name: "agent", bytes: Buffer.from("#!/bin/sh\nexit 0\n"), mode: 0o755 };
  const cases = [
    ["an entry that climbs out", [agent, { name: "../outside", bytes: Buffer.from("x") }]],
    ["an absolute entry", [agent, { name: "/tmp/agentrun-zip-absolute", bytes: Buffer.from("x") }]],
    ["a symbolic link", [agent, { name: "link", bytes: Buffer.from("/etc/passwd"), link: true }]],
  ];
  for (const [name, entries] of cases) {
    const root = await scratch(t);
    const data = join(root, "agents");
    const bytes = zipOf(entries);
    const file = await recipeFile(t, formatRecipe(bytes, "zip"));
    await assert.rejects(installRecipe(loadRecipe(file).recipe, file, data, { fetch: servedFetch(bytes) }), (error) => error instanceof ArchiveInstallFailed && error.code === ARCHIVE_CODES.unpack, name);
    assert.equal(existsSync(join(data, "harnesses", "model-agent")), false, `${name}: nothing installed`);
    assert.equal(existsSync(join(root, "outside")) || existsSync(join(data, "outside")) || existsSync(join(data, "harnesses", "outside")), false, `${name}: nothing written outside`);
  }
  assert.equal(existsSync("/tmp/agentrun-zip-absolute"), false);
});

test("every file the archive unpacks to is pinned, not the binary alone: a sidecar changed after the install is refused at the check, and a recipe's treeSha256 at the install", async (t) => {
  const { treeDigest } = await import("@parcha/agentrun-harness-acp");
  const data = join(await scratch(t), "agents");
  const built = await release(t, "", "zip", { sidecar: "#!/bin/sh\necho sidecar\n" });
  const file = await recipeFile(t, formatRecipe(built.bytes, "zip"));
  const { recipe } = loadRecipe(file);
  await installRecipe(recipe, file, data, { fetch: servedFetch(built.bytes) });
  const installedAt = join(data, "harnesses", "model-agent");
  chmodSync(installedAt, 0o755);
  chmodSync(join(installedAt, "sidecar"), 0o755);
  writeFileSync(join(installedAt, "sidecar"), "#!/bin/sh\necho swapped\n");
  const run = await check(t, file, data);
  assert.equal(run.status, 1);
  assert.equal(run.report.refused.code, "HARNESS_BINARY_MISMATCH", run.report.refused.message);
  assert.match(run.report.refused.message, /tree sha256/);
  // A recipe that pins the tree: the right digest installs, another is refused before anything is put in place.
  const tree = await treeDigest(built.tree);
  const pinned = await recipeFile(t, formatRecipe(built.bytes, "zip", { treeSha256: tree }));
  assert.equal((await installRecipe(loadRecipe(pinned).recipe, pinned, join(await scratch(t), "agents"), { fetch: servedFetch(built.bytes) })).installed, "now");
  const wrong = await recipeFile(t, formatRecipe(built.bytes, "zip", { treeSha256: "1".repeat(64) }));
  const elsewhere = join(await scratch(t), "agents");
  await assert.rejects(installRecipe(loadRecipe(wrong).recipe, wrong, elsewhere, { fetch: servedFetch(built.bytes) }), (error) => error instanceof ArchiveInstallFailed && error.code === "HARNESS_BINARY_MISMATCH" && /tree sha256/.test(error.message));
  assert.equal(existsSync(join(elsewhere, "harnesses", "model-agent")), false);
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

test("harness-check fails an agent whose title for our tool the adapter can't tie (`github: check echo`): its permission is the agent's own, refused, so mcp_tool fails", { skip: linux, timeout: 120_000 }, async (t) => {
  const { data, file, env } = await installed(t, recipeOf(undefined, { env: { MODEL_AGENT_MODE: "untied" } }));
  const run = await check(t, file, data, env);
  assert.equal(run.status, 1, `${run.stdout}\n${run.stderr}\n${JSON.stringify(run.report?.gate)}`);
  assert.match(run.stdout, /stage 3 mcp_tool: FAIL/);
  assert.equal(run.report.stage3.mcp_tool.calls, 0, "the check echo call never ran");
  // The server's gate answers an untied call as the agent's own: so does the check.
  assert.ok(run.report.gate.asked.some((g) => g.tool === "acp_other" && g.answer === "deny"), JSON.stringify(run.report.gate.asked));
});

test("harness-check lists what the agent reaches for beyond loopback, refused by its own proxy", { skip: linux, timeout: 120_000 }, async (t) => {
  const { data, file, env } = await installed(t, recipeOf(undefined, { env: { MODEL_AGENT_MODE: "side" } }));
  const run = await check(t, file, data, env);
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.ok(run.report.stage2.side_requests.beyondLoopbackRefused.includes("CONNECT telemetry.invalid:443"), JSON.stringify(run.report.stage2.side_requests));
});

test("harness-check lists what the agent reached for beyond loopback even when the check stops: an agent that refuses its session while its vendor is out of reach", { skip: linux, timeout: 120_000 }, async (t) => {
  const { data, file, env } = await installed(t, recipeOf(undefined, { env: { MODEL_AGENT_MODE: "start-gate" } }));
  const run = await check(t, file, data, env);
  assert.equal(run.status, 1, `${run.stdout}\n${run.stderr}`);
  assert.equal(run.report.ok, false);
  // Checked once with no hosts, the report names the host it needs, whether the check got to its end or not.
  assert.ok(run.report.stage2.side_requests?.beyondLoopbackRefused?.includes("CONNECT auth.vendor.invalid:443"), JSON.stringify(run.report.stage2));
  // The same agent on a key with keyMethod: its authenticate, before any session, is what it refuses.
  const keyed = await installed(t, (o) => {
    const recipe = signingIn(o);
    return { ...recipe, env: { ...recipe.env, MODEL_AGENT_MODE: "start-gate" } };
  });
  const stopped = await check(t, keyed.file, keyed.data, cliEnv({ MODEL_AGENT_GEMINI_API_KEY: "fake-test-key" }));
  assert.equal(stopped.status, 1, `${stopped.stdout}\n${stopped.stderr}`);
  assert.ok(stopped.report.stage2.side_requests?.beyondLoopbackRefused?.includes("CONNECT auth.vendor.invalid:443"), JSON.stringify(stopped.report));
});

test("the check's egress proxy lists what a client asks it to reach (absolute-form or CONNECT), never a request to its own port as a server (origin-form, a stray that reused the port)", async (t) => {
  const { egressProxy } = await import("../dist/harness-check.js");
  const proxy = await egressProxy([]);
  t.after(() => proxy.close());
  const { port, hostname } = new URL(proxy.url);
  const send = (path) => new Promise((resolve, reject) => {
    const request = httpRequest({ host: hostname, port, method: "GET", path }, (response) => (response.resume(), response.on("end", () => resolve(response.statusCode))));
    request.on("error", reject);
    request.end();
  });
  assert.equal(await send("/"), 403);
  assert.equal(await send("/health"), 403);
  assert.deepEqual(proxy.asked, [], "a request to the proxy itself is refused and not one the agent sent beyond loopback");
  assert.equal(await send("http://telemetry.invalid/ping"), 403);
  assert.deepEqual(proxy.asked, [{ method: "GET", target: "http://telemetry.invalid/ping", tunneled: false }]);
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
  // The key is handed the one way a run's is (the adapter's recipe.keys, read by name at its start): a host without it
  // is refused before the agent starts, naming the key, and the vendor hears nothing.
  const keyless = await installed(t, planned);
  const missing = await check(t, keyless.file, keyless.data, cliEnv());
  assert.equal(missing.status, 1);
  assert.match(`${missing.stdout}\n${JSON.stringify(missing.report)}`, /ACP_KEY_MISSING: [^"\n]*MODEL_AGENT_API_KEY/);
  assert.equal(keyless.origin.messages().length, 0);
});

test("harness-check cuts the recipe's key from its report and its output: an agent that prints its key on stderr as it dies", { skip: linux, timeout: 120_000 }, async (t) => {
  // A fake literal, long enough to be cut (MIN_SECRET): never a real key.
  const key = "fake-test-key-the-agent-prints";
  const { data, file } = await installed(t, recipeOf(undefined, { keys: ["MODEL_AGENT_API_KEY"], env: { MODEL_AGENT_MODE: "leak-key" }, model: { billing: "plan", maxTurns: 8, maxToolCalls: 8, hosts: ["vendor.example.invalid"] } }));
  const run = await check(t, file, data, cliEnv({ MODEL_AGENT_API_KEY: key }));
  assert.equal(run.status, 1, "an agent that dies at each prompt fails the check");
  assert.ok(run.written, "the report was written");
  // Where the agent's words land, each told only whether it holds the key, never shown it.
  for (const [where, text] of [["the report on disk", run.written], ["stdout", run.stdout], ["stderr", run.stderr]]) assert.equal(text.includes(key), false, `${where} holds the recipe's key`);
  assert.match(run.report.stage3.mcp_tool.error ?? "", /the vendor refused the key \[redacted\] \(401\)/, "the agent's words, its key cut in place");
});

/** Each `n`-character piece of `key`: text holding any of them holds part of the key. */
const piecesOf = (key, n = 8) => Array.from({ length: key.length - n + 1 }, (_, i) => key.slice(i, i + n));

test("harness-check leaves no piece of the recipe's key where the agent's last words were cut inside it (the key, then 280 characters)", { skip: linux, timeout: 120_000 }, async (t) => {
  // A fake literal, never a real key: its pieces match nothing else a report says.
  const key = "fake-Qz7Wv9Lm2Np4Rs6Tx8Yb3Kc5Hd";
  // " (401) " and 273 more: 280 characters after the key, so the last 300 of its words start 20 characters into it.
  const { data, file } = await installed(t, recipeOf(undefined, { keys: ["MODEL_AGENT_API_KEY"], env: { MODEL_AGENT_MODE: "leak-key", MODEL_AGENT_LEAK_AFTER: "273" }, model: { billing: "plan", maxTurns: 8, maxToolCalls: 8, hosts: ["vendor.example.invalid"] } }));
  const run = await check(t, file, data, cliEnv({ MODEL_AGENT_API_KEY: key }));
  assert.equal(run.status, 1, "an agent that dies at each prompt fails the check");
  assert.ok(run.written, "the report was written");
  for (const [where, text] of [["the report on disk", run.written], ["stdout", run.stdout], ["stderr", run.stderr]]) {
    const held = piecesOf(key).filter((piece) => text.includes(piece)).length;
    assert.equal(held, 0, `${where} holds ${held} 8-character pieces of the recipe's key`);
  }
  assert.match(run.report.stage3.mcp_tool.error ?? "", /\(401\) \.{20}/, "the agent's last words are still there");
});

/** What a report says, without what differs run to run (pids, paths, digests, times): its result, its refusal's code,
 *  its facts, each stage row's name, result and fields, and its failures. */
const shapeOf = (report) => ({
  ok: report.ok,
  refused: report.refused?.code ?? null,
  facts: report.facts ?? null,
  ...Object.fromEntries(["stage2", "stage3"].map((stage) => [stage, Object.fromEntries(Object.entries(report[stage] ?? {}).map(([name, row]) => [name, { ok: row.ok, fields: Object.keys(row).sort() }]))])),
  failures: report.failures,
});

// A plan-billed recipe's check starts its agent on the adapter over its recipe alone (harness-check.ts): its rows, their
// fields and its failures as they were before a proxy-billed one went through the kit's entry (fixtures/
// plan-check-shapes.json, written by the check before that change).
test("a plan-billed recipe's check keeps its rows and codes: passed, a host it does not name refused, a key it lacks refused", { skip: linux, timeout: 120_000 }, async (t) => {
  const planned = (hosts) => (origin) => {
    const vendor = new URL(origin.url).host;
    return recipeOf(undefined, { keys: ["MODEL_AGENT_API_KEY"], env: { MODEL_AGENT_MODE: "plan", MODEL_AGENT_VENDOR: vendor, MODEL_AGENT_MODEL: "vendor-model" }, model: { billing: "plan", maxTurns: 8, maxToolCalls: 8, hosts: hosts ?? [vendor] } });
  };
  const keyed = cliEnv({ MODEL_AGENT_API_KEY: "fake-test-key" });
  const passed = await installed(t, planned());
  const unnamed = await installed(t, planned(["vendor.example.invalid"]));
  const keyless = await installed(t, planned());
  const runs = {
    passed: await check(t, passed.file, passed.data, keyed),
    unnamed: await check(t, unnamed.file, unnamed.data, keyed),
    keyless: await check(t, keyless.file, keyless.data, cliEnv()),
  };
  assert.deepEqual(Object.fromEntries(Object.entries(runs).map(([name, run]) => [name, shapeOf(run.report)])), JSON.parse(readFileSync(new URL("./fixtures/plan-check-shapes.json", import.meta.url), "utf8")));
  assert.deepEqual(Object.values(runs).map((run) => run.status), [0, 1, 1]);
  // The key it lacks is refused by its code at the agent's start, before the vendor hears anything.
  assert.match(runs.keyless.report.stage3.mcp_tool.error, /ACP_KEY_MISSING: [^\n]*MODEL_AGENT_API_KEY/);
  assert.equal(keyless.origin.messages().length, 0);
  assert.equal(unnamed.origin.messages().length, 0);
});

test("harness-check finds a host key the recipe copied under another name, though the server keeps its keys off the environment's enumeration", { skip: linux, timeout: 120_000 }, async (t) => {
  const { data, file, env } = await installed(t, recipeOf(undefined, { env: { MODEL_AGENT_MODE: "good", DEBUG_VALUE: "fake-test-key" } }));
  const run = await check(t, file, data, env);
  assert.equal(run.status, 1, `${run.stdout}\n${run.stderr}`);
  assert.deepEqual(run.report.stage2.env_allowlist.hostSecretsSeen, ["DEBUG_VALUE"]);
  assert.match(run.stdout, /stage 2 env_allowlist: FAIL/);
});

test("an archive's own args start the agent on its platform, over the recipe's (the registry lists Antigravity's per platform: linux `--uid=`)", { skip: linux, timeout: 120_000 }, async (t) => {
  const recipe = recipeOf(undefined, { args: ["--everywhere"], env: { MODEL_AGENT_MODE: "good", MODEL_AGENT_WANT_ARG: "--uid=" } });
  recipe.release.archives[PLATFORM].args = ["--uid="];
  const { data, file, env } = await installed(t, recipe);
  const run = await check(t, file, data, env);
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  // A list of strings, as the top-level one.
  const broken = recipeOf();
  broken.release.archives[PLATFORM].args = "--uid=";
  assert.equal(refusalOf(broken).code, RECIPE_CODES.invalid);
});

/** A plan-billed recipe for the stand-in agent on `origin` as its vendor, `over` merged over its model. */
const planOn = (origin, { env = {}, model = {}, ...over } = {}) => {
  const vendor = new URL(origin.url).host;
  return recipeOf(undefined, { keys: ["MODEL_AGENT_API_KEY"], env: { MODEL_AGENT_MODE: "plan", MODEL_AGENT_VENDOR: vendor, MODEL_AGENT_MODEL: "vendor-model", ...env }, model: { billing: "plan", maxTurns: 8, maxToolCalls: 8, hosts: [vendor], ...model }, ...over });
};

test("a plan-billed recipe names its model (model.id): chosen with session/set_model among those the agent lists, and one it does not list is refused", { skip: linux, timeout: 120_000 }, async (t) => {
  const MODELS = { MODEL_AGENT_MODELS: "vendor-model,vendor-model-2" };
  const keyed = cliEnv({ MODEL_AGENT_API_KEY: "fake-test-key" });
  const chosen = await installed(t, (origin) => planOn(origin, { env: MODELS, model: { id: "vendor-model-2" } }));
  const run = await check(t, chosen.file, chosen.data, keyed);
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.ok(chosen.origin.messages().length >= 4);
  assert.deepEqual([...new Set(chosen.origin.messages().map((r) => r.body.model))], ["vendor-model-2"], "every request on the model the recipe names");
  const unlisted = await installed(t, (origin) => planOn(origin, { env: MODELS, model: { id: "vendor-model-9" } }));
  const refused = await check(t, unlisted.file, unlisted.data, keyed);
  assert.equal(refused.status, 1);
  assert.match(JSON.stringify(refused.report), /ACP_MODEL_UNLISTED/);
  assert.equal(unlisted.origin.messages().length, 0, "no prompt was sent");
  // A model id as an agent lists one, and only on plan billing (a proxy-billed run's model is --model's).
  assert.equal(refusalOf(recipeOf(undefined, { keys: ["MODEL_AGENT_API_KEY"], model: { billing: "plan", maxTurns: 8, maxToolCalls: 8, id: "two words" } })).code, RECIPE_CODES.invalid);
  assert.equal(refusalOf(recipeOf(undefined, { model: { billing: "proxy", wire: "anthropic-messages", env: "MODEL_AGENT_MODEL", id: "vendor-model" } })).code, RECIPE_CODES.invalid);
});

/** The code the person's browser brings back to the agent: never a real one. The agent keeps `signed-<code>` as its
 *  sign-in. */
const CODE = "Qz7Wv9Lm2Np4Rs6Tx8Yb3Kc5Hd";
const TOKEN = `signed-${CODE}`;
/** The key saved for this harness alone, and the server's own under the name the agent reads (GEMINI_API_KEY): fakes. */
const SAVED_KEY = "fake-harness-gemini-key";
const SERVER_KEY = "fake-server-gemini-key";
const SIGN_IN_HOME = (data) => join(data, "harnesses", "model-agent.sign-in");
/** A plan-billed recipe for the stand-in agent as Antigravity's is: it signs in with ACP `authenticate`, on a key saved
 *  for it alone and handed as GEMINI_API_KEY (keyMethod), and with a person's own sign-in on attended runs (signIn). */
const signingIn = (origin, { keyed = true, method = "model-agent-login" } = {}) => {
  const { keys: _, ...recipe } = planOn(origin, { env: { MODEL_AGENT_AUTH: "1", MODEL_AGENT_READS: "GEMINI_API_KEY" } });
  return {
    ...recipe,
    ...(keyed ? { keys: [{ name: "MODEL_AGENT_GEMINI_API_KEY", env: "GEMINI_API_KEY" }], keyMethod: "model-agent-api-key" } : {}),
    signIn: { method, homeEnv: "MODEL_AGENT_HOME", runs: "attended" },
  };
};

/** `agentrun-serve sign-in-harness` on `file` and `data`, the test as the person at its terminal: the agent prints there
 *  the address to open (the command hands the agent its own stderr and reads none of it), and the person's browser
 *  (`visit`) ends on the redirect_uri that address names, the agent's own loopback server. */
function signIn(file, data, { env = cliEnv(), visit = (redirect) => fetch(`${redirect}?state=fake&code=${CODE}`) } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, "sign-in-harness", "--recipe", file, "--data", data], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let visited;
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => {
      stderr += c;
      const found = /redirect_uri=([^&\s]+)/.exec(stderr);
      if (found && !visited) visited = Promise.resolve(visit(decodeURIComponent(found[1]))).then((r) => r?.text()).catch((error) => String(error));
    });
    child.on("close", async (status) => resolve({ status, stdout, stderr, page: await visited }));
  });
}

test("harness-check runs a recipe that also signs a person in on its key alone: saved for it, handed as GEMINI_API_KEY with keyMethod, the server's own GEMINI_API_KEY never reaching it, and no sign-in folder touched", { skip: linux, timeout: 120_000 }, async (t) => {
  const { data, file, origin } = await installed(t, (o) => signingIn(o));
  const run = await check(t, file, data, cliEnv({ MODEL_AGENT_GEMINI_API_KEY: SAVED_KEY, GEMINI_API_KEY: SERVER_KEY }));
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}\n${JSON.stringify(run.report?.stage3)}`);
  assert.equal(run.report.facts.billing, "plan");
  assert.ok(origin.messages().length >= 4);
  assert.ok(origin.messages().every((r) => r.headers["x-api-key"] === SAVED_KEY), "the vendor heard the harness's own key");
  assert.equal(existsSync(SIGN_IN_HOME(data)), false, "a check neither makes nor reads the sign-in folder");
  for (const [where, text] of [["the report on disk", run.written], ["stdout", run.stdout], ["stderr", run.stderr]]) {
    for (const secret of [SAVED_KEY, SERVER_KEY]) assert.equal(text.includes(secret), false, `${where} holds a key`);
  }
  // Without its key, the run is refused by its code before a session opens.
  const keyless = await installed(t, (o) => signingIn(o));
  const refused = await check(t, keyless.file, keyless.data, cliEnv({ GEMINI_API_KEY: SERVER_KEY }));
  assert.equal(refused.status, 1);
  assert.match(JSON.stringify(refused.report), /ACP_KEY_MISSING[^"]*MODEL_AGENT_GEMINI_API_KEY/);
  assert.equal(keyless.origin.messages().length, 0);
});

test("a person signs the agent in with `agentrun harness sign-in`: the agent's own address on their terminal, the browser back on the agent's own server, its sign-in in its folder alone; harness-check still runs on a key", { skip: linux, timeout: 120_000 }, async (t) => {
  const { data, file, origin } = await installed(t, (o) => signingIn(o, { keyed: false }));
  const before = await check(t, file, data, cliEnv());
  assert.equal(before.status, 1);
  assert.equal(before.report.refused.code, "HARNESS_SIGN_IN_ATTENDED", before.report.refused.message);
  assert.match(before.report.refused.message, /"env": "GEMINI_API_KEY"/, "it names the key route");

  const signed = await signIn(file, data, { env: cliEnv({ MODEL_AGENT_GEMINI_API_KEY: SAVED_KEY }) });
  assert.equal(signed.status, 0, `${signed.stdout}\n${signed.stderr}`);
  assert.match(signed.stderr, /https:\/\/accounts\.example\.invalid\/o\/oauth2\/auth\?/, "the agent's own address, on the person's terminal");
  assert.match(signed.stderr, /ssh -L PORT:127\.0\.0\.1:PORT/, "the remote route said");
  assert.match(signed.page, /authentication flow has completed/, "the browser landed on the agent's own server");
  assert.match(signed.stdout, /Signed in/);
  for (const [where, text] of [["stdout", signed.stdout], ["stderr", signed.stderr]]) assert.equal(text.includes(TOKEN), false, `${where} holds the sign-in`);
  assert.equal(statSync(SIGN_IN_HOME(data)).mode & 0o777, 0o700);
  assert.ok(existsSync(join(SIGN_IN_HOME(data), "token.json")), "the agent wrote its sign-in into its own folder");
  assert.equal(origin.messages().length, 0, "a sign-in prompts nothing");

  // Signed in, an unattended run still refuses the person's sign-in.
  const after = await check(t, file, data, cliEnv());
  assert.equal(after.report.refused.code, "HARNESS_SIGN_IN_ATTENDED");
  assert.equal(origin.messages().length, 0);
  for (const [where, text] of [["the report on disk", after.written], ["stdout", after.stdout], ["stderr", after.stderr]]) assert.equal(text.includes(TOKEN), false, `${where} holds the sign-in`);
});

test("`agentrun harness sign-in` refuses a method the agent does not list, a recipe with no signIn, and an agent not installed, by their codes, and keeps nothing the agent said", { skip: linux, timeout: 120_000 }, async (t) => {
  const unlisted = await installed(t, (o) => signingIn(o, { method: "another-login" }));
  const refused = await signIn(unlisted.file, unlisted.data, { visit: () => assert.fail("no address is printed for a method the agent does not list") });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /ACP_AUTH_UNLISTED: [^\n]*another-login[^\n]*model-agent-login/);
  assert.equal(existsSync(join(SIGN_IN_HOME(unlisted.data), "token.json")), false);

  const keysOnly = await installed(t, (o) => planOn(o));
  const none = await signIn(keysOnly.file, keysOnly.data);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /HARNESS_NO_SIGN_IN: [^\n]*MODEL_AGENT_API_KEY/);

  const data = join(await scratch(t), "agents");
  const file = await recipeFile(t, signingIn({ url: "http://127.0.0.1:9" }, { keyed: false }));
  const absent = await signIn(file, data);
  assert.equal(absent.status, 1);
  assert.match(absent.stderr, /HARNESS_NOT_INSTALLED: [^\n]*agentrun harness install --recipe/);
  assert.equal(existsSync(SIGN_IN_HOME(data)), false, "no folder for an agent not installed");

  // An agent that dies as it signs in: its exit status and our code, none of its words on stdout (its stderr is the
  // person's terminal, where they read it themselves).
  const dying = await installed(t, (o) => {
    const recipe = signingIn(o, { keyed: false });
    return { ...recipe, env: { ...recipe.env, MODEL_AGENT_WANT_ARG: "--never-given" } };
  });
  const died = await signIn(dying.file, dying.data);
  assert.equal(died.status, 1);
  assert.match(died.stderr, /ACP_AGENT_EXITED: [^\n]*exit status 2/);
  assert.equal(died.stdout.includes("started without"), false);
});

test("a recipe's keys and sign-in are checked: keys handed under the name the agent reads, keyMethod with keys, signIn on plan billing and attended runs alone, its folder's variable its own", () => {
  const plan = { billing: "plan", maxTurns: 8, maxToolCalls: 8 };
  const SIGN_IN = { method: "model-agent-login", homeEnv: "MODEL_AGENT_HOME", runs: "attended" };
  const KEY = { name: "MODEL_AGENT_GEMINI_API_KEY", env: "GEMINI_API_KEY" };
  const both = (over = {}, signIn = SIGN_IN) => recipeOf(undefined, { model: plan, keys: [KEY], keyMethod: "model-agent-api-key", signIn, ...over });
  const parsed = parseRecipe(JSON.stringify(both()));
  assert.deepEqual(parsed.keys, ["MODEL_AGENT_GEMINI_API_KEY"]);
  assert.deepEqual(parsed.keyEnv, { [KEY.name]: KEY.env });
  assert.equal(parsed.keyMethod, "model-agent-api-key");
  assert.deepEqual(parsed.signIn, SIGN_IN);
  assert.equal(parseRecipe(JSON.stringify(recipeOf(undefined, { model: plan, signIn: SIGN_IN }))).keys.length, 0, "a sign-in alone loads (harness-check refuses it)");

  const cases = [
    ["proxy billing signs in with the server's key", recipeOf(undefined, { signIn: SIGN_IN }), RECIPE_CODES.invalid],
    ["runs other than attended", both({}, { ...SIGN_IN, runs: "scheduled" }), RECIPE_CODES.invalid],
    ["a field signIn has not", both({}, { ...SIGN_IN, files: [".gemini/oauth_creds.json"] }), RECIPE_CODES.invalid],
    ["homeEnv a key's name", both({}, { ...SIGN_IN, homeEnv: "MODEL_AGENT_GEMINI_API_KEY" }), RECIPE_CODES.env],
    ["homeEnv a server key's name", both({}, { ...SIGN_IN, homeEnv: "GEMINI_API_KEY" }), RECIPE_CODES.env],
    ["homeEnv set in env", both({ env: { MODEL_AGENT_HOME: "/elsewhere" } }), RECIPE_CODES.env],
    ["signIn.method also keyMethod", both({ keyMethod: "model-agent-login" }), RECIPE_CODES.invalid],
    ["a key saved under the server's own name", both({ keys: [{ name: "GEMINI_API_KEY", env: "GEMINI_API_KEY" }] }), RECIPE_CODES.keys],
    ["two keys handed under one name", both({ keys: [KEY, { name: "MODEL_AGENT_OTHER_API_KEY", env: "GEMINI_API_KEY" }] }), RECIPE_CODES.keys],
    ["one saved key handed under two names", both({ keys: [KEY, { name: "MODEL_AGENT_GEMINI_API_KEY", env: "GOOGLE_API_KEY" }] }), RECIPE_CODES.keys],
    ["one saved key named twice", both({ keys: [KEY, "MODEL_AGENT_GEMINI_API_KEY"] }), RECIPE_CODES.keys],
    ["a key handed as the server's own variable", both({ keys: [{ name: "MODEL_AGENT_GEMINI_API_KEY", env: "AGENTRUN_TOKEN" }] }), RECIPE_CODES.env],
    ["a key entry with a field it has not", both({ keys: [{ ...KEY, value: "x" }] }), RECIPE_CODES.keys],
    // The ACP adapter's key-name rule: capitals, digits and _, at most 64. A lowercase or long name would load here and
    // be refused at harness-check.
    ["a key saved under a lowercase name", both({ keys: [{ name: "model_agent_key", env: "GEMINI_API_KEY" }] }), RECIPE_CODES.keys],
    ["a key handed under a lowercase name", both({ keys: [{ name: "MODEL_AGENT_GEMINI_API_KEY", env: "gemini_api_key" }] }), RECIPE_CODES.keys],
    ["a key named with a leading _", both({ keys: ["_MODEL_AGENT_KEY"] }), RECIPE_CODES.keys],
    ["a key named past 64 characters", both({ keys: [`M${"_".repeat(64)}`] }), RECIPE_CODES.keys],
    ["keyMethod with no keys", recipeOf(undefined, { model: plan, keyMethod: "model-agent-api-key", signIn: SIGN_IN }), RECIPE_CODES.invalid],
  ];
  for (const [why, recipe, code] of cases) assert.ok(refusalOf(recipe).codes.includes(code), `${why}: ${refusalOf(recipe).message}`);
  const neither = refusalOf(recipeOf(undefined, { model: plan }));
  assert.equal(neither.code, RECIPE_CODES.invalid);
  assert.match(neither.message, /in keys or the sign-in in signIn/);
});

test("a key's handed name, signIn.homeEnv and env never name a variable that changes what the agent's process loads or runs, and homeEnv never one the adapter sets", () => {
  const plan = { billing: "plan", maxTurns: 8, maxToolCalls: 8 };
  const SIGN_IN = { method: "model-agent-login", homeEnv: "MODEL_AGENT_HOME", runs: "attended" };
  const KEY = { name: "MODEL_AGENT_GEMINI_API_KEY", env: "GEMINI_API_KEY" };
  const LAUNCHERS = ["PATH", "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "NODE_OPTIONS", "NODE_PATH", "PYTHONPATH", "PYTHONSTARTUP", "BASH_ENV", "ENV", "GIT_CONFIG_GLOBAL", "GIT_SSH_COMMAND"];
  for (const name of LAUNCHERS) {
    const handed = refusalOf(recipeOf(undefined, { model: plan, keys: [{ name: "MODEL_AGENT_GEMINI_API_KEY", env: name }] }));
    assert.ok(handed.codes.includes(RECIPE_CODES.env), `a key handed as ${name}: ${handed.message}`);
    assert.match(handed.message, /loads or runs|the adapter, the proxy or the server sets/);
    const home = refusalOf(recipeOf(undefined, { model: plan, keys: [KEY], signIn: { ...SIGN_IN, homeEnv: name } }));
    assert.ok(home.codes.includes(RECIPE_CODES.env), `signIn.homeEnv ${name}: ${home.message}`);
    const env = refusalOf(recipeOf(undefined, { model: plan, keys: [KEY], env: { [name]: "x" } }));
    assert.ok(env.codes.includes(RECIPE_CODES.env), `env setting ${name}: ${env.message}`);
  }
  for (const name of ["HOME", "TMPDIR", "XDG_CONFIG_HOME", "GIT_CEILING_DIRECTORIES"]) {
    assert.ok(refusalOf(recipeOf(undefined, { model: plan, keys: [KEY], signIn: { ...SIGN_IN, homeEnv: name } })).codes.includes(RECIPE_CODES.env), `signIn.homeEnv ${name}`);
  }
});

// The Antigravity example (examples/harness-recipe/antigravity.json): the ACP registry's antigravity-acp 1.5.2 release
// as the registry lists it, on a key saved for it alone and, on a run its owner attends, the owner's own sign-in.
const ANTIGRAVITY_REGISTRY = {
  "linux-x86_64": { url: "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.5.2-linux-x86_64.zip", sha256: "99dd8612450805011619d7b8447ce374c289e00549d8557f36790e1dd6256852", args: ["--uid="] },
  "linux-aarch64": { url: "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.5.2-linux-arm64.zip", sha256: "e729e05ef54ef0763e48900032466b47fa7c9939cde257f93ba49410ab577acb", args: ["--uid="] },
  "darwin-aarch64": { url: "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.5.2-darwin-arm64.zip", sha256: "123a16d5c40a8ac99e20f01a62b68dd860fd96b1c528dfb8eaa37ca8733d4845" },
  "darwin-x86_64": { url: "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.5.2-darwin-x86_64.zip", sha256: "92addb5580577b5356d35484d72d1a113d9c5312ad766bcb304983aa8e3fbb06" },
};

test("the Antigravity example recipe loads under the five rules: the registry's 1.5.2 zips, its key handed as GEMINI_API_KEY with gemini-api-key, and oauth-personal on attended runs alone", () => {
  const file = new URL("../../../examples/harness-recipe/antigravity.json", import.meta.url).pathname;
  const { recipe } = loadRecipe(file);
  assert.equal(recipe.id, "antigravity");
  assert.deepEqual([recipe.release.registry, recipe.release.version], ["antigravity-acp", "1.5.2"]);
  assert.deepEqual(Object.keys(recipe.release.archives).sort(), Object.keys(ANTIGRAVITY_REGISTRY).sort());
  for (const [platform, want] of Object.entries(ANTIGRAVITY_REGISTRY)) {
    const archive = recipe.release.archives[platform];
    assert.equal(archive.url, want.url, platform);
    assert.equal(archive.sha256, want.sha256, platform);
    assert.equal(archive.format, "zip", platform);
    assert.equal(archive.cmd, "./agy_acp_server.par", platform);
    assert.deepEqual(archive.args, want.args, platform);
  }
  assert.deepEqual(recipe.args, []);
  assert.equal(recipe.model.billing, "plan");
  assert.deepEqual(recipe.keys, ["ANTIGRAVITY_GEMINI_API_KEY"]);
  assert.deepEqual(Object.entries(recipe.keyEnv), [["ANTIGRAVITY_GEMINI_API_KEY", "GEMINI_API_KEY"]]);
  assert.equal(recipe.keyMethod, "gemini-api-key");
  assert.deepEqual(recipe.signIn, { method: "oauth-personal", homeEnv: "GEMINI_HOME", runs: "attended" });
  assert.deepEqual(recipe.declares, { load: true, mcp: "http" });
  assert.deepEqual(recipe.env, {}, "no switch the binary is not known to read");
});
