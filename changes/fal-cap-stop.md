---
packages: @parcha/agentrun-serve
kind: fix
---
A fal job booked above its hold (its output larger or longer than asked) that takes the run past its spend cap now stops the run at once, in the cap's words, and nothing runs after it, a script's own calls included. Before, the run went on until its next model request. Only charges already in stop a run. Pricing by the length of the input media now covers only the endpoints fal bills that way: ElevenLabs dubbing, voice isolation and speech-to-text, and sync-lipsync v2. Another endpoint billed per second whose input names no length, such as LatentSync, is refused under a cap and booked as an unknown charge without one.
