// A CLI run (claude-agent, codex) on a server whose secrets came over its launcher's pipe: the runner's run environment
// (runEnv) holds each secret readable by name and never enumerable, and the CLI run's environment (cli-run-spec.ts
// cliRunEnv) must keep it so: its model route reads the key by name (model.ts, `env[row.field]`), while a program a run
// spawns with that environment carries none. A spread of the run environment dropped every secret, and the route sent no
// key at all.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

// As the launcher hands it: the secrets module takes it at its load (secrets.ts), and runEnv gives it to the runs.
const KEY = "test-model-key-not-real";
process.env.ANTHROPIC_API_KEY = KEY;
const { runEnv } = await import("../dist/runner/main.js");
const { cliRunEnv } = await import("../dist/runner/cli-run-spec.js");
const { hostModel } = await import("../dist/model.js");
const { DATA_ENV } = await import("../dist/server-fs.js");

/** The names a program started with `env` sees in its environment. */
const seenBy = (env) => spawnSync("sh", ["-c", "env"], { encoding: "utf8", env }).stdout.split("\n").map((line) => line.slice(0, Math.max(0, line.indexOf("=")))).filter(Boolean);

test("a CLI run's environment keeps the run environment's secrets readable by name, so its model route finds the key, while a program it spawns holds none", () => {
  const runs = runEnv({ PATH: process.env.PATH });
  assert.equal(runs.ANTHROPIC_API_KEY, KEY, "the run environment holds the key by name");
  assert.ok(!Object.keys(runs).includes("ANTHROPIC_API_KEY"), "and never enumerates it");

  const env = cliRunEnv(runs, "/data/agentrun");
  assert.equal(env.ANTHROPIC_API_KEY, KEY, "the CLI run's environment holds it by name");
  assert.ok(!Object.keys(env).includes("ANTHROPIC_API_KEY"), "and never enumerates it");
  assert.equal(env[DATA_ENV], "/data/agentrun", "with the server's data directory named");
  assert.equal(hostModel(env, "default", "claude-agent"), "anthropic/claude-sonnet-5-5", "a claude-agent run's route finds the Anthropic key");
  assert.equal(hostModel({ ...runs }, "default", "claude-agent"), undefined, "the spread it replaces kept no key: the route found none");
  assert.ok(!seenBy(env).includes("ANTHROPIC_API_KEY"), "a program spawned with it holds no key");
  assert.ok(seenBy(env).includes(DATA_ENV), "and sees the data directory");
});
