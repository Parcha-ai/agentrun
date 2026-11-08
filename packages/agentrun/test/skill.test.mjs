// The agentrun-cli skill: each shell block of its recipes, run in order against a server started with a faux model on
// loopback, with `agentrun` this repository's bin on the PATH, exits as its last line says; --check fails when the
// skill names a command the CLI does not have; `skill install` writes the folder; `tool-keys set` and `login` take their
// secret from stdin or the environment and never print it; a config file open to others is refused.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";

const BIN = new URL("../bin/agentrun.mjs", import.meta.url).pathname;
const SERVE = new URL("../../serve/dist/cli.js", import.meta.url).pathname;
const ROOT = new URL("../../../", import.meta.url).pathname;
const SKILL = join(ROOT, "packages", "agentrun", "skills", "agentrun-cli");
const GENERATOR = join(ROOT, "scripts", "generate-clients.mjs");
const DROPPED = ["AGENTRUN_BASE_URL", "AGENTRUN_API_KEY", "AGENTRUN_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "AGENT_MODEL", "AGENTRUN_BOXES", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "PARALLEL_API_KEY"];

// Writes the file the first message names (`write NAME.md`); asks its person first when told to ask, and writes what
// they said; then answers. Priced, so recipe 5's run stops at its cap.
const FAUX = `import { isReminder } from ${JSON.stringify(new URL("../../serve/test/fixtures/faux-model.mjs", import.meta.url).href)};
const textOf = (m) => (typeof m?.content === "string" ? m.content : (m?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(""));
export default (context, faux) => {
  // The person's messages: a <system-reminder> (the spend cap's wrap-up) is the server's aside, as serve's faux reads it.
  const users = context.messages.filter((m) => m.role === "user" && !isReminder(m)).map(textOf);
  const wrote = context.messages.some((m) => m.role === "assistant" && Array.isArray(m.content) && m.content.some((c) => c.type === "toolCall" && c.name === "write"));
  if (wrote) return faux.message("Done.");
  if (users[0].includes("Ask me") && users.length === 1 && context.messages.at(-1)?.role !== "toolResult") return faux.message(faux.toolCall("ask_person", { question: "Which region?" }), { stopReason: "toolUse" });
  const file = /write (\\S+\\.md)/i.exec(users[0])?.[1] ?? "out.md";
  return faux.message(faux.toolCall("write", { path: file, content: "# " + users.at(-1) + "\\n" }), { stopReason: "toolUse" });
};
// Priced on output only, $100 a million, as the server's cap tests price it: a request's least (1,024 tokens) is
// $0.1024, so a run capped under that stops at its cap before its first request. A request is held at far more, so a
// cap under three of those holds draws the server's wrap-up reminder before the first request; this script reads it as
// the server's, not its person's. Recipes 2 and 3 still cap their runs at $5, clear of it, as a real run wants.
export const cost = { input: 0, output: 100, cacheRead: 0, cacheWrite: 0 };
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
  const ran = [];
  for (const block of blocks) {
    const done = spawnSync("sh", ["-e", "-c", block.code], { cwd: work, env: server.env, encoding: "utf8", timeout: 60_000 });
    seen.push(done.stdout, done.stderr);
    assert.equal(done.status, block.exit, `${block.title}:\n${block.code}\n${done.stdout}\n${done.stderr}`);
    ran.push({ ...block, out: done.stdout, err: done.stderr, run: existsSync(join(work, "out.json")) ? JSON.parse(readFileSync(join(work, "out.json"), "utf8")) : undefined });
  }
  const of = (n) => ran.filter((block) => block.title.startsWith(`${n}.`));
  assert.match(of(4)[0].out, /^# Europe$/m, "recipe 4 read what the run that asked wrote: its person's answer");
  const [stopped, raised] = of(5);
  assert.ok(raised, "recipe 5 raises a cap: the table has the command");
  // Strict, so no request goes past the cap, and the recipe says what the default allows.
  assert.match(stopped.code, /^agentrun runs start .* --cap-mode strict /m);
  assert.match(readFileSync(join(SKILL, "SKILL.md"), "utf8"), /`--cap-mode strict`.*no request is sent that the cap cannot cover.*`expected`.*`cost\.overshoot_bound_usd`/);
  assert.deepEqual([stopped.run.status, stopped.run.pending?.kind, stopped.run.cost.cap_usd], ["input_required", "budget", 0.05], "it stopped at its cap");
  // Its hint names the command that raises the cap, with the cap the server suggests.
  assert.ok(typeof stopped.run.pending.suggested_cap_usd === "number", JSON.stringify(stopped.run.pending));
  assert.equal(stopped.err, `Run ${stopped.run.run_id} stopped at its spend cap: raise it with \`agentrun runs raise-cap ${stopped.run.run_id} --max-cost-usd ${stopped.run.pending.suggested_cap_usd}\`, then \`agentrun runs wait ${stopped.run.run_id}\`.\n`);
  assert.deepEqual([raised.run.run_id, raised.run.status, raised.run.pending, raised.run.cost.cap_usd], [stopped.run.run_id, "completed", null, 1], "raised, the same run went on and completed under the new cap");
  const read = spawnSync("sh", ["-c", `agentrun runs read-file ${raised.run.run_id} moon.md`], { cwd: work, env: server.env, encoding: "utf8" });
  assert.equal(read.status, 0, read.stderr);
  for (const out of seen) assert.ok(!out.includes(server.token), "no output holds the token");

  await t.test("under a cap small enough to draw the wrap-up reminder first, the run still asks its person: the reminder is the server's, not theirs", () => {
    const run = (args) => spawnSync("sh", ["-c", args], { cwd: work, env: server.env, encoding: "utf8", timeout: 60_000 });
    const asked = run(`agentrun runs start notes --max-cost-usd 0.5 --body '{"input": {"content": "Ask me which region to cover, then write region.md about it."}}' --wait`);
    seen.push(asked.stdout, asked.stderr);
    const view = JSON.parse(asked.stdout);
    const timeline = JSON.parse(run(`agentrun runs timeline ${view.run_id}`).stdout);
    assert.ok(timeline.rows.some((row) => row.kind === "phase" && /this run.s budget/i.test(row.summary ?? "")), "the wrap-up reminder came first");
    assert.deepEqual([asked.status, view.status, view.pending?.kind], [8, "input_required", "question"], asked.stderr);
    assert.equal(run(`agentrun runs cancel ${view.run_id}`).status, 0);
  });

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
    // Codex reads a person's skills from ~/.agents/skills: --codex writes there, and nowhere else.
    const agents = join(server.dir, ".agents", "skills", "agentrun-cli");
    const codex = cli(["skill", "install", "--codex"], { extra: { CODEX_HOME: join(server.dir, "codex") } });
    assert.equal(codex.code, 0, codex.err);
    assert.deepEqual([codex.json().installed, codex.err], [[agents], ""]);
    assert.deepEqual(readdirSync(agents).sort(), ["SKILL.md", "references"]);
    assert.equal(existsSync(join(server.dir, "codex")), false, "nothing under CODEX_HOME");
    // With no flag: each of ~/.claude and ~/.agents that exists.
    const both = cli(["skill", "install"]);
    assert.deepEqual(both.json().installed, [join(server.dir, ".claude", "skills", "agentrun-cli"), agents]);

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
    // A base URL whose query or fragment would swallow the check's path, so a public route answers it: refused, exit 2.
    for (const base of [`${server.base}/openapi.json#x`, `${server.base}/health?x=`, `${server.base}#`]) {
      const swallowed = cli(["login", "--base-url", base], { input: `${server.token}\n` });
      assert.equal(swallowed.code, 2, base);
      assert.match(swallowed.err, /no query, fragment, user or password/);
    }
    assert.equal(existsSync(config), false, "nothing written for a base URL that swallows the check");

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

