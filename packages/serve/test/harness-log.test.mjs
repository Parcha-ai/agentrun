// A harness's own log lines in the run's log, on their own: one JSON line each, no secret in it, and never the line a
// failed run's message is made of.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HARNESS_LOG_EVENT, harnessLog } from "../dist/adapters.js";
import { failureLine, lastLogLine } from "../dist/runs.js";

const CANARY = "not-a-secret-canary-0123456789";

test("a harness's log line: one JSON line of the run's log format, its path without the query, and no value of a key-shaped variable", () => {
  const lines = [];
  // Placeholders, never real keys: what serve's environment holds under key-shaped names.
  const placeholder = (what) => `not-a-secret-${what}`;
  const env = { AGENT_MODEL_API_KEY: placeholder("model-key"), ANTHROPIC_AUTH_TOKEN: placeholder("auth-token"), MY_SECRET_THING: placeholder("thing-value"), SHORT_TOKEN: "abc", PATH: "/usr/bin" };
  const log = harnessLog("codex", env, (line) => lines.push(line));
  log("model proxy (openai): refused", { status: 401, method: "GET", path: `/?key=${CANARY}`, reason: "this session's key is required", userAgent: `curl not-a-secret-model-key` });
  log("model proxy (openai): responded threw", { error: "the store said not-a-secret-auth-token and not-a-secret-thing-value" });
  assert.equal(lines.length, 2);
  assert.ok(lines.every((line) => line.endsWith("\n") && !line.slice(0, -1).includes("\n")), "one line per call");
  const [refused, threw] = lines.map((line) => JSON.parse(line));
  assert.equal(refused.event, HARNESS_LOG_EVENT);
  assert.deepEqual({ ...refused, at: undefined }, { at: undefined, event: "harness", harness: "codex", message: "model proxy (openai): refused", status: 401, method: "GET", path: "/", reason: "this session's key is required", userAgent: "curl [redacted]" });
  assert.equal(threw.error, "the store said [redacted] and [redacted]");
  assert.ok(!Number.isNaN(Date.parse(refused.at)));
  const all = lines.join("");
  for (const secret of [CANARY, env.AGENT_MODEL_API_KEY, env.ANTHROPIC_AUTH_TOKEN, env.MY_SECRET_THING]) assert.ok(!all.includes(secret), `${secret} is not in the log`);
  assert.ok(all.includes("/usr/bin") === false && !all.includes("abc"), "nothing else of the environment is written");
});

test("a failed run's message is its log's last line past any harness line: a proxy refusal just before a crash is not why the process went", () => {
  const own = JSON.stringify({ at: "2026-10-29T05:00:00.000Z", event: "fenced", message: "the lease lapsed" });
  const harness = JSON.stringify({ at: "2026-10-29T05:00:01.000Z", event: "harness", harness: "codex", message: "model proxy (openai): refused" });
  assert.equal(failureLine(`${own}\n${harness}\n`), own);
  assert.equal(failureLine(`${own}\nplain words from a crash\n${harness}`), "plain words from a crash");
  assert.equal(failureLine(`${harness}\n`), harness, "a log of harness lines only gives its last");
  assert.equal(failureLine(""), "");
});

test("a failed run's message, read from its process.log, is in words of the process's own last line, never a harness line after it", async (t) => {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "harness-log-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const own = JSON.stringify({ at: "2026-10-29T05:00:00.000Z", event: "fenced", message: "the lease lapsed" });
  const harness = JSON.stringify({ at: "2026-10-29T05:00:01.000Z", event: "harness", harness: "codex", message: "model proxy (openai): refused" });
  await writeFile(join(dir, "process.log"), `${own}\n${harness}\n`);
  assert.equal(await lastLogLine({ dir }), "fenced: the lease lapsed");
});

test("a key-shaped variable the environment holds as a non-enumerable property is cut out of the line too", () => {
  const lines = [];
  const env = { PATH: "/usr/bin" };
  const hidden = `not-a-secret-${"hidden-value"}`;
  Object.defineProperty(env, "AGENT_MODEL_API_KEY", { value: hidden, enumerable: false });
  harnessLog("claude-agent", env, (line) => lines.push(line))("model proxy (anthropic): responded threw", { error: `the store said ${hidden}` });
  assert.equal(JSON.parse(lines[0]).error, "the store said [redacted]");
  assert.ok(!lines.join("").includes(hidden));
});
