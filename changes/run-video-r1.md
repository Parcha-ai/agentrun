---
packages: @parcha/agentrun-serve
kind: feature
---
An agent's desktop or phone can record a video of each run's screen: `definition.computer.record: true` (off by default).
- The recorder watches the screen on a connection of its own, from the claim's attach until the computer's release or the run's end, with or without a viewer open. A park pauses it; the resumed run goes on in a new file. It never holds up the live view or the agent: a frame that comes while the encoder is busy replaces the one waiting, and is counted.
- One ffmpeg per recorded computer, frames piped in and stamped as they come: at most 10 frames a second, 1280 pixels on the long side, no audio, H.264 in fragmented MP4. A frame of another format (a phone's PNG, then JPEG) goes on in the next file.
- The files are `recordings/<computer>.mp4` in the run's folder on the machine that runs it, beside `work/`, never in it. Caps: 500 MB across a run's files, and 2 hours from the recording's start or the run's resume. A cap, an encoder that stops (a crash, a full disk) or a screen that stops answering ends the recording with a line on the run's timeline; the run never fails because of it.
- The video shows everything on the screen, a person's typing during a take-over and any secret included: pixels can't be redacted.
- A server without ffmpeg on its `PATH` refuses `record: true` at save: 422 `not_allowed` on `definition.computer.record`, naming the fix. The published image now has an `ffmpeg` built for the recorder alone (about 6 MB). A desktop or a phone only: on another kind, 422 `not_allowed`.
