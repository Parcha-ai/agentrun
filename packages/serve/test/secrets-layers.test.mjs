// Each layer that keeps the server's secrets out of a run's reach, pinned on its own. The run's process also deletes every
// listed name from its environment as it starts (secrets.ts), which would hide a layer that stopped working; these tests
// do not rely on it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { childEnv } from "../dist/runs.js";
import { SECRET_NAMES, withoutSecrets, withSecrets } from "../dist/secrets.js";

test("childEnv hands a run's process none of the server's secrets and not the token by value, whatever environment it is given; the rest passes", () => {
  const secrets = Object.fromEntries(SECRET_NAMES.map((name) => [name, `canary-${name}`]));
  const token = `ar_test_${"t".repeat(40)}`;
  const out = childEnv({ ...secrets, TOKEN_COPY: token, PATH: "/usr/bin", AGENT_MODEL: "m-1" }, token);
  assert.deepEqual(Object.keys(out).filter((name) => SECRET_NAMES.includes(name)), [], "a listed secret reached the run's environment");
  assert.equal(out.TOKEN_COPY, undefined, "the token by value, under another name");
  assert.deepEqual([out.PATH, out.AGENT_MODEL], ["/usr/bin", "m-1"]);
});

test("childEnv also leaves out every name shaped like a key that no list names (`*_API_KEY`, `*_TOKEN`, any with SECRET), and passes what a run's process reads: the AGENT_MODEL variables, a provider's settings, the pipe's own descriptor and length", () => {
  const token = `ar_test_${"t".repeat(40)}`;
  const unlisted = ["ACME_API_KEY", "GITHUB_TOKEN", "GH_TOKEN", "NPM_TOKEN", "NODE_AUTH_TOKEN", "CLIENT_SECRET", "MY_SECRET_THING"];
  for (const name of unlisted) assert.ok(!SECRET_NAMES.includes(name), `${name} is on no list`);
  const passes = { PATH: "/usr/bin", HOME: "/home/x", AGENT_MODEL: "google/gemini-2.5-flash", AGENT_MODEL_FAST: "m-fast", AGENT_MODEL_BASE_URL: "http://127.0.0.1:1", AGENT_MODEL_PRICE: "1,2", AGENT_THINKING: "low", AWS_REGION: "us-east-1", AWS_PROFILE: "p", GOOGLE_CLOUD_PROJECT: "p", AZURE_OPENAI_BASE_URL: "http://127.0.0.1:2", ANTHROPIC_BASE_URL: "http://127.0.0.1:3", AGENTRUN_SERVE_EFFORT: "low", AGENTRUN_SERVE_DECISION_KEY_FD: "4" };
  const out = childEnv({ ...Object.fromEntries(unlisted.map((name) => [name, `canary-${name}`])), ...passes }, token);
  assert.deepEqual(unlisted.filter((name) => name in out), [], "a key-shaped name reached the run's environment");
  assert.deepEqual(out, passes, "what a run's process reads passes, whole");
  // The pipe's own variables are set for the run after this cut, but match the rule: they pass it by name.
  assert.deepEqual(withoutSecrets({ AGENTRUN_SECRETS_FD: "3", AGENTRUN_SECRETS_LEN: "12" }), { AGENTRUN_SECRETS_FD: "3", AGENTRUN_SECRETS_LEN: "12" });
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
