// The README's code samples, as written. A sample that is a program runs in an empty project that has the package under
// node_modules, as a stranger's install lays it out, and prints what the README says it prints. A sample that is a host's
// excerpt (a pi-durable extension needs a Harness) type-checks against the built package and the pi types this
// workspace resolves. A code block the README gains is a failure here until it is named below, so no sample is left
// unchecked.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const PACKAGE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const README = fs.readFileSync(path.join(PACKAGE, "README.md"), "utf8");

/** Every fenced block of the README with its heading and its number among the blocks of its language under that heading. */
function blocks(markdown) {
  const found = [];
  const counts = new Map();
  let heading = "";
  let open;
  for (const line of markdown.split("\n")) {
    if (open === undefined) {
      const title = /^#{1,6}\s+(.*)$/.exec(line);
      if (title) { heading = title[1].trim(); continue; }
      const fence = /^```(\S*)\s*$/.exec(line);
      if (fence) open = { language: fence[1], body: [] };
    } else if (/^```\s*$/.test(line)) {
      const key = `${heading}\u0000${open.language}`;
      const index = counts.get(key) ?? 0;
      counts.set(key, index + 1);
      found.push({ heading, language: open.language, index, text: `${open.body.join("\n")}\n` });
      open = undefined;
    } else open.body.push(line);
  }
  return found;
}
const BLOCKS = blocks(README);
const block = (heading, language, index = 0) => {
  const found = BLOCKS.find((b) => b.heading === heading && b.language === language && b.index === index);
  assert.ok(found, `the README has no ${language} block ${index} under "${heading}"`);
  return found;
};

const FIRST_READ = "A first read, with no key";
const EXAMPLE = "Example";
const SEE = "For a host: `vision.see` in code mode";
const JUDGE = "For a host: `vision.judge`, Jev in code mode";
const TRANSCRIBE = "For a host: `vision.transcribe`, speech to text in code mode";
const PROGRAMS = "For a host: what a program is started with";
const EYES = "For a host: eyes, with a provider key of your own";

/** Programs: a file, the environment it runs in, and the text block that shows what it prints. */
const RUN = [
  { name: "limits.mjs", heading: EXAMPLE, expected: [EXAMPLE, "text", 0], env: {} },
  { name: "read.mjs", heading: FIRST_READ, expected: [FIRST_READ, "text", 0], env: {}, bare: true },
  { name: "programs.mjs", heading: PROGRAMS, expected: [PROGRAMS, "text", 0], env: { MY_SECRET: "hunter2" } },
];
/** Excerpts that type-check: a name for the file and where the block is. */
const TYPES = [
  { name: "code-mode.mts", heading: SEE, index: 0 },
  { name: "jev.mts", heading: JUDGE, index: 0 },
  { name: "transcribe.mts", heading: TRANSCRIBE, index: 0 },
  { name: "adapter-env.mts", heading: PROGRAMS, index: 0 },
];

const CODE = new Set(["js", "mjs", "ts", "mts", "javascript", "typescript"]);

test("every code block in the README is a sample this test runs or type-checks", () => {
  const named = new Set([
    ...RUN.map((s) => `${s.heading}\u0000js\u00000`),
    `${EYES}\u0000js\u00000`,
    ...TYPES.map((s) => `${s.heading}\u0000ts\u0000${s.index}`),
  ]);
  const unnamed = BLOCKS.filter((b) => CODE.has(b.language) && !named.has(`${b.heading}\u0000${b.language}\u0000${b.index}`));
  assert.deepEqual(unnamed.map((b) => `${b.language} block ${b.index} under "${b.heading}"`), [], "name each in readme.test.mjs: a program that prints what its README block says, or an excerpt that type-checks");
});

/** The nearest `node_modules/<name>` above this package, as the package itself resolves it. */
function copyOf(name) {
  for (let at = fs.realpathSync(PACKAGE); ; at = path.dirname(at)) {
    const dir = path.join(at, "node_modules", name);
    if (fs.existsSync(path.join(dir, "package.json"))) return fs.realpathSync(dir);
    if (at === path.dirname(at)) throw new Error(`${name} does not resolve from ${PACKAGE}`);
  }
}

