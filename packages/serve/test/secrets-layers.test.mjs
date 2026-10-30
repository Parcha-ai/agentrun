// Each layer that keeps the server's secrets out of a run's reach, pinned on its own. The run's process also deletes every
// listed name from its environment as it starts (secrets.ts), which would hide a layer that stopped working; these tests
// do not rely on it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { childEnv } from "../dist/runs.js";
import { SECRET_NAMES, withSecrets } from "../dist/secrets.js";

test("childEnv hands a run's process none of the server's secrets and not the token by value, whatever environment it is given; the rest passes", () => {
  const secrets = Object.fromEntries(SECRET_NAMES.map((name) => [name, `canary-${name}`]));
  const token = `ar_test_${"t".repeat(40)}`;
  const out = childEnv({ ...secrets, TOKEN_COPY: token, PATH: "/usr/bin", AGENT_MODEL: "m-1" }, token);
  assert.deepEqual(Object.keys(out).filter((name) => SECRET_NAMES.includes(name)), [], "a listed secret reached the run's environment");
  assert.equal(out.TOKEN_COPY, undefined, "the token by value, under another name");
  assert.deepEqual([out.PATH, out.AGENT_MODEL], ["/usr/bin", "m-1"]);
});

test("withSecrets gives this process a secret to read by name, but never as a key: not in Object.keys, a spread or JSON, so a child given the object never gets it", (t) => {
  const name = SECRET_NAMES.find((n) => n === "OPENAI_API_KEY") ?? SECRET_NAMES.at(-1);
  const canary = `canary-${name}-${process.pid}`;
  const before = process.env[name];
  t.after(() => (before === undefined ? delete process.env[name] : (process.env[name] = before)));
  process.env[name] = canary;
  const env = withSecrets({ PATH: "/usr/bin" });
  assert.equal(env[name], canary, "read by name");
  assert.deepEqual(Object.keys(env).filter((key) => SECRET_NAMES.includes(key)), [], "a secret is an enumerable key");
  assert.equal({ ...env }[name], undefined, "a spread carries it");
  assert.equal(JSON.stringify(env).includes(canary), false, "JSON carries it");
});
