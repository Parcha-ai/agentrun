// The README, held to what it says. Its quickstart runs in an empty project laid out like an install and prints what the
// README shows. Every other code block is named here, and a block the README gains fails until it is. Every name each entry
// point exports is in that entry point's Library section, and every error code is in the Errors table. Its links work on
// npm: absolute, or inside the page.
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

const QUICKSTART = "Quickstart (no key, no network)";
/** Blocks that are not a program of their own: a host's excerpt (it names a `home`, an `access` or a `harness` the host
 *  has), a shell line or a layout. Each is checked to parse, or not at all, and each is named. */
const EXCERPTS = [
  { heading: "Moving a home", language: "js", index: 0 },
  { heading: "The timeline", language: "js", index: 0 },
  { heading: "An agent home on a disk", language: "js", index: 0 },
];
const NOT_CODE = new Set(["", "text", "sh"]);
const CODE = new Set(["js", "mjs", "ts", "mts", "javascript", "typescript"]);

test("every code block in the README is the quickstart, a named excerpt that parses, or not code", () => {
  const named = new Set([`${QUICKSTART}\u0000js\u00000`, ...EXCERPTS.map((e) => `${e.heading}\u0000${e.language}\u0000${e.index}`)]);
  const unnamed = BLOCKS.filter((b) => CODE.has(b.language) && !named.has(`${b.heading}\u0000${b.language}\u0000${b.index}`));
  assert.deepEqual(unnamed.map((b) => `${b.language} block ${b.index} under "${b.heading}"`), [], "name each in readme.test.mjs");
  const odd = BLOCKS.filter((b) => !CODE.has(b.language) && !NOT_CODE.has(b.language));
  assert.deepEqual(odd.map((b) => `${b.language} block under "${b.heading}"`), [], "a fence language this test does not know");
});

test("the excerpts parse as modules", () => {
  for (const { heading, language, index } of EXCERPTS) {
    const { diagnostics } = ts.transpileModule(block(heading, language, index).text, { reportDiagnostics: true, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 } });
    assert.deepEqual((diagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")), [], `${heading}, ${language} block ${index}`);
  }
});

/** The nearest `node_modules/<name>` above this package, as the package itself resolves it. */
function copyOf(name) {
  for (let at = fs.realpathSync(PACKAGE); ; at = path.dirname(at)) {
    const dir = path.join(at, "node_modules", name);
    if (fs.existsSync(path.join(dir, "package.json"))) return fs.realpathSync(dir);
    if (at === path.dirname(at)) throw new Error(`${name} does not resolve from ${PACKAGE}`);
  }
}

test("the quickstart runs as the README writes it, with the package and its peers under node_modules, and prints what the README shows", (t) => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "readme-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const link = (name, target) => {
    fs.mkdirSync(path.dirname(path.join(dir, "node_modules", name)), { recursive: true });
    fs.symlinkSync(target, path.join(dir, "node_modules", name), "dir");
  };
  link("@parcha/pi-durable-agent", PACKAGE);
  for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-durable", "@earendil-works/chord"]) link(name, copyOf(name));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "readme-sample", private: true, type: "module" }));
  fs.writeFileSync(path.join(dir, "quickstart.mjs"), block(QUICKSTART, "js").text);
  // A stranger's environment: no key, an empty home, nothing but the PATH.
  const run = spawnSync(process.execPath, ["--no-warnings=ExperimentalWarning", "quickstart.mjs"], { cwd: dir, env: { PATH: path.dirname(process.execPath), HOME: dir }, encoding: "utf8", timeout: 60_000 });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, block(QUICKSTART, "text").text);
});

/** The names an entry point of the built package exports, read from its declaration file, and whether each is a value (a
 *  function, a constant or a class) or only a type. */