/** An empty project with the package and its peers under node_modules, the layout of an install. */
function project(t) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "readme-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const modules = path.join(dir, "node_modules");
  const link = (name, target) => { fs.mkdirSync(path.dirname(path.join(modules, name)), { recursive: true }); fs.symlinkSync(target, path.join(modules, name), "dir"); };
  link("@parcha/pi-vision", PACKAGE);
  for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-durable", "@earendil-works/pi-codemode", "@earendil-works/chord", "@parcha/agentrun-jev", "@types/node"]) link(name, copyOf(name));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "readme-sample", private: true, type: "module" }));
  return dir;
}

for (const sample of RUN) {
  test(`${sample.name} runs as the README writes it and prints what the README shows`, (t) => {
    const dir = project(t);
    fs.writeFileSync(path.join(dir, sample.name), block(sample.heading, "js").text);
    // A stranger's environment: no key, an empty home. `read.mjs` runs where no LibreOffice is found, as on a fresh install.
    const bin = path.dirname(process.execPath);
    const env = { PATH: sample.bare ? bin : `${bin}:/usr/bin:/bin`, HOME: dir, ...sample.env };
    const run = spawnSync(process.execPath, [sample.name], { cwd: dir, env, encoding: "utf8", timeout: 60_000 });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, block(...sample.expected).text);
  });
}

test("the shell the code-mode excerpt gives the sandbox runs the commands a skill recipe runs, and rejects with what a failed one printed", (t) => {
  const tool = /const bash: CodemodeTool = \{[\s\S]*?\n\};\n/.exec(block(SEE, "ts").text)?.[0];
  assert.ok(tool, "the excerpt declares a bash tool");
  const dir = project(t);
  const { outputText } = ts.transpileModule(`import { execFile } from "node:child_process";\nimport { inheritedEnv } from "@parcha/pi-vision/node";\n${tool}\nexport { bash };\n`, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 } });
  fs.writeFileSync(path.join(dir, "bash-tool.mjs"), outputText);
  fs.writeFileSync(path.join(dir, "run.mjs"), `
    import { CodemodeSandbox } from "@earendil-works/pi-codemode";
    import { bash } from "./bash-tool.mjs";
    const sandbox = new CodemodeSandbox({ tools: [bash] });
    const ok = await sandbox.execute('return await tools.bash({ command: "printf hello; ls ." })');
    const failed = await sandbox.execute('try { await tools.bash({ command: "echo oops >&2; exit 3" }); return "no rejection"; } catch (error) { return error.message; }');
    await sandbox.close();
    console.log(JSON.stringify({ ok: ok.ok && ok.value, failed: failed.ok && failed.value }));
  `);
  const run = spawnSync(process.execPath, ["run.mjs"], { cwd: dir, env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: dir }, encoding: "utf8", timeout: 60_000 });
  assert.equal(run.status, 0, run.stderr);
  const { ok, failed } = JSON.parse(run.stdout);
  assert.match(ok, /^hello/, "the command's output comes back, run in the working directory");
  assert.match(failed, /oops/, "a failed command rejects with its stderr");
});

