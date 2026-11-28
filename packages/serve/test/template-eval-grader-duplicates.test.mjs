// What an llm grader sees of a long media run, once its input is past the cap (template-eval.ts graderInput): the bytes
// the input would hold twice are shown once before anything is cut, each counted in <cuts>.
//
// A live launch-video case (11-28) failed two of its graders on both runs, though the run did what they check. Its calls
// were 287k and 360k characters, against a grader input of 120k: the final files took about 62k of it and each call's
// result was cut to about 1.5k. A queue tool's polls that answered only "pending" (each about 7.5k, eight to fifteen of them
// while the video clips rendered) took much of the calls' room; each submit's answer repeated the input it was sent, so its
// request handles sat in the cut middle; the files repeated what the calls showed (each completed job's result filed as
// JSON, and the agent's own skills, read whole by the run and copied into its work folder). The page the run fetched
// kept about 7k of its 25k, and the release claims its script used sat at about 4.8k. The run below is that shape,
// synthetic: its sizes, its calls' order, its replies' fields.
import assert from "node:assert/strict";
import { test } from "node:test";
import { GRADER_PROMPT_MAX, graderInput, shownOnce } from "../dist/template-eval.js";

const GRADER = { type: "llm", rubric: "Pass only if every submit_job's request handles are followed as answered, and every claim in the script is on the page the run fetched." };
const pretty = (value) => JSON.stringify(value, null, 2);
const hex = (n, width) => n.toString(16).padStart(width, "0");
const idOf = (n) => `01a222d6-${hex(n * 977, 4)}-7a00-8b00-${hex(n * 7919, 12)}`;
const KLING = "fal-ai/kling-video/v2.5-turbo/pro/text-to-video";
const VOICE = "fal-ai/elevenlabs/tts/eleven-v3";
const MUSIC = "fal-ai/elevenlabs/music";
const handlesOf = (endpoint, id) => ({ endpoint_id: endpoint, request_id: id, status_url: `https://queue.fal.run/${endpoint.split("/").slice(0, 2).join("/")}/requests/${id}/status`, response_url: `https://queue.fal.run/${endpoint.split("/").slice(0, 2).join("/")}/requests/${id}` });
const withCancel = (h) => ({ ...h, cancel_url: `${h.response_url}/cancel` });

// The page: a 25k fetch whose claims sit at about 4.8k, past a fallback notice and the site's navigation.
const CLAIM = "This release brings a new and improved interactive interpreter and an experimental free-threaded build mode.";
const nav = (n) => Array.from({ length: n }, (_, i) => `- [Section ${i}](https://lang.example/section-${i}/)`).join("\n");
const PAGE = `**Notice:** This page displays a fallback because interactive scripts did not run.\n${nav(160)}`.slice(0, 4_790) + `\n${CLAIM}\n` + `${nav(600)}`.slice(0, 20_100);
const SKILL_MEDIA = `---\nname: media-skill\n---\n${"How to submit a job, wait for it and save its result, step by step.\n".repeat(160)}`;
const SKILL_AUDIO = `---\nname: audio-skill\n---\n${"How to voice a script and read its length from the file size.\n".repeat(150)}`;

