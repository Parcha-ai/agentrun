---
packages: @parcha/agentrun-serve
kind: fix
---
A fal job whose output states more than its input asked for (a larger image, a longer clip) is still booked at what its output states, and when that takes the run past its spend cap, the run now stops at once in the cap's words: no tool runs after it, a script's own calls included. Before, the run went on until its next model request. A fal job priced by the length of the media it is given is now only one of the endpoints fal bills that way (ElevenLabs dubbing, voice isolation and speech-to-text, and sync-lipsync v2); another endpoint billed per second whose input names no length, such as a talking video made from a voice or LatentSync, which fal bills by its output video, is refused under a cap and booked as an unknown charge without one.
