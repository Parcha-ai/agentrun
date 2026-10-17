---
packages: @parcha/pi-vision
kind: feature
---
The `transcribe` skill ships in the package (`skills/transcribe/SKILL.md`, beside `look` under `pi.skills`): strip a long video's audio once, cut it in ten-minute chunks, have a speech-to-text model transcribe each through an OpenAI-compatible `/audio/transcriptions` endpoint the host gives (`OPENAI_BASE_URL`, `OPENAI_API_KEY`; Scribe v2 by default, any model the host names), write one `transcript.tsv` of start, end and words in seconds of the whole video, and search it with `rg` to cite `file#t=seconds`. A chunk's answer is kept beside it and never sent twice; the words are read in OpenAI's `verbose_json` shape or in fal's and ElevenLabs'.