/** A server on loopback that answers each request with `answer.status` and a body quoting `answer.secret` (raw in a
 *  text body, or JSON-escaped and URL-encoded in a JSON error), as a server that echoes what it was sent does. It answers only
 *  under its own random path prefix (part of `base`), recording each such request's method and path past it; any other
 *  request, a stray one from another test on this machine, gets a bare 404 and is not recorded. */
async function echoServer(t) {
  const answer = { status: 422, secret: "", form: "json" };
  const prefix = `/${randomBytes(8).toString("hex")}`;
  const requests = [];
  const server = createServer((req, res) => {
    if (!req.url.startsWith(`${prefix}/`)) return void req.resume().on("end", () => res.writeHead(404).end());
    requests.push(`${req.method} ${req.url.slice(prefix.length)}`);
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const { status, secret, form } = answer;
      // An MCP server's preview that repeats what it was sent: each header's value in its instructions, and the URL.
      if (form === "mcp") {
        const sent = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ url: sent.url, instructions: `Call with ${Object.values(sent.auth.headers).join(" and ")}.` }));
      }
      // One that repeats a header's value in a string and as a key of its answer.
      if (form === "mcp-keys") {
        const [value] = Object.values(JSON.parse(Buffer.concat(chunks).toString("utf8")).auth.headers);
        return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ url: "https://mcp.example.com/mcp", instructions: `Call with ${value}.`, tools: { [value]: { name: "lookup" } }, count: 2 }));
      }
      // A tool's input schema may name any property, those JavaScript's objects hold for themselves among them. Written
      // as text: an object literal's __proto__ would set its prototype, not a key.
      if (form === "mcp-proto") return res.writeHead(200, { "content-type": "application/json" }).end('{"tools":{"t":{"input_schema":{"properties":{"__proto__":{"type":"string"},"constructor":{"type":"string"}}}}}}');
      if (form === "shape") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
      if (form === "raw") return res.writeHead(status, { "content-type": "text/plain" }).end(`refused ${secret}`);
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: "input_invalid", message: `refused ${secret} ${encodeURIComponent(secret)}` }, echo: { secret } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => (server.closeAllConnections(), server.close()));
  return { answer, requests, base: `http://127.0.0.1:${server.address().port}${prefix}/v2` };
}

