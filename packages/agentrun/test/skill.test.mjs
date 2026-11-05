// The agentrun-cli skill: each shell block of its recipes, run in order against a server started with a faux model on
// loopback, with `agentrun` this repository's bin on the PATH, exits as its last line says; --check fails when the
// skill names a command the CLI does not have; `skill install` writes the folder; `tool-keys set` and `login` take their
// secret from stdin or the environment and never print it; a config file open to others is refused.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const BIN = new URL("../bin/agentrun.mjs", import.meta.url).pathname;
const SERVE = new URL("../../serve/dist/cli.js", import.meta.url).pathname;
const ROOT = new URL("../../../", import.meta.url).pathname;
const SKILL = join(ROOT, "packages", "agentrun", "skills", "agentrun-cli");
const GENERATOR = join(ROOT, "scripts", "generate-clients.mjs");
const DROPPED = ["AGENTRUN_BASE_URL", "AGENTRUN_API_KEY", "AGENTRUN_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "AGENT_MODEL", "AGENTRUN_BOXES", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "PARALLEL_API_KEY"];

// Writes the file the first message names (`write NAME.md`); asks its person first when told to ask, and writes what
// they said; then answers.
const FAUX = `const textOf = (m) => (typeof m?.content === "string" ? m.content : (m?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(""));
export default (context, faux) => {
  const users = context.messages.filter((m) => m.role === "user").map(textOf);
  const wrote = context.messages.some((m) => m.role === "assistant" && Array.isArray(m.content) && m.content.some((c) => c.type === "toolCall" && c.name === "write"));
  if (wrote) return faux.message("Done.");
  if (users[0].includes("Ask me") && users.length === 1 && context.messages.at(-1)?.role !== "toolResult") return faux.message(faux.toolCall("ask_person", { question: "Which region?" }), { stopReason: "toolUse" });
  const file = /write (\\S+\\.md)/i.exec(users[0])?.[1] ?? "out.md";
  return faux.message(faux.toolCall("write", { path: file, content: "# " + users.at(-1) + "\\n" }), { stopReason: "toolUse" });
};
`;

/** The server, its data in HOME/.agentrun where the CLI looks with no flag, and a PATH with `agentrun` on it. */
async function serve(t) {
  const dir = mkdtempSync(join(tmpdir(), "agentrun-skill-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const shim = join(dir, "bin");
  mkdirSync(shim);
  writeFileSync(join(shim, "agentrun"), `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`, { mode: 0o755 });
  const kept = Object.fromEntries(Object.entries(process.env).filter(([name]) => !DROPPED.includes(name)));
  const env = { ...kept, HOME: dir, XDG_CONFIG_HOME: join(dir, ".config"), PATH: `${shim}:${process.env.PATH}` };
  writeFileSync(join(dir, "faux.mjs"), FAUX);
  const data = join(dir, ".agentrun");
  const child = spawn(process.execPath, [SERVE, "--data", data, "--port", "0", "--faux", join(dir, "faux.mjs")], { stdio: ["ignore", "pipe", "pipe"], env: { ...env, AGENTRUN_ACCOUNTS: "0", AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") } });
  t.after(() => child.exitCode === null && child.kill("SIGKILL"));
  let err = "";
  child.stdout.resume();
  child.stderr.on("data", (chunk) => (err += chunk));
  for (let i = 0; !existsSync(join(data, ".server.json")); i++) {
    assert.ok(i < 600 && child.exitCode === null, `the server started: ${err}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const record = JSON.parse(readFileSync(join(data, ".server.json"), "utf8"));
  return { dir, env, base: record.base_url, token: readFileSync(join(data, ".token"), "utf8").trim() };
}

/** The CLI on the PATH, every output kept in `seen`. */
const cliOf = (env, seen) => (args, { input, extra = {}, cwd } = {}) => {
  const run = spawnSync("agentrun", args, { env: { ...env, ...extra }, input, cwd, encoding: "utf8", timeout: 60_000 });
  seen.push(run.stdout, run.stderr);
  return { code: run.status, out: run.stdout, err: run.stderr, json: () => JSON.parse(run.stdout) };
};

/** SKILL.md's recipes: each shell block, with the exit its last line says. */
function recipes() {
  const text = readFileSync(join(SKILL, "SKILL.md"), "utf8");
  const section = text.slice(text.indexOf("\n## Recipes\n"), text.indexOf("\n## Exit codes\n"));
  return [...section.matchAll(/^### (.+)$|^```sh\n([\s\S]*?)^```$/gm)].reduce((blocks, [, title, code]) => {
    if (title) blocks.title = title;
    else blocks.push({ title: blocks.title, code, exit: Number(/^# exit (\d+)/m.exec(code.trim().split("\n").at(-1))?.[1]) });
    return blocks;
  }, []);
}

test("SKILL.md: its front matter, its size, and each recipe block run in order against the server, exiting as it says", { timeout: 180_000 }, async (t) => {
  const text = readFileSync(join(SKILL, "SKILL.md"), "utf8");
  assert.match(text, /^---\nname: agentrun-cli\ndescription: .+ Use when .+\n---\n<!-- Generated by scripts\/generate-clients\.mjs[^\n]*-->\n<!-- SHA-256 of what the command table is made of [^\n]*: [0-9a-f]{64} -->\n/);
  const hash = (file) => /SHA-256 of what the (?:command )?table is made of [^\n]*: ([0-9a-f]{64})/.exec(readFileSync(file, "utf8"))[1];
  assert.equal(hash(join(SKILL, "SKILL.md")), hash(join(ROOT, "packages", "agentrun", "lib", "commands.generated.mjs")), "the skill and the table are made of the same projection");
  assert.equal(hash(join(SKILL, "references", "commands.md")), hash(join(SKILL, "SKILL.md")));
  assert.ok(text.split("\n").length < 150, "under 150 lines");
  const blocks = recipes();
  assert.deepEqual([...new Set(blocks.map((b) => b.title.split(".")[0]))], ["1", "2", "3", "4", "5"]);
  for (const block of blocks) assert.ok(Number.isInteger(block.exit), `${block.title}: its last line says its exit`);

  const server = await serve(t);
  const work = join(server.dir, "work");
  mkdirSync(work);
  const seen = [];
  for (const block of blocks) {
    const ran = spawnSync("sh", ["-e", "-c", block.code], { cwd: work, env: server.env, encoding: "utf8", timeout: 60_000 });
    seen.push(ran.stdout, ran.stderr);
    assert.equal(ran.status, block.exit, `${block.title}:\n${block.code}\n${ran.stdout}\n${ran.stderr}`);
  }
  const run = JSON.parse(readFileSync(join(work, "run.json"), "utf8"));
  assert.deepEqual([run.status, run.cost.cap_usd], ["completed", 0.5], "the last run read is the one that asked, answered and capped");
  const read = spawnSync("sh", ["-c", `agentrun runs read-file ${run.run_id} region.md`], { cwd: work, env: server.env, encoding: "utf8" });
  assert.equal(read.stdout, "# Europe\n", "it wrote what its person answered");
  for (const out of seen) assert.ok(!out.includes(server.token), "no output holds the token");

  await t.test("skill install --dir writes the folder; with no flag, each agent's folder that exists; never over a folder not its own", () => {
    const cli = cliOf(server.env, seen);
    const dir = join(server.dir, "project", ".agents", "skills");
    const installed = cli(["skill", "install", "--dir", dir]);
    assert.equal(installed.code, 0, installed.err);
    assert.deepEqual(installed.json(), { installed: [join(dir, "agentrun-cli")] });
    for (const file of ["SKILL.md", join("references", "commands.md")]) assert.equal(readFileSync(join(dir, "agentrun-cli", file), "utf8"), readFileSync(join(SKILL, file), "utf8"));
    assert.equal(cli(["skill", "install", "--dir", dir]).code, 0, "again, over its own");

    assert.equal(cli(["skill", "install"]).code, 2, "no agent's folder here");
    mkdirSync(join(server.dir, ".claude"));
    const claude = cli(["skill", "install"]);
    assert.deepEqual([claude.code, claude.json().installed], [0, [join(server.dir, ".claude", "skills", "agentrun-cli")]]);
    const codex = cli(["skill", "install", "--codex"], { extra: { CODEX_HOME: join(server.dir, "codex") } });
    assert.deepEqual(codex.json().installed, [join(server.dir, "codex", "skills", "agentrun-cli")]);
    assert.deepEqual(readdirSync(join(server.dir, "codex", "skills", "agentrun-cli")).sort(), ["SKILL.md", "references"]);

    const other = join(server.dir, "other");
    mkdirSync(join(other, "agentrun-cli"), { recursive: true });
    writeFileSync(join(other, "agentrun-cli", "SKILL.md"), "---\nname: something-else\n---\n");
    assert.equal(cli(["skill", "install", "--dir", other]).code, 1);
    assert.equal(readFileSync(join(other, "agentrun-cli", "SKILL.md"), "utf8"), "---\nname: something-else\n---\n", "left as it was");
  });

  await t.test("tool-keys set: the value from stdin or --from-env reaches the server, and is in no output", () => {
    const outputs = [];
    const cli = cliOf(server.env, outputs);
    const value = `not-a-secret-${randomBytes(12).toString("hex")}`;
    const unset = cli(["tool-keys", "list"]).json().keys.find((key) => key.id === "parallel");
    assert.deepEqual(unset.fields.map((f) => f.set), [false]);

    const piped = cli(["tool-keys", "set", "parallel", "PARALLEL_API_KEY"], { input: `${value}\n` });
    assert.equal(piped.code, 0, piped.err);
    const field = () => cli(["tool-keys", "list"]).json().keys.find((key) => key.id === "parallel").fields[0];
    assert.equal(field().set, true);
    assert.equal(cli(["tool-keys", "delete", "parallel"]).code, 0);
    assert.equal(field().set, false);

    const fromEnv = cli(["tool-keys", "set", "parallel", "PARALLEL_API_KEY", "--from-env", "KEY_VALUE"], { extra: { KEY_VALUE: value } });
    assert.equal(fromEnv.code, 0, fromEnv.err);
    assert.equal(field().set, true);

    // A field the key does not have: the server's refusal, and still not the value.
    const wrongField = cli(["tool-keys", "set", "parallel", "NO_SUCH_FIELD"], { input: value });
    assert.equal(wrongField.code, 1);
    assert.match(wrongField.err, /input_invalid/);
    // On the command line, it is one argument too many: refused, nothing sent, and not echoed.
    assert.equal(cli(["tool-keys", "set", "parallel", "PARALLEL_API_KEY", value]).code, 2);
    assert.equal(cli(["tool-keys", "set", "parallel", "PARALLEL_API_KEY", "--from-env", "NOT_SET_HERE"]).code, 2);
    // A KEY_ID fetch would read as a step up: refused, nothing sent.
    const up = cli(["tool-keys", "set", "..", "PARALLEL_API_KEY"], { input: value });
    assert.equal(up.code, 2);
    assert.match(up.err, /KEY_ID may not be empty, \. or \.\./);
    assert.equal(cli(["tool-keys", "set", "parallel", "PARALLEL_API_KEY"], { input: "" }).code, 2, "nothing on stdin");
    for (const out of outputs) {
      assert.ok(!out.includes(value), "no output holds the value");
      assert.ok(!out.includes(server.token), "no output holds the token");
    }
  });

  await t.test("login: a wrong token is refused, exit 4, nothing written; the right one is kept 0600 in a 0700 folder and used; logout removes it", () => {
    const outputs = [];
    const cli = cliOf(server.env, outputs);
    const config = join(server.dir, ".config", "agentrun", "config.json");
    const wrong = cli(["login", "--base-url", server.base], { input: "fake-test-key\n" });
    assert.equal(wrong.code, 4);
    assert.match(wrong.err, /refused the token; nothing was written/);
    assert.equal(existsSync(config), false);
    assert.equal(cli(["login"], { input: server.token }).code, 2, "no server named");
    // Not a header value: refused before anything is sent, as every command refuses one.
    for (const bad of ["two words\n", "fake\u0100key\n"]) {
      const refused = cli(["login", "--base-url", server.base], { input: bad });
      assert.equal(refused.code, 4, bad);
      assert.match(refused.err, /not a valid header value; nothing was written|not a valid header value \(/);
    }
    assert.equal(existsSync(config), false);

    const done = cli(["login", "--base-url", `${server.base}/`], { input: `${server.token}\n` });
    assert.equal(done.code, 0, done.err);
    assert.deepEqual(done.json(), { base_url: server.base, config_file: config });
    assert.equal(statSync(config).mode & 0o777, 0o600);
    assert.equal(statSync(join(config, "..")).mode & 0o777, 0o700);
    assert.deepEqual(JSON.parse(readFileSync(config, "utf8")), { base_url: server.base, api_key: server.token });

    // Used with no flag and no data directory: the config file's server and token.
    const listed = cli(["agents", "list", "--data", join(server.dir, "nowhere")]);
    assert.equal(listed.code, 0, listed.err);
    assert.ok(listed.json().agents.some((agent) => agent.agent_id === "notes"));

    // Open to others: refused, exit 4, its token not read.
    chmodSync(config, 0o644);
    const open = cli(["agents", "list", "--data", join(server.dir, "nowhere")]);
    assert.equal(open.code, 4);
    assert.match(open.err, /is not a private file of yours/);
    chmodSync(config, 0o600);

    const out = cli(["logout"]);
    assert.deepEqual([out.code, out.json()], [0, { config_file: config, removed: true }]);
    assert.equal(existsSync(config), false);
    assert.equal(cli(["logout"]).json().removed, false);

    // A token typed on a terminal is refused: it would show.
    const script = spawnSync("script", ["-qec", `agentrun login --base-url ${server.base}`, "/dev/null"], { env: server.env, encoding: "utf8", timeout: 30_000 });
    if (script.error?.code !== "ENOENT") {
      outputs.push(script.stdout);
      assert.equal(script.status, 2, script.stdout);
      assert.match(script.stdout, /read from stdin, never typed on a terminal/);
    }
    for (const text of outputs) assert.ok(!text.includes(server.token), "no output holds the token");
  });
});

test("generate-clients --check passes on the committed skill, and fails on a hand-edited SKILL.md or a recipe naming a command the CLI does not have", { timeout: 60_000 }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "agentrun-skill-check-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const check = (...args) => spawnSync(process.execPath, [GENERATOR, "--check", ...args], { encoding: "utf8", cwd: ROOT });
  const committed = check();
  assert.equal(committed.status, 0, committed.stderr);

  const edited = join(dir, "skill");
  mkdirSync(join(edited, "references"), { recursive: true });
  writeFileSync(join(edited, "SKILL.md"), readFileSync(join(SKILL, "SKILL.md"), "utf8").replace("## Recipes", "## Recipes, edited"));
  writeFileSync(join(edited, "references", "commands.md"), readFileSync(join(SKILL, "references", "commands.md"), "utf8"));
  const stale = check("--skill", edited);
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /SKILL\.md is not the server's document's; run node scripts\/generate-clients\.mjs/);

  // The table names listRunFiles `runs list-files`: the recipes' `runs files` is a command the CLI no longer has.
  const resources = JSON.parse(readFileSync(join(ROOT, "scripts", "clients", "resources.json"), "utf8"));
  const renamed = join(dir, "renamed.json");
  writeFileSync(renamed, JSON.stringify({ ...resources, commands: { ...resources.commands, listRunFiles: ["runs", "list-files"] } }));
  const missing = check("--resources", renamed);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /the skill names agentrun runs files, a command the CLI does not have/);
});
