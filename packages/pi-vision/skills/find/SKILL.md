---
name: find
description: Find when a phrase is said in a long video (every time it is said, picked by what is said around it), or the second a thing is first seen and its box, coarse to fine and for cents. Words narrow the search, Jev scores frames, the span is halved, the eyes name the second with the sound, and Jev checks that frame and draws the box. Use when a question asks when something is said or appears in a video longer than a minute or two, and cite the answer as video#t=seconds or video#t=seconds&xywh=percent:x,y,w,h.
---

# Find a thing in a long video, to the second

Two questions: when a phrase is said, and when a thing is first seen and where. The first needs only the transcript.
The second never looks at every frame.

## Heard: every time a phrase is said

The transcript answers alone, for $0: the `transcribe` skill's transcript of the video, found by its name (no
transcript: write one with that skill first). A phrase may be said more than once, word for word (a line replayed in
an opening before the story, a name called twice), so find every time it is said, each with the rows before and after
it. Then pick the one the question means by what is said around it, and name the others in the answer: "said at
`talk.mp4#t=803.06`, after the question is asked; also at 122.70, in the opening". The phrase is matched word by word,
case and punctuation aside, across the ends of rows; each time it is said is one hit, cited at the row where it starts.

```js
const task = { video: "film.mp4", phrase: "umbrella by the door" };
const q = (text) => `'${String(text).replaceAll("'", "'\\''")}'`;
const heard = (await tools.bash({ command: `grep -lxF -- ${q(task.video)} .hear/*/video 2>/dev/null || true` })).split("\n")[0].replace(/\/video$/, "");
if (!heard) return { transcript: null, hits: [] };
const rows = (await tools.bash({ command: `cat ${heard}/transcript.tsv` })).split("\n").filter(Boolean).map((row) => row.split("\t"));
const plain = (text) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(" ").filter(Boolean);
const words = rows.flatMap(([, , text], i) => plain(text).map((word) => ({ word, i })));
const want = plain(task.phrase);
const hits = [];
for (let k = 0; k + want.length <= words.length; k++) {
  if (!want.every((word, j) => words[k + j].word === word)) continue;
  const [first, last] = [words[k].i, words[k + want.length - 1].i];
  hits.push({ at: Number(rows[first][0]), cite: `${task.video}#t=${rows[first][0]}`, said: rows.slice(first, last + 1).map((r) => r[2]).join(" "),
    before: rows.slice(Math.max(0, first - 2), first).map((r) => r[2]).join(" "), after: rows.slice(last + 1, last + 3).map((r) => r[2]).join(" ") });
}
return { transcript: `${heard}/transcript.tsv`, hits };
```

## Seen: coarse to fine, to the second and the box

Search coarse to fine, and pay for each step only where the step before points:

1. **Words narrow the search.** Where the thing is named aloud or in a chapter title, the rows that name it give
   windows around them. No hit, or no transcript: the whole video is the window.
2. **Jev scores frames.** One frame every few seconds of each window, one `vision.judge` noul a frame: is the thing in
   it? Words say where to look first, not where the thing is first: once a window holds it, everything before that
   window is scanned too.
3. **Halve.** The thing is first seen after the last frame that scored low and by the first that scored high. Halve
   that span until it is 40 seconds or less.
4. **The eyes name the second.** `vision.see` watches the minute around that span, with its sound when the eyes take
   video.
5. **Jev checks and boxes.** The frames at that second and the seconds either side, from the best copy of the video you
   have, each with a noul and a box. The answer is the first that passes: `film.mp4#t=1024&xywh=percent:31,6,49,52`.

Each step writes what it found to `.find/<search>/task.json` and the next step reads it, so a run cut short goes on
from the last step that finished. A step run again asks nothing it already has (a scanned frame keeps its score) and
counts only what it pays for (an answer kept from before costs nothing). Name each search by one word of its thing,
in letters, digits and dashes (`.find/umbrella`): the folder goes into every path and command as it is, and a second
search never mixes in frames or scores of the first. The steps are code-mode programs:
`tools.bash` runs ffmpeg and reads files, `vision.judge` and `vision.see` answer (the `look` skill says what each takes
and returns). The video's and the best copy's paths go to the shell quoted, so a film named with spaces works; the
search's folder is the one word above.

## What each step costs

From the receipts of one run on a 47-minute film, a 320x180 copy to scan and watch and a 720x486 one for the box:

| Step | What is paid for | Cost |
| --- | --- | --- |
| 1 Words | nothing once the transcript exists; the transcript is paid once a video | $0 (a transcript: $0.008 an audio minute, $0.38 for this film) |
| 2 Scan | one Jev noul a frame (687 tokens a 320x180 frame) | $0.00003 a frame; 110 for this film (13 around a hit, 97 before it), $0.0032 |
| 3 Halve | four Jev nouls a round | $0.00012 a round |
| 4 Name the second | one eyes request on a minute with its sound (5,539 tokens in) | about $0.005 |
| 5 Check and box | a noul and a box on three frames (1,283 tokens a 720x486 frame) | $0.00016 |

## When to stop

- **Found**: a frame within a second of the eyes' second has a noul of at least 0.8. Answer with its citation, its noul,
  and the price. The box comes with Jev's confidence in it: under 0.6, say the box is loose, but the thing is still found.
  The confidence never decides that: asked about the same frame for the same thing, Jev drew the same box each time with
  a confidence anywhere from 0.31 to 0.83. Name the box by a short noun (`box`, "the umbrella"): a long description in
  the box question lowers its confidence even when the box is right.
- **Likely, not just possible**: a frame is high at a noul of 0.7 or more. A lookalike scores in between (0.6, where
  the thing itself scored 0.86): starting from it puts the eyes' minute in the wrong place. With no frame at 0.7, start
  from the best frame at 0.5 or more and say so.
- **Halving stops** when the span is 40 seconds or less, so the minute the eyes watch holds it with room either side.
- **The check fails** (no frame of the three passes): run steps 4 and 5 once more on the next span where the scan
  scored high after this one. Then stop, and answer with the best frame you have, its noul and box confidence, and say
  the check did not pass.
- **Not found**: no frame of any window scores 0.5 or more. Scan once more at a quarter of the step where the budget
  allows (a thing on screen for less than a step falls between frames), then say it was not found, and give the two
  frames that scored highest with their times and nouls. Never guess a second.
- **Budget**: every request first checks `spentUsd` in `task.json` against the task's `budgetUsd` (the steps here
  default to $0.10; the transcript is not counted, it is paid once a video), and a step that reaches it stops with
  `stopped: "budget"`. Say what was found so far and what is left to do.

## 1. Name the search, and narrow by words

The thing in words, once: the questions to Jev and the eyes read `thing`, the box question reads `box`. `words` is what
the transcript or a chapter title would say (a regular expression, case ignored). The transcript is the `transcribe`
skill's, found by the video's name; when there is none and the thing may be named aloud, write it first with that
skill. Chapters written as rows of start, end and title in seconds narrow the same way: name their file in `chapters`.
Each row with a hit becomes a window from a minute before it to a minute after it, and windows that touch are joined.
`best` is the best copy of the same video (the original upload, a higher resolution) on the same timeline, for the box;
the same file when there is no other.

```js
const task = { video: "film.mp4", best: "film.mp4", thing: "a red umbrella", box: "the umbrella", words: "umbrella|parasol", chapters: null, scanFrames: 300, budgetUsd: 0.1 };
const dir = ".find/umbrella";
if (!/^\.find\/[\w-]+$/.test(dir)) throw new Error(`name the search with one word of letters, digits and dashes, like .find/umbrella, not ${dir}`);
const q = (text) => `'${String(text).replaceAll("'", "'\\''")}'`;
const duration = Math.floor(Number(await tools.bash({ command: `ffprobe -v error -show_entries format=duration -of csv=p=0 ${q(task.video)}` })));
const heard = (await tools.bash({ command: `grep -lxF -- ${q(task.video)} .hear/*/video 2>/dev/null || true` })).split("\n")[0].replace(/\/video$/, "");
const files = [heard && `${heard}/transcript.tsv`, task.chapters].filter(Boolean).map(q).join(" ");
const rows = files ? (await tools.bash({ command: `grep -h -i -E -e ${q(task.words)} ${files} || true` })).split("\n").filter(Boolean) : [];
const windows = [];
for (const [start, end] of rows.map((row) => row.split("\t").map(Number)).sort((x, y) => x[0] - y[0])) {
  const [from, to] = [Math.max(0, Math.floor(start - 60)), Math.min(duration, Math.ceil(end + 60))];
  if (windows.length && from <= windows.at(-1)[1]) windows.at(-1)[1] = Math.max(windows.at(-1)[1], to);
  else windows.push([from, to]);
}
if (!windows.length) windows.push([0, duration]);
await tools.bash({ command: `rm -rf ${dir} && mkdir -p ${dir} && cat > ${dir}/task.json <<'EOF'\n${JSON.stringify({ ...task, duration, windows, scores: [], spentUsd: 0 })}\nEOF` });
return { transcript: heard ? `${heard}/transcript.tsv` : null, hits: rows, windows };
```

