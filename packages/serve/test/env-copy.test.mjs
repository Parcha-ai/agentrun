// A copy of an env withSecrets made (secrets.ts). Each secret there is a property that does not enumerate, so a spread of
// the env (`{ ...env }`) keeps none of them: a check that reads a key off such a copy reads no key at all (envAtPlace's
// spread once made every agent in a box read as having no model key while Claude Code's login was on). A copy that is
// read for keys goes through secrets.ts copyEnv, which keeps every own property as it is.
//
// The guard is a scan of the server's sources: in each module that takes from secrets.ts or claude-login.ts (and those
// two), an object spread of an env (`{ ...env`, `{ ...base`, `{ ...working`, `{ ...deps.env`, `{ ...options.env`,
// `{ ...host.env`, `{ ...this.env`) fails it, unless ALLOWED names the line with why no key is read off the copy. A type
// brand on withSecrets' env would not catch it: TypeScript types a spread as keeping every property the type declares,
// a brand's symbol included, and the env goes through many signatures as NodeJS.ProcessEnv. Comments are not code.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import * as secrets from "../dist/secrets.js";
import { withEnv } from "./support.mjs";

const SRC = new URL("../src/", import.meta.url).pathname;

const SPREAD = /\{\s*\.\.\.\s*\(?(env|base|working|deps\.env|options\.env|host\.env|this\.env)\b/;
const COMMENT = /^\s*(\/\/|\*|\/\*\*?)/;
const TAKES = /from\s+["'](?:\.\.?\/)+(?:secrets|claude-login)\.js["']/;

/** The spreads that stay, each a module, a piece of its line, and why no key is read off the copy. */
const ALLOWED = [
  { file: "secrets.ts", text: "const out: NodeJS.ProcessEnv = { ...env };", why: "withSecrets' own start: the env it is given, before it lays the secrets" },
  { file: "server.ts", text: "const schema = { ...base, properties:", why: "a JSON schema, not an env" },
  { file: "import.ts", text: "defaultData({ ...env, HOME: home })", why: "defaultData reads the data folder's variables and HOME, no key" },
  { file: "runner/claim-secrets.ts", text: "const env: NodeJS.ProcessEnv = { ...base };", why: "base is withoutSecrets' cut, plain values; the run's keys are laid on the copy after it" },
  { file: "runner/claim-secrets.ts", text: "withPlan({ ...working }, plan), scoped, revision)", why: "workingEnv's values are plain, enumerable ones" },
  { file: "runner/claim-secrets.ts", text: "const probe = withPlan({ ...working }, plan);", why: "workingEnv's values are plain, enumerable ones" },
  { file: "runner/cli-run-spec.ts", text: "decisionProvidersIn({ ...(deps.env ?? {}), ...(await hostDecisionKeys(", why: "the decision keys are laid over it by hostDecisionKeys, which reads them by name" },
  { file: "runner/run-child-host.ts", text: "decisionProvidersIn({ ...(deps.env ?? {}), ...(await hostDecisionKeys(", why: "the decision keys are laid over it by hostDecisionKeys, which reads them by name" },
  { file: "runner/run-child-host.ts", text: "return { ...env, ...extra, [SECRETS_FD_ENV]:", why: "a run's process environment: its secrets go on its pipe, never on it" },
  { file: "runner/runner-check.ts", text: "openRunnerStore(dataDir, { ...env, [POOL_SIZE_ENV]: \"1\" }", why: "the store's URL is given apart; the copy is read for the pool size" },
];

function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") ? [path] : [];
  });
}

test("copyEnv keeps every own property of a withSecrets env as it is: each secret read by name and never enumerated, which were saved, and a symbol's", (t) => {
  withEnv(t, {}, ["OPENROUTER_API_KEY"]);
  assert.equal(typeof secrets.copyEnv, "function", "secrets.ts has no copyEnv");
  const mark = Symbol("mark");
  const env = secrets.withSecrets({ PATH: "/usr/bin" }, "all", (name) => (name === "OPENROUTER_API_KEY" ? "fake-test-key" : undefined));
  Object.defineProperty(env, mark, { value: "kept", enumerable: true, configurable: true });
  const copy = secrets.copyEnv(env);
  assert.notEqual(copy, env);
  assert.equal(copy.OPENROUTER_API_KEY, "fake-test-key", "the copy lost the saved key");
  assert.ok(secrets.savedIn(copy).has("OPENROUTER_API_KEY"), "the copy no longer says the key was saved");
  assert.ok(!Object.keys(copy).includes("OPENROUTER_API_KEY"), "the copy enumerates a secret");
  assert.equal({ ...copy }.OPENROUTER_API_KEY, undefined, "a spread of the copy carries a secret");
  assert.equal(copy.PATH, "/usr/bin");
  assert.equal(copy[mark], "kept");
  assert.equal(delete copy[mark], true, "a configurable property of the env is not configurable on the copy");
  assert.equal(env[mark], "kept", "a change to the copy reached the env");
});

test("no module that takes from secrets.ts or claude-login.ts spreads an env: a copy read for keys goes through copyEnv; each spread left is ALLOWED with why", () => {
  const found = [];
  for (const path of sources(SRC)) {
    const file = relative(SRC, path);
    const text = readFileSync(path, "utf8");
    if (!TAKES.test(text) && file !== "secrets.ts" && file !== "claude-login.ts") continue;
    text.split("\n").forEach((line, i) => {
      if (!COMMENT.test(line) && SPREAD.test(line)) found.push({ file, at: i + 1, line: line.trim() });
    });
  }
  const allowed = (spread) => ALLOWED.some((entry) => entry.file === spread.file && spread.line.includes(entry.text));
  const strangers = found.filter((spread) => !allowed(spread));
  assert.deepEqual(strangers.map((s) => `${s.file}:${s.at}: ${s.line}`), [], "a module spreads an env that may be withSecrets', which leaves out every secret: copy it with secrets.ts copyEnv, or add the line to ALLOWED with why no key is read off the copy");
  const stale = ALLOWED.filter((entry) => !found.some((spread) => spread.file === entry.file && spread.line.includes(entry.text)));
  assert.deepEqual(stale, [], "an ALLOWED entry names a spread no longer there: take it out");
});
