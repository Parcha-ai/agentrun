---
packages: @parcha/pi-vision
kind: feature
---
The `transcribe` skill ships in the package (`skills/transcribe/SKILL.md`, beside `look` under `pi.skills`): strip a long video's audio once, cut it in ten-minute chunks, transcribe each in code mode with `vision.transcribe` (the host's speech-to-text model; its key and its price stay with the host), write one `transcript.tsv` of start, end and words in seconds of the whole video (each video in its own folder under `.hear`), and search it with `rg` to cite `file#t=seconds`. Each chunk's rows are kept beside it, so a chunk is sent once and a run cut short pays for nothing twice; files are renamed into place only when complete, and the transcript step stops at a chunk with no rows rather than leave a piece of the video out.
