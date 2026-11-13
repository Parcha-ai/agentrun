// Each layer that keeps the server's secrets out of a run's reach, pinned on its own. The run's process also deletes every
// listed name from its environment as it starts (secrets.ts), which would hide a layer that stopped working; these tests
// do not rely on it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import * as secretCut from "../dist/secret-cut.js";
import * as secrets from "../dist/secrets.js";

const { SECRET_NAMES, withoutSecrets, withSecrets } = secrets;

/** Names of keys no list names, each with a segment that makes it one, in any case, wherever it is in the name. */
const UNLISTED = ["FOO_API_KEY", "GITHUB_TOKEN", "GH_TOKEN", "NPM_TOKEN", "NODE_AUTH_TOKEN", "CLIENT_SECRET", "MY_SECRET_THING", "DB_PASSWORD", "Db_PassWord_Hash", "db_passwd",
  "SERVICE_KEY", "SUPABASE_SERVICE_ROLE_KEY", "STRIPE_KEY", "SSH_PRIVATE_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "X_Credential", "DB_PASS", "GH_PAT", "MY_TOKEN_FILE", "FOO_TOKEN_BAR", "GITHUB_TOKEN_RO", "OPENAI_API_KEY_2", "SENTRY_DSN", "DB_PWD", "mysql_pwd"];
/** Names that are no key's, however close: the shell's working directories, and words that hold a segment's letters. */
const NOT_KEYS = { PWD: "/w", OLDPWD: "/o", TOKENIZERS_PARALLELISM: "false", KEYBOARD: "us", SECRETARY: "ok", PATTERN: "x", COMPASS: "n", PASSENGER_APP: "a", AGENTRUN_SECRETS_FD: "3", AGENTRUN_SECRETS_LEN: "12" };

test("one rule names a key, for a run's environment and the import's cut alike: what one leaves out by its name the import cuts by its value", async () => {
  const value = (name) => `canary-value-of-${name}`;
  const names = [...UNLISTED, "AWS_SECRET_ACCESS_KEY", "MYSQL_PASSWORD_FILE", "PATH", "AGENT_MODEL", "AWS_REGION", ...Object.keys(NOT_KEYS)];
  const env = Object.fromEntries(names.map((name) => [name, value(name)]));
  const dropped = names.filter((name) => !(name in withoutSecrets(env)));
  const { text } = secretCut.secretCut(env);
  const cut = names.filter((name) => !text(`said ${value(name)}`).includes(value(name)));
  assert.deepEqual(dropped, [...UNLISTED, "AWS_SECRET_ACCESS_KEY", "MYSQL_PASSWORD_FILE"], "every key's name, and nothing else");
  assert.deepEqual(cut, dropped, "the import's cut cuts each one's value, and no other");
  // The rule is secret-name.ts', written once, and the same function here.
  const rule = await import("../dist/secret-name.js");
  assert.equal(secretCut.keyShaped, rule.keyShaped, "serve's cut uses the one rule");
  assert.deepEqual(names.filter((name) => rule.keyShaped(name)), dropped);
});

test("no allow list lets a key-shaped name past the rule: a run's own descriptors are set on its environment after the cut, and match no segment", () => {
  assert.equal("RUN_ENV_ALLOW" in secrets, false, "no allow list");
  for (const name of [secrets.SECRETS_FD_ENV, secrets.SECRETS_LEN_ENV]) assert.equal(secretCut.keyShaped(name), false, `${name} is no key's name`);
});

test("withSecrets gives this process a secret to read by name, but never as a key: not in Object.keys, a spread or JSON, so a child given the object never gets it", () => {
  // In a process of its own, whose environment is only PATH and a canary under a secret's name: secrets.js holds what
  // its process had at import, so a key this test process was started with would stand in for the canary. The child
  // answers in booleans, never a value.
  const name = "OPENAI_API_KEY";
  assert.ok(SECRET_NAMES.includes(name), `${name} is one of the launcher's secrets`);
  const canary = `canary-${name}-${process.pid}`;
  const script = `const { withSecrets } = await import(${JSON.stringify(new URL("../dist/secrets.js", import.meta.url).href)});
const name = ${JSON.stringify(name)};
const expected = process.env.SECRETS_LAYERS_EXPECT;
const env = withSecrets({ PATH: "/usr/bin" });
process.stdout.write(JSON.stringify({ read: env[name] === expected, keys: Object.keys(env).includes(name), spread: { ...env }[name] !== undefined, json: JSON.stringify(env).includes(expected), left: process.env[name] !== undefined }));`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env: { PATH: process.env.PATH, [name]: canary, SECRETS_LAYERS_EXPECT: canary }, encoding: "utf8" });
  assert.equal(child.status, 0, `the child failed: ${child.stderr.slice(0, 500)}`);
  assert.deepEqual(JSON.parse(child.stdout), { read: true, keys: false, spread: false, json: false, left: false }, "read by name; never a key, a spread or JSON; gone from the environment");
});