function exportsOf(declaration) {
  const file = path.join(PACKAGE, "dist", declaration);
  const program = ts.createProgram([file], { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, target: ts.ScriptTarget.ES2023, types: ["node"], skipLibCheck: true, noEmit: true });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(file);
  assert.ok(source, `${declaration} is built`);
  return checker.getExportsOfModule(checker.getSymbolAtLocation(source)).map((symbol) => {
    const real = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    return { name: symbol.getName(), value: Boolean(real.flags & ts.SymbolFlags.Value) };
  }).sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** The text of one `###` heading of the Library section, up to the next heading. */
function librarySection(title) {
  const lines = README.split("\n");
  const start = lines.indexOf(`### ${title}`);
  assert.notEqual(start, -1, `the README has no "### ${title}" under Library`);
  const end = lines.findIndex((line, at) => at > start && /^#{2,3}\s/.test(line));
  return lines.slice(start + 1, end === -1 ? undefined : end).join("\n");
}
/** The names a section documents: the first cell of each table row (a function, a constant), and the code spans of the
 *  paragraph or list that names its types. A name elsewhere in the README does not count. */
function documentedIn(section) {
  const rows = section.split("\n").filter((line) => line.startsWith("| `"));
  const firstCells = rows.map((row) => row.split("|")[1] ?? "").flatMap((cell) => [...cell.matchAll(/`([A-Za-z_]\w*)/g)].map((m) => m[1]));
  const typeText = section.split("\n").filter((line) => !line.startsWith("|")).join("\n");
  const types = [...typeText.matchAll(/`([A-Za-z_]\w*)[`(]/g)].map((m) => m[1]);
  return { values: new Set(firstCells), types: new Set([...firstCells, ...types]) };
}

test("every name each entry point exports is documented in that entry point's Library section: a value in a table row, a type in its types list", () => {
  const entries = [
    { title: "`@parcha/pi-durable-agent`", declaration: "index.d.ts" },
    { title: "`@parcha/pi-durable-agent/export`", declaration: "export.d.ts" },
    { title: "`@parcha/pi-durable-agent/timeline`", declaration: "timeline/index.d.ts" },
  ];
  const missing = [];
  for (const { title, declaration } of entries) {
    const names = exportsOf(declaration);
    assert.ok(names.length > 0, `${title} exports something`);
    const section = documentedIn(librarySection(title));
    // `./export` is three names in its first sentence, not a table.
    const spans = new Set([...librarySection(title).trim().split(/\.\s/)[0].matchAll(/`([A-Za-z_]\w*)`/g)].map((m) => m[1]));
    for (const { name, value } of names) {
      const found = title.endsWith("/export`") ? spans.has(name) : value ? section.values.has(name) : section.types.has(name);
      if (!found) missing.push(`${title}: ${name} (${value ? "a value: a table row" : "a type: the types list"})`);
    }
  }
  assert.deepEqual(missing, [], "document each in its entry point's Library section, not elsewhere in the README");
});

test("every AgentHomeError code is in the README's Errors table", () => {
  const declaration = fs.readFileSync(path.join(PACKAGE, "dist", "store.d.ts"), "utf8");
  const codes = [...(/readonly code: ([^;]+);/.exec(declaration)?.[1] ?? "").matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  assert.ok(codes.length >= 8, "the declaration's codes were read");
  const table = README.slice(README.indexOf("### Errors"), README.indexOf("## An agent home on a disk"));
  assert.deepEqual(codes.filter((code) => !table.includes(`| \`${code}\` |`)), []);
});

test("the README's links work on npm: absolute, or inside the page", () => {
  const links = [...README.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]);
  assert.ok(links.length > 0);
  assert.deepEqual(links.filter((target) => !/^(https:\/\/|#)/.test(target)), []);
  const slug = (title) => title.toLowerCase().replace(/[^a-z0-9 _-]/g, "").trim().replace(/ /g, "-");
  const anchors = new Set(README.split("\n").filter((l) => /^#{1,6}\s/.test(l)).map((l) => slug(l.replace(/^#+\s*/, ""))));
  assert.deepEqual(links.filter((target) => target.startsWith("#") && !anchors.has(target.slice(1))), [], "an in-page link to a heading that is not there");
});
