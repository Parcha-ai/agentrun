---
packages: @parcha/pi-vision
kind: feature
---
The `transcribe` skill ships in the package (`skills/transcribe/SKILL.md`, beside `look` under `pi.skills`): strip a long video's audio once, cut it in ten-minute chunks, send each to a speech-to-text model on fal's queue through the address the host gives (`FAL_QUEUE_URL`, by default `$OPENAI_BASE_URL` without `/v1` plus `/fal-queue`, with `OPENAI_API_KEY` as the bearer; Scribe v2 by default, any model the host names), write one `transcript.tsv` of start, end and words in seconds of the whole video (each video in its own folder under `.hear`), and search it with `rg` to cite `file#t=seconds`. A chunk is submitted once: its request and its transcript are kept beside it, so a run cut short polls what it sent and pays for nothing twice; files are renamed into place only when complete. The words are read in fal's and ElevenLabs' shape or in OpenAI's `verbose_json`.
