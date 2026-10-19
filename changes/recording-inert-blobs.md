---
packages: @parcha/agentrun-harness
kind: fix
---
A recording publishes only inert blobs. The validator and the gallery gate take a blob's extension from an allowlist (`png jpg jpeg webp gif webm mp4 pdf json jsonl txt md csv vtt`; `html`, `htm` and `css` only as the files of `manifest.artifact`; `svg`, `xml`, `js` and any other never), and the recorder records an `image/svg+xml` output, or any other extension it is handed, as text. Every blob that is not media is scanned as text, in the validator, the gate and the live follower. The scan knows the Google, fal, ElevenLabs, xAI, Groq, Hugging Face, Slack and Stripe key shapes, and a bare `/home/<user>`, a Windows profile, `/root/` and a macOS temp folder as machine paths.
