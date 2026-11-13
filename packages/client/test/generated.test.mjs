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