/** The CLI, run without blocking this process (the echo server runs in it). */
const cliAsync = (env) => (args, { input = "", extra = {} } = {}) => new Promise((resolve) => {
  const child = spawn(process.execPath, [BIN, ...args], { env: { ...env, ...extra }, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (err += chunk));
  child.once("close", (code) => resolve({ code, out, err }));
  child.stdin.end(input);
});

const formsOf = (secret) => [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)];

test("a secret-bearing command never prints a server's error body, and cuts the secret from what it prints, at any length and in any form", { timeout: 60_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "agentrun-skill-echo-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !DROPPED.includes(name))), HOME: dir, XDG_CONFIG_HOME: join(dir, ".config") };
  const echo = await echoServer(t);
  const cli = cliAsync(env);
  const key = { extra: { AGENTRUN_API_KEY: "fake-test-key" } };
  const base = ["--base-url", echo.base];
  const clean = (ran, secret, what) => {
    for (const form of formsOf(secret)) assert.ok(!`${ran.out}${ran.err}`.includes(form), `${what}: ${JSON.stringify(form)} is in its output: ${ran.out}${ran.err}`);
  };
  const config = join(dir, ".config", "agentrun", "config.json");

  for (const secret of ['not"a\\secret-01', "Z", "fake-test-key-xyz"]) {
    for (const form of ["json", "raw"]) {
      Object.assign(echo.answer, { status: 422, secret, form });
      const set = await cli(["tool-keys", "set", "parallel", "PARALLEL_API_KEY", ...base], { ...key, input: secret });
      assert.equal(set.code, 1, set.err);
      assert.equal(echo.requests.at(-1), "PUT /v2/settings/tool-keys/parallel", "it reached this test's own server");
      clean(set, secret, `tool-keys set, ${form}`);
      if (form === "json") assert.match(set.err, /422 input_invalid/);

      const save = await cli(["tool-keys", "save", "parallel", "--body", "-", ...base], { ...key, input: JSON.stringify({ values: { PARALLEL_API_KEY: secret } }) });
      assert.equal(save.code, 1, save.err);
      clean(save, secret, `tool-keys save, ${form}`);
      const mcp = await cli(["mcp-servers", "save", "srv", "--body", "-", ...base], { ...key, input: JSON.stringify({ url: "https://mcp.example.com/mcp", auth: { type: "bearer", token: secret } }) });
      assert.equal(mcp.code, 1, mcp.err);
      clean(mcp, secret, `mcp-servers save, ${form}`);

      Object.assign(echo.answer, { status: 401 });
      const login = await cli(["login", ...base], { input: `${secret}\n` });
      assert.equal(login.code, 4, login.err);
      assert.equal(echo.requests.at(-1), "GET /v2/agents?limit=1");
      clean(login, secret, `login, ${form}`);
      assert.equal(existsSync(config), false);
    }
    // A success that quotes it: printed, with every copy cut.
    Object.assign(echo.answer, { status: 200, secret, form: "json" });
    const ok = await cli(["tool-keys", "set", "parallel", "PARALLEL_API_KEY", ...base], { ...key, input: secret });
    assert.equal(ok.code, 0, ok.err);
    clean(ok, secret, "tool-keys set, a success");
  }

  // An MCP server's credential under any header name, `url` and `type` among them, is a secret: cut from a success that
  // repeats it. The body's own url and auth.type are not, and print as they are.
  Object.assign(echo.answer, { form: "mcp" });
  const headers = { url: `not-a-secret-${randomBytes(8).toString("hex")}`, type: `not-a-secret-${randomBytes(8).toString("hex")}`, "x-api-key": `not-a-secret-${randomBytes(8).toString("hex")}` };
  for (const args of [["mcp-servers", "preview"], ["mcp-servers", "save", "srv"]]) {
    const sent = await cli([...args, "--body", "-", ...base], { ...key, input: JSON.stringify({ url: "https://mcp.example.com/mcp", auth: { type: "headers", headers } }) });
    assert.equal(sent.code, 0, sent.err);
    assert.match(echo.requests.at(-1), /^(?:POST \/v2\/settings\/mcp-servers\/preview|PUT \/v2\/settings\/mcp-servers\/srv)$/);
    for (const value of Object.values(headers)) clean(sent, value, `${args.join(" ")}, a header's value`);
    assert.match(sent.out, /"url":"https:\/\/mcp\.example\.com\/mcp"/, "the server's URL is no secret");
  }

  // A secret that is JSON's own punctuation: cut from the answer's strings and keys, never from its structure, so the
  // answer still parses, with its non-secret values as they were.
  Object.assign(echo.answer, { form: "mcp-keys" });
  const strings = (value) => (typeof value === "string" ? [value] : value && typeof value === "object" ? Object.entries(value).flatMap(([k, v]) => [...(Array.isArray(value) ? [] : [k]), ...strings(v)]) : []);
  for (const secret of ['"', ",", ":", "{"]) {
    const sent = await cli(["mcp-servers", "preview", "--body", "-", ...base], { ...key, input: JSON.stringify({ url: "https://mcp.example.com/mcp", auth: { type: "headers", headers: { "x-api-key": secret } } }) });
    assert.equal(sent.code, 0, sent.err);
    let answer;
    assert.doesNotThrow(() => (answer = JSON.parse(sent.out)), `the answer still parses with a secret of ${secret}: ${sent.out}`);
    for (const text of strings(answer)) for (const form of formsOf(secret)) assert.ok(!text.includes(form), `${JSON.stringify(form)} in ${JSON.stringify(text)}`);
    assert.deepEqual(Object.keys(answer), ["url", "instructions", "tools", "count"]);
    assert.equal(answer.count, 2);
    assert.deepEqual(Object.values(answer.tools), [{ name: "lookup" }]);
    if (secret !== ":") assert.equal(answer.url, "https://mcp.example.com/mcp", "a value the secret is not in is as it was");
  }

  // Every key of the answer printed as it came, __proto__ and constructor too, each with its value.
  Object.assign(echo.answer, { form: "mcp-proto" });
  const proto = await cli(["mcp-servers", "preview", "--body", "-", ...base], { ...key, input: JSON.stringify({ url: "https://mcp.example.com/mcp", auth: { type: "headers", headers: { "x-api-key": `not-a-secret-${randomBytes(8).toString("hex")}` } } }) });
  assert.equal(proto.code, 0, proto.err);
  const properties = JSON.parse(proto.out).tools.t.input_schema.properties;
  assert.deepEqual(Object.keys(properties), ["__proto__", "constructor"], proto.out);
  for (const name of ["__proto__", "constructor"]) assert.deepEqual(Object.getOwnPropertyDescriptor(properties, name)?.value, { type: "string" }, `${name}: ${proto.out}`);
  assert.equal(proto.out, '{"tools":{"t":{"input_schema":{"properties":{"__proto__":{"type":"string"},"constructor":{"type":"string"}}}}}}\n', "printed as it came");

  // An MCP sign-in starts in the owner's browser (the console's MCP page): the callback needs the cookie its start's
  // answer sets, which a CLI would keep. So there is no command for it, and nothing is sent.
  const sent = echo.requests.length;
  const oauth = await cli(["mcp-servers", "oauth-start", "acme", "--body", "-", ...base], { ...key, input: JSON.stringify({ url: "https://mcp.example.com/mcp" }) });
  assert.equal(oauth.code, 2, oauth.err);
  assert.equal(echo.requests.length, sent, "nothing was sent");
  const group = await cli(["mcp-servers", ...base], key);
  assert.doesNotMatch(group.out, /oauth-start/, "the group's help lists no oauth-start");
  assert.match(group.out, /oauth-client/, "its public client document stays");

  // A 200 that is not the agents list: not the server it says it is, so nothing is written.
  Object.assign(echo.answer, { form: "shape" });
  const shape = await cli(["login", ...base], { input: "fake-test-key\n" });
  assert.equal(shape.code, 1, shape.err);
  assert.match(shape.err, /not an agents list; nothing was written/);
  assert.equal(existsSync(config), false);

  // Every command takes its base URL whole: no query, fragment, user or password, from a flag, the environment or the config file.
  // A request outside its prefix, as a stray one from another test would be: a bare 404, and not recorded.
  const before = echo.requests.length;
  const stray = await fetch(`${new URL(echo.base).origin}/v2/settings/tool-keys/parallel`, { method: "PUT", body: "{}" });
  assert.deepEqual([stray.status, await stray.text(), echo.requests.length], [404, "", before]);

  for (const bad of [`${echo.base}#x`, `${echo.base}?x=1`, Object.assign(new URL(echo.base), { username: "user", password: "pw" }).href, "ftp://127.0.0.1/v2", "not a url"]) {
    const flagged = await cli(["agents", "list", "--base-url", bad], key);
    assert.equal(flagged.code, 2, bad);
    assert.ok(!flagged.err.includes("pw@"), "a URL's password is not echoed");
    const fromEnv = await cli(["agents", "list"], { extra: { ...key.extra, AGENTRUN_BASE_URL: bad } });
    assert.equal(fromEnv.code, 2, `AGENTRUN_BASE_URL ${bad}`);
  }
});

