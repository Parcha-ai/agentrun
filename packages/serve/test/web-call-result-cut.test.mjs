// A web call's answer passes the run's one redactor before the harness stores it (adapter-run-spec.ts answersCut, the pi
// spec's and the CLI spec's). That redactor reads a run of more than 8,192 characters with no whitespace as "[redacted]"
// (key-refusal.ts redactedAnswer), and a web_fetch's JSON line is one such run from its page text's last space through
// its whole links array: cut as one text, the line lost its links and no longer parsed, so a grader's link check found
// none of them (autoqa, oss-tracker on f6a55a2: a releases.atom fetch on pi and on claude-agent). Each string of a web
// call's JSON is cut by itself, so the stored answer parses and keeps every link, and a held value is still cut.
import assert from "node:assert/strict";
import { test } from "node:test";
import { answersCut } from "../dist/runner/adapter-run-spec.js";
import { secretRedactor } from "../dist/runner/redact.js";
import { CALL_RESULT_CHARS, webShownOf, webWithin } from "../dist/timeline/index.js";
import { graderInput } from "../dist/template-eval.js";
import { webFetchText } from "../dist/web-fetch.js";

const URL = "https://github.com/vitejs/vite/releases.atom";
// A held value, made at runtime: no credential-shaped literal for the source export.
const HELD = ["not-a-secret", "held", "0123456789"].join("-");
const LINKS = Array.from({ length: 20 }, (_, i) => `https://github.com/vitejs/vite/releases/tag/v8.3.${i}`);
// An Atom feed's escaped content: its newlines are "\n" in the JSON line, so from its last space on it is one run of
// more than 8,192 characters with no whitespace, as releases.atom's was.
const ESCAPED = Array.from({ length: 120 }, (_, i) => `&lt;li&gt;(&lt;a\nhref=&quot;https://github.com/vitejs/vite/pull/${24000 + i}&quot;&gt;#${24000 + i}&lt;/a&gt;)&lt;/li&gt;`).join("\n");
const PAGE = { ok: true, url: URL, status: 200, title: "", text: `<feed>\n  <title>Release notes from vite</title> token ${HELD}\n${ESCAPED}`, chars: 0, links: LINKS, via: "direct", truncated: true, next_offset: 9000, original_chars: 35475 };
PAGE.chars = PAGE.text.length;

const fetchTool = (name = "web_fetch") => ({ name, description: "", inputSchema: {}, replay: "safe", call: async () => ({ text: webFetchText(PAGE) }) });
const context = { callId: "call-6", signal: new AbortController().signal };

test("a web_fetch answer the run's redactor cuts still parses and keeps every link; a held value in its text is still cut", async () => {
  assert.ok(ESCAPED.length > 8192 && !/\s/.test(JSON.stringify(ESCAPED)));
  const { text: stored } = await answersCut(fetchTool(), secretRedactor([HELD])).call({ url: URL }, context);
  const [line, ...after] = stored.split("\n");
  const read = JSON.parse(line);
  assert.deepEqual(read.links, LINKS);
  assert.equal(read.url, URL);
  assert.ok(!stored.includes(HELD) && read.text.includes("[redacted]"));
  // The line after the JSON (where this part is in the page) is kept, cut by the same redactor.
  assert.deepEqual(after, [`Characters 0-${PAGE.chars} of 35475: call web_fetch again with offset=9000 for the rest.`]);
});

test("a cited link from a web_fetch answer the redactor cut matches it in a grader's link check, read as the timeline reads it", async () => {
  const { text: stored } = await answersCut(fetchTool(), secretRedactor([HELD])).call({ url: URL }, context);
  // As a timeline read with `calls` shows it (timeline.ts resultText): the web call's JSON read, its texts cut to fit.
  const shown = webShownOf("web_fetch", stored);
  assert.ok(shown, "the stored answer is web_fetch's JSON");
  const result = webWithin(shown, CALL_RESULT_CHARS);
  const run = { answer: `vite shipped ${LINKS[17]} this week.`, calls: [{ tool: "web_fetch", name: "web_fetch", arguments: { url: URL }, status: "success", result }], mcpCalls: [], files: [] };
  const prompt = graderInput({ file: "links.md", type: "llm", rubric: "Pass only if every cited link appears in the run's calls." }, "task", run);
  assert.match(prompt, new RegExp(`${LINKS[17].replaceAll(".", "\\.")} — matches call 1`));
});

test("any other tool's answer is cut as one text, as before", async () => {
  const { text: stored } = await answersCut(fetchTool("read"), secretRedactor([HELD])).call({}, context);
  assert.ok(!stored.includes(HELD));
  assert.throws(() => JSON.parse(stored.split("\n")[0]));
});