// The jobs: six clips, a voiceover, a music bed, and the shorter voiceover the run made again.
const prompt = (k) => `Scene ${k}: a glass greenhouse opening its doors at dawn, pale sunlight over rows of seedlings, slow push-in, playful mood, cinematic, 16:9`;
const NEGATIVE = "text, letters, words, captions, subtitles, logo, watermark, signage, brand, real person, celebrity, blur, distortion, low quality";
const JOBS = [
  ...Array.from({ length: 6 }, (_, k) => ({ key: `clip-${k + 1}`, endpoint: KLING, id: idOf(k + 1), input: { prompt: prompt(k + 1), duration: "5", aspect_ratio: "16:9", negative_prompt: NEGATIVE } })),
  { key: "voiceover", endpoint: VOICE, id: idOf(7), input: { text: `[playfully] ${"A release worth a look, and every word of it from the page. ".repeat(6)}`, voice: "Aria", stability: 0.4, output_format: "mp3_44100_128", timestamps: true } },
  { key: "music", endpoint: MUSIC, id: idOf(8), input: { prompt: "A light acoustic bed for a launch, soft and steady under a spoken voice, warm guitar and brushed drums, no vocals, 96 bpm, ending on a gentle resolve", music_length_ms: 30000, force_instrumental: true } },
  { key: "voiceover-2", endpoint: VOICE, id: idOf(9), input: { text: `[playfully] ${"A release worth a look, every word from the page. ".repeat(5)}`, voice: "Aria", stability: 0.4, output_format: "mp3_44100_128", timestamps: true } },
];
const timestamps = (n) => Array.from({ length: n }, (_, i) => ({ text: `word${i} `, start: i * 0.31, end: i * 0.31 + 0.28 }));
const resultOf = (job) =>
  job.endpoint === KLING ? { video: { url: `https://cdn.example/files/${job.id}/output.mp4`, content_type: "video/mp4", file_name: "output.mp4", file_size: 8_170_794 } }
  : job.endpoint === MUSIC ? { audio: { url: `https://cdn.example/files/${job.id}/music.mp3`, content_type: "audio/mpeg", file_name: "music.mp3", file_size: 480_000 } }
  : { audio: { url: `https://cdn.example/files/${job.id}/voice.mp3`, content_type: "audio/mpeg", file_name: "voice.mp3", file_size: job.key === "voiceover" ? 512_000 : 438_400 }, timestamps: timestamps(job.key === "voiceover" ? 260 : 200) };
const entryOf = (job, index, done) => done
  ? { index, ...withCancel(handlesOf(job.endpoint, job.id)), queue_status: "COMPLETED", status: "completed", terminal: true, result: resultOf(job), media: [{ url: Object.values(resultOf(job))[0].url, json_path: "result.video.url", media_type: "video" }] }
  : { index, ...withCancel(handlesOf(job.endpoint, job.id)), queue_status: "IN_PROGRESS", status: "pending", terminal: false, has_result: false };
const submitReply = (job) => pretty({ status: "submitted", submission_key: `lv-e033qfep-${job.key}`, submission_replayed: false, submission_journal_status: "confirmed", recipe: { endpoint_id: job.endpoint, input: job.input, note: "The queue keeps this job's recipe; wait_for_jobs with the handles below reads it, and includes its result when ready. Never resubmit it." }, ...withCancel(handlesOf(job.endpoint, job.id)), has_result: false, next_action: { tool: "wait_for_jobs", jobs: [{ index: 0, ...withCancel(handlesOf(job.endpoint, job.id)) }], reason: "The job is queued: follow it with wait_for_jobs, its handles copied as they are." }, hint: "Job submitted. Follow next_action: wait_for_jobs takes the original handles inside jobs[] and includes the result once ready." });
const waitArgs = (list) => ({ jobs: list.map(([job, index]) => ({ index, ...handlesOf(job.endpoint, job.id) })) });
const waitReply = (list, done) => {
  const jobs = list.map(([job, index]) => entryOf(job, index, done.includes(job.key)));
  const pending = list.filter(([job]) => !done.includes(job.key));
  return pretty({ status: pending.length ? "pending" : "resolved", all_terminal: !pending.length, needs_attention: false, waited_ms: 39_325, jobs, poll_after_seconds: 0, ...(pending.length ? { next_action: { tool: "wait_for_jobs", jobs: pending.map(([job, index]) => ({ index, ...withCancel(handlesOf(job.endpoint, job.id)) })), reason: `${pending.length} jobs are still unsettled. Call wait_for_jobs now, without pausing: it waits for these jobs itself.` } } : {}), hint: "Keep caller indexes and original handles across groups. A read failure cannot restart generation; do not submit a new job to check or recover an existing one." });
};
const CLIPS = JOBS.slice(0, 6).map((job, i) => [job, i]);
const FIRST = [...CLIPS, [JOBS[6], 6], [JOBS[7], 7]];
const SECOND = [...CLIPS, [JOBS[8], 6]];
const call = (tool, args, result) => ({ tool, name: tool, arguments: args, status: "success", result });
const PLAN = pretty({ script: JOBS[6].input.text, shots: JOBS.slice(0, 6).map((job, i) => ({ n: i + 1, prompt: job.input.prompt })), music_prompt: JOBS[7].input.prompt });
const COMPOSE_EVIDENCE = pretty({ request: { tracks: Array.from({ length: 6 }, (_, k) => ({ url: `https://cdn.example/files/${idOf(k + 1)}/output.mp4`, timestamp: k * 5000, duration: 5000 })) }, log: "compose ".repeat(900) });

