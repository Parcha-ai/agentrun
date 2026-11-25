// What an llm grader sees of what a run sent, when its final folder is large (template-eval.ts graderInput), and a
// tool_used grader's args_file, which checks the calls a run sent against a list it wrote (argsFileVerdict).
//
// QA on a media template (11-25): a music-video run sent 12 image-to-video clips, each with the case's exact negative
// prompt and a motion-only prompt, and its grader failed "cannot be verified": the final files took about 3/4 of the
// grader's room, a quarter of it the package's own skills copied under .agents/skills and a render tool's cache under
// film/.hyperframes; the two call lists split the rest by their whole sizes, so the fake fal server's 36 calls got about
// 2.9k and each argument list was cut to about 15 characters. An earlier run of the same case passed the same condition
// with no sent prompt in its input either. The case below is that run's shape, synthetic: its file sizes, its 76 timeline
// calls, its 36 fake calls.
import assert from "node:assert/strict";
import { test } from "node:test";
import { argsFilesOf, argsFileVerdict, ARGS_FILE_MAX, finalFilesOf, fitFiles, GRADER_PROMPT_MAX, graderInput, toolState } from "../dist/template-eval.js";

const GRADER = { type: "llm", rubric: "Pass only if every clip's submit_job carries the exact negative prompt and a motion-only prompt." };
const NEGATIVE = "text, letters, words, captions, subtitles, logo, watermark, signage, brand, real person, celebrity, blur, distortion, low quality";
const MOTIONS = ["slow push in as the ferry glides left", "the thread shimmers, camera drifts right", "a gentle tilt up the lighthouse", "waves roll in under a still frame", "lanterns sway as the camera holds", "a slow pull back from the pier", "gulls cross left to right", "rain streaks down the window", "the boat bobs, camera locked", "clouds race over the hill", "a drift along the market stalls", "the sun sinks, camera still"];
const clipArgs = (i) => ({ endpoint_id: "fal-ai/kling-video/v3/pro/image-to-video", submission_key: `mv-clip-${i + 1}`, input: { prompt: `${MOTIONS[i]}, the scene as it is`, start_image_url: `https://media.example/files/still-${i + 1}-${"s".repeat(24)}.png`, duration: "6", generate_audio: false, negative_prompt: NEGATIVE } });
const stillArgs = (i) => ({ endpoint_id: "fal-ai/nano-banana-pro", submission_key: `mv-still-${i + 1}`, input: { prompt: `cut paper with soft shadows, layered paper shapes in deep teal and amber, shot ${i + 1}: ${"a harbour at dusk ".repeat(12)}`, aspect_ratio: "16:9", num_images: 1, output_format: "png", sync_mode: false } });
const waitArgs = (n) => ({ jobs: Array.from({ length: n }, (_, j) => ({ index: j, endpoint_id: "fal-ai/kling-video/v3/pro/image-to-video", request_id: `${"9".repeat(8)}-${j}`, status_url: `https://queue.example/requests/${j}/status`, response_url: `https://queue.example/requests/${j}` })) });

/** The fake fal server's 36 calls: pricing, 14 stills, 12 clips, and their waits and reads. */
const FAKE = [
  { tool: "mcp:fal/get_pricing", arguments: { endpoint_ids: ["fal-ai/elevenlabs/audio-isolation", "fal-ai/nano-banana-pro", "fal-ai/kling-video/v3/pro/image-to-video"] } },
  ...Array.from({ length: 14 }, (_, i) => ({ tool: "mcp:fal/submit_job", arguments: stillArgs(i) })),
  { tool: "mcp:fal/wait_for_jobs", arguments: waitArgs(14) },
  ...Array.from({ length: 12 }, (_, i) => ({ tool: "mcp:fal/submit_job", arguments: clipArgs(i) })),
  { tool: "mcp:fal/wait_for_jobs", arguments: waitArgs(12) },
  ...Array.from({ length: 7 }, (_, i) => ({ tool: "mcp:fal/get_result", arguments: { request_id: `r-${i}` } })),
];
/** The timeline's 76 calls, about 168k whole: the fake's calls with their results, and the run's own (scripts, reads,
 *  writes, renders), each with a result of about 2,000 characters. */
