// The generated layer: a consumer that uses the client as documented typechecks against the built package, and one that
// passes a wrong body field (or calls what the client does not have) fails on exactly those lines; generate-clients
// --check fails on a hand-edited operations.generated.ts, whose hash is the CLI table's.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const ROOT = new URL("../../../", import.meta.url).pathname;
const TYPES = new URL("./types/", import.meta.url).pathname;
const GENERATED = join(ROOT, "packages", "client", "src", "operations.generated.ts");
const GENERATOR = join(ROOT, "scripts", "generate-clients.mjs");
const TSC = join(ROOT, "node_modules", "typescript", "bin", "tsc");

const typecheck = (file) => spawnSync(process.execPath, [TSC, "--noEmit", "--strict", "--target", "es2023", "--module", "nodenext", "--moduleResolution", "nodenext", "--types", "node", "--skipLibCheck", join(TYPES, file)], { cwd: ROOT, encoding: "utf8", timeout: 120_000 });

test("a consumer of the documented calls typechecks; a wrong body field, a wrong type, a missing field, an unknown method fail on their lines", { timeout: 240_000 }, () => {
  const ok = typecheck("ok.ts");
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  const bad = typecheck("bad.ts");
  assert.equal(bad.status, 2, bad.stdout + bad.stderr);
  const marked = readFileSync(join(TYPES, "bad.ts"), "utf8").split("\n").flatMap((line, i) => (line.endsWith("// error") ? [i + 1] : []));
  const failed = [...new Set([...bad.stdout.matchAll(/bad\.ts\((\d+),\d+\): error TS\d+/g)].map((match) => Number(match[1])))];
  assert.deepEqual(failed, marked, bad.stdout);
  assert.match(bad.stdout, /'definitio' does not exist/);
});

test("generate-clients --check passes on the committed file and fails on a hand-edited one; the file's hash is the CLI table's", { timeout: 120_000 }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "agentrun-client-check-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const check = (...args) => spawnSync(process.execPath, [GENERATOR, "--check", ...args], { cwd: ROOT, encoding: "utf8", timeout: 60_000 });
  const committed = check();
  assert.equal(committed.status, 0, committed.stderr);
  const text = readFileSync(GENERATED, "utf8");
  const edited = join(dir, "operations.generated.ts");
  writeFileSync(edited, text.replace("start: (agentId: string, body: CreateRunBody", "begin: (agentId: string, body: CreateRunBody"));
  assert.notEqual(readFileSync(edited, "utf8"), text);
  const stale = check("--client", edited);
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /operations\.generated\.ts is not the server's document's; run node scripts\/generate-clients\.mjs/);
  const hash = (file) => /SHA-256 of what the (?:table|clients) (?:is|are) made of [^\n]*: ([0-9a-f]{64})/.exec(readFileSync(file, "utf8"))?.[1];
  assert.ok(hash(GENERATED));
  assert.equal(hash(GENERATED), hash(join(ROOT, "packages", "agentrun", "lib", "commands.generated.mjs")));
});

// Two pull requests that change two different operations each regenerate every output. Git merges each output's two
// sides over their base with no conflict, and the merge is what the generator makes from the document with both changes:
// no line of any output changes with every change to the document.
test("two changes to different operations regenerate without a shared changed line: every output merges clean, into the output of both changes", { timeout: 240_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "agentrun-client-merge-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { servedDocument } = await import(GENERATOR);
  const served = await servedDocument();
  const OUTPUTS = { out: "commands.generated.mjs", client: "operations.generated.ts", python: "_generated.py", types: "api.generated.ts" };
  const FILES = [...Object.values(OUTPUTS), join("skill", "SKILL.md"), join("skill", "references", "commands.md")];
  const generate = (name, doc) => {
    const document = join(dir, `${name}.json`);
    writeFileSync(document, JSON.stringify(doc));
    const flags = Object.entries(OUTPUTS).flatMap(([flag, file]) => [`--${flag}`, join(dir, name, file)]);
    const made = spawnSync(process.execPath, [GENERATOR, "--document", document, ...flags, "--skill", join(dir, name, "skill")], { cwd: ROOT, encoding: "utf8", timeout: 60_000 });
    assert.equal(made.status, 0, made.stderr);
    return (file) => join(dir, name, file);
  };
  // The first and the last operation that takes a JSON body: a new summary, and a new optional field in its body.
  const ops = Object.values(served.paths).flatMap((item) => Object.values(item)).filter((op) => op?.operationId && op.requestBody?.content?.["application/json"]?.schema);
  const [x, y] = [ops.at(0).operationId, ops.at(-1).operationId].sort();
  assert.notEqual(x, y);
  const change = (doc, id) => {
    const op = Object.values(doc.paths).flatMap((item) => Object.values(item)).find((o) => o?.operationId === id);
    op.summary = `${op.summary ?? id}, changed`;
    let schema = op.requestBody.content["application/json"].schema;
    while (schema.$ref) schema = schema.$ref.slice(2).split("/").reduce((at, key) => at[key], doc);
    schema.properties = { ...schema.properties, [`${id}_probe`]: { type: "string" } };
    return doc;
  };
  const base = generate("base", served);
  const a = generate("a", change(structuredClone(served), x));
  const b = generate("b", change(structuredClone(served), y));
  const both = generate("both", change(change(structuredClone(served), x), y));
  for (const file of FILES) {
    const merged = spawnSync("git", ["merge-file", "-p", "-L", "a", "-L", "base", "-L", "b", a(file), base(file), b(file)], { encoding: "utf8" });
    const conflict = merged.stdout.slice(merged.stdout.indexOf("<<<<<<< a"), merged.stdout.indexOf(">>>>>>> b") + 9);
    assert.equal(merged.status, 0, `${file}: ${merged.status} conflicting hunk(s) merging ${x}'s change with ${y}'s, the first:\n${conflict}`);
    assert.equal(merged.stdout, readFileSync(both(file), "utf8"), `${file}: the merge is not the output of both changes`);
  }
  // Each change reached every output but the skill's SKILL.md, which names a group's commands and not their fields.
  for (const file of FILES.filter((f) => !f.endsWith("SKILL.md"))) {
    assert.notEqual(readFileSync(a(file), "utf8"), readFileSync(base(file), "utf8"), `${x}'s change reaches ${file}`);
    assert.notEqual(readFileSync(b(file), "utf8"), readFileSync(base(file), "utf8"), `${y}'s change reaches ${file}`);
  }
});
