---
packages: repo
kind: breaking
---
The recording validator now refuses a live host line that carries an event-level `gen` ("a supervisor line (kind) has no event-level gen", as the viewer says); it accepted one before. A hand-built recording, or one made by a recorder older than this change (a tool box's `box.receipt` written by a process), is refused until the line's `gen` is removed and the process is named in `data.gen`.