/** The run's 50-odd calls in order: the skills read, the page fetched, eight submits, a wait, the re-voice, ten polls
 *  that answered only pending, the clips' last reads, the saves and the cut. */
function liveRun(pendingPolls = 10) {
  const calls = [
    call("read", { path: ".agents/skills/media-skill/SKILL.md" }, SKILL_MEDIA),
    call("read", { path: ".agents/skills/audio-skill/SKILL.md" }, SKILL_AUDIO),
    call("web_fetch", { url: "https://lang.example/downloads/release/" }, JSON.stringify({ ok: true, url: "https://lang.example/downloads/release/", status: 200, title: "Release 3.13.0", text: PAGE })),
    call("mcp:fal/get_pricing", { endpoint_ids: [KLING, VOICE, MUSIC] }, pretty({ prices: [KLING, VOICE, MUSIC].map((e) => ({ endpoint_id: e, unit_price: 0.07, unit: "second", currency: "USD" })) })),
    call("write", { path: "media/plan.json", content: PLAN }, "ok"),
    ...JOBS.slice(0, 8).map((job) => call("mcp:fal/submit_job", { endpoint_id: job.endpoint, submission_key: `lv-e033qfep-${job.key}`, input: job.input }, submitReply(job))),
    call("mcp:fal/wait_for_jobs", waitArgs(FIRST), waitReply(FIRST, ["voiceover", "music"])),
    call("codemode", { script: `const v = 512000 * 8 / 128000; ${"check();".repeat(200)}` }, `{"V": 32.0, "fits": false, "note": "${"n".repeat(1_500)}"}`),
    call("mcp:fal/submit_job", { endpoint_id: VOICE, submission_key: "lv-e033qfep-voiceover-2", input: JOBS[8].input }, submitReply(JOBS[8])),
    call("mcp:fal/wait_for_jobs", waitArgs(SECOND), waitReply(SECOND, ["voiceover-2"])),
    ...Array.from({ length: pendingPolls }, () => call("mcp:fal/wait_for_jobs", waitArgs(CLIPS), waitReply(CLIPS, []))),
    call("mcp:fal/wait_for_jobs", waitArgs(CLIPS), waitReply(CLIPS, ["clip-1", "clip-2", "clip-3"])),
    call("mcp:fal/wait_for_jobs", waitArgs(CLIPS.slice(3)), waitReply(CLIPS.slice(3), ["clip-4", "clip-5", "clip-6"])),
    ...JOBS.map((job) => call("web_save", { url: Object.values(resultOf(job))[0].url, path: `media/${job.key}.${job.endpoint === KLING ? "mp4" : "mp3"}` }, pretty({ ok: true, path: `media/${job.key}`, bytes: 1_000_000, note: "s".repeat(1_200) }))),
    ...Array.from({ length: 5 }, (_, i) => call("codemode", { script: `${"caption();".repeat(250)} // ${i}` }, "c".repeat(2_800))),
    call("mcp:fal/run_model", { endpoint_id: "fal-ai/ffmpeg-api/compose", submission_key: "lv-e033qfep-cut", input: { tracks: [] } }, pretty({ status: "completed", result: { video_url: "https://cdn.example/files/cut/composed.mp4" }, note: "r".repeat(1_400) })),
    call("write", { path: "media/captions.srt", content: "1\n00:00:00,500 --> 00:00:03,000\nA release worth a look\n".repeat(12) }, "ok"),
  ];
  const evidence = [[JOBS[6], "voiceover"], [JOBS[7], "music"], [JOBS[8], "voiceover-2"], ...JOBS.slice(0, 6).map((job) => [job, job.key])].map(([job]) => {
    const text = pretty(resultOf(job));
    return { name: `evidence/fal/${job.id}.json`, bytes: text.length, text };
  });
  const finalFiles = [
    { name: ".agents/skills/media-skill/SKILL.md", bytes: SKILL_MEDIA.length, text: SKILL_MEDIA },
    { name: ".agents/skills/audio-skill/SKILL.md", bytes: SKILL_AUDIO.length, text: SKILL_AUDIO },
    ...evidence,
    { name: "evidence/mcp/fal/run_model-compose.json", bytes: COMPOSE_EVIDENCE.length, text: COMPOSE_EVIDENCE },
    { name: "media/plan.json", bytes: PLAN.length, text: PLAN },
    ...JOBS.map((job) => ({ name: `media/${job.key}.${job.endpoint === KLING ? "mp4" : "mp3"}`, bytes: 1_000_000 })),
    { name: "media/launch.mp4", bytes: 9_000_000 },
  ];
  return { answer: `{"status":"saved","script":"${CLAIM}"}`, calls, mcpCalls: [], finalFiles };
}

