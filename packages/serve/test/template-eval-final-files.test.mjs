// An llm grader reads the files a run left whole, ahead of its calls (template-eval.ts graderInput, fitFiles). A call
// shows a file only in its arguments or its output. Its calls show a write's content cut at 2,000 characters, ending
// "...", when the file is in <files> (so the grader's room never holds those bytes twice). Graded on its calls alone, a run whose 2,888-byte timestamps file was whole read to its
// grader as a run that wrote less, and failed (a release-film eval). The package's agent and its grader are played by
// fixtures/faux-template-eval.mjs, whose grader reads a file's text from its <file> block alone. The eval reads each file
// under the run's own cut, on the server (GET /runs/{id}/files/{path}?cut=run), each read bounded, within a budget in
// UTF-8 bytes.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { apiOf, evalTemplate, finalFilesOf, fitFiles, GRADER_PROMPT_MAX, graderInput } from "../dist/template-eval.js";
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
// under a key's name: the eval's own server holds it (hostSecrets), so it is in the run's cut, which cuts it from the
// calls and from a file read under the cut.
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
  assert.equal(input.split("END-OF-VOICEOVER").length - 1, 1, "the file's bytes are in the grader's input once");
  assert.ok(input.indexOf("<files untrusted>") < input.indexOf("<tool-calls untrusted>"));
  assert.ok(input.includes(`<file path="media/voiceover-timestamps.json" bytes="${Buffer.byteLength(TIMESTAMPS) + 1}">\n${TIMESTAMPS}\n\n</file>`), input);
  // A held value the run wrote to a file never reaches a grader: cut from the file as from the call.
  assert.ok(graderInputs().every((one) => !one.includes(HELD)), "no grader input holds the held value");
  assert.match(input, /<file path="notes\/key\.txt" bytes="\d+">\nkey=\[redacted\]\n\n<\/file>/);
  assert.match(input, /Not shown \(not text, or past what a grader is given\), by path and size in bytes: media\/voiceover\.mp3 \(\d+\)/);
});

const GRADER = { type: "llm", file: "whole.md", rubric: 'Pass if the file "out.json" contains "LAST".' };
const record = (calls, finalFiles) => ({ answer: "done", calls, mcpCalls: [], files: finalFiles.flatMap((f) => (f.name === undefined ? [] : [f.name])), finalFiles });

