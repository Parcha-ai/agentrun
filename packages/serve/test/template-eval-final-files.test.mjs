// An llm grader reads the files a run left whole, ahead of its calls (template-eval.ts graderInput, fitFiles). A call
// shows a file only in its arguments or its output, each cut where the timeline cuts it: a write's content at 2,000
// characters, ending "...". Graded on its calls alone, a run whose 2,888-byte timestamps file was whole read to its
// grader as a run that wrote less, and failed (a release-film eval). The package's agent and its grader are played by
// fixtures/faux-template-eval.mjs, whose grader reads a file's text from its <file> block alone.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { evalTemplate, fitFiles, GRADER_PROMPT_MAX, graderInput } from "../dist/template-eval.js";
import { scratch } from "./support.mjs";

const PKG = new URL("./fixtures/templates-eval/evalpkg", import.meta.url).pathname;
const FAUX = new URL("./fixtures/faux-template-eval.mjs", import.meta.url).pathname;
const STATE = await scratch();
process.env.AGENTRUN_TEST_EVAL_GRADER_LOG = join(STATE, "graders.jsonl");
const graderInputs = () => readFileSync(process.env.AGENTRUN_TEST_EVAL_GRADER_LOG, "utf8").trim().split("\n").map((line) => JSON.parse(line));

// A voiceover's word timestamps, one JSON line of about 3,000 characters, its last word past the 2,000 a write's
// content shows in the run's timeline.
const WORDS = Array.from({ length: 60 }, (_, i) => ({ word: `w${i}`, start: i * 0.4, end: i * 0.4 + 0.35 }));
WORDS.push({ word: "END-OF-VOICEOVER", start: 24, end: 24.6 });
const TIMESTAMPS = JSON.stringify({ voice: "narrator", words: WORDS, padding: "x".repeat(400) });
// A held value, made at runtime (no credential-shaped literal for the source export), in this process's environment
// under a key's name: the eval's own server holds it, so its runner cuts it from the calls, and a file holding it is cut too.
const HELD = ["not", "a", "real", "key", "0123456789abcdef"].join("-");
process.env.AGENTRUN_TEST_FINAL_FILES_API_KEY = HELD;

