---
name: transcribe
description: Turn the speech in a long video or audio file into one timestamped transcript file with vision.transcribe, then search it with rg to find where something is said, to the second. Use when a question is about what is said in a recording, or to narrow where to look in a long video before looking at its frames, and cite each answer as file#t=seconds.
---

# Transcribe a long video, then search it

Write the transcript once, then search the file as often as you like. It is one tab-separated row a phrase (a row ends
at a pause or after 20 words): start and end in seconds of the whole video, then the words. A row is a citation:
`talk.mp4#t=803.06`.

Steps 1, 2, 4 and 5 run in a shell. Step 3 runs in code mode, where `tools.bash({ command })` runs a command and returns
its output, and `vision.transcribe({ path, fragment })` has the host's speech-to-text model write what one audio file
says: `{ words: [{ text, start, end }], text, provider, model, costUsd, receipts, kept }`, the times in seconds of that
file. The host picks the model, holds its key and pays for it; you never handle an address or a key.

## 1. Name the video and the chunk length

Each video gets its own folder under `.hear`, named by a hash of its path (its `video` file says which), so two videos
never share audio, chunks or a transcript. Name a video the same way each time to find its transcript again. The
folder's `source` file is the SHA-256 of the video's bytes: a different recording at the same path empties the folder,
so nothing of the old one is reused. The last line prints the folder: step 3 names it.

```bash
: "${VIDEO:=talk.mp4}" "${CHUNK:=600}"
H=".hear/$(node -p 'require("crypto").createHash("sha256").update(process.argv[1]).digest("hex").slice(0, 16)' "$VIDEO")"
SRC=$(node -e 'const h = require("crypto").createHash("sha256"); require("fs").createReadStream(process.argv[1]).on("data", (d) => h.update(d)).on("end", () => console.log(h.digest("hex")))' "$VIDEO")
[ "$(cat "$H/source" 2>/dev/null)" = "$SRC" ] || { rm -rf "$H" && mkdir -p "$H" && echo "$SRC" > "$H/source"; }
printf '%s\n' "$VIDEO" > "$H/video" && echo "$H"
```

## 2. Strip the audio once, then cut it in chunks

16 kHz mono is all speech needs, about 14 MB an hour. A ten-minute chunk at 32 kbps is about 2.4 MB, which every model
the host can name takes in one request; ffmpeg writes where each one starts in `chunks.csv`, so the words get the time
of the whole video. Each file is written under a temporary name and renamed once it is complete, so a run that was cut
short is redone, never taken as done. The chunk length is kept as `chunk`: run this step with another `CHUNK` (shorter,
when a chunk is over the model's limit) and the audio is cut again and the old chunks' rows are dropped.

```bash
[ -s "$H/audio.mp3" ] || { ffmpeg -v error -y -i "$VIDEO" -vn -ac 1 -ar 16000 -b:a 32k "$H/audio.tmp.mp3" &&
  mv "$H/audio.tmp.mp3" "$H/audio.mp3"; }
[ "$(cat "$H/chunk" 2>/dev/null)" = "$CHUNK" ] ||
  { rm -f "$H/chunks.csv" "$H/transcript.tsv" "$H"/c[0-9]*.* && echo "$CHUNK" > "$H/chunk"; }
[ -s "$H/chunks.csv" ] || { ffmpeg -v error -y -i "$H/audio.mp3" -f segment -segment_time "$CHUNK" \
  -segment_list "$H/chunks.tmp.csv" -segment_list_type csv -c copy "$H/c%03d.mp3" &&
  mv "$H/chunks.tmp.csv" "$H/chunks.csv"; }
```

## 3. Transcribe each chunk, never twice

Each chunk's rows are kept beside it as `c000.tsv`: a chunk that has them is never sent again, and `vision.transcribe`
keeps each answer it paid for, so a run cut short pays for nothing twice. Each word's time is its chunk's start plus its
own; a pause of 0.8 s or more starts a new row. The rows reach the shell as a here-document: each starts with its time
and has no newline inside, so no text a model returns can end it early, and a write that fails is never renamed into
place. Each chunk is a paid call, and `costUsd` says what it cost: at Scribe v2's list price, $0.008 an audio minute,
an hour is six chunks and about $0.48. Stop when the task's budget would be passed. A call that cannot be made throws
an Error whose message starts with its code (`no_vision_route` when this run has no speech-to-text model, `over_budget`
naming the model's limit, `unsupported` when the model gives no word times, `look_failed`); the chunks done so far stay
done. For `over_budget`, run step 2 with a shorter `CHUNK`.

```js
const video = "talk.mp4", H = ".hear/1541da8e8c9bd056"; // the folder step 1 printed
const done = [];
for (const line of (await tools.bash({ command: `cat ${H}/chunks.csv` })).trim().split("\n")) {
  const [file, start, end] = line.split(",");
  const rows = `${H}/${file.replace(/\.mp3$/, ".tsv")}`;
  if ((await tools.bash({ command: `[ -e ${rows} ] && echo kept || echo new` })).trim() === "kept") continue;
  const heard = await vision.transcribe({ path: `${H}/${file}`, fragment: `${video}#t=${Number(start)},${Number(end)}` });
  const out = [];
  for (const w of heard.words) {
    const at = Number(start) + w.start, row = out.at(-1), said = w.text.replace(/\s+/g, " ");
    if (row && at - row.end < 0.8 && row.words.length < 20) row.words.push(said);
    else out.push({ start: at, words: [said] });
    out.at(-1).end = Number(start) + w.end;
  }
  const tsv = out.map((r) => `${r.start.toFixed(2)}\t${r.end.toFixed(2)}\t${r.words.join(" ")}\n`).join("");
  await tools.bash({ command: `cat > ${rows}.tmp <<'ROWS' && mv ${rows}.tmp ${rows}\n${tsv}ROWS` });
  done.push({ file, rows: out.length, costUsd: heard.costUsd, receipts: heard.receipts });
}
return done;
```

## 4. Write one transcript of the whole video

The chunks' rows, in order. A chunk without its rows stops this step with an error, so a transcript never leaves out a
piece of the video without saying so.

```bash
(cd "$H" && sed 's/\.mp3,.*/.tsv/' chunks.csv | xargs cat) > "$H/transcript.tmp.tsv" &&
  mv "$H/transcript.tmp.tsv" "$H/transcript.tsv"
```

## 5. Search it

`rg` prints each matching row with its start; `grep -n -i` takes the same arguments where `rg` is not installed.

```bash
rg -n -i 'eagle has landed' "$H/transcript.tsv"
```

Answer with the words and the place: "The Eagle has landed" at `talk.mp4#t=807.12`. To see what happens there, cut that
window and look at it (the `look` skill).
