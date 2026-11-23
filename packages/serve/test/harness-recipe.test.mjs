// The five rules (HARNESS.md#the-five-rules), the owner's install and harness-check.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { follow, scratch, serve, startRun } from "./support.mjs";
import { zipOf } from "./fixtures/zip-of.mjs";

const [{ checkedNoteOf, installRecipe, loadRecipe, parseRecipe, RECIPE_CODES, RecipeRefused, firstSeenOf, signedInNoteOf }, { ARCHIVE_CODES, archivePlatform, ArchiveInstallFailed }] = await Promise.all([
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
  // Not shaped as a key's name, so the cut every child's environment takes (withoutSecrets) would pass it on by name.
  ["rule 1, own keys only: a key not named as a key (FOO_CRED)", RECIPE_CODES.keys, () => recipeOf(undefined, { keys: ["FOO_CRED"] })],
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
  const rules = [RECIPE_CODES.keys, RECIPE_CODES.binary, RECIPE_CODES.paths, RECIPE_CODES.install, RECIPE_CODES.env].map((each) => BROKEN.find(([, code]) => code === each));
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
  const installsItself = BROKEN.find(([, code]) => code === RECIPE_CODES.install);
  const broken = await cli(["install-harness", "--recipe", await recipeFile(t, installsItself[2]()), "--data", data]);
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
  assert.equal(existsSync(join(data, "harnesses", "model-agent.checked")), false, "a failed check notes no pass, so no server runs it");
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

/** The code Google's page shows the person, which they paste into the agent: never a real one. The agent keeps
 *  `signed-<code>` as its sign-in. */
const CODE = "Qz7Wv9Lm2Np4Rs6Tx8Yb3Kc5Hd";
const TOKEN = `signed-${CODE}`;
/** The key saved for this harness alone, and the server's own under the name the agent reads (GEMINI_API_KEY): fakes. */
const SAVED_KEY = "fake-harness-gemini-key";
const SERVER_KEY = "fake-server-gemini-key";
const SIGN_IN_HOME = (data) => join(data, "harnesses", "model-agent.sign-in");
/** The stand-in's sign-in as agy's is (`agy acp --login --gemini-dir DIR`): its own flag, and the flag naming its folder. */
const SIGN_IN = { args: ["--login"], homeArg: "--model-agent-dir" };
/** A plan-billed recipe for the stand-in agent as Antigravity's is: a key saved for it alone and handed as GEMINI_API_KEY
 *  (keyMethod), the route its check, a schedule and a shared server take, and its owner's own sign-in beside it (signIn). */
const signingIn = (origin, { env = {} } = {}) => {
  const { keys: _, ...recipe } = planOn(origin, { env: { MODEL_AGENT_AUTH: "1", MODEL_AGENT_READS: "GEMINI_API_KEY", ...env } });
  return { ...recipe, keys: [{ name: "MODEL_AGENT_GEMINI_API_KEY", env: "GEMINI_API_KEY" }], keyMethod: "model-agent-api-key", signIn: SIGN_IN };
};

/** `agentrun-serve sign-in-harness` on `file` and `data`, the test as the person at its terminal: the agent prints the
 *  address to open there, and once it asks for the code the person types `code` and presses Enter. */
function signIn(file, data, { env = cliEnv(), code = CODE } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, "sign-in-harness", "--recipe", file, "--data", data], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let typed = false;
    child.stdout.on("data", (c) => {
      stdout += c;
      if (!typed && /paste the authorization code/.test(stdout)) {
        typed = true;
        child.stdin.end(`${code}\n`);
      }
    });
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
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
  // Without its key, the check is refused by its code, naming the key, before the vendor hears anything: signed in or
  // not, a check never runs on its owner's sign-in, and the server's own GEMINI_API_KEY is no key of the harness's.
  const keyless = await installed(t, (o) => signingIn(o));
  assert.equal((await signIn(keyless.file, keyless.data)).status, 0);
  const refused = await check(t, keyless.file, keyless.data, cliEnv({ GEMINI_API_KEY: SERVER_KEY }));
  assert.equal(refused.status, 1);
  assert.match(JSON.stringify(refused.report), /ACP_KEY_MISSING[^"]*MODEL_AGENT_GEMINI_API_KEY/);
  assert.doesNotMatch(`${refused.stdout}\n${refused.stderr}`, /runs on its owner's sign-in/);
  assert.equal(keyless.origin.messages().length, 0, "the vendor heard nothing: no key, and never the sign-in");
  assert.equal(existsSync(checkedNoteOf(keyless.data, "model-agent")), false, "no pass is noted");
});

test("a person signs the agent in with `agentrun harness sign-in`: one line first warning that the vendor's terms, the recipe's signIn.terms, may not cover it, then the agent's own --login on their terminal, its stdin theirs with nothing between, its sign-in in its folder alone; harness-check never runs on it", { skip: linux, timeout: 120_000 }, async (t) => {
  const TERMS = "https://vendor.example.invalid/terms";
  const { data, file, origin } = await installed(t, (o) => {
    const recipe = signingIn(o);
    return { ...recipe, signIn: { ...recipe.signIn, terms: TERMS } };
  });
  const signed = await signIn(file, data, { env: cliEnv({ MODEL_AGENT_GEMINI_API_KEY: SAVED_KEY }) });
  assert.equal(signed.status, 0, `${signed.stdout}\n${signed.stderr}`);
  // A warning, never a refusal: the sign-in goes on.
  const warning = `Model Agent's own sign-in: its vendor's terms may not cover use through AgentRun (${TERMS}). Your choice, on your own machine, at your own account's risk.`;
  assert.equal(`${signed.stdout}\n${signed.stderr}`.split("\n").filter((line) => line.includes(warning)).length, 1, `${signed.stdout}\n${signed.stderr}`);
  assert.match(signed.stdout, /https:\/\/accounts\.example\.invalid\/o\/oauth2\/auth\?/, "the agent's own address, on the person's terminal");
  assert.match(signed.stderr, /model-agent: stdin: the caller's/, "the agent reads the person's own terminal: nothing of AgentRun's sits between");
  assert.match(signed.stdout, /Signed in/);
  assert.equal(statSync(SIGN_IN_HOME(data)).mode & 0o777, 0o700);
  assert.equal(readFileSync(join(SIGN_IN_HOME(data), "token.json"), "utf8").trim(), TOKEN, "the agent wrote its sign-in into its own folder");
  assert.equal(origin.messages().length, 0, "a sign-in prompts nothing");

  // Signed in, the check still runs on the recipe's key alone: the vendor hears the key, never the sign-in.
  const after = await check(t, file, data, cliEnv({ MODEL_AGENT_GEMINI_API_KEY: SAVED_KEY }));
  assert.equal(after.status, 0, `${after.stdout}\n${after.stderr}\n${JSON.stringify(after.report?.stage3 ?? after.report?.refused)}`);
  assert.ok(origin.messages().length >= 4);
  assert.ok(origin.messages().every((r) => r.headers["x-api-key"] === SAVED_KEY), "the vendor heard the harness's key, never the sign-in");
  for (const [where, text] of [["the report on disk", after.written], ["stdout", after.stdout], ["stderr", after.stderr]]) assert.equal(text.includes(TOKEN), false, `${where} holds the sign-in`);

  // A recipe that names no terms is warned all the same, naming none.
  const plain = await installed(t, (o) => signingIn(o));
  const bare = await signIn(plain.file, plain.data);
  assert.match(`${bare.stdout}\n${bare.stderr}`, /Model Agent's own sign-in: its vendor's terms may not cover use through AgentRun\. Your choice, on your own machine, at your own account's risk\./);
});

test("`agentrun harness sign-in` says how the agent's own sign-in ended, and refuses a recipe with no signIn and an agent not installed, by their codes", { skip: linux, timeout: 120_000 }, async (t) => {
  // The person gives no code: the agent's --login exits 1, and no sign-in is noted.
  const cancelled = await installed(t, (o) => signingIn(o));
  const none = await signIn(cancelled.file, cancelled.data, { code: "" });
  assert.equal(none.status, 1);
  assert.match(none.stderr, /login cancelled/, "the agent's own words, on the person's terminal");
  assert.match(none.stderr, /HARNESS_SIGN_IN_FAILED: [^\n]*exit status 1/);
  assert.equal(existsSync(join(SIGN_IN_HOME(cancelled.data), "token.json")), false);
  assert.equal(existsSync(signedInNoteOf(cancelled.data, "model-agent")), false);

  const keysOnly = await installed(t, (o) => planOn(o));
  const nothing = await signIn(keysOnly.file, keysOnly.data);
  assert.equal(nothing.status, 1);
  assert.match(nothing.stderr, /HARNESS_NO_SIGN_IN: [^\n]*MODEL_AGENT_API_KEY/);

  const data = join(await scratch(t), "agents");
  const file = await recipeFile(t, signingIn({ url: "http://127.0.0.1:9" }));
  const absent = await signIn(file, data);
  assert.equal(absent.status, 1);
  assert.match(absent.stderr, /HARNESS_NOT_INSTALLED: [^\n]*agentrun harness install --recipe/);
  assert.equal(existsSync(SIGN_IN_HOME(data)), false, "no folder for an agent not installed");

  // An agent that dies as it starts: its exit status and our code.
  const dying = await installed(t, (o) => signingIn(o, { env: { MODEL_AGENT_WANT_ARG: "--never-given" } }));
  const died = await signIn(dying.file, dying.data);
  assert.equal(died.status, 1);
  assert.match(died.stderr, /HARNESS_SIGN_IN_FAILED: [^\n]*exit status 2/);
});

test("a sign-in that runs out of time ends with everything it started: a launcher that never execs the agent leaves no child behind", { skip: linux, timeout: 60_000 }, async (t) => {
  const { signInHarness } = await import("../dist/harness-sign-in.js");
  const origin = await fakeAnthropic({ step: checkStep });
  t.after(() => origin.close());
  const dir = await scratch(t);
  const pidFile = join(dir, "child.pid");
  // The launcher starts a child of its own and waits on it, so killing the launcher alone would leave the child running.
  const built = await release(t, `sleep 300 & echo $! > '${pidFile}'; echo $$ > '${pidFile}.shell'; wait\n`);
  const recipe = signingIn(origin);
  const file = await recipeFile(t, { ...recipe, release: { ...recipe.release, archives: { [PLATFORM]: { ...recipe.release.archives[PLATFORM], sha256: built.archiveSha } } } });
  const data = join(dir, "agents");
  await installRecipe(loadRecipe(file).recipe, file, data, { fetch: servedFetch(built.bytes) });
  const done = await signInHarness({ recipe: file, data, env: cliEnv(), timeoutMs: 1_000 });
  assert.equal(done.ok, false);
  assert.equal(done.code, "HARNESS_SIGN_IN_FAILED");
  assert.match(done.message, /was not signed in within/);
  assert.equal(existsSync(join(data, "harnesses", "model-agent.signed-in")), false, "no note for a sign-in that ran out of time");
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return !/^State:\s+Z/m.test(readFileSync(`/proc/${pid}/status`, "utf8"));
    } catch {
      return false;
    }
  };
  for (const name of ["child.pid", "child.pid.shell"]) {
    const pid = Number(readFileSync(join(dir, name), "utf8"));
    const deadline = Date.now() + 5_000;
    while (alive(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(alive(pid), false, `${name} (${pid}) outlived the sign-in`);
  }
});

test("a recipe's keys and sign-in are checked: keys handed under the name the agent reads, keyMethod with keys, signIn on plan billing alone, the agent's own sign-in flags and the one flag naming its folder", () => {
  const plan = { billing: "plan", maxTurns: 8, maxToolCalls: 8 };
  const KEY = { name: "MODEL_AGENT_GEMINI_API_KEY", env: "GEMINI_API_KEY" };
  const both = (over = {}, signIn = SIGN_IN) => recipeOf(undefined, { model: plan, keys: [KEY], keyMethod: "model-agent-api-key", signIn, ...over });
  const parsed = parseRecipe(JSON.stringify(both()));
  assert.deepEqual(parsed.keys, ["MODEL_AGENT_GEMINI_API_KEY"]);
  assert.deepEqual(parsed.keyEnv, { [KEY.name]: KEY.env });
  assert.equal(parsed.keyMethod, "model-agent-api-key");
  assert.deepEqual(parsed.signIn, SIGN_IN);
  const TERMS = "https://vendor.example.invalid/terms";
  assert.deepEqual(parseRecipe(JSON.stringify(both({}, { ...SIGN_IN, terms: TERMS }))).signIn, { ...SIGN_IN, terms: TERMS }, "the vendor's terms, said at each sign-in");
  const LONGEST = `https://vendor.example.invalid/${"t".repeat(169)}`;
  assert.equal(LONGEST.length, 200);
  assert.equal(parseRecipe(JSON.stringify(both({}, { ...SIGN_IN, terms: LONGEST }))).signIn.terms, LONGEST, "200 characters is the most");

  const cases = [
    // A plan-billed agent runs on its key, the one route a check, a schedule and a shared server take: a sign-in alone is
    // no route of theirs.
    ["a sign-in alone, with no key", recipeOf(undefined, { model: plan, signIn: SIGN_IN }), RECIPE_CODES.invalid],
    ["terms not an https address", both({}, { ...SIGN_IN, terms: "http://vendor.example.invalid/terms" }), RECIPE_CODES.invalid],
    ["terms not an address", both({}, { ...SIGN_IN, terms: "see the vendor's site" }), RECIPE_CODES.invalid],
    ["terms not a string", both({}, { ...SIGN_IN, terms: ["https://vendor.example.invalid/terms"] }), RECIPE_CODES.invalid],
    // Printed on a terminal as given: no control character, no space, nothing past ASCII, at most 200 characters.
    ["terms with an escape sequence", both({}, { ...SIGN_IN, terms: "https://vendor.example.invalid/\u001b[2Jterms" }), RECIPE_CODES.invalid],
    ["terms with a space", both({}, { ...SIGN_IN, terms: "https://vendor.example.invalid/ terms" }), RECIPE_CODES.invalid],
    ["terms past ASCII", both({}, { ...SIGN_IN, terms: "https://vendor.example.invalid/térms" }), RECIPE_CODES.invalid],
    ["terms past 200 characters", both({}, { ...SIGN_IN, terms: `https://vendor.example.invalid/${"t".repeat(170)}` }), RECIPE_CODES.invalid],
    ["a label with a control character", both({ label: "Model\u001b[31m Agent" }, SIGN_IN), RECIPE_CODES.invalid],
    ["proxy billing signs in with the server's key", recipeOf(undefined, { signIn: SIGN_IN }), RECIPE_CODES.invalid],
    // The shape before the agent's own --login: a method sent with ACP authenticate, a folder by variable, attended runs.
    ["the old method field", both({}, { ...SIGN_IN, method: "model-agent-login" }), RECIPE_CODES.invalid],
    ["the old homeEnv field", both({}, { ...SIGN_IN, homeEnv: "MODEL_AGENT_HOME" }), RECIPE_CODES.invalid],
    ["the old runs field", both({}, { ...SIGN_IN, runs: "attended" }), RECIPE_CODES.invalid],
    ["a field signIn has not", both({}, { ...SIGN_IN, files: [".gemini/oauth_creds.json"] }), RECIPE_CODES.invalid],
    ["no sign-in args", both({}, { ...SIGN_IN, args: [] }), RECIPE_CODES.invalid],
    ["sign-in args not strings", both({}, { ...SIGN_IN, args: [1] }), RECIPE_CODES.invalid],
    ["a sign-in arg that reads the host's environment", both({}, { ...SIGN_IN, args: ["--login", "--home=$HOME"] }), RECIPE_CODES.env],
    ["homeArg a variable, not a flag", both({}, { ...SIGN_IN, homeArg: "MODEL_AGENT_HOME" }), RECIPE_CODES.invalid],
    ["homeArg with its value", both({}, { ...SIGN_IN, homeArg: "--model-agent-dir=/elsewhere" }), RECIPE_CODES.invalid],
    ["homeArg a bare --", both({}, { ...SIGN_IN, homeArg: "--" }), RECIPE_CODES.invalid],
    ["homeArg among the sign-in args", both({}, { args: ["--login", "--model-agent-dir"], homeArg: "--model-agent-dir" }), RECIPE_CODES.invalid],
    ["homeArg among the recipe's args", both({ args: ["--model-agent-dir", "/elsewhere"] }), RECIPE_CODES.invalid],
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
  const neither = refusalOf(recipeOf(undefined, { model: plan, signIn: SIGN_IN }));
  assert.equal(neither.code, RECIPE_CODES.invalid);
  assert.match(neither.message, /plan-billed agent runs on its vendor's key[^"]*name the key in keys/);
});

test("a key's handed name and env never name a variable that changes what the agent's process loads or runs", () => {
  const plan = { billing: "plan", maxTurns: 8, maxToolCalls: 8 };
  const KEY = { name: "MODEL_AGENT_GEMINI_API_KEY", env: "GEMINI_API_KEY" };
  const LAUNCHERS = ["PATH", "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "NODE_OPTIONS", "NODE_PATH", "PYTHONPATH", "PYTHONSTARTUP", "BASH_ENV", "ENV", "GIT_CONFIG_GLOBAL", "GIT_SSH_COMMAND"];
  for (const name of LAUNCHERS) {
    const handed = refusalOf(recipeOf(undefined, { model: plan, keys: [{ name: "MODEL_AGENT_GEMINI_API_KEY", env: name }] }));
    assert.ok(handed.codes.includes(RECIPE_CODES.env), `a key handed as ${name}: ${handed.message}`);
    assert.match(handed.message, /loads or runs|the adapter, the proxy or the server sets/);
    const env = refusalOf(recipeOf(undefined, { model: plan, keys: [KEY], env: { [name]: "x" } }));
    assert.ok(env.codes.includes(RECIPE_CODES.env), `env setting ${name}: ${env.message}`);
  }
});

test("an archive is pinned by exactly one digest, its sha256 or its sha512 (as Google's agy CLI manifest lists it), and release.registry is optional", () => {
  const SHA512 = "a".repeat(128);
  const pinned = (archive) => {
    const r = recipeOf();
    r.release.archives[PLATFORM] = { ...r.release.archives[PLATFORM], ...archive };
    return r;
  };
  const { sha256: _, ...unpinned } = recipeOf().release.archives[PLATFORM];
  const by512 = recipeOf();
  by512.release.archives[PLATFORM] = { ...unpinned, sha512: SHA512 };
  assert.equal(parseRecipe(JSON.stringify(by512)).release.archives[PLATFORM].sha512, SHA512);
  const noRegistry = recipeOf();
  delete noRegistry.release.registry;
  assert.equal(parseRecipe(JSON.stringify(noRegistry)).release.registry, undefined, "a release outside the ACP registry loads");

  const neither = recipeOf();
  neither.release.archives[PLATFORM] = unpinned;
  for (const [why, recipe] of [["both digests", pinned({ sha512: SHA512 })], ["neither", neither], ["a sha512 not 128 hex digits", (() => {
    const r = recipeOf();
    r.release.archives[PLATFORM] = { ...unpinned, sha512: "A".repeat(128) };
    return r;
  })()], ["a registry id not one", (() => {
    const r = recipeOf();
    r.release.registry = "Not An Id";
    return r;
  })()]]) {
    const refused = refusalOf(recipe);
    assert.ok(refused.codes.includes(RECIPE_CODES.binary) || refused.codes.includes(RECIPE_CODES.invalid), `${why}: ${refused.message}`);
  }
  assert.equal(refusalOf(pinned({ sha512: SHA512 })).code, RECIPE_CODES.binary);
});

// The Antigravity example (examples/harness-recipe/antigravity.json): Google's agy CLI 1.5.14 as its release manifests
// list it (https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/<target>.json), each archive
// pinned by the manifest's sha512, as T3 Code installs it. It runs on its owner's own sign-in, or a key saved for it alone.
const AGY = "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.14-5302690847260672";
const ANTIGRAVITY_CLI = {
  "linux-x86_64": { url: `${AGY}/linux-x64/cli_linux_x64.tar.gz`, sha512: "83311d3f354567612dc16c1ae2ea9b503d6f6833aa4e138d39aa229da3f3bb99b0e4d7cca0bce4796b0060d6a51d8113eb7449ed5dc0e7900bf217107ea5bff9" },
  "linux-aarch64": { url: `${AGY}/linux-arm/cli_linux_arm64.tar.gz`, sha512: "c9b29bba475f63a1a80161ae93ba72b221c7a586d9851e4d0061546704bab66d6b2760b25d716d191724fc7564f3246456ee151e28aa37af48dbcd72bdc6c463" },
  "darwin-x86_64": { url: `${AGY}/darwin-x64/cli_mac_x64.tar.gz`, sha512: "1b6a1fc6dbe46ba6d9d0405d1b6095189f35ebfc4c3c33ceb1fd1b6d0c9fd702b52ac10b64b8b52aed0d8d71ae02c5df3cffd5e3e3d37549c2daffcce2a853c7" },
  "darwin-aarch64": { url: `${AGY}/darwin-arm/cli_mac_arm64.tar.gz`, sha512: "26830fd46bfb9200d073cf3e71bf94b707552557b4380ec01afd6e99f3a2b030e65422dab1867f77318078692defc859a7547d17ec4b0b1e9369f13c9c3caea6" },
};

test("the Antigravity example recipe loads under the five rules: agy CLI 1.5.14 pinned by its manifests' sha512, `agy acp`, the agent's own --login with --gemini-dir, and a key handed as GEMINI_API_KEY with gemini-api-key", () => {
  const file = new URL("../../../examples/harness-recipe/antigravity.json", import.meta.url).pathname;
  const { recipe } = loadRecipe(file);
  assert.equal(recipe.id, "antigravity");
  assert.equal(recipe.release.registry, undefined, "the agy CLI is not in the ACP registry");
  assert.equal(recipe.release.version, "1.5.14");
  assert.deepEqual(Object.keys(recipe.release.archives).sort(), Object.keys(ANTIGRAVITY_CLI).sort());
  for (const [platform, want] of Object.entries(ANTIGRAVITY_CLI)) {
    const archive = recipe.release.archives[platform];
    assert.equal(archive.url, want.url, platform);
    assert.equal(archive.sha512, want.sha512, platform);
    assert.equal(archive.sha256, undefined, platform);
    assert.equal(archive.format, "tar.gz", platform);
    assert.equal(archive.cmd, "./antigravity", platform);
    assert.equal(archive.args, undefined, platform);
  }
  assert.deepEqual(recipe.args, ["acp", "--disable-telemetry"]);
  assert.deepEqual(recipe.env, { AGY_CLI_DISABLE_AUTO_UPDATE: "1", AGY_ACP_FORCE_FILE_STORAGE: "1" });
  assert.deepEqual(recipe.signIn, { args: ["--login"], homeArg: "--gemini-dir", terms: "https://antigravity.google/terms" });
  assert.equal(recipe.model.billing, "plan");
  assert.deepEqual(recipe.keys, ["ANTIGRAVITY_GEMINI_API_KEY"]);
  assert.deepEqual(Object.entries(recipe.keyEnv), [["ANTIGRAVITY_GEMINI_API_KEY", "GEMINI_API_KEY"]]);
  assert.equal(recipe.keyMethod, "gemini-api-key");
  assert.deepEqual(recipe.declares, { load: true, mcp: "http" });
});

test("AgentRun never reads, refreshes or sends an agent's sign-in, and has no usage reader: no harness source or ACP adapter source names a credential file or Google's account and quota APIs", () => {
  const sources = (dir, pattern) => spawnSync("git", ["ls-files", pattern], { cwd: dir, encoding: "utf8" }).stdout.split("\n").filter(Boolean).map((name) => join(dir, name));
  const serve = new URL("../src/", import.meta.url).pathname;
  const files = [...sources(serve, "harness*.ts"), join(serve, "acp-package.ts"), ...sources(new URL("../../run-adapters-acp/src/", import.meta.url).pathname, "*.ts")];
  assert.ok(files.length > 20, "the sources are listed");
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const banned of ["oauth2.googleapis.com", "cloudcode-pa", "retrieveUserQuota", "loadCodeAssist", "refresh_token", "oauth_creds", "acp_token", "token.json"]) {
      assert.equal(text.includes(banned), false, `${file} names ${banned}`);
    }
  }
  // The sign-in folder's path is taken in two places: the sign-in that makes it for the agent, and the route that hands
  // its path to the agent (harness-check's and a server's runs alike). Neither opens a file at all.
  const naming = files.filter((file) => readFileSync(file, "utf8").includes("signInHomeOf(")).map((file) => file.slice(serve.length));
  assert.deepEqual(naming.sort(), ["harness-recipe-entry.ts", "harness-sign-in.ts"]);
  for (const name of naming) assert.doesNotMatch(readFileSync(join(serve, name), "utf8"), /readdir|readFile|createReadStream|opendir/, `${name} reads nothing`);
  assert.doesNotMatch(readFileSync(join(serve, "harness-check.ts"), "utf8"), /(readdir|readFile|createReadStream|opendir|stat)\w*\([^)]*signInHome/, "the check hands the folder's path on and reads nothing in it");
});

test("the install's pins are found and checked in one place (harness-recipe.ts installedPins, pinsHold): a check, a sign-in and a server's entry call it, and none reads a pin or digests a file itself", () => {
  const serve = new URL("../src/", import.meta.url).pathname;
  for (const name of ["harness-check.ts", "harness-sign-in.ts", "harness-recipe-entry.ts"]) {
    const text = readFileSync(join(serve, name), "utf8");
    assert.match(text, /\binstalledPins\(/, `${name} finds the install with installedPins`);
    assert.match(text, /\bpinsHold\(/, `${name} checks it with pinsHold`);
    assert.doesNotMatch(text, /\b(pinnedDigest|pinnedTree|digestOf|treeDigest)\(/, `${name} keeps no copy of the pin check`);
    assert.doesNotMatch(text, /has no release for/, `${name} keeps no copy of the platform refusal`);
  }
});

/** The note a passing check writes (harness-recipe.ts writeChecked), written here for the install as it now is. */
async function noteChecked(data, file) {
  const { installedPins, writeChecked } = await import("../dist/harness-recipe.js");
  const { recipe, sha256: recipeSha } = loadRecipe(file);
  const pins = installedPins(data, recipe, PLATFORM, "agentrun harness install");
  assert.ok(!("code" in pins), JSON.stringify(pins));
  writeChecked(data, recipe.id, { recipe: recipeSha, binary: pins.pin.sha256, tree: pins.tree.sha256, platform: PLATFORM });
}

test("a server takes a recipe it names only once its install is checked: hidden until then, by the code and the command that fix it, and never on the recipe's keys", { timeout: 60_000 }, async (t) => {
  const [{ harnessIds, harnessOf, harnessRecipesEnv, harnessTable, tableIds }, { checkedNoteOf, signedInNoteOf }] = await Promise.all([import("../dist/harness-table.js"), import("../dist/harness-recipe.js")]);
  // Named but not installed: in the table, so a run naming it is refused in words, and listed nowhere.
  const bare = join(await scratch(t), "agents");
  const bareFile = await recipeFile(t, recipeOf());
  const bareEnv = harnessRecipesEnv([bareFile], bare);
  assert.ok(tableIds(bareEnv).includes("model-agent"));
  assert.equal(harnessIds(bareEnv).includes("model-agent"), false);
  assert.match(harnessOf(bareEnv, "model-agent").hidden(bareEnv), /^HARNESS_NOT_INSTALLED: .*Install it with: agentrun harness install --recipe/);

  // Installed, never checked: hidden, and a run is refused, naming the check.
  const proxy = await installed(t, recipeOf());
  const env = harnessRecipesEnv([proxy.file], proxy.data);
  const entry = harnessOf(env, "model-agent");
  assert.match(entry.hidden(env), /^HARNESS_NOT_CHECKED: .*Check it with: agentrun harness-check --recipe/);
  assert.match((await entry.refusal(env, undefined, { atStart: false }))?.reason ?? "", /HARNESS_NOT_CHECKED/);
  // Checked for this recipe, binary and tree: listed, through this server's model proxy.
  await noteChecked(proxy.data, proxy.file);
  assert.equal(statSync(checkedNoteOf(proxy.data, "model-agent")).mode & 0o777, 0o600);
  assert.equal(entry.hidden(env), undefined);
  assert.ok(harnessIds(env).includes("model-agent"));
  // A pass noted for another binary is no pass for this one.
  const note = JSON.parse(readFileSync(checkedNoteOf(proxy.data, "model-agent"), "utf8"));
  writeFileSync(checkedNoteOf(proxy.data, "model-agent"), JSON.stringify({ ...note, binary: "0".repeat(64) }));
  assert.match(entry.hidden(env), /^HARNESS_NOT_CHECKED: .*changed since the last check that passed/);

  // Plan-billed: on keys saved for its harness alone, which no server saves yet, whatever key the server's shell holds.
  const keyed = await installed(t, (o) => planOn(o));
  await noteChecked(keyed.data, keyed.file);
  const keyedEnv = { ...harnessRecipesEnv([keyed.file], keyed.data), MODEL_AGENT_API_KEY: "fake-test-key" };
  assert.match(harnessOf(keyedEnv, "model-agent").hidden(keyedEnv), /^HARNESS_KEYS_NOT_SAVED: .*MODEL_AGENT_API_KEY.*saved for this harness alone/);

  // With a sign-in too: still its keys, signed in or not, on a server its owner did not start with --harness-sign-in
  // (a shared one, a deployed one, a runner apart reading the owner's setting).
  const signing = await installed(t, (o) => signingIn(o));
  await noteChecked(signing.data, signing.file);
  writeFileSync(signedInNoteOf(signing.data, "model-agent"), "{}\n");
  const sharedEnv = harnessRecipesEnv([signing.file], signing.data);
  assert.match(harnessOf(sharedEnv, "model-agent").hidden(sharedEnv), /^HARNESS_KEYS_NOT_SAVED: .*--harness-sign-in runs it on your own sign-in/);
  // On its owner's own machine (--harness-sign-in): hidden until its owner signs the agent in, naming the command; then listed.
  const ownEnv = harnessRecipesEnv([signing.file], signing.data, { signIn: true });
  assert.equal(harnessOf(ownEnv, "model-agent").hidden(ownEnv), undefined);
  rmSync(signedInNoteOf(signing.data, "model-agent"));
  assert.match(harnessOf(ownEnv, "model-agent").hidden(ownEnv), /^HARNESS_NOT_SIGNED_IN: .*--harness-sign-in.*sign it in with: agentrun harness sign-in --recipe/);
  // A proxy-billed recipe is the same on either: the model proxy.
  await noteChecked(proxy.data, proxy.file);
  assert.equal(harnessOf(harnessRecipesEnv([proxy.file], proxy.data, { signIn: true }), "model-agent").hidden(harnessRecipesEnv([proxy.file], proxy.data, { signIn: true })), undefined);

  // At the start: a recipe the loader refuses, or two recipes of one id, refuse it in words.
  const foo = await recipeFile(t, recipeOf(undefined, { keys: ["FOO_CRED"] }));
  assert.throws(() => harnessTable(harnessRecipesEnv([foo], bare)), /FOO_CRED is not named as a key/);
  assert.throws(() => harnessTable(harnessRecipesEnv([bareFile, proxy.file], bare)), /names model-agent, which a harness module or another recipe already adds/);
});

test("a runner takes --harness-recipe as a server does, and the recipes a start names reach no run's environment, nor load from an operator's shell", async () => {
  const [{ HARNESS_RECIPES_ENV, HARNESS_RECIPES_SETTING, harnessRecipesOf, harnessTable, tableIds }, { withoutFaux }, main] = await Promise.all([import("../dist/harness-table.js"), import("../dist/model.js"), import("../dist/runner/main.js")]);
  assert.deepEqual(main.runnerArgs(["--data", "/data/agents", "--harness-recipe", "/data/a.json", "--harness-recipe=/data/b.json"]).harnessRecipes, ["/data/a.json", "/data/b.json"]);
  assert.equal("harnessRecipes" in main.runnerArgs(["--data", "/data/agents"]), false);
  // The flag over the setting; the setting comma-separated where no flag is given.
  assert.deepEqual(harnessRecipesOf(["/data/a.json"], { [HARNESS_RECIPES_SETTING]: "/data/c.json" }), ["/data/a.json"]);
  assert.deepEqual(harnessRecipesOf([], { [HARNESS_RECIPES_SETTING]: "/data/c.json, /data/d.json" }), ["/data/c.json", "/data/d.json"]);
  // What a start hands its table (AGENTRUN_HARNESS_RECIPES) is the server's own: cut from every run's environment.
  const named = { [HARNESS_RECIPES_ENV]: JSON.stringify({ data: "/data/agents", files: ["/data/a.json"] }), KEEP: "1" };
  assert.deepEqual(Object.keys(withoutFaux(named)), ["KEEP"]);
  assert.deepEqual(Object.keys(main.besideRunEnv(named, {})), ["KEEP"]);
  // And a malformed one is refused in words, never half read.
  assert.throws(() => tableIds({ [HARNESS_RECIPES_ENV]: "{\"files\": [1]}" }), new RegExp(HARNESS_RECIPES_ENV));
  assert.throws(() => harnessTable({ [HARNESS_RECIPES_ENV]: "not json" }), new RegExp(HARNESS_RECIPES_ENV));
});

test("where each run is a user of its own, a run on a recipe's harness is refused at its claim in words naming AGENTRUN_RUN_USER=same; where runs are the server's user it is a process of its own", async (t) => {
  const [host, { harnessRecipesEnv }] = await Promise.all([import("../dist/runner/run-child-host.js"), import("../dist/harness-table.js")]);
  const data = join(await scratch(t), "agents");
  const env = harnessRecipesEnv([await recipeFile(t, recipeOf())], data);
  const deps = { data, env, sealKey: Buffer.alloc(32), store: { settings: { get: async () => null } } };
  const launch = { input: {}, place: { mode: "runner" } };
  await assert.rejects(host.staysInRunner(deps, "model-agent", launch, "run-own", { kind: "uid", helper: "/nonexistent/agentrun-runas", first: 0, slots: 1 }), (error) => {
    assert.equal(error.name, "ClaimRefused", error.stack);
    assert.equal(error.message, host.RECIPE_NEEDS_SERVER_USER);
    assert.match(error.message, /AGENTRUN_RUN_USER=same/);
    return true;
  });
  assert.equal(await host.staysInRunner(deps, "model-agent", launch, "run-own", { kind: "process", why: "AGENTRUN_RUN_USER=same" }), false);
  // A built-in harness on the same table is never refused by it.
  assert.equal(await host.staysInRunner(deps, "pi", launch, "run-own", { kind: "uid", helper: "/nonexistent/agentrun-runas", first: 0, slots: 1 }), false);
});

test("a run with no record of who started it (a schedule's, a trigger's, a learned workflow's audit shadow or replay, a start no owner's session or token made) on a plan-billed recipe is refused at its claim on every path, even on its owner's own machine: it runs on keys saved for its harness, never the owner's sign-in", async (t) => {
  const [host, loops, { harnessRecipesEnv }] = await Promise.all([import("../dist/runner/run-child-host.js"), import("../dist/runner/harness-loops.js"), import("../dist/harness-table.js")]);
  const data = join(await scratch(t), "agents");
  const own = harnessRecipesEnv([await recipeFile(t, signingIn({ url: "http://127.0.0.1:9" }))], data, { signIn: true });
  const deps = { data, env: own, sealKey: Buffer.alloc(32), store: { settings: { get: async () => null } } };
  // A person's run: the owner's request made it (POST /agents/{id}/runs under their password session or the server's
  // token), which its launch says (startedBy). Every run the runner or a trigger makes says nothing.
  const unmarked = { input: {}, place: { mode: "runner" } };
  const person = { ...unmarked, startedBy: "token" };
  const scheduled = { ...unmarked, trigger: { triggerId: "trg_nightly", firingId: "fir_1" } };
  // The runner's own audit of a person's run (runner/audit.ts): its shadow copies the harness, sets `audit`, no trigger.
  const shadow = { ...unmarked, audit: { of: "run-1", workflow: "w", digest: "d" } };
  const replay = { ...unmarked, replay: { of: "run-1", workflow: "w", digest: "d" } };
  const sameUser = { kind: "process", why: "AGENTRUN_RUN_USER=same" };
  const refusedFor = (error) => {
    assert.equal(error.name, "ClaimRefused", error.stack);
    assert.equal(error.message, host.RECIPE_SIGN_IN_PERSON_ONLY);
    assert.match(error.message, /^This run carries no record of who started it .*on its owner's own sign-in only for a run its owner started/);
    return true;
  };
  for (const [launch, id] of [[scheduled, "run-nightly"], [shadow, "run-audit"], [replay, "run-replay"], [unmarked, "run-unmarked"]]) {
    await assert.rejects(host.staysInRunner(deps, "model-agent", launch, id, sameUser), refusedFor, id);
    // The runner's own dispatch (no process of its own per run) refuses it too, before any loop is made.
    await assert.rejects(loops.resolveRunnerLoop(deps)("model-agent", launch, id), refusedFor, id);
    assert.throws(() => loops.refuseRecipeRunNoPerson(own, "model-agent", launch), refusedFor, id);
  }
  // A person's run is not, under the owner's session or the token, nor a scheduled run on a proxy-billed recipe (the
  // model proxy) or a built-in harness.
  assert.equal(await host.staysInRunner(deps, "model-agent", person, "run-own", sameUser), false);
  loops.refuseRecipeRunNoPerson(own, "model-agent", { ...unmarked, startedBy: "owner_session" });
  const proxied = harnessRecipesEnv([await recipeFile(t, recipeOf())], data, { signIn: true });
  loops.refuseRecipeRunNoPerson(proxied, "model-agent", scheduled);
  loops.refuseRecipeRunNoPerson(own, "pi", scheduled);
});

test("only the owner's request marks a run as theirs: a start under the token or the owner's password session says who in its launch, a trigger's run and the runner's own say nothing, and a stored mark reads back", async () => {
  const { launchBody, readLaunchBody } = await import("../dist/run-launch.js");
  const base = { input: {}, title: "t", place: { mode: "runner" } };
  for (const by of ["token", "owner_session"]) assert.equal(readLaunchBody(launchBody({ ...base, startedBy: by })).startedBy, by);
  assert.equal(readLaunchBody(launchBody(base)).startedBy, undefined);
  assert.equal(readLaunchBody({ ...launchBody(base), started_by: "someone" }).startedBy, undefined, "only the two marks read back");
});

test("--harness-sign-in starts only one owner's own server on their own machine: loopback with no public address, the SQLite store in its data directory, its runs beside it as its own user, an owner and one token; anything else refuses the start in words", async (t) => {
  const { harnessSignInRefusal, HARNESS_SIGN_IN_NOT_LOCAL, startServe } = await import("../dist/server.js");
  const { runsAsOwnUser } = await import("../dist/runner/run-child-host.js");
  const data = join(await scratch(t), "agents");
  // The owner's account (accounts on, the CLI's default): the one person whose session or token starts a run on the sign-in.
  const owned = { accounts: true };
  assert.equal(harnessSignInRefusal(owned, data, true), undefined, "the default start: 127.0.0.1, SQLite, a runner beside it, its owner's account");
  assert.equal(harnessSignInRefusal({ ...owned, host: "localhost" }, data, true), undefined);
  assert.equal(harnessSignInRefusal({ ...owned, token: "x" }, data, true), undefined, "AGENTRUN_TOKEN alone is one token");
  assert.equal(harnessSignInRefusal({ ...owned, tokens: [{ id: "a", token: "x" }] }, data, true), undefined, "a one-entry AGENTRUN_TOKENS is one token");
  const cases = [
    [{ host: "0.0.0.0" }, true, /listens on 0\.0\.0\.0, past loopback/],
    [{ publicUrl: "https://agents.example.invalid" }, true, /has a public address/],
    [{ runnerApart: true }, true, /--no-runner/],
    [{}, false, /runs each run as a user of its own/],
    [{ apiOnly: true }, true, /no owner \(the API-only profile\)/],
    [{ tokens: [{ id: "a", token: "x" }, { id: "b", token: "y" }] }, true, /takes 2 API tokens/],
    // AGENTRUN_TOKEN beside a one-entry AGENTRUN_TOKENS: the server takes both (acceptedTokens), so two people could start runs.
    [{ token: "x", tokens: [{ id: "a", token: "y" }] }, true, /takes 2 API tokens/],
    // Accounts off (AGENTRUN_ACCOUNTS=0): no owner's account, so whoever opens its console link starts runs.
    [{ accounts: false }, true, /has no owner's account \(AGENTRUN_ACCOUNTS=0\)/],
  ];
  for (const [over, ownUser, words] of cases) {
    const options = { ...owned, ...over };
    const refused = harnessSignInRefusal(options, data, ownUser);
    assert.match(refused ?? "", new RegExp(`^${HARNESS_SIGN_IN_NOT_LOCAL}: `), JSON.stringify(options));
    assert.match(refused, words);
    assert.match(refused, /Start it without --harness-sign-in/);
  }
  // A store in Postgres is shared by servers elsewhere: refused, by the variable that names it.
  const before = process.env.AGENTRUN_STORE_URL;
  process.env.AGENTRUN_STORE_URL = "postgres://agentrun.example.invalid/agentrun";
  try {
    assert.match(harnessSignInRefusal({}, data, true) ?? "", /keeps its store in Postgres \(AGENTRUN_STORE_URL\)/);
  } finally {
    if (before === undefined) delete process.env.AGENTRUN_STORE_URL;
    else process.env.AGENTRUN_STORE_URL = before;
  }
  // Runs as the server's own user: AGENTRUN_RUN_USER=same, or no helper to switch with and slot not asked for.
  assert.equal(runsAsOwnUser({ AGENTRUN_RUN_USER: "same" }, "/nonexistent/agentrun-runas"), true);
  assert.equal(runsAsOwnUser({}, "/nonexistent/agentrun-runas"), true);
  assert.equal(runsAsOwnUser({ AGENTRUN_RUN_USER: "slot" }, "/nonexistent/agentrun-runas"), false);
  assert.equal(runsAsOwnUser({}, process.execPath), false, "a helper is there: each run a user of its own");
  // And the start itself refuses, before it serves anything.
  await assert.rejects(startServe({ data, port: 0, host: "0.0.0.0", harnessSignIn: true }), new RegExp(`${HARNESS_SIGN_IN_NOT_LOCAL}: .*past loopback`));
});

test("a server started with --harness-recipe says so in the store, so a runner apart without the recipe fails its check", async (t) => {
  const file = await recipeFile(t, recipeOf());
  const { store } = await serve(t, { harnessRecipes: [file], runner: false });
  const { serverRunEnv } = await import("../dist/runner/runner-check.js");
  assert.ok((await serverRunEnv(store)).includes("AGENTRUN_SERVE_HARNESS_RECIPES"), "the recipe setting is one a runner needs");
});

test("a server its owner starts with --harness-sign-in on their own machine runs a recipe on the owner's sign-in: checked on its key first, then each person's run's agent handed its folder alone, and the vendor hears the sign-in from the agent; started without it, the run is refused for its keys", { skip: linux, timeout: 180_000 }, async (t) => {
  const { data, file, origin } = await installed(t, (o) => signingIn(o));
  assert.equal((await signIn(file, data)).status, 0);
  const checked = await check(t, file, data, cliEnv({ MODEL_AGENT_GEMINI_API_KEY: SAVED_KEY }));
  assert.equal(checked.status, 0, `${checked.stdout}\n${checked.stderr}`);
  assert.ok(existsSync(join(data, "harnesses", "model-agent.checked")), "the pass is noted");

  // Without --harness-sign-in (a shared or deployed server): never the sign-in, signed in and checked as it is, so the
  // run is refused for its keys and the vendor hears nothing.
  const sharedCopy = await installed(t, (o) => signingIn(o));
  assert.equal((await signIn(sharedCopy.file, sharedCopy.data)).status, 0);
  await noteChecked(sharedCopy.data, sharedCopy.file);
  const shared = await serve(t, { data: sharedCopy.data, harnessRecipes: [sharedCopy.file] });
  const keysFirst = await startRun(shared.api, "shared", "Reply with the word ready.", { harness: "model-agent", model: "model-agent/default" }).catch((error) => ({ error }));
  if (keysFirst.run_id) {
    const { last } = await follow(shared.api, keysFirst.run_id, ["completed", "failed"], { deadlineMs: 60_000 });
    assert.equal(last.status, "failed", JSON.stringify(last));
    assert.match(JSON.stringify(last), /HARNESS_KEYS_NOT_SAVED/);
  } else assert.match(String(keysFirst.error?.message), /HARNESS_KEYS_NOT_SAVED/);
  assert.equal(sharedCopy.origin.messages().length, 0, "the vendor heard nothing from a shared server");
  const before = origin.messages().length;

  // Its owner's account on (the CLI's default; accounts off is refused at the start), and the run started with its token.
  const { api } = await serve(t, { data, harnessRecipes: [file], harnessSignIn: true, accounts: true });
  const offer = (await api("GET", "/capabilities")).body.harnesses.find((each) => each.id === "model-agent");
  assert.deepEqual([offer?.label, offer?.available, offer?.promises?.billing], ["Model Agent", true, "plan"], JSON.stringify(offer));
  const started = await startRun(api, "on-sign-in", "Reply with the word ready.", { harness: "model-agent", model: "model-agent/default" });
  const { last } = await follow(api, started.run_id, ["completed", "failed"], { deadlineMs: 120_000 });
  assert.equal(last.status, "completed", JSON.stringify(last));
  const heard = origin.messages().slice(before);
  assert.ok(heard.length >= 1, "the run's turn reached the vendor");
  assert.ok(heard.every((r) => r.headers["x-api-key"] === TOKEN), "on the owner's sign-in, read by the agent from its own folder");
  // The one line the terminal's sign-in says first is on the run too, for a run started from the console or the API: its
  // read's sign_in_warning, which the run's page shows. A run on keys (the shared server's) has none.
  const { signInWarning } = await import("../dist/harness-sign-in.js");
  const read = (await api("GET", `/runs/${started.run_id}`)).body;
  assert.equal(read.sign_in_warning, signInWarning("Model Agent", undefined), JSON.stringify(read));
  assert.match(read.sign_in_warning, /vendor's terms may not cover use through AgentRun/);
  if (keysFirst.run_id) assert.equal((await shared.api("GET", `/runs/${keysFirst.run_id}`)).body.sign_in_warning, undefined);
  // A trigger never sends a turn into a person's run on the sign-in: a schedule's or a webhook's message_run to it is refused.
  const poke = await api("POST", "/triggers", { name: "poke", source: { kind: "webhook" }, target: { kind: "message_run", run_id: started.run_id, input: { content: "A new event came in." } } });
  assert.equal(poke.status, 422, JSON.stringify(poke.body));
  assert.match(JSON.stringify(poke.body), /owner's own sign-in only for what a person starts/);

  // model.hosts holds on a run as on the check: an agent whose vendor is not among them never reaches it.
  const elsewhere = await installed(t, (o) => {
    const recipe = signingIn(o);
    return { ...recipe, model: { ...recipe.model, hosts: ["vendor.example.invalid"] } };
  });
  assert.equal((await signIn(elsewhere.file, elsewhere.data)).status, 0);
  await noteChecked(elsewhere.data, elsewhere.file);
  const second = await serve(t, { data: elsewhere.data, harnessRecipes: [elsewhere.file], harnessSignIn: true, accounts: true });
  const refused = await startRun(second.api, "elsewhere", "Reply with the word ready.", { harness: "model-agent", model: "model-agent/default" });
  const ended = await follow(second.api, refused.run_id, ["completed", "failed"], { deadlineMs: 120_000 });
  assert.equal(ended.last.status, "failed", JSON.stringify(ended.last));
  assert.equal(elsewhere.origin.messages().length, 0, "the vendor heard nothing: its host is not one the recipe names");
});

test("an agent on its owner's sign-in that prints its token as it dies leaves it nowhere the server keeps or serves: not its timeline, its run's read or error, its log, nor the store", { skip: linux, timeout: 180_000 }, async (t) => {
  // The vendor CLI that echoes its credential on an auth failure (leak-key), on the server route: no cut knows the
  // sign-in's token, so the route drops what the agent prints (stderr "none") and the run fails in words of its own.
  const leaking = await installed(t, (o) => signingIn(o, { env: { MODEL_AGENT_MODE: "leak-key" } }));
  assert.equal((await signIn(leaking.file, leaking.data)).status, 0);
  await noteChecked(leaking.data, leaking.file);
  const logs = [];
  const server = await serve(t, { data: leaking.data, harnessRecipes: [leaking.file], harnessSignIn: true, accounts: true, log: (line) => logs.push(line) });
  const run = await startRun(server.api, "leaks", "Reply with the word ready.", { harness: "model-agent", model: "model-agent/default" });
  const followed = await follow(server.api, run.run_id, ["completed", "failed"], { deadlineMs: 120_000 });
  assert.equal(followed.last.status, "failed", JSON.stringify(followed.last));
  const read = (await server.api("GET", `/runs/${run.run_id}`)).body;
  assert.equal(read.status, "failed", JSON.stringify(read));
  // The store and its write-ahead log, where a write not yet checkpointed sits.
  const bytes = Buffer.concat(["store.sqlite", "store.sqlite-wal"].map((name) => join(leaking.data, name)).filter((file) => existsSync(file)).map((file) => readFileSync(file)));
  assert.ok(bytes.length > 0, "the store was read");
  const where = [
    ["every timeline page", JSON.stringify(followed.pages)],
    ["the run's read", JSON.stringify(read)],
    ["its error", JSON.stringify(read.error)],
    ["the server's log", logs.join("\n")],
    ["the store's bytes", bytes.toString("latin1")],
  ];
  for (const [place, text] of where) assert.ok(!text.includes(TOKEN), `the sign-in's token is not in ${place}`);
  // Nor any file in the data directory but the sign-in's own folder: the run's folder, its recordings, its logs.
  const home = SIGN_IN_HOME(leaking.data);
  const files = readdirSync(leaking.data, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((file) => file !== home && !file.startsWith(`${home}/`));
  assert.ok(files.some((file) => file.includes(`${run.run_id}`)), `the run's own files were scanned: ${files.length} files`);
  const holding = files.filter((file) => readFileSync(file).toString("latin1").includes(TOKEN));
  assert.deepEqual(holding.map((file) => file.slice(leaking.data.length)), [], "the sign-in's token is in no file of the data directory but its own folder");
});