/** The line a call has in a grader's input, from its number to the next call's. */
function lineOf(text, n, tool) {
  const calls = text.slice(text.indexOf("<tool-calls"));
  const start = calls.indexOf(`\n${n}. ${tool}`);
  if (start < 0) return "";
  const end = calls.indexOf(`\n${n + 1}. `, start + 1);
  return calls.slice(start, end < 0 ? undefined : end);
}
const submits = (run) => run.calls.flatMap((one, i) => (one.tool === "mcp:fal/submit_job" ? [[i + 1, JSON.parse(one.result).request_id]] : []));

test("the run's whole calls and files pass the cap: the input is cut, and the synthetic shape is the live one's", () => {
  const run = liveRun();
  const whole = run.calls.reduce((sum, one) => sum + JSON.stringify(one.arguments).length + one.result.length, 0);
  // The live runs' calls were 287k and 360k characters.
  assert.ok(whole > 280_000 && whole > GRADER_PROMPT_MAX, `the calls are ${whole} characters`);
  assert.match(graderInput(GRADER, "Make a launch video", run), /<cuts>/);
});

test("a grader sees each submit's request handles in that submit's own line, past the cap", () => {
  const run = liveRun();
  const text = graderInput(GRADER, "Make a launch video", run);
  assert.ok(text.length <= GRADER_PROMPT_MAX, `${text.length} characters`);
  for (const [n, id] of submits(run)) assert.ok(lineOf(text, n, "mcp:fal/submit_job").includes(`"request_id": "${id}"`), `submit ${n} shows ${id}`);
});

test("a grader sees the claims in the middle of the page the run fetched, past the cap", () => {
  const run = liveRun();
  const text = graderInput(GRADER, "Make a launch video", run);
  const fetched = lineOf(text, 3, "web_fetch");
  assert.ok(fetched.includes(CLAIM), "the page's claims are in its web_fetch line");
});

test("a poll that answered only pending and was asked again is collapsed to its number; the last one and every other answer stay whole", () => {
  const run = liveRun();
  const text = graderInput(GRADER, "Make a launch video", run);
  const polls = run.calls.flatMap((one, i) => (one.tool === "mcp:fal/wait_for_jobs" ? [i + 1] : []));
  // The first two waits carry completed jobs, then ten pending-only polls of the same six clips, then two that settle them.
  const [first, second, ...rest] = polls;
  const pending = rest.slice(0, 10);
  for (const n of pending.slice(0, -1)) assert.match(lineOf(text, n, "mcp:fal/wait_for_jobs"), new RegExp(`^\\n${n}\\. mcp:fal/wait_for_jobs -> success: \\[collapsed: every status in its answer was "pending", and call ${n + 1} asked the same again\\]$`));
  const last = lineOf(text, pending.at(-1), "mcp:fal/wait_for_jobs");
  assert.ok(last.includes('"status": "pending"') && !last.includes("collapsed"), "the last pending poll is kept");
  for (const n of [first, second, ...rest.slice(10)]) assert.ok(!lineOf(text, n, "mcp:fal/wait_for_jobs").includes("[collapsed"), `wait ${n} is kept`);
  assert.match(text, /<cuts>[\s\S]*- Shown once: 9 polls collapsed \(each answered only "pending" and the next call of its tool asked the same again; the last such poll is kept\)/);
});

