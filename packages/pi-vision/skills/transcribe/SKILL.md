---
name: transcribe
description: Turn the speech in a long video or audio file into one timestamped transcript file, then search it with rg to find where something is said, to the second. Use when a question is about what is said in a recording, or to narrow where to look in a long video before looking at its frames, and cite each answer as file#t=seconds.
---

# Transcribe a long video, then search it

Write the transcript once, then search the file as often as you like. It is one tab-separated row a phrase (a row ends
at a pause or after 20 words): start and end in seconds of the whole video, then the words. A row is a citation:
`talk.mp4#t=803.06`.

The steps run in a shell. The speech-to-text model runs on fal's queue, reached through the host: the host gives the
queue's address as `FAL_QUEUE_URL` (by default `$OPENAI_BASE_URL` without its `/v1`, plus `/fal-queue`) and its key as
`OPENAI_API_KEY`, sent as a bearer token. The task or the host names the model; Scribe v2 is the default here. Never
write a URL or a key into a file or a command you print.

Where the shell has no network, the host names another way to make this call with the same arguments (the model, the
audio file, word timestamps); use it in place of `curl` in step 3.

## 1. Name the video, the chunk length and the model

Each video gets its own folder under `.hear`, named by a hash of its path (its `video` file says which), so two videos
never share audio, chunks or a transcript. Name a video the same way each time to find its transcript again.

```bash
: "${VIDEO:=talk.mp4}" "${CHUNK:=600}" "${STT_MODEL:=fal-ai/elevenlabs/speech-to-text/scribe-v2}"
H=".hear/$(node -p 'require("crypto").createHash("sha256").update(process.argv[1]).digest("hex").slice(0, 16)' "$VIDEO")"
mkdir -p "$H" && printf '%s\n' "$VIDEO" > "$H/video"
```

## 2. Strip the audio once, then cut it in chunks

16 kHz mono is all speech needs, about 14 MB an hour. Ten-minute chunks keep each call small; ffmpeg writes where each
one starts in `chunks.csv`, so the words get the time of the whole video. Each file is written under a temporary name
and renamed once it is complete, so a run that was cut short is redone, never taken as done.

```bash
[ -s "$H/audio.mp3" ] || { ffmpeg -v error -y -i "$VIDEO" -vn -ac 1 -ar 16000 -b:a 32k "$H/audio.tmp.mp3" &&
  mv "$H/audio.tmp.mp3" "$H/audio.mp3"; }
[ -s "$H/chunks.csv" ] || { ffmpeg -v error -y -i "$H/audio.mp3" -f segment -segment_time "$CHUNK" \
  -segment_list "$H/chunks.tmp.csv" -segment_list_type csv -c copy "$H/c%03d.mp3" &&
  mv "$H/chunks.tmp.csv" "$H/chunks.csv"; }
```

## 3. Transcribe each chunk, never twice

Each chunk goes to the queue once, as a data URI: a 10-minute chunk at 32 kbps is a 3.2 MB request, which the queue
takes; a 20-minute one comes back with an error instead of words. The queue answers with a request id and two
addresses on fal's own host: call them through `FAL_QUEUE_URL` instead. The submit answer is kept as `c000.req.json`
and the transcript as `c000.json`: a chunk with a transcript is never sent again, and one with only a request is
polled, never sent again, so a run cut short pays for nothing twice. Each chunk is a paid call: at Scribe v2's list
price, $0.008 an audio minute, an hour is six chunks and about $0.48. Stop when the task's budget would be passed.

```bash
: "${FAL_QUEUE_URL:=${OPENAI_BASE_URL%/v1}/fal-queue}"
H="$H" FAL_QUEUE_URL="$FAL_QUEUE_URL" STT_MODEL="$STT_MODEL" node --input-type=module -e '
import fs from "node:fs";
const { H: dir, FAL_QUEUE_URL: queue, STT_MODEL: model, OPENAI_API_KEY: key } = process.env;
const auth = { Authorization: `Bearer ${key}` };
const via = (url) => url.replace("https://queue.fal.run", queue);
const keep = (file, value) => { fs.writeFileSync(file + ".tmp", JSON.stringify(value)); fs.renameSync(file + ".tmp", file); };
for (const line of fs.readFileSync(dir + "/chunks.csv", "utf8").trim().split("\n")) {
  const chunk = dir + "/" + line.split(",")[0].replace(/\.mp3$/, "");
  if (fs.existsSync(chunk + ".json")) continue;
  if (!fs.existsSync(chunk + ".req.json")) {
    const body = JSON.stringify({ audio_url: "data:audio/mpeg;base64," + fs.readFileSync(chunk + ".mp3").toString("base64") });
    const res = await fetch(queue + "/" + model, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body });
    if (!res.ok) throw new Error("submit " + chunk + ": " + res.status + " " + (await res.text()).slice(0, 300));
    keep(chunk + ".req.json", await res.json());
  }
  const req = JSON.parse(fs.readFileSync(chunk + ".req.json", "utf8"));
  let status = "IN_QUEUE";
  for (let i = 0; i < 600 && !["COMPLETED", "FAILED", "CANCELLED"].includes(status); i++) {
    if (i) await new Promise((done) => setTimeout(done, 1000));
    status = (await (await fetch(via(req.status_url), { headers: auth })).json()).status;
  }
  const answer = status === "COMPLETED" ? await (await fetch(via(req.response_url), { headers: auth })).json() : {};
  if (!Array.isArray(answer.words)) throw new Error(chunk + ": " + status + " " + JSON.stringify(answer).slice(0, 300) + "; remove " + chunk + ".req.json to send it again");
  keep(chunk + ".json", answer);
}
'
```

## 4. Write one transcript of the whole video

Each word's time is its chunk's start plus its own; a pause of 0.8 s or more starts a new row. The words come as
`{ word, start, end }` (OpenAI's `verbose_json`) or as `{ text, start, end, type }` (fal and ElevenLabs, with `spacing`
entries between words): read both.

```bash
H="$H" node -e '
const fs = require("fs");
const dir = process.env.H;
const rows = [];
let row = null;
for (const line of fs.readFileSync(dir + "/chunks.csv", "utf8").trim().split("\n")) {
  const [file, start] = line.split(",");
  const { words = [] } = JSON.parse(fs.readFileSync(dir + "/" + file.replace(/\.mp3$/, ".json"), "utf8"));
  for (const w of words) {
    if (w.type && w.type !== "word") continue;
    const text = String(w.word ?? w.text).trim();
    const at = Number(start) + w.start;
    if (row && (at - row.end >= 0.8 || row.words.length === 20)) { rows.push(row); row = null; }
    row ??= { start: at, words: [] };
    row.end = Number(start) + w.end;
    row.words.push(text);
  }
}
if (row) rows.push(row);
fs.writeFileSync(dir + "/transcript.tsv", rows.map((r) => [r.start.toFixed(2), r.end.toFixed(2), r.words.join(" ")].join("\t")).join("\n") + "\n");
'
```

## 5. Search it

`rg` prints each matching row with its start; `grep -n -i` takes the same arguments where `rg` is not installed.

```bash
rg -n -i 'eagle has landed' "$H/transcript.tsv"
```

Answer with the words and the place: "The Eagle has landed" at `talk.mp4#t=807.12`. To see what happens there, cut that
window and look at it (the `look` skill).