## 2. Scan with Jev

About `scanFrames` frames over all the windows, never closer than 10 seconds apart. Each frame is cut by seeking, named
by its second, and asked one noul; a frame already scored is not asked again. Once a window holds a likely frame,
everything before that window is scanned at about `scanFrames` frames too, so an earlier sighting the words did not
name is not missed.

```js
const dir = ".find/umbrella";
const task = JSON.parse(await tools.bash({ command: `cat ${dir}/task.json` }));
const q = (text) => `'${String(text).replaceAll("'", "'\\''")}'`;
const paid = (answer) => (answer.kept ? 0 : answer.costUsd ?? 0);
const here = { type: "noul", instructions: `Is ${task.thing} in \`images[0].image\`?` };
const scores = new Map(task.scores);
let spent = task.spentUsd;
const score = async (t) => {
  if (scores.has(t) || spent >= task.budgetUsd) return;
  await tools.bash({ command: `ffmpeg -v error -y -ss ${t} -i ${q(task.video)} -frames:v 1 ${dir}/s${t}.png` });
  const answer = await vision.judge({ paths: [`${dir}/s${t}.png`], fragments: [`${task.video}#t=${t}`], questions: { here } });
  scores.set(t, answer.answers.here.noul);
  spent += paid(answer);
};
const step = Math.max(10, Math.ceil(task.windows.reduce((sum, [from, to]) => sum + to - from, 0) / task.scanFrames));
for (const [from, to] of task.windows) for (let t = from; t < to; t += step) await score(t);
const likely = () => [...scores].filter(([, p]) => p >= 0.7).map(([t]) => t).sort((x, y) => x - y);
const inWindow = (t) => task.windows.find(([from, to]) => t >= from && t < to);
const held = likely().find(inWindow);
const before = held === undefined ? 0 : inWindow(held)[0];
for (let t = 0; t < before; t += Math.max(step, Math.ceil(before / task.scanFrames))) await score(t);
const sorted = [...scores].sort((x, y) => x[0] - y[0]);
await tools.bash({ command: `cat > ${dir}/task.json <<'EOF'\n${JSON.stringify({ ...task, scores: sorted, spentUsd: spent })}\nEOF` });
return { step, frames: sorted.length, likely: likely(), spentUsd: spent, ...(spent >= task.budgetUsd ? { stopped: "budget" } : {}) };
```

## 3. Halve to 40 seconds

The first likely frame (0.7 or more) and the last frame scored before it hold the second the thing is first seen.
While that span is longer than 40 seconds, score four frames across its first half: any of them high keeps the first
half, else the second. The minute the eyes watch is centred on what is left, so it holds both ends.

```js
const dir = ".find/umbrella";
const task = JSON.parse(await tools.bash({ command: `cat ${dir}/task.json` }));
const q = (text) => `'${String(text).replaceAll("'", "'\\''")}'`;
const paid = (answer) => (answer.kept ? 0 : answer.costUsd ?? 0);
const ranked = [...task.scores].sort((x, y) => y[1] - x[1]);
const first = task.scores.find(([, p]) => p >= 0.7) ?? ranked.find(([, p]) => p >= 0.5);
if (!first) return { found: false, best: ranked.slice(0, 2) };
const bar = first[1] >= 0.7 ? 0.7 : 0.5;
const here = { type: "noul", instructions: `Is ${task.thing} in \`images[0].image\`?` };
let [a, b] = [task.scores.filter(([t]) => t < first[0]).at(-1)?.[0] ?? 0, first[0]];
let spent = task.spentUsd;
halving: while (b - a > 40) {
  const mid = Math.round((a + b) / 2);
  let seen = false;
  for (const t of [1, 2, 3, 4].map((i) => Math.round(a + ((mid - a) * i) / 4))) {
    if (spent >= task.budgetUsd) break halving;
    await tools.bash({ command: `ffmpeg -v error -y -ss ${t} -i ${q(task.video)} -frames:v 1 ${dir}/h${t}.png` });
    const answer = await vision.judge({ paths: [`${dir}/h${t}.png`], fragments: [`${task.video}#t=${t}`], questions: { here } });
    seen ||= answer.answers.here.noul >= bar;
    spent += paid(answer);
  }
  [a, b] = seen ? [a, mid] : [mid, b];
}
const middle = Math.round((a + b) / 2);
const window = [Math.max(0, middle - 30), Math.min(task.duration, middle + 30)];
await tools.bash({ command: `cat > ${dir}/task.json <<'EOF'\n${JSON.stringify({ ...task, span: [a, b], window, spentUsd: spent })}\nEOF` });
return { span: [a, b], window, spentUsd: spent, ...(b - a > 40 ? { stopped: "budget" } : {}) };
```

## 4. The eyes name the second

Cut the minute and ask the eyes at which second the thing is first seen. Cut it by encoding, not by stream copy: a copy
starts at the keyframe before the window, and only its edit list says where the window begins, so a decoder that
ignores the edit list counts the seconds from the keyframe. Encoded without B-frames, second 0 is the window's start
for every decoder, and the bitexact flags make the same window the same bytes, so an answer already paid for is found
again. Eyes that take no video get a frame a second instead, each named by its time.

```js
const dir = ".find/umbrella";
const task = JSON.parse(await tools.bash({ command: `cat ${dir}/task.json` }));
const q = (text) => `'${String(text).replaceAll("'", "'\\''")}'`;
const paid = (answer) => (answer.kept ? 0 : answer.costUsd ?? 0);
if (task.spentUsd >= task.budgetUsd) return { at: null, stopped: "budget", spentUsd: task.spentUsd };
const [from, to] = task.window;
const ask = `At which second is ${task.thing} first seen?`;
let seen, at;
try {
  await tools.bash({ command: `ffmpeg -v error -y -ss ${from} -i ${q(task.video)} -t ${to - from} -c:v libx264 -bf 0 -crf 28 -preset veryfast -c:a aac -b:a 64k -fflags +bitexact -flags +bitexact ${dir}/w${from}.mp4` });
  seen = await vision.see({ ask: `${ask} First line: SECOND=<whole seconds from the start of this clip>`, paths: [`${dir}/w${from}.mp4`], fragments: [`${task.video}#t=${from},${to}`] });
  at = from + Number(seen.text.match(/SECOND=(\d+)/)?.[1]);
} catch (error) {
  if (!String(error?.message).startsWith("video_unseeable")) throw error;
  await tools.bash({ command: `for t in $(seq ${from} ${to - 1}); do ffmpeg -v error -y -ss $t -i ${q(task.video)} -frames:v 1 ${dir}/e$t.png; done` });
  const times = Array.from({ length: to - from }, (_, i) => from + i);
  seen = await vision.see({ ask: `${ask} First line: AT=<the name of the first image that shows it>`, paths: times.map((t) => `${dir}/e${t}.png`), fragments: times.map((t) => `${task.video}#t=${t}`) });
  at = Number(seen.text.match(/AT=\S*#t=(\d+)/)?.[1]);
}
const spent = task.spentUsd + paid(seen);
await tools.bash({ command: `cat > ${dir}/task.json <<'EOF'\n${JSON.stringify({ ...task, at: Number.isFinite(at) ? at : null, said: seen.text, spentUsd: spent })}\nEOF` });
return { at: Number.isFinite(at) ? at : null, said: seen.text, receipts: seen.receipts, spentUsd: spent };
```

When `at` is null the eyes did not say a second in the form asked: read `said`, and ask once more in other words.

## 5. Jev checks the frame and draws the box

The frames at the eyes' second and the seconds either side, from `best`, each named by its time in the video the
question was about, so the box comes back as that video's fragment. The first whose noul passes is the answer; its
box is `loose` when Jev's confidence in it is under 0.6.

```js
const dir = ".find/umbrella";
const task = JSON.parse(await tools.bash({ command: `cat ${dir}/task.json` }));
const q = (text) => `'${String(text).replaceAll("'", "'\\''")}'`;
const paid = (answer) => (answer.kept ? 0 : answer.costUsd ?? 0);
const checks = [];
let spent = task.spentUsd;
for (const t of [task.at - 1, task.at, task.at + 1].filter((t) => t >= 0 && t < task.duration)) {
  if (spent >= task.budgetUsd) break;
  await tools.bash({ command: `ffmpeg -v error -y -ss ${t} -i ${q(task.best)} -frames:v 1 ${dir}/b${t}.png` });
  const answer = await vision.judge({ paths: [`${dir}/b${t}.png`], fragments: [`${task.video}#t=${t}`], questions: {
    here: { type: "noul", instructions: `Is ${task.thing} in \`images[0].image\`?` },
    where: { type: "box", instructions: `${task.box} in \`images[0].image\`` },
  } });
  checks.push({ t, noul: answer.answers.here.noul, confidence: answer.answers.where.confidence, cite: answer.answers.where.fragment });
  spent += paid(answer);
}
const passed = checks.find((c) => c.noul >= 0.8);
const found = passed ? { ...passed, loose: passed.confidence < 0.6 } : null;
await tools.bash({ command: `cat > ${dir}/task.json <<'EOF'\n${JSON.stringify({ ...task, checks, found, spentUsd: spent })}\nEOF` });
return { found: Boolean(found), ...(found ?? { checks }), spentUsd: spent, ...(spent >= task.budgetUsd && checks.length < 3 ? { stopped: "budget" } : {}) };
```

Answer with the citation, the noul and the price: "first seen at `film.mp4#t=1024&xywh=percent:31,6,49,52` (Jev 0.88
sure; $0.008 for the search)", and say "the box is loose" when `loose` is true. To show it, crop the box from that frame
(the `look` skill's region).