test("a submit's answer shows the input it repeats from its own arguments as a pointer", () => {
  const run = liveRun();
  const text = graderInput(GRADER, "Make a launch video", run);
  const [n] = submits(run)[0];
  const line = lineOf(text, n, "mcp:fal/submit_job");
  assert.match(line, /"input": "\[the same as this call's arguments\]"/);
  assert.equal(line.split(prompt(1)).length - 1, 1, "the prompt is shown once, in the arguments");
  assert.match(text, /9 calls' answers repeat values of their own arguments, shown as a pointer/);
});

test("a value a call's answer holds that a file shown in <files> holds whole points at the file, which keeps its text", () => {
  const run = liveRun();
  const text = graderInput(GRADER, "Make a launch video", run);
  const files = text.slice(text.indexOf("<files"), text.indexOf("</files>"));
  // The voiceovers' results (their word timestamps) are long; a clip's is shorter than what a pointer would save.
  for (const voice of [JOBS[6], JOBS[8]]) {
    const name = `evidence/fal/${voice.id}.json`;
    assert.ok(files.includes(`<file path="${name}"`) && files.includes(pretty(resultOf(voice))), `${name} is whole in <files>`);
    const wait = run.calls.findIndex((one) => one.tool === "mcp:fal/wait_for_jobs" && one.result.includes(voice.id) && one.result.includes('"word0 "')) + 1;
    assert.ok(shownOnce(run).run.calls[wait - 1].result.includes(`"result": "[the file ${name} in <files>]"`), `wait ${wait} points at ${name}`);
  }
  const clip = `evidence/fal/${JOBS[0].id}.json`;
  assert.ok(!shownOnce(run).run.calls.some((one) => one.result.includes(`[the file ${clip} in <files>]`)), "a short file is not pointed at");
  assert.match(text, /- Shown once: [^\n]*; 2 files' contents a call's answer also held, shown in <files> and pointed at from the call/);
});

test("the agent's own skills, copied into its work folder, are listed by name alone once the input is cut", () => {
  const run = liveRun();
  const text = graderInput(GRADER, "Make a launch video", run);
  const files = text.slice(text.indexOf("<files"), text.indexOf("</files>"));
  assert.ok(!files.includes('<file path=".agents/skills/media-skill/SKILL.md"'), "no block for a skill copy");
  assert.match(files, /\.agents\/skills\/media-skill\/SKILL\.md \(\d+\)/);
  assert.match(text, /2 copies of the agent's own skills \(under \.agents\/skills\) listed by name/);
});

test("a run that fits is shown whole: no poll is collapsed, no answer or file is pointed at, and no skill is listed by name", () => {
  const run = liveRun(2);
  const big = graderInput(GRADER, "Make a launch video", run, 10_000_000);
  assert.ok(!/<cuts>|\[collapsed|\[the same as this call's arguments\]|\[the file \S+ in <files>\]/.test(big));
  for (const one of run.calls) assert.ok(big.includes(one.result), `${one.tool}'s answer is whole`);
  assert.ok(big.includes('<file path=".agents/skills/media-skill/SKILL.md"'));
});

test("a poll that answered pending is kept when the next call of its tool asks for something else, and one with a settled job is never collapsed", () => {
  const ask = (list) => call("mcp:fal/wait_for_jobs", waitArgs(list), waitReply(list, []));
  const settled = call("mcp:fal/wait_for_jobs", waitArgs(CLIPS), waitReply(CLIPS, ["clip-1"]));
  const filler = call("codemode", { script: "x" }, "p".repeat(200_000));
  const run = { answer: "{}", calls: [ask(CLIPS), ask(CLIPS.slice(1)), settled, ask(CLIPS), filler], mcpCalls: [] };
  const text = graderInput(GRADER, "task", run);
  assert.ok(!text.includes("[collapsed"), text.slice(0, 400));
});

test("a file the cut leaves out of <files> is never pointed at: each call that held its content keeps it", () => {
  // Own files of 130k, a 10k cache under a dot folder (tool state, left out first past the room) and 130k of calls.
  const MARK = "cache-7f3a: the layout the composition held at frame 0";
  const cache = pretty({ note: MARK, frames: Array.from({ length: 110 }, (_, i) => ({ frame: i, layout: "l".repeat(60) })) });
  const notes = (k) => `# Notes ${k}\n${"A line of the run's own notes, whole when it fits.\n".repeat(1_300)}`;
  const run = {
    answer: "{}",
    calls: [
      call("read", { path: "film/.hyperframes/cache.json" }, cache),
      call("mcp:hf/inspect", { what: "layout" }, pretty({ ok: true, cache: JSON.parse(cache) })),
      ...Array.from({ length: 11 }, (_, i) => call("codemode", { script: `step(${i})` }, `${i} `.padEnd(10_000, "r"))),
    ],
    mcpCalls: [],
    finalFiles: [
      ...[notes(1), notes(2)].map((text, i) => ({ name: `notes/${i + 1}.md`, bytes: text.length, text })),
      { name: "film/.hyperframes/cache.json", bytes: cache.length, text: cache },
    ],
  };
  const text = graderInput(GRADER, "Make a film", run);
  assert.match(text, /tool state[^\n]*film\/\.hyperframes\/cache\.json \(\d+\)/, "the cut lists the cache by name alone");
  assert.ok(!text.includes("[the file film/.hyperframes/cache.json in <files>]"), "no call points at it");
  assert.ok(lineOf(text, 1, "read").includes(MARK), "the read shows the cache's head");
  assert.ok(lineOf(text, 2, "mcp:hf/inspect").includes(MARK), "the answer that nested it shows it too");
});

test("an answer's echo of its own arguments stays when the cut takes those arguments", () => {
  // A call whose arguments are long enough that their list is cut, and whose answer repeats them.
  const MIDDLE = "the-middle-of-the-sent-text";
  const sent = `${"head of the text sent ".repeat(800)}${MIDDLE}${" tail of the text sent".repeat(800)}`;
  const run = {
    answer: "{}",
    calls: [
      call("mcp:tts/submit", { text: sent }, pretty({ status: "queued", recipe: { text: sent }, request_id: "r-1" })),
      ...Array.from({ length: 30 }, (_, i) => call("codemode", { script: `step(${i}) ${"s".repeat(4_000)}` }, `${i} `.padEnd(4_000, "r"))),
    ],
    mcpCalls: [],
  };
  const max = 60_000;
  const text = graderInput(GRADER, "Voice it", run, max);
  const line = lineOf(text, 1, "mcp:tts/submit");
  assert.ok(!line.slice(0, line.indexOf(" -> ")).includes(MIDDLE), "the cut takes the argument's middle");
  assert.ok(!line.includes("[the same as this call's arguments]"), "the answer does not point at what the cut took");
});

test("the link check matches a cited link against the calls as the run made them, not as shown once", () => {
  const URL = "https://cdn.example/files/render-42/final.mp4";
  const answerOf = pretty({ request_id: "render-42", video: { url: URL, content_type: "video/mp4", file_size: 8_170_794 }, log: "rendered ".repeat(60) });
  const run = {
    answer: `{"status":"saved","video":"${URL}"}`,
    calls: [
      call("web_fetch", { url: "https://lang.example/about/" }, JSON.stringify({ ok: true, url: "https://lang.example/about/", status: 200, text: "About." })),
      call("mcp:render/result", { request_id: "render-42" }, answerOf),
      call("codemode", { script: "x" }, "p".repeat(200_000)),
    ],
    mcpCalls: [],
    finalFiles: [{ name: "evidence/render.json", bytes: answerOf.length, text: answerOf }],
  };
  const text = graderInput(GRADER, "Render it", run);
  assert.ok(lineOf(text, 2, "mcp:render/result").includes("[the file evidence/render.json in <files>]"), "the answer is shown once, as a pointer");
  const links = text.slice(text.indexOf("<link-check"), text.indexOf("</link-check>"));
  assert.match(links, /final\.mp4 — matches call 2/);
});
