---
packages: @parcha/agentrun-serve
kind: feature
---
`web_save` answers a saved audio or video file's length in seconds as `duration_s` (to the millisecond), read from the file's own bytes: mp3, wav, mp4 and m4a. An agent can then fit a cut to a voiceover, or price a job billed by its input's length, without another tool. Any other file, or media whose length its bytes don't give (ogg, webm, a file with no header), answers no `duration_s`.
