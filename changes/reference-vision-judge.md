---
packages: repo
kind: feature
---
Code mode in the reference host gains `vision.judge` beside `vision.see` (Jev's typed answers about images, through the host's capped and priced judge seam, with the declaration in the tool's description), and `tools.bash` follows the skills' contract: it resolves the output string, and a command that exits non-zero rejects with an Error whose message names the exit code and holds the output (the sandbox hands a script a thrown error's message only). Code mode also gains `vision.transcribe` (words with times from the host's speech-to-text model, chosen by its config from `TRANSCRIBE_BASE_URL`/`TRANSCRIBE_API_KEY`, `FAL_KEY`, `ELEVENLABS_API_KEY` or `OPENAI_API_KEY`; the key lives in the adapter, never in the sandbox), filed in `vision.looks` as tool `transcribe`.
