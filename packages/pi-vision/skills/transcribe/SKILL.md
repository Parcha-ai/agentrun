---
name: transcribe
description: Turn the speech in a long video or audio file into one timestamped transcript file, then search it with rg to find where something is said, to the second. Use when a question is about what is said in a recording, or to narrow where to look in a long video before looking at its frames, and cite each answer as file#t=seconds.
---

# Transcribe a long video, then search it

Write the transcript once, then search the file as often as you like. It is one tab-separated row a phrase (a row ends
at a pause or after 20 words): start and end in seconds of the whole video, then the words. A row is a citation:
`talk.mp4#t=803.06`.

The steps run in a shell. The speech-to-text model is reached through an OpenAI-compatible transcription endpoint. The
host gives its base URL and key in the environment, as `OPENAI_BASE_URL` (ending in `/v1`) and `OPENAI_API_KEY`. The
task or the host names the model; Scribe v2 is the default here. Never write a URL or a key into a file or a command
you print.

Where the shell has no network, the host names another way to make this call with the same arguments (the model, the
audio file, word timestamps); use it in place of `curl` in step 3.

## 1. Name the video, the chunk length and the model

Each video gets its own folder under `.hear`, named for its path, so two videos never share audio, chunks or a
transcript.

```bash
: "${VIDEO:=talk.mp4}" "${CHUNK:=600}" "${STT_MODEL:=fal-ai/elevenlabs/speech-to-text/scribe-v2}"
H=".hear/${VIDEO//\//_}"
mkdir -p "$H"
```

## 2. Strip the audio once, then cut it in chunks

16 kHz mono is all speech needs, about 14 MB an hour. Ten-minute chunks keep each call small; ffmpeg writes where each
one starts in `chunks.csv`, so the words get the time of the whole video.

```bash
[ -s "$H/audio.mp3" ] || ffmpeg -v error -y -i "$VIDEO" -vn -ac 1 -ar 16000 -b:a 32k "$H/audio.mp3"
[ -s "$H/chunks.csv" ] || ffmpeg -v error -y -i "$H/audio.mp3" -f segment -segment_time "$CHUNK" \
  -segment_list "$H/chunks.csv" -segment_list_type csv -c copy "$H/c%03d.mp3"
```

## 3. Transcribe each chunk, never twice

A chunk's answer is kept beside it (`c000.json`); a chunk that has one is never sent again. Each chunk is a paid call:
at Scribe v2's list price, $0.008 an audio minute, an hour is six chunks and about $0.48. Stop when the task's budget
would be passed.

```bash
for c in "$H"/c[0-9]*.mp3; do
  [ -s "${c%.mp3}.json" ] && continue
  curl -sS --fail "$OPENAI_BASE_URL/audio/transcriptions" -H "Authorization: Bearer $OPENAI_API_KEY" \
    -F model="$STT_MODEL" -F file=@"$c" -F response_format=verbose_json -F "timestamp_granularities[]=word" \
    -o "${c%.mp3}.json.part" && mv "${c%.mp3}.json.part" "${c%.mp3}.json"
done
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
