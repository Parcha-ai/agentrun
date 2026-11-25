// A timeline read with calls=whole carries each call's arguments (tool_input) whole to CALL_RESULT_CHARS, through the
// run's cut, on the served route: a grader reads a long write's tail, and a value the server holds in it reads
// [redacted]. The rows' preview and summary keep their own bound. The agent is played by fixtures/faux-template-eval.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CAPS } from "../dist/timeline/index.js";
import { agent, follow, serve } from "./support.mjs";

const FAUX = new URL("./fixtures/faux-template-eval.mjs", import.meta.url).pathname;

// A held value, made at runtime (no credential-shaped literal for the source export), in this process's environment
// under a key's name: the server holds it (hostSecrets), so it is in every run's cut.
const HELD = ["not", "a", "real", "key", "calls", "input", "7d2e9a41c0b8"].join("-");
process.env.AGENTRUN_TEST_CALLS_INPUT_API_KEY = HELD;
const forms = [HELD, Buffer.from(HELD).toString("base64"), encodeURIComponent(HELD)];

test("a calls=whole read carries a 5,000-character argument whole, a held value near its end read [redacted], on the served route", { timeout: 180_000 }, async (t) => {
  const { api } = await serve(t, { faux: FAUX });
  assert.equal((await api("POST", "/agents", agent("writer", { tools: ["write"] }))).status, 201);
  // About 5,000 characters, the held value near character 4,000: past the 2,000 a row's own text is cut at.
  const head = "line ".repeat(800);
  const tail = "tail ".repeat(190);
  const args = { path: "notes/long.md", content: `${head}{{env:AGENTRUN_TEST_CALLS_INPUT_API_KEY}} ${tail}end` };
  const started = await api("POST", "/agents/writer/runs", { input: { content: `Call write with ${JSON.stringify(args)}\nAnswer:\nWrote it.` } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  await follow(api, runId, ["completed", "failed"], { deadlineMs: 150_000 });
  const whole = await api("GET", `/runs/${runId}/timeline?calls=whole`);
  assert.equal(whole.status, 200, JSON.stringify(whole.body));
  const row = whole.body.rows.find((r) => r.kind === "tool_use" && r.tool_name === "write");
  assert.ok(row, JSON.stringify(whole.body.rows.map((r) => [r.kind, r.tool_name])));
  assert.equal(row.tool_input.content, `${head}[redacted] ${tail}end`, "whole, the held value redacted");
  assert.equal(row.tool_input.path, "notes/long.md");
  assert.ok(row.summary.length <= CAPS.preview && (row.tool_input_preview ?? "").length <= CAPS.preview, "the summary and the preview keep their bound");
  const page = JSON.stringify(whole.body);
  assert.deepEqual(forms.filter((form) => page.includes(form)), [], "no form of the held value on the page");
});