/** Every file under `dir`, by its path, with its bytes' SHA-256. */
const treeOf = (dir) => Object.fromEntries(readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => {
  const file = join(e.parentPath, e.name);
  return [file.slice(dir.length), createHash("sha256").update(readFileSync(file)).digest("hex")];
}).sort());

test("skill install never installs into its own skill folder, inside it or over a folder holding it, and replaces an older copy whole", { timeout: 60_000 }, (t) => {
  // A copy of the package, so the folder a wrong install would delete is the copy's. It sits in a folder named
  // agentrun-cli, so that DIR/agentrun-cli for DIR its parent holds the skill folder.
  const dir = mkdtempSync(join(tmpdir(), "agentrun-skill-own-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pkg = join(dir, "agentrun-cli");
  for (const part of ["bin", "lib", "skills", "package.json"]) cpSync(join(ROOT, "packages", "agentrun", part), join(pkg, part), { recursive: true });
  const source = join(pkg, "skills", "agentrun-cli");
  const before = treeOf(source);
  symlinkSync(join(pkg, "skills"), join(dir, "link"));
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !DROPPED.includes(name))), HOME: dir };
  const install = (...args) => spawnSync(process.execPath, [join(pkg, "bin", "agentrun.mjs"), "skill", "install", ...args], { env, encoding: "utf8", timeout: 30_000 });

  for (const target of [join(pkg, "skills"), join(dir, "link"), join(source, "references"), dir]) {
    const refused = install("--dir", target);
    assert.equal(refused.status, 2, `${target}: ${refused.stdout}${refused.stderr}`);
    assert.match(refused.stderr, /this package's own skill folder/);
    assert.equal(refused.stdout, "");
    assert.deepEqual(treeOf(source), before, `${target}: the skill folder is as it was`);
  }

  // An older copy of this skill, with a file the new one lacks: replaced whole.
  const elsewhere = join(dir, "project", "skills");
  mkdirSync(join(elsewhere, "agentrun-cli"), { recursive: true });
  writeFileSync(join(elsewhere, "agentrun-cli", "SKILL.md"), "---\nname: agentrun-cli\n---\nAn older copy.\n");
  writeFileSync(join(elsewhere, "agentrun-cli", "stale.md"), "gone after\n");
  const done = install("--dir", elsewhere);
  assert.equal(done.status, 0, done.stderr);
  assert.deepEqual(JSON.parse(done.stdout), { installed: [join(elsewhere, "agentrun-cli")] });
  assert.deepEqual(treeOf(join(elsewhere, "agentrun-cli")), before);
  assert.deepEqual(readdirSync(elsewhere), ["agentrun-cli"], "no temporary folder left beside it");
  assert.deepEqual(treeOf(source), before);
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

  // A public field (left in what a secret command prints) must be a string field of the secret body by its full path,
  // never a map's value: a header's value is always a secret, whatever its name.
  for (const field of ["auth.headers.*", "auth.headers", "type", "nope"]) {
    const loose = join(dir, "public.json");
    writeFileSync(loose, JSON.stringify({ ...resources, publicFields: { ...resources.publicFields, saveMcpServer: ["url", field] } }));
    const refused = check("--resources", loose);
    assert.equal(refused.status, 1, field);
    assert.match(refused.stderr, new RegExp(`saveMcpServer's public field ${field.replace(/[.*]/g, "\\$&")}, which is not a string field of its body`));
  }
});