test("under the prompt's cap the calls' results are cut first, each cut marked in place, and a file stays whole", () => {
  const file = { name: "out.json", bytes: 30_000, text: `${"a".repeat(29_996)}LAST` };
  const calls = Array.from({ length: 6 }, (_, i) => ({ tool: "read", arguments: { path: `in-${i}.txt` }, status: "ok", result: `${"r".repeat(20_000)}${i}` }));
  const input = graderInput(GRADER, "Write it.", record(calls, [file]), 60_000);
  assert.ok(input.length <= 60_000, String(input.length));
  assert.ok(input.includes(`<file path="out.json" bytes="30000">\n${file.text}\n</file>`));
  const shown = input.slice(input.indexOf("<tool-calls untrusted>"));
  assert.match(shown, /\(Cut to keep this prompt under its cap: each long result keeps its head and tail/);
  assert.equal((shown.match(/ \[\.\.\. \d+ characters cut \.\.\.\] /g) ?? []).length, 6);
});

test("files past three quarters of the room are cut, the largest first, each cut marked; the calls keep a quarter", () => {
  const big = { name: "big.txt", bytes: 200_000, text: `${"b".repeat(199_996)}LAST` };
  const small = { name: "small.txt", bytes: 5, text: "small" };
  const calls = [{ tool: "write", arguments: { path: "big.txt" }, status: "ok", result: "r".repeat(50_000) }];
  const input = graderInput(GRADER, "Write it.", record(calls, [big, small, { name: "a.mp4", bytes: 9_000_000 }]));
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

test("a write whose file is in <files> shows its content cut at 2,000 in the call, with the pointer; another stays whole", () => {
  const file = { name: "out.md", bytes: 5_006, text: `${"c".repeat(5_000)}TAILMK` };
  const calls = [
    { tool: "write", arguments: { path: "out.md", content: file.text }, status: "ok", result: "wrote out.md" },
    { tool: "write", arguments: { path: "other.md", content: `${"d".repeat(5_000)}OTHERTAIL` }, status: "ok", result: "wrote other.md" },
  ];
  const input = graderInput(GRADER, "Write it.", record(calls, [file]));
  const shown = input.slice(input.indexOf("<tool-calls untrusted>"));
  assert.equal(input.split("TAILMK").length - 1, 1, "the file's bytes are in the grader's input once, in <files>");
  assert.ok(input.indexOf("TAILMK") < input.indexOf("<tool-calls untrusted>"));
  assert.match(shown, /1\. write \{"path":"out\.md","content":"c{1997}\.\.\."\} -> ok \[the file out\.md is in <files>, whole unless marked cut\]: wrote out\.md/);
  assert.ok(shown.includes(JSON.stringify(calls[1].arguments)), "a write no shown file holds is whole");
});

test("the calls' arguments take at most half their room, each cut marked in place, so every call keeps its result", () => {
  const calls = Array.from({ length: 3 }, (_, i) => ({ tool: "create_issue", arguments: { body: `${"a".repeat(100_000)}END${i}` }, status: "ok", result: `${"r".repeat(5_000)}R${i}` }));
  const input = graderInput(GRADER, "File them.", record(calls, []));
  assert.ok(input.length <= GRADER_PROMPT_MAX, String(input.length));
  const shown = input.slice(input.indexOf("<tool-calls untrusted>"), input.indexOf("</tool-calls>"));
  for (const [i, call] of calls.entries()) {
    assert.ok(shown.includes(` -> ok: ${call.result}\n`), `call ${i + 1}'s result is whole`);
    assert.match(shown, new RegExp(`${i + 1}\\. create_issue \\{"body":"a+ \\[\\.\\.\\. \\d+ characters cut \\.\\.\\.\\] a+END${i}"\\} -> ok: `));
  }
  const heads = shown.split("\n").filter((line) => /^\d+\. /.test(line)).map((line) => line.slice(0, line.indexOf(" -> ok: ")));
  assert.equal(heads.length, 3);
  assert.ok(heads.reduce((sum, head) => sum + head.length, 0) <= GRADER_PROMPT_MAX / 2, String(heads.map((head) => head.length)));
});

test("a long argument stays whole when the calls fit", () => {
  const calls = [{ tool: "create_issue", arguments: { title: "Release notes", body: `${"b".repeat(30_000)}BODYEND` }, status: "ok", result: "created #12" }];
  const input = graderInput(GRADER, "File it.", record(calls, []));
  assert.ok(input.includes(`1. create_issue ${JSON.stringify(calls[0].arguments)} -> ok: created #12`));
  assert.doesNotMatch(input, /characters cut/);
});

/** A server for finalFilesOf's reads, answering each `?cut=run` path as `answers` says: `stall` sends its head and a
 *  first part, then nothing; `old` the text with no cut mark (a server that doesn't know the cut); a number that status;
 *  any other string the text, marked as the cut. Each request's path is kept in `asked`, and `closed` counts the
 *  requests whose connection the client closed. */
async function filesServer(t, answers) {
  const asked = [];
  let closed = 0;
  const server = createServer((req, res) => {
    asked.push(req.url);
    req.socket.on("close", () => { closed++; });
    const name = decodeURIComponent(req.url.replace(/^\/v2\/runs\/r1\/files\//, "").replace(/\?cut=run$/, ""));
    const answer = req.url.endsWith("?cut=run") ? answers[name] : 404;
    if (answer === "stall") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "x-agentrun-cut": "run" });
      return void res.write("the first part ");
    }
    if (typeof answer === "number") return void res.writeHead(answer, { "content-type": "application/json" }).end("{}");
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8", ...(answer.startsWith("old:") ? {} : { "x-agentrun-cut": "run" }) });
    res.end(answer.replace(/^old:/, ""));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return { api: apiOf(`http://127.0.0.1:${server.address().port}/v2`, "t"), asked, closed: () => closed };
}
// Each listed with its cut name: the path with "-cut" before its extension, so a test tells the name a grader sees from
// the path the eval reads by.
const listedOf = (files) => files.map(([path, bytes]) => ({ path, name: path.replace(/\./, "-cut."), bytes, type: null, unreadable: false }));

test("a final file whose server stalls mid-body is cut at the read's bound, and the files after it are still read", { timeout: 30_000 }, async (t) => {
  const { api, asked, closed } = await filesServer(t, { "a-stalls.txt": "stall", "b.txt": "the next file", "c.txt": "old:raw bytes", "d.json": 415 });
  const began = Date.now();
  const files = await finalFilesOf(api, "r1", listedOf([["a-stalls.txt", 5], ["b.txt", 13], ["c.txt", 14], ["d.json", 15]]), undefined, 500);
  const took = Date.now() - began;
  assert.ok(took >= 450 && took < 5_000, `cut at the bound: ${took} ms`);
  assert.deepEqual(files, [{ name: "a-stalls-cut.txt", bytes: 5 }, { name: "b-cut.txt", bytes: 13, text: "the next file" }, { name: "c-cut.txt", bytes: 14 }, { name: "d-cut.json", bytes: 15 }]);
  assert.deepEqual(asked, ["a-stalls.txt", "b.txt", "c.txt", "d.json"].map((name) => `/v2/runs/r1/files/${name}?cut=run`), "every read through the run's cut");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(closed() >= 1, "the stalled read's connection is closed");
});

test("the files' budget is in UTF-8 bytes: a text past it in bytes is left out, under it in characters or not, and the next file is read", { timeout: 30_000 }, async (t) => {
  // Listed small, then grown: 70,000 two-byte characters, 140,000 bytes, past GRADER_PROMPT_MAX in bytes alone.
  const grown = "é".repeat(70_000);
  assert.ok(grown.length < GRADER_PROMPT_MAX && Buffer.byteLength(grown) > GRADER_PROMPT_MAX);
  const { api } = await filesServer(t, { "grown.txt": grown, "after.txt": "after" });
  const files = await finalFilesOf(api, "r1", listedOf([["grown.txt", 10], ["after.txt", 11]]));
  assert.deepEqual(files, [{ name: "grown-cut.txt", bytes: 10 }, { name: "after-cut.txt", bytes: 11, text: "after" }]);
});

// A held value in a file's name: the listing's paths are the run's own, so a run that names a file by a key (a cache keyed
// by it, a voiceover named for it) put the key in the grader's prompt through the file's name, the text alone being cut.
// The eval names each file by the listing's cut name (GET /runs/{id}/files?cut=run), the text file and the audio alike.
test("a held value in a file's name never reaches a grader: the text file and the audio are each named under the run's cut", { timeout: 300_000 }, async (t) => {
  const dir = join(await scratch(t), "evalpkg");
  cpSync(PKG, dir, { recursive: true });
  const at = join(dir, "evals", "held-names");
  mkdirSync(join(at, "graders"), { recursive: true });
  writeFileSync(join(at, "case.yaml"), "parameters:\n  team: blue\n");
  writeFileSync(join(at, "prompt.md"), `---\ndescription: Caches a reply under a held name.\n---\nCall write with {"path":"cache/{{env:AGENTRUN_TEST_FINAL_FILES_API_KEY}}.json","content":"{\\"reply\\": \\"CACHED-REPLY\\"}\\n"}\nCall write with {"path":"media/{{env:AGENTRUN_TEST_FINAL_FILES_API_KEY}}.mp3","content":"not text a grader reads\\n"}\nAnswer:\nCached it.\n\n\`\`\`json\n{"verdict": "good", "score": 80, "summary": "cached"}\n\`\`\`\n`);
  writeFileSync(join(at, "graders", "cached.md"), '---\ntype: llm\n---\nPass if a file holds "CACHED-REPLY".\n');
  const report = await evalTemplate({ dir, cases: ["held-names"], serve: { faux: FAUX } });
  const [run] = report.cases[0].runs;
  assert.equal(run.status, "completed", JSON.stringify(run, null, 1));
  const input = graderInputs().find((one) => one.includes("CACHED-REPLY"));
  assert.ok(input, "the grader's input was logged");
  assert.ok(!input.includes(HELD), "the grader's input holds no held value");
  assert.match(input, /<file path="cache\/\[redacted\]\.json" bytes="\d+">\n\{"reply": "CACHED-REPLY"\}\n\n<\/file>/);
  assert.match(input, /Not shown \(not text, or past what a grader is given\), by path and size in bytes: media\/\[redacted\]\.mp3 \(\d+\)/);
  // The call that wrote the text file (its arguments cut in the timeline) points at it by its cut name.
  assert.match(input.slice(input.indexOf("<tool-calls untrusted>")), /\[the file cache\/\[redacted\]\.json is in <files>, whole unless marked cut\]/);
});

test("a file with no cut name (a server that doesn't cut its listing's names) is never named to a grader: its text is shown unnamed, the rest counted", () => {
  const files = [
    { name: "out.json", bytes: 4, text: "LAST" },
    { bytes: 9, text: "UNNAMED-1" },
    { name: "a.mp4", bytes: 9_000_000 },
    { bytes: 7 },
    { bytes: 8 },
  ];
  const shown = fitFiles(files, 10_000);
  assert.match(shown, /<file path="out\.json" bytes="4">\nLAST\n<\/file>/);
  assert.match(shown, /<file bytes="9">\nUNNAMED-1\n<\/file>/);
  assert.match(shown, /Not shown \(not text, or past what a grader is given\), by path and size in bytes: a\.mp4 \(9000000\); and 2 files not named \(this server doesn't cut file names\)/);
  // Nothing fits but the names: the named listed, the unnamed counted.
  assert.match(fitFiles(files, 220), /^\(Cut to keep this prompt under its cap: every file's text is left out\.\)\nBy path and size in bytes: out\.json \(4\), a\.mp4 \(9000000\); and 3 files not named \(this server doesn't cut file names\)$/);
  // A call that writes a file is pointed at it by its cut name only.
  const input = graderInput(GRADER, "Write it.", record([{ tool: "write", arguments: { path: "out.json" }, status: "ok" }], files));
  assert.match(input, /1\. write \{"path":"out\.json"\} -> ok \[the file out\.json is in <files>, whole unless marked cut\]/);
});

test("a final file listed with no cut name is read by its path and given back by no name: its path is the eval's, never a grader's", { timeout: 30_000 }, async (t) => {
  const { api, asked } = await filesServer(t, { "plain.txt": "the text" });
  const files = await finalFilesOf(api, "r1", [{ path: "plain.txt", bytes: 8, type: null, unreadable: false }, { path: "clip.mp3", bytes: 9, type: "audio/mpeg", unreadable: false }]);
  assert.deepEqual(files, [{ bytes: 8, text: "the text" }, { bytes: 9 }]);
  assert.deepEqual(asked, ["/v2/runs/r1/files/plain.txt?cut=run"]);
});
