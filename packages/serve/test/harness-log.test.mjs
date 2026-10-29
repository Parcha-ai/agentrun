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

test("a key holding a quote or a backslash is cut out too: values are scrubbed before JSON escapes them", () => {
  const lines = [];
  const awkward = `not-a-secret-${'q"uo\\te'}`;
  const log = harnessLog("codex", { OPENAI_API_KEY: awkward }, (line) => lines.push(line));
  log("model proxy (openai): refused", { status: 401, userAgent: `curl ${awkward}`, nested: { why: [`it said ${awkward}`] } });
  const said = JSON.parse(lines[0]);
  assert.equal(said.userAgent, "curl [redacted]");
  assert.deepEqual(said.nested, { why: ["it said [redacted]"] });
  for (const form of [awkward, JSON.stringify(awkward).slice(1, -1)]) assert.ok(!lines[0].includes(form), `${form} is not in the line`);
});

test("a failed run's message is found past more than one read of harness lines, and never from the torn line a read starts in", async (t) => {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "harness-log-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const own = JSON.stringify({ at: "2026-10-29T05:00:00.000Z", event: "fenced", message: "the lease lapsed" });
  const harness = (n) => JSON.stringify({ at: "2026-10-29T05:00:01.000Z", event: "harness", harness: "codex", message: `model proxy (openai): refused ${n}`, padding: "x".repeat(40) });
  // About 30 KB of harness lines after the process's own: many reads back, each starting inside a line.
  const after = Array.from({ length: 250 }, (_, n) => harness(n)).join("\n");
  assert.ok(after.length > 8 * 4096);
  await writeFile(join(dir, "process.log"), `${own}\n${after}\n`);
  assert.equal(await lastLogLine({ dir }), "fenced: the lease lapsed");
  // Harness lines only: the last whole one, never a fragment.
  await writeFile(join(dir, "process.log"), `${after}\n`);
  assert.equal(await lastLogLine({ dir }), "harness: model proxy (openai): refused 249");
});

test("a key is cut as literal text, whatever characters it holds: one full of a pattern's special characters is cut, and nothing else", () => {
  const lines = [];
  const special = `not-a-secret-${"sk+a.b*c(d[e$f?g|h\\i^j{2}"}`;
  harnessLog("codex", { OPENAI_API_KEY: special }, (line) => lines.push(line))("model proxy (openai): refused", { userAgent: `curl ${special} and sk-a-b-c` });
  assert.equal(JSON.parse(lines[0]).userAgent, "curl [redacted] and sk-a-b-c");
});

test("an empty or short value under a key-shaped name cuts nothing: an unset variable's empty string never redacts the whole line", () => {
  const lines = [];
  harnessLog("codex", { EMPTY_API_KEY: "", SHORT_TOKEN: "abc1234", UNSET_SECRET: undefined }, (line) => lines.push(line))("model proxy (openai): abc1234 refused", { status: 401 });
  const said = JSON.parse(lines[0]);
  assert.equal(said.message, "model proxy (openai): abc1234 refused");
  assert.ok(!lines[0].includes("[redacted]"));
});

test("a key holding a quote or a backslash is cut out of a field's name too, at the top level and nested, and out of what an object's toJSON gives", () => {
  const lines = [];
  const awkward = `not-a-secret-${'n"a\\me'}`;
  const log = harnessLog("codex", { OPENAI_API_KEY: awkward }, (line) => lines.push(line));
  log("model proxy (openai): refused", { [awkward]: 1, nested: { [`x-${awkward}`]: [{ [awkward]: true }] }, made: { toJSON: () => ({ said: `it was ${awkward}` }) } });
  const said = JSON.parse(lines[0]);
  assert.equal(said["[redacted]"], 1);
  assert.deepEqual(said.nested, { "x-[redacted]": [{ "[redacted]": true }] });
  assert.deepEqual(said.made, { said: "it was [redacted]" });
  for (const form of [awkward, JSON.stringify(awkward).slice(1, -1)]) assert.ok(!lines[0].includes(form), `${form} is not in the line`);
});
