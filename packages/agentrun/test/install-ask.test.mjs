// install.sh asks before it makes AgentRun a service of the user (GRE-4837): want_service, run on its own with the
// terminal it asks on standing in as a file. Yes only for y or yes; No for anything else, and always under --no-service;
// with no terminal to ask in, yes, as the installer did before it asked.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const INSTALL = new URL("../install.sh", import.meta.url);
const wantService = /^want_service\(\) \{\n[\s\S]*?\n\}\n/m.exec(await readFile(INSTALL, "utf8"))?.[0];

async function ask(t, { answer, noService = "", terminal = true }) {
  const dir = await mkdtemp(join(tmpdir(), "install-ask-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tty = terminal ? join(dir, "tty") : join(dir, "none", "tty");
  if (terminal) await writeFile(tty, answer === undefined ? "" : `${answer}\n`);
  await writeFile(join(dir, "script.sh"), `set -u\nno_service=${noService}\n${wantService}want_service ${tty}\n`);
  return promisify(execFile)("sh", [join(dir, "script.sh")]).then(() => 0, (e) => e.code);
}

test("install.sh has want_service", () => assert.ok(wantService, "want_service() { ... } in install.sh"));

test("a service only for y or yes; No for anything else, an empty line included", async (t) => {
  for (const yes of ["y", "Y", "yes", "YES"]) assert.equal(await ask(t, { answer: yes }), 0, yes);
  for (const no of ["", "n", "no", "maybe"]) assert.equal(await ask(t, { answer: no }), 1, JSON.stringify(no));
});

test("--no-service says no without asking, and no terminal to ask in keeps the service, as before", async (t) => {
  assert.equal(await ask(t, { answer: "y", noService: "1" }), 1);
  assert.equal(await ask(t, { terminal: false }), 0);
});