const TIMELINE = [
  ...FAKE.map((call) => ({ ...call, status: "success", result: `{"status":"IN_QUEUE","request_id":"q","note":"${"n".repeat(1_900)}"}` })),
  ...Array.from({ length: 10 }, (_, i) => ({ tool: "codemode", arguments: { script: `const style = "cut paper"; ${"step();".repeat(330)} // ${i}` }, status: "success", result: "o".repeat(2_400) })),
  ...Array.from({ length: 30 }, (_, i) => ({ tool: i % 2 ? "read" : "bash", arguments: { command: `node film/beats.mjs check --shot ${i}` }, status: "success", result: "l".repeat(2_300) })),
];
const text = (name, bytes) => ({ name, bytes, text: `${name}:${"x".repeat(bytes - name.length - 5)}:END` });
/** About 53k of the run's own files and 39k of tool state, read whole (92,878 bytes in all in the run). */
const FILES = [
  text("storyboard.md", 2_840), text("film/plan.json", 8_043), text("media/transcript.json", 9_662), text("media/review/snapshot.log", 9_553),
  text("film/index.html", 4_696), text("film/price.json", 4_584), text("film/compositions/lyrics.html", 4_047), text("media/check.json", 3_422),
  text("film/lyrics.json", 1_852), text("film/placed.json", 1_745), text("film/review.mjs", 2_485), text("media/lyrics.vtt", 639),
  text(".agents/skills/fal-media/SKILL.md", 10_565), text(".agents/skills/music-video/SKILL.md", 11_701), text(".agents/skills/music-video/kit/index.html", 2_537),
  text(".agents/skills/music-video/kit/review.mjs", 2_485), text(".agents/skills/music-video/references/film.md", 6_460), text("film/.hyperframes/artifacts/checks/c.json", 3_122),
  text("film/.hyperframes/cache/check.json", 2_351), { name: "film/assets/shots.mp4", bytes: 86_234_619 }, { name: "media/film.mp4", bytes: 38_474_449 },
];
const RUN = { answer: "Made the film: media/film.mp4.", calls: TIMELINE, mcpCalls: FAKE, fakeLog: [], files: [], finalFiles: FILES };
const section = (input, tag) => input.match(new RegExp(`<${tag} untrusted>\\n([\\s\\S]*?)\\n</${tag}>`))?.[1] ?? "";

