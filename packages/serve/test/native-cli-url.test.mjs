// `agentrun native connect`'s server URL (native/cli.ts): --url, else AGENTRUN_BASE_URL, else AGENTRUN_URL, else the
// one the server recorded. The server's token goes to it, and fetch's errors print the whole URL, so one with a user, a
// password, a query or a fragment is refused by the name it came by, its origin alone said, and nothing is sent. In
// process, over a fetch stand-in: no server, no network.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { nativeMain } = await import("../dist/native/cli.js");

const NAMES = ["AGENTRUN_BASE_URL", "AGENTRUN_URL", "AGENTRUN_API_KEY", "AGENTRUN_TOKEN"];

/** One `native connect` with `env` over a fetch stand-in: its exit code, its stderr, and the URLs it fetched. */
async function connect(t, { args = [], env = {} } = {}) {
  const data = await mkdtemp(join(tmpdir(), "agentrun-native-cli-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  await writeFile(join(data, ".token"), "fake-test-key");
  const saved = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));
  const fetched = [];
  const said = [];
  const { fetch, console: { error, log } } = globalThis;
  for (const name of NAMES) delete process.env[name];
  Object.assign(process.env, env);
  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    return new Response(JSON.stringify({ connected: true }), { status: 200, headers: { "content-type": "application/json" } });
  };
  console.error = (line) => said.push(String(line));
  console.log = () => {};
  try {
    const code = await nativeMain(["connect", "--project", data, "--runtime", "codex", "--data", data, "--no-sync", ...args], "usage");
    return { code, stderr: said.join("\n"), fetched };
  } finally {
    globalThis.fetch = fetch;
    console.error = error;
    console.log = log;
    for (const [name, value] of Object.entries(saved)) value === undefined ? delete process.env[name] : (process.env[name] = value);
  }
}

test("a loopback server URL with no user, password, query or fragment is the one connected to", async (t) => {
  const plain = await connect(t, { env: { AGENTRUN_URL: "http://127.0.0.1:9" } });
  assert.equal(plain.code, 0, plain.stderr);
  assert.deepEqual(plain.fetched, ["http://127.0.0.1:9/v2/native/connect"]);
});

test("a server URL with a user, password, query or fragment is refused by the name it came by, its origin alone said, and nothing is sent", async (t) => {
  const FAKE = "not-a-secret";
  const credentialed = "http://agent:" + FAKE + "@127.0.0.1:9";
  for (const url of [credentialed, "http://127.0.0.1:9/?key=not-a-secret", "http://127.0.0.1:9/#not-a-secret"]) {
    for (const [name, given] of [["--url", { args: ["--url", url] }], ["AGENTRUN_BASE_URL", { env: { AGENTRUN_BASE_URL: url } }], ["AGENTRUN_URL", { env: { AGENTRUN_URL: url } }]]) {
      const refused = await connect(t, given);
      assert.equal(refused.code, 2, `${name}=${url}`);
      assert.deepEqual(refused.fetched, [], `${name}=${url}: nothing sent`);
      assert.ok(refused.stderr.startsWith(`agentrun native: ${name} `), `${name}=${url}: ${refused.stderr}`);
      assert.match(refused.stderr, /http:\/\/127\.0\.0\.1:9/, `${name}=${url}`);
      assert.doesNotMatch(refused.stderr, /not-a-secret|key=|agent:/, `${name}=${url}`);
    }
  }
});
