// The README's code samples, as written. A sample that is a program runs in an empty project that has the package under
// node_modules, as a stranger's install lays it out, and prints what the README says it prints. A sample that is a host's
// excerpt (a pi-durable extension needs a Harness) type-checks against the built package and the pi types this
// workspace resolves. A code block the README gains is a failure here until it is named below, so no sample is left
// unchecked.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
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
