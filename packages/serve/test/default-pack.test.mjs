// The profile pack serve ships (`default`), as the build lays it out next to the server: its pack.json is a valid
// version 1 pack, it resolves for every effort and every output type it names, every skill it names is a skill it
// bundles (and it bundles no other), and every bundled SKILL.md passes the skill check the native harnesses run, so
// each one loads natively on claude-agent and codex. Its text carries no product identity, gateway tool id or internal
// name, and the slides skill, adapted from an MIT-licensed project, carries that project's notice.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { test } from "node:test";
import { EFFORTS } from "../dist/model.js";
import { defaultPack, packIssues, resolvePack } from "../dist/packs.js";

// The shared skill check: @parcha/agentrun-kernel's own once it holds it; the Claude adapter's export is the same check.
const adapters = await import("@parcha/agentrun-kernel");
const { skillProblems } = typeof adapters.skillProblems === "function" ? adapters : await import("@parcha/agentrun-harness-claude");

/** What each output type loads after the effort skill, and the file it writes. */
const OUTPUTS = {
  report: { writers: ["report-writer"], file: "report.md" },
  decision: { writers: ["report-writer"], file: "report.md" },
  answer: { writers: [] },
  slides: { writers: ["slides"], file: "slides.html" },
  dashboard: { writers: ["data-visualization", "html-app-architecture"], file: "dashboard.html" },
  website: { writers: ["html-app-architecture", "anti-slop-design"], file: "index.html" },
};

/** Every file under `dir`, by its path relative to `dir`. */
async function filesUnder(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) out.push(relative(dir, join(entry.parentPath, entry.name)).split("\\").join("/"));
  }
  return out.sort();
}