test("a run whose final file is past what its write call shows still grades PASS on the file's whole content", { timeout: 300_000 }, async (t) => {
  assert.ok(TIMESTAMPS.length > 2_500 && TIMESTAMPS.indexOf("END-OF-VOICEOVER") > 2_000, String(TIMESTAMPS.length));
  const dir = join(await scratch(t), "evalpkg");
  cpSync(PKG, dir, { recursive: true });
  const at = join(dir, "evals", "final-file");
  mkdirSync(join(at, "graders"), { recursive: true });
  writeFileSync(join(at, "case.yaml"), "parameters:\n  team: blue\n");
  writeFileSync(join(at, "prompt.md"), `---\ndescription: Writes the voiceover's timestamps.\n---\nWrite media/voiceover-timestamps.json: ${TIMESTAMPS}\nWrite media/voiceover.mp3: not text a grader reads\nCall write with {"path":"notes/key.txt","content":"key={{env:AGENTRUN_TEST_FINAL_FILES_API_KEY}}\\n"}\nAnswer:\nWrote the timestamps.\n\n\`\`\`json\n{"verdict": "good", "score": 80, "summary": "timestamps"}\n\`\`\`\n`);
  writeFileSync(join(at, "graders", "whole.md"), '---\ntype: llm\n---\nPass if the file "media/voiceover-timestamps.json" contains "END-OF-VOICEOVER".\n');
  const report = await evalTemplate({ dir, cases: ["final-file"], serve: { faux: FAUX } });
  const [run] = report.cases[0].runs;
  assert.equal(run.status, "completed", JSON.stringify(run, null, 1));
  const whole = run.graders.find((g) => g.grader === "whole.md");
  assert.equal(whole.pass, true, JSON.stringify(whole));
  // The write the grader saw is cut ("..."), and the file is whole, ahead of the calls, as the run left it (its JSON
  // text, never parsed), the call pointing at it; the audio is named by its size alone.
  const input = graderInputs().find((one) => one.includes("END-OF-VOICEOVER") || one.includes("Writes the voiceover"));
  assert.ok(input, "the grader's input was logged");
  const calls = input.slice(input.indexOf("<tool-calls untrusted>"));
  assert.doesNotMatch(calls, /END-OF-VOICEOVER/);
  assert.match(calls, /\.\.\.".*\[the file media\/voiceover-timestamps\.json is in <files>, whole unless marked cut\]/);
  assert.ok(input.indexOf("<files untrusted>") < input.indexOf("<tool-calls untrusted>"));
  assert.ok(input.includes(`<file path="media/voiceover-timestamps.json" bytes="${Buffer.byteLength(TIMESTAMPS) + 1}">\n${TIMESTAMPS}\n\n</file>`), input);
  // A held value the run wrote to a file never reaches a grader: cut from the file as from the call.
  assert.ok(graderInputs().every((one) => !one.includes(HELD)), "no grader input holds the held value");
  assert.match(input, /<file path="notes\/key\.txt" bytes="\d+">\nkey=\[redacted\]\n\n<\/file>/);
  assert.match(input, /Not shown \(not text, or past what a grader is given\), by path and size in bytes: media\/voiceover\.mp3 \(\d+\)/);
});

const GRADER = { type: "llm", file: "whole.md", rubric: 'Pass if the file "out.json" contains "LAST".' };
const record = (calls, finalFiles) => ({ answer: "done", calls, mcpCalls: [], files: finalFiles.map((f) => f.path), finalFiles });

test("under the prompt's cap the calls' results are cut first, each cut marked in place, and a file stays whole", () => {
  const file = { path: "out.json", bytes: 30_000, text: `${"a".repeat(29_996)}LAST` };
  const calls = Array.from({ length: 6 }, (_, i) => ({ tool: "read", arguments: { path: `in-${i}.txt` }, status: "ok", result: `${"r".repeat(20_000)}${i}` }));
  const input = graderInput(GRADER, "Write it.", record(calls, [file]), 60_000);
  assert.ok(input.length <= 60_000, String(input.length));
  assert.ok(input.includes(`<file path="out.json" bytes="30000">\n${file.text}\n</file>`));
  const shown = input.slice(input.indexOf("<tool-calls untrusted>"));
  assert.match(shown, /\(Cut to keep this prompt under its cap: each long result keeps its head and tail/);
  assert.equal((shown.match(/ \[\.\.\. \d+ characters cut \.\.\.\] /g) ?? []).length, 6);
});

test("files past three quarters of the room are cut, the largest first, each cut marked; the calls keep a quarter", () => {
  const big = { path: "big.txt", bytes: 200_000, text: `${"b".repeat(199_996)}LAST` };
  const small = { path: "small.txt", bytes: 5, text: "small" };
  const calls = [{ tool: "write", arguments: { path: "big.txt" }, status: "ok", result: "r".repeat(50_000) }];
  const input = graderInput(GRADER, "Write it.", record(calls, [big, small, { path: "a.mp4", bytes: 9_000_000 }]));
  assert.ok(input.length <= GRADER_PROMPT_MAX, String(input.length));
  const files = input.slice(input.indexOf("<files untrusted>"), input.indexOf("</files>"));
  assert.match(files, /\(Cut to keep this prompt under its cap: each long file keeps its head and tail, its middle cut where marked\.\)/);
  assert.match(files, /<file path="big\.txt" bytes="200000">\nb+ \[\.\.\. \d+ characters cut \.\.\.\] b+LAST\n<\/file>/);
  assert.match(files, /<file path="small\.txt" bytes="5">\nsmall\n<\/file>/);
  assert.match(files, /a\.mp4 \(9000000\)/);
  const calls_ = input.slice(input.indexOf("<tool-calls untrusted>"));
  assert.ok(calls_.length >= Math.floor(GRADER_PROMPT_MAX / 4) - 2_000, String(calls_.length));
  // Nothing fits but the names: every text is left out, and the names are cut to the room.
  assert.match(fitFiles([big, small], 200), /^\(Cut to keep this prompt under its cap: every file's text is left out\.\)\nBy path and size in bytes: big\.txt \(200000\), small\.txt \(5\)$/);
  assert.ok(fitFiles([big, small], 60).length <= 60);
});

test("a run with no files read gets the grader input it got before", () => {
  const calls = [{ tool: "read", arguments: { path: "in.txt" }, status: "ok", result: "r".repeat(500) }];
  const before = graderInput(GRADER, "Write it.", { answer: "done", calls, mcpCalls: [], files: [] });
  assert.doesNotMatch(before, /<files/);
  assert.match(before, /<answer untrusted>\ndone\n<\/answer>\n\n<tool-calls untrusted>\n1\. read/);
});
