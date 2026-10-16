import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { scratch } from "./support.mjs";
import { branchesOf, remoteWith, showOn, treeOf } from "./coding-agent/rig.mjs";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// The package's root is the directory above `dist/` of its main entry: its exports map has no `package.json` subpath.
const piCli = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")))), "dist", "bundle", "cli.js");

/**
 * A model on loopback that speaks the OpenAI chat-completions stream and nothing else: its first answer calls pi's `write`
 * tool for a file beside the AGENTS.md the system prompt names, its second says it is done. No network, no key, no spend.
 */
async function fakeModel(t, checkouts) {
  const requests = [];
  const server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404).end();
      return;
    }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push(body);
      const sent = (delta, finish, usage) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: "fake-1", choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
      const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      if (body.messages.at(-1).role === "tool") {
        res.end(sent({ role: "assistant", content: "Done." }, null) + sent({}, "stop", usage) + "data: [DONE]\n\n");
        return;
      }
      // Only a path inside the test's own checkouts directory is ever written: a prompt that names another one is answered in words.
      const at = new RegExp(`path=\\\\"(${checkouts.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/[^/"\\\\]+)/AGENTS\\.md\\\\"`).exec(JSON.stringify(body));
      if (!at) {
        res.end(sent({ role: "assistant", content: "No repository in this prompt." }, null) + sent({}, "stop", usage) + "data: [DONE]\n\n");
        return;
      }
      const args = JSON.stringify({ path: `${at[1]}/notes/learned.md`, content: "Registries match the legal name.\n" });
      res.end(sent({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "write", arguments: args } }] }, null) + sent({}, "tool_calls", usage) + "data: [DONE]\n\n");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return { port: server.address().port, requests };
}

function run(args, { cwd, env }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [piCli, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const out = [];
    const err = [];
    child.stdout.on("data", (c) => out.push(c));
    child.stderr.on("data", (c) => err.push(c));
    const timer = setTimeout(() => child.kill("SIGKILL"), 150_000);
    child.on("close", (status) => { clearTimeout(timer); resolve({ status, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }); });
  });
}

test("the real pi CLI loads the package, seeds the repository, and a print-mode run commits what the model wrote on exit", { timeout: 170_000 }, async (t) => {
  const root = await scratch();
  const { bare, main } = await remoteWith(root, { "AGENTS.md": "# Rules\nCite every claim.\n", "notes/hello.md": "hello\n", "src/code.js": "x\n" });
  const home = path.join(root, "home");
  const agent = path.join(home, "agent");
  const model = await fakeModel(t, path.join(agent, "git-remote", "checkouts"));
  const work = path.join(root, "work");
  await mkdir(agent, { recursive: true });
  await mkdir(work, { recursive: true });
  await writeFile(path.join(agent, "models.json"), JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${model.port}/v1`, api: "openai-completions", apiKey: "fake-test-key", models: [{ id: "fake-1", name: "fake-1", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
  const env = { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", TMPDIR: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };

  const helped = await run(["-e", pkgDir, "--help"], { cwd: work, env });
  for (const flag of ["--git-remote", "--git-ref", "--git-allow", "--git-branch", "--git-checkout-dir"]) assert.ok(helped.stdout.includes(flag), `${flag} is a flag of the loaded package: ${helped.stdout.slice(0, 300)}`);

  const ran = await run(["-e", pkgDir, "--git-remote", bare, "--git-allow", "notes/**", "--no-session", "--no-context-files", "--provider", "fake", "--model", "fake-1", "-p", "add a note"], { cwd: work, env });
  assert.equal(ran.status, 0, ran.stderr + ran.stdout);
  assert.match(ran.stdout, /Done\./);
  const checkouts = path.join(agent, "git-remote", "checkouts");
  const [id] = readdirSync(checkouts);
  assert.ok(id, "a checkout was made for the session");
  assert.ok(existsSync(path.join(checkouts, id, "notes/learned.md")), "the model's write tool wrote beside the AGENTS.md the prompt named");
  assert.ok(JSON.stringify(model.requests[0]).includes("Cite every claim."), "the model was shown the repository's AGENTS.md");
  assert.deepEqual(await branchesOf(bare), ["main", `sessions/${id}`], "the end committed on exit, to the session's branch only");
  assert.equal(await showOn(bare, `sessions/${id}`, "notes/learned.md"), "Registries match the legal name.\n");
  assert.deepEqual((await treeOf(bare, `sessions/${id}`)).sort(), ["AGENTS.md", "notes/hello.md", "notes/learned.md", "src/code.js"]);
  assert.equal(await showOn(bare, "main", "notes/learned.md"), null);
  assert.notEqual(main, undefined);
  assert.deepEqual(readdirSync(work), [], "nothing was written to the working directory");
});
