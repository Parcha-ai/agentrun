// The fake mail account (src/email/email-faux.ts) is runtime code, kept for template-eval.ts's evals, and the server's real
// email path never reaches it: the account routes name no fake (no preset or field picks one), the fake's own servers by
// any name but 127.0.0.1 are not reached in the clear, and only the template evals reach it: email-faux.ts is imported by
// eval-mailbox.ts and template-eval.ts alone, eval-mailbox.ts by template-eval.ts alone, and template-eval.ts by cli.ts
// alone, as a dynamic import in its eval-template command, so the server (server.ts, the runner) never loads it.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { test } from "node:test";
import { serve, withEnv } from "./support.mjs";
import { accountBody, mailbox } from "./email-support.mjs";

const SRC = new URL("../src/", import.meta.url).pathname;
/** Each module of the evals' fake mail, and the server files that may import it: the template evals alone. */
const MAY_IMPORT = {
  "email/email-faux.ts": ["eval-mailbox.ts", "template-eval.ts"],
  "eval-mailbox.ts": ["template-eval.ts"],
  "template-eval.ts": ["cli.ts"],
};

test("the account routes refuse the fake: no preset or field names it, and its servers by a name are not reached in the clear", { timeout: 60_000 }, async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") });
  const { api } = await serve(t, { runner: false });
  const faux = await mailbox(t);
  for (const [path, method] of [["/settings/email", "PUT"], ["/settings/email/test", "POST"]]) {
    const named = await api(method, path, accountBody(faux, { preset: "faux" }));
    assert.equal(named.status, 422, `${method} ${path}: ${JSON.stringify(named.body)}`);
    assert.deepEqual(named.body.error.fields.map((f) => [f.field, f.reason]), [["preset", "not_an_option"]]);
    const flagged = await api(method, path, accountBody(faux, { faux: true }));
    assert.equal(flagged.status, 422, `${method} ${path}: ${JSON.stringify(flagged.body)}`);
    assert.deepEqual(flagged.body.error.fields.map((f) => f.field), ["faux"]);
  }
  // By name the fake is a server like any other: TLS is required of it, which it never offers, so it is never signed in to.
  const byName = accountBody(faux, { imap: { host: "localhost", port: faux.imap.port }, smtp: { host: "localhost", port: faux.smtp.port } });
  const tested = await api("POST", "/settings/email/test", byName);
  assert.equal(tested.status, 200, JSON.stringify(tested.body));
  assert.deepEqual([tested.body.ok, tested.body.imap.ok, tested.body.smtp.ok], [false, false, false], JSON.stringify(tested.body));
});

/** The server's files, each with the files it imports (static or dynamic, by a relative name), comments left out. */
function importGraph() {
  const files = readdirSync(SRC, { recursive: true }).filter((name) => /\.(ts|mts)$/.test(name) && !name.endsWith(".d.ts"));
  assert.ok(files.length > 100, `read the server's files: ${files.length}`);
  const known = new Set(files);
  const graph = new Map();
  for (const name of files) {
    const code = readFileSync(join(SRC, name), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const imported = [];
    for (const [, how, spec] of code.matchAll(/(from\s*|import\s*\(\s*|require\s*\(\s*|^\s*import\s+)["'](\.{1,2}\/[^"']+)["']/gm)) {
      const file = normalize(join(dirname(name), spec)).replace(/\.[cm]?js$/, ".ts");
      if (known.has(file)) imported.push({ file, dynamic: how.startsWith("import") && how.includes("(") });
    }
    graph.set(name, { code, imported });
  }
  return graph;
}

test("only the template evals reach the fake mail account: email-faux by eval-mailbox and template-eval, eval-mailbox by template-eval, template-eval by the CLI's eval-template command alone", () => {
  const graph = importGraph();
  const importersOf = (target) => [...graph].filter(([, { imported }]) => imported.some((one) => one.file === target)).map(([name]) => name).sort();
  for (const [module, may] of Object.entries(MAY_IMPORT)) {
    assert.ok(graph.has(module), `${module} is a server file`);
    assert.deepEqual(importersOf(module).filter((name) => !may.includes(name)), [], `only ${may.join(" and ")} import ${module}`);
  }
  // Transitively: every file that reaches the fake through any chain of imports is one of the evals' own, or the CLI.
  const reaching = new Set(["email/email-faux.ts"]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [name, { imported }] of graph) if (!reaching.has(name) && imported.some((one) => reaching.has(one.file))) grew = reaching.add(name) && true;
  }
  assert.deepEqual([...reaching].sort(), ["cli.ts", "email/email-faux.ts", "eval-mailbox.ts", "template-eval.ts"]);
  assert.ok(!reaching.has("server.ts"));
  // The CLI loads template-eval only when its command is eval-template: one dynamic import, inside that command's branch.
  const cli = graph.get("cli.ts");
  const edges = cli.imported.filter((one) => one.file === "template-eval.ts");
  assert.deepEqual(edges.map((one) => one.dynamic), [true], "cli.ts imports template-eval once, dynamically");
  const at = cli.code.search(/import\(\s*["']\.\/template-eval\.js["']\s*\)/);
  const branch = [...cli.code.slice(0, at).matchAll(/^if \(process\.argv\[2\] === "([^"]+)"\) \{$/gm)].at(-1);
  assert.equal(branch?.[1], "eval-template", "the import is in the eval-template command's branch");
  assert.ok(!/^\}$/m.test(cli.code.slice(branch.index, at)), "and that branch has not closed before it");
});