test("a media run's grader input shows every clip it sent to the fake whole: the package's skills and a tool's cache are listed by name, not given the room", () => {
  const input = graderInput(GRADER, "Make a 60 second music video.", RUN);
  assert.ok(input.length <= GRADER_PROMPT_MAX, String(input.length));
  const fake = section(input, "mcp-calls");
  // Before: each argument list cut to about 15 characters ({"endpoint_i [... 425 characters cut ...] ity"}}).
  for (let i = 0; i < 12; i += 1) assert.ok(fake.includes(`mcp:fal/submit_job: ${JSON.stringify(clipArgs(i))}`), `clip ${i + 1} whole in <mcp-calls>:\n${fake.slice(0, 600)}`);
  for (let i = 0; i < 14; i += 1) assert.ok(fake.includes(JSON.stringify(stillArgs(i))), `still ${i + 1} whole`);
  const files = section(input, "files");
  for (const file of FILES.filter((one) => one.text !== undefined)) {
    if (toolState(file.name)) {
      assert.ok(!files.includes(`<file path="${file.name}"`), `${file.name}'s text is left out`);
      assert.ok(files.includes(`${file.name} (${file.bytes})`), `${file.name} is listed by name and size`);
    } else assert.ok(files.includes(`<file path="${file.name}" bytes="${file.bytes}">`), `${file.name} is shown`);
  }
  // Every cut is said once, ahead of the evidence: what was cut, counted, and that what it left out was not seen.
  const note = input.match(/<cuts>\n([\s\S]*?)\n<\/cuts>/)?.[1] ?? "";
  assert.match(note, /<files>: 7 files of tool state \(under a folder whose name starts with "\."\) listed by name alone/);
  assert.match(note, /<tool-calls>: \d+ calls' arguments cut in the middle; \d+ results cut or left out\./);
  assert.match(note, /What a cut leaves out was not seen: a condition only it could show is not shown to hold\./);
  assert.ok(input.indexOf("<cuts>") < input.indexOf("<files untrusted>"), "the note comes before the evidence");
});

test("a grader input that fits says nothing of cuts; one that drops calls says how many", () => {
  const small = { answer: "done", calls: TIMELINE.slice(0, 3), mcpCalls: FAKE.slice(0, 2), fakeLog: [], files: [], finalFiles: [text("out.md", 400)] };
  const whole = graderInput(GRADER, "Do it.", small);
  assert.doesNotMatch(whole, /<cuts>/);
  assert.doesNotMatch(whole, /Cut to keep this prompt under its cap/);
  const tight = graderInput(GRADER, "Do it.", { ...RUN, finalFiles: [] }, 8_000);
  assert.ok(tight.length <= 8_000, String(tight.length));
  const dropped = Number(section(tight, "tool-calls").match(/\[\.\.\. (\d+) calls cut \.\.\.\]/)?.[1]);
  assert.ok(dropped > 0, section(tight, "tool-calls").slice(0, 300));
  assert.match(tight, new RegExp(`<tool-calls>: [^\\n]*${dropped} calls in the middle left out\\.`));
  // Every result left out with no call dropped says so, and no "0 calls" marker.
  const heads = graderInput(GRADER, "Do it.", { ...RUN, finalFiles: [] }, 12_000);
  assert.match(section(heads, "tool-calls"), /^\(Cut to keep this prompt under its cap: every result is left out\.\)\n1\. /);
  assert.doesNotMatch(heads, /0 calls cut/);
});

test("fitFiles leaves the tool state's texts out before it cuts a file of the run's own, and shows them when everything fits", () => {
  const own = text("storyboard.md", 3_000);
  const skill = text(".agents/skills/x/SKILL.md", 5_000);
  const cache = text("film/.hyperframes/state.json", 4_000);
  const all = fitFiles([own, skill, cache], 20_000);
  for (const file of [own, skill, cache]) assert.ok(all.includes(file.text), `${file.name} whole when everything fits`);
  const tight = fitFiles([own, skill, cache], 4_000);
  assert.ok(tight.includes(own.text), "the run's own file stays whole");
  assert.doesNotMatch(tight, /characters cut/);
  assert.match(tight, /Not shown \(tool state: under a folder whose name starts with "\.", left out before any file of the run's own is cut\), by path and size in bytes: \.agents\/skills\/x\/SKILL\.md \(5000\), film\/\.hyperframes\/state\.json \(4000\)/);
  assert.equal(toolState(".agents/skills/x/SKILL.md"), true);
  assert.equal(toolState("film/.hyperframes/cache/check.json"), true);
  assert.equal(toolState(".env"), false, "a dotfile at the top is the run's own");
  assert.equal(toolState("film/plan.json"), false);
  assert.equal(toolState(undefined), false);
});

test("finalFilesOf reads the run's own files before tool state: a cache never takes the budget a file of the run's own needed", async () => {
  const listed = [
    { path: "film/.hyperframes/video-state.json", name: "film/.hyperframes/video-state.json", bytes: 60_000, type: "application/json", unreadable: false },
    { path: "media/clips.json", name: "media/clips.json", bytes: 70_000, type: "application/json", unreadable: false },
  ];
  const asked = [];
  const api = async (_method, path) => {
    asked.push(path);
    const file = listed.find((one) => path.includes(one.path.split("/").map(encodeURIComponent).join("/")));
    return { status: 200, headers: new Headers({ "x-agentrun-cut": "run" }), body: "c".repeat(file.bytes) };
  };
  const files = await finalFilesOf(api, "run_1", listed);
  // Before: smallest first, so the 60k cache was read and the 70k list was past what was left of the 120k.
  assert.equal(files.find((file) => file.name === "media/clips.json").text?.length, 70_000);
  assert.equal(files.find((file) => file.name === "film/.hyperframes/video-state.json").text, undefined);
  assert.equal(asked.length, 1, asked.join(", "));
});

// ---- args_file ---------------------------------------------------------------------------------------------------

const CLIPS = Array.from({ length: 3 }, (_, i) => clipArgs(i).input);
const sent = (inputs) => inputs.map((input, i) => ({ tool: "mcp:fal/submit_job", arguments: { endpoint_id: "fal-ai/kling-video/v3/pro/image-to-video", submission_key: `k${i}`, input } }));
const verdict = (list, calls, count) => argsFileVerdict("media/clips.json", { text: JSON.stringify(list.map((input) => ({ input }))) }, calls, `${calls.length} calls of mcp:fal/submit_job`, count);

test("args_file passes when each entry the run wrote is carried by its own call, and as many calls were sent", () => {
  assert.deepEqual(verdict(CLIPS, sent(CLIPS)), { pass: true, reason: "3 calls of mcp:fal/submit_job; each of the 3 entries in the run's media/clips.json is carried by its own call" });
  // In any order: each entry is a subset of its call's arguments (carries), whatever else the call holds.
  assert.equal(verdict(CLIPS, sent([...CLIPS].reverse())).pass, true);
  assert.equal(verdict([{ prompt: CLIPS[0].prompt }, { prompt: CLIPS[1].prompt }, { prompt: CLIPS[2].prompt }], sent(CLIPS)).pass, true, "entries naming one field each");
});

test("args_file reads its list cut and the fake's calls whole: an entry's [redacted] stands for the value a call sent, and nothing else", () => {
  // A synthetic held value (fake-test-key shaped): the call sent it whole, the cut file names it [redacted].
  const held = "fake-test-key-0001";
  const calls = [{ tool: "mcp:fal/submit_job", arguments: { endpoint_id: "e", input: { prompt: "clip one", image_url: `https://img.example.com/a.png?token=${held}`, key: held } } }];
  const of = (input) => argsFileVerdict("media/clips.json", { text: JSON.stringify([{ input }]) }, calls, "1 call of mcp:fal/submit_job");
  assert.equal(of({ prompt: "clip one", image_url: "https://img.example.com/a.png?token=[redacted]", key: "[redacted]" }).pass, true, "a span and a whole value cut");
  assert.equal(of({ prompt: "clip one", image_url: "https://img.example.com/b.png?token=[redacted]" }).pass, false, "the text around a mark still has to match");
  assert.equal(of({ prompt: "[redacted]", key: "[redacted]" }).pass, true);
  assert.equal(of({ prompt: "clip one", missing: "[redacted]" }).pass, false, "a mark stands for a value, never for a key the call lacks");
  assert.equal(of({ prompt: "clip one", image_url: "https://img.example.com/a.png?token=[redacted]x" }).pass, false);
  assert.doesNotMatch(of({ prompt: "clip two", key: "[redacted]" }).reason, new RegExp(held), "the call's value is never said");
  // A timeline call is cut too: its [redacted] carries the entry's.
  const cut = [{ tool: "mcp:fal/submit_job", arguments: { input: { key: "[redacted]" } } }];
  assert.equal(argsFileVerdict("media/clips.json", { text: '[{"input":{"key":"[redacted]"}}]' }, cut, "1 call").pass, true);
});

test("args_file under the cut compares arrays whole, as without it: an object inside one carries no field the entry lacks", () => {
  const calls = [{ tool: "mcp:fal/submit_job", arguments: { items: [{ id: 1, enabled: false }], tags: ["a", "fake-test-key-0001"] } }];
  const of = (entry) => argsFileVerdict("media/clips.json", { text: JSON.stringify([entry]) }, calls, "1 call of mcp:fal/submit_job").pass;
  assert.equal(of({ items: [{ id: 1 }] }), false, "an extra field inside an array's object is not carried");
  assert.equal(of({ items: [{ id: 1, enabled: false }] }), true);
  assert.equal(of({ tags: ["a"] }), false, "an array's length is whole");
  assert.equal(of({ tags: ["a", "[redacted]"] }), true, "a mark inside an array still stands for the value");
  assert.equal(of({ items: [{ id: 1 }], tags: ["a", "[redacted]"] }), false);
});

test("args_file's cut match is linear: many marks with a suffix the call lacks fail at once, never backtracking", { timeout: 30_000 }, () => {
  const long = "a".repeat(20_000);
  const calls = [{ tool: "mcp:fal/submit_job", arguments: { prompt: long } }];
  const of = (prompt) => argsFileVerdict("media/clips.json", { text: JSON.stringify([{ prompt }]) }, calls, "1 call of mcp:fal/submit_job").pass;
  assert.equal(of(`${"[redacted]".repeat(40)}b`), false);
  assert.equal(of("[redacted]".repeat(40)), true, "40 marks, each one character or more, in 20,000");
  assert.equal(of(`a[redacted]a[redacted]a`), true);
  assert.equal(of("[redacted]".repeat(20_001)), false, "more marks than characters");
});

test("args_file fails a call sent with other arguments, a call missing, one call standing for two entries, and an extra call", () => {
  const changed = [CLIPS[0], CLIPS[1], { ...CLIPS[2], negative_prompt: "blur" }];
  const off = verdict(CLIPS, sent(changed));
  assert.equal(off.pass, false);
  assert.match(off.reason, /^3 calls of mcp:fal\/submit_job; 1 of the 3 entries in the run's media\/clips\.json have no call of their own: entry 3 \(\{"input":\{"prompt":"a gentle tilt up the lighthouse, the scene as it is",.*\.\.\.\): no call carries it$/);
  assert.match(verdict(CLIPS, sent(CLIPS.slice(0, 2))).reason, /entry 3 .*: no call carries it$/);
  // Two entries only one call carries: a matching gives that call to one of them, never both.
  const both = [{ duration: "6" }, { prompt: CLIPS[0].prompt }];
  const shared = verdict(both, sent([CLIPS[0], { ...CLIPS[1], duration: "4" }]));
  assert.equal(shared.pass, false);
  assert.match(shared.reason, /1 of the 2 entries .* have no call of their own: entry 2 .*: every call that carries it stands for another entry$/);
  // A matching, not first come: entry 1 fits both calls, entry 2 only the first, and each still gets one.
  assert.equal(verdict(both, sent([CLIPS[0], CLIPS[1]])).pass, true);
  const extra = verdict(CLIPS, sent([...CLIPS, CLIPS[0]]));
  assert.deepEqual(extra, { pass: false, reason: "4 calls of mcp:fal/submit_job; each of the 3 entries in the run's media/clips.json is carried by its own call, and the grader expects exactly 3 calls" });
  assert.equal(verdict(CLIPS, sent([...CLIPS, CLIPS[0]]), 4).pass, true, "count, when given, is the number of calls");
});

test("args_file fails a list that can't be read, isn't JSON, or isn't a list of argument objects, saying which", () => {
  const of = (file) => argsFileVerdict("media/clips.json", file, [], "0 calls of x").reason;
  assert.equal(of({ why: "its work folder has no such file" }), "the run's media/clips.json could not be read: its work folder has no such file");
  assert.equal(of(undefined), "the run's media/clips.json could not be read");
  assert.match(of({ text: "{nope" }), /^the run's media\/clips\.json is not JSON: /);
  assert.equal(of({ text: '{"a":1}' }), "the run's media/clips.json is not a list of argument objects");
  assert.equal(of({ text: '[{"a":1}, "b"]' }), "entry 2 of the run's media/clips.json is not an argument object");
});

test("argsFilesOf reads each list whole under the run's cut, and says why one has no text", async () => {
  const answers = {
    "media/clips.json": { status: 200, cut: true, body: JSON.stringify(CLIPS) },
    "media/raw.json": { status: 200, cut: false, body: "[]" },
    "media/big.json": { status: 200, cut: true, body: "x".repeat(ARGS_FILE_MAX + 1) },
    "media/gone.json": { status: 404, cut: false, body: "" },
    "media/huge.json": { status: 413, cut: false, body: "" },
  };
  const asked = [];
  const api = async (_method, path) => {
    asked.push(path);
    const [, file] = path.match(/^\/runs\/run_1\/files\/(.*)\?cut=run$/);
    const answer = answers[decodeURIComponent(file)];
    return { status: answer.status, headers: new Headers(answer.cut ? { "x-agentrun-cut": "run" } : {}), body: answer.body };
  };
  const read = await argsFilesOf(api, "run_1", [...Object.keys(answers), "media/clips.json"]);
  assert.deepEqual(read, {
    "media/clips.json": { text: JSON.stringify(CLIPS) },
    "media/raw.json": { why: "the server did not read it under the run's cut" },
    "media/big.json": { why: `it is past ${ARGS_FILE_MAX} bytes` },
    "media/gone.json": { why: "its work folder has no such file" },
    "media/huge.json": { why: `it is past ${ARGS_FILE_MAX} bytes` },
  });
  assert.equal(asked.length, 5, "each path read once");
  assert.equal(ARGS_FILE_MAX, 256 * 1024, "the most a cut read answers: no list the server refuses is promised");
});