/** The bundled skills, each `{name, files}` as an adapter takes it. */
async function bundled(skillsDir) {
  const names = (await readdir(skillsDir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  return Promise.all(names.map(async (name) => {
    const dir = join(skillsDir, name);
    const files = {};
    for (const path of await filesUnder(dir)) files[path] = await readFile(join(dir, path), "utf8");
    return { name, files };
  }));
}

const { pack, skills: skillsDir } = await defaultPack();
const skills = await bundled(skillsDir);

test("the default pack is a valid version 1 pack named default: one effort skill per effort, at the run's own thinking level, the six output types, and no output unless the run asks for one", async () => {
  assert.deepEqual(packIssues(pack), []);
  assert.equal(pack.name, "default");
  assert.deepEqual(JSON.parse(await readFile(new URL("../src/packs/default/pack.json", import.meta.url), "utf8")), pack, "the build's copy is the source's");
  assert.deepEqual(Object.fromEntries(EFFORTS.map((effort) => [effort, pack.effort[effort]])), {
    low: { skills: ["effort-low"] },
    medium: { skills: ["effort-medium"] },
    high: { skills: ["effort-high"] },
  });
  assert.deepEqual(Object.keys(pack.outputs).sort(), Object.keys(OUTPUTS).sort());
});

test("the default pack resolves for every effort and every output type: the effort skill, then the output's writers, and its file", () => {
  for (const effort of EFFORTS) {
    assert.deepEqual(resolvePack(pack, { effort }), { effort, skills: [`effort-${effort}`] }, `${effort} with no output, and no thinking level: the run's effort sets it`);
    for (const [type, { writers, file }] of Object.entries(OUTPUTS)) {
      assert.deepEqual(resolvePack(pack, { effort, output: type }), { effort, skills: [`effort-${effort}`, ...writers], output: { type, ...(file ? { file } : {}), skills: writers } }, `${effort} × ${type}`);
    }
  }
  // A binary format needs a shell to produce it, which serve does not give an agent.
  for (const type of ["xlsx", "docx", "pdf", "pptx", "spreadsheet", "document"]) assert.ok(!Object.hasOwn(pack.outputs, type), `no ${type} output`);
});

test("every skill the pack names is one it bundles, with a SKILL.md, and it bundles no skill it never names", () => {
  const named = new Set([...EFFORTS.flatMap((effort) => pack.effort[effort].skills), ...Object.values(pack.outputs).flatMap((output) => output.skills)]);
  assert.deepEqual(skills.map((skill) => skill.name), [...named].sort());
  for (const skill of skills) assert.ok(typeof skill.files["SKILL.md"] === "string", `${skill.name} has a SKILL.md`);
});

test("every bundled skill passes the shared skill check on its own, and so does every set one run loads, so each loads natively", () => {
  for (const skill of skills) assert.deepEqual(skillProblems([skill]), [], skill.name);
  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  for (const effort of EFFORTS) {
    for (const type of [undefined, ...Object.keys(OUTPUTS)]) {
      const loaded = resolvePack(pack, { effort, ...(type ? { output: type } : {}) }).skills.map((name) => byName.get(name));
      assert.deepEqual(skillProblems(loaded), [], `${effort} × ${type ?? "no output"}`);
    }
  }
});

test("each effort skill loads the run's writer skill right before it writes the deliverable, and every skill stays well under half the largest source", () => {
  for (const effort of EFFORTS) assert.match(byNameText(`effort-${effort}`), /writer skill/i, `effort-${effort} names the writer skill`);
  for (const skill of skills) assert.ok(Buffer.byteLength(skill.files["SKILL.md"]) < 20_000, `${skill.name}'s SKILL.md is ${Buffer.byteLength(skill.files["SKILL.md"])} bytes`);
});

/** Every word or mark that has no place in an open skill: a product identity, a gateway tool id or vendor, a tool serve
 *  does not give an agent, an internal path or service, and two words the project never uses. */
const FORBIDDEN = [
  /\bGREP\b/, /\bParcha\b/i, /grep\.ai/i, /\bgrep-cite\b/i,
  /\bparallel:/i, /brightdata/i, /bright data/i, /serpapi/i, /\bxai[:_]/i, /\bgrok\b/i,
  /\bpython\b/i, /pymupdf/i, /\bfitz\b/, /\bbash\b/i, /TaskCreate/, /\bsub-?agents?\b/i,
  /\$CLAUDE_CONFIG_DIR/, /code\.storage/i, /\bClaude\b/, /\bAnthropic\b/, /\bCodex\b/,
  /\/(?:home|Users)\/[A-Za-z0-9._-]+\//, /smoking gun/i, /\bhonest/i,
];

function byNameText(name) {
  return Object.values(skills.find((skill) => skill.name === name)?.files ?? {}).join("\n");
}

test("no bundled file carries a product identity, a gateway tool id, a shell or python recipe, an internal path, or a word the project never uses", () => {
  for (const skill of skills) {
    for (const [path, text] of Object.entries(skill.files)) {
      if (path === "LICENSE.txt") continue;
      for (const pattern of FORBIDDEN) assert.doesNotMatch(text, pattern, `${skill.name}/${path}`);
    }
  }
  assert.doesNotMatch(JSON.stringify(pack), new RegExp(FORBIDDEN.map((pattern) => pattern.source).join("|"), "i"));
});

test("the slides skill, adapted from frontend-slides (MIT), carries that project's notice, and serve's NOTICE names it", async () => {
  const slides = skills.find((skill) => skill.name === "slides");
  assert.match(slides.files["LICENSE.txt"] ?? "", /^MIT License\n\nCopyright \(c\) 2025 Zara Zhang\n/);
  assert.match(slides.files["LICENSE.txt"], /The above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software\./);
  assert.match(slides.files["SKILL.md"], /frontend-slides/);
  assert.match(slides.files["SKILL.md"], /https:\/\/github\.com\/zarazhangrui\/frontend-slides/);
  const notice = await readFile(new URL("../NOTICE", import.meta.url), "utf8");
  assert.match(notice, /frontend-slides \(https:\/\/github\.com\/zarazhangrui\/frontend-slides\), Copyright \(c\) 2025 Zara Zhang, licensed under the MIT License/);
  assert.ok(existsSync(join(skillsDir, "slides", "LICENSE.txt")));
});