/** An Anthropic Messages endpoint on this machine: it records each request and answers with `answer`, streamed. */
async function endpoint(answer, t) {
  const seen = [];
  const server = http.createServer((req, res) => {
    // Only the Messages call is answered and recorded: anything else that finds the port is refused and not counted.
    if (req.method !== "POST" || !req.url.startsWith("/v1/messages")) { res.writeHead(404).end(); return; }
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const sent = body ? JSON.parse(body) : {};
      seen.push({ path: req.url.split("?")[0], key: req.headers["x-api-key"], model: sent.model, images: JSON.stringify(sent.messages).split('"type":"image"').length - 1 });
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      send("message_start", { message: { id: "msg_1", type: "message", role: "assistant", model: sent.model, content: [], stop_reason: null, usage: { input_tokens: 1500, output_tokens: 1 } } });
      send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      send("content_block_delta", { index: 0, delta: { type: "text_delta", text: answer } });
      send("content_block_stop", { index: 0 });
      send("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 12 } });
      send("message_stop", {});
      res.end();
    });
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  t.after(() => new Promise((ok) => server.close(ok)));
  return { url: `http://127.0.0.1:${server.address().port}`, seen };
}

/** `node <file>` in `dir` with `env`, without blocking this process (the endpoint above lives in it). */
function node(dir, file, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("close", (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

/** What the README's `look.mjs` prints, with the price taken out: the catalog's rates are pi-ai's, the shape is ours. */
const unpriced = (text) => text.replace(/\$\d+\.\d+/g, "$PRICE");

test("look.mjs runs as the README writes it: the key reaches the endpoint with the picture, and nothing it prints or files carries the key", async (t) => {
  const answer = "The square is solid red.";
  const { url, seen } = await endpoint(answer, t);
  assert.equal((await fetch(`${url}/`)).status, 404, "a stray request to the port (a service that probes new listeners) is refused and not counted");
  const dir = project(t);
  fs.writeFileSync(path.join(dir, "look.mjs"), block(EYES, "js").text);
  const key = "readme-sample-key-not-a-secret";
  const run = await node(dir, "look.mjs", { PATH: path.dirname(process.execPath), HOME: dir, ANTHROPIC_API_KEY: key, EYES_BASE_URL: url });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(unpriced(run.stdout), unpriced(block(EYES, "text").text), "the README's output, with the model's words and its price as the endpoint gave them");
  assert.deepEqual(seen, [{ path: "/v1/messages", key, model: "claude-sonnet-5-5", images: 1 }], "one request, with the caller's key, the picture and the catalog's model");
  const receipt = fs.readFileSync(path.join(dir, "looks", "1.json"), "utf8");
  const record = JSON.parse(receipt);
  assert.match(record.facts.sha256, /^[0-9a-f]{64}$/);
  assert.equal(record.body, answer);
  assert.equal(record.args.ask, "What colour is the square?");
  assert.ok(![run.stdout, run.stderr, receipt].some((text) => text.includes(key)), "the key is in no output and no receipt");
});

test("eyes with no apiKey function read the provider's own variable, which is what the README says", async (t) => {
  const { url, seen } = await endpoint("seen", t);
  const dir = project(t);
  const key = "readme-env-key-not-a-secret";
  fs.writeFileSync(path.join(dir, "env-key.mjs"), `
    import { getModel } from "@earendil-works/pi-ai/compat";
    import { piAiEyes } from "@parcha/pi-vision/eyes/pi-ai";
    const eyes = piAiEyes({ ...getModel("anthropic", "claude-sonnet-5-5"), baseUrl: process.env.EYES_BASE_URL });
    console.log((await eyes.see({ parts: [], ask: "q" }, new AbortController().signal)).text);
  `);
  const run = await node(dir, "env-key.mjs", { PATH: path.dirname(process.execPath), HOME: dir, ANTHROPIC_API_KEY: key, EYES_BASE_URL: url });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), "seen");
  assert.deepEqual(seen.map((request) => request.key), [key]);
});

test("the install line before look.mjs names everything the program needs, Photon included", () => {
  // The test project links the workspace package, which resolves Photon from the workspace's own development
  // dependencies, so running look.mjs cannot show that a reader's install is complete: the README's line is checked
  // against the program's imports and against the package's optional peers instead.
  const line = block(EYES, "sh").text.trim();
  assert.match(line, /^npm install( [@a-z][^ ]*)+$/, "one npm install line");
  const installed = line.split(" ").slice(2);
  const program = block(EYES, "js").text;
  const imported = [...program.matchAll(/from "((?:@[a-z0-9-]+\/)?[a-z0-9-]+)(?:\/[^"]*)?"/g)].map((m) => m[1]).filter((name) => name !== "@parcha/pi-vision" && !name.startsWith("node:"));
  assert.deepEqual(imported.filter((name) => !installed.includes(name)), [], "every package the program imports is in the install line");
  assert.ok(installed.includes("@silvia-odwyer/photon-node"), "the image processor the read needs is in the install line");
  const peers = JSON.parse(fs.readFileSync(path.join(PACKAGE, "package.json"), "utf8")).peerDependenciesMeta;
  assert.equal(peers["@silvia-odwyer/photon-node"]?.optional, true, "the README says Photon is optional and not installed for you: it is an optional peer");
});

test("the host excerpts type-check against the built package and the pi types this workspace resolves", (t) => {
  const dir = project(t);
  for (const sample of TYPES) fs.writeFileSync(path.join(dir, sample.name), block(sample.heading, "ts", sample.index).text);
  const program = ts.createProgram(TYPES.map((s) => path.join(dir, s.name)), {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2023,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: ["node"],
    typeRoots: [path.join(dir, "node_modules", "@types")],
  });
  const problems = ts.getPreEmitDiagnostics(program).map((d) => {
    const where = d.file ? `${path.basename(d.file.fileName)}:${d.file.getLineAndCharacterOfPosition(d.start).line + 1}` : "program";
    return `${where}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`;
  });
  assert.deepEqual(problems, []);
});
