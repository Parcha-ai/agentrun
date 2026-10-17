---
packages: @parcha/pi-vision
kind: feature
---
`vision.transcribe`, a code-mode global beside `vision.see` (`handle.transcribe(env, call)`, described to the model by `VISION_TRANSCRIBE`): one audio or video file in, its words with their start and end in seconds out, with the provider, the model, the price and the receipt. The host picks the speech-to-text model in `VisionOptions.transcriber` and holds its key; `@parcha/pi-vision/transcribers` builds fal's queue (`falTranscriber`, fal's own `Key` auth or a gateway's bearer key), ElevenLabs' (`elevenLabsTranscriber`, `scribe_v2`) and OpenAI's (`openAiTranscriber`, `whisper-1`), each answering in one word shape. A file over the provider's limit is an `over_budget` miss that names it; each transcript is filed and told like a look, priced per audio minute (unknown when no price is known, never $0), and kept, so asking again pays nothing.
- The kinds gain `audio` (MP3, WAV, Ogg, FLAC, M4A, told by their bytes); `allow` is asked with `tool: "vision.transcribe"`.
- `./testing` gains `fakeTranscriptionFetch` (each provider's documented request and answer) and `SENTINEL_TRANSCRIBER_KEY`.
