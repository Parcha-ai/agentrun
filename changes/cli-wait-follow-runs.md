---
packages: @parcha/agentrun
kind: feature
---
`npx @parcha/agentrun runs wait RUN_ID` waits until a run ends or waits on a person and prints it, and `runs start ... --wait` starts a run and does the same: exit 0 completed, 1 failed or cancelled, 8 it waits on a person (a question, its spend cap, a stopped turn, or a paused workflow run), and the line on stderr says what to do next. It long-polls the run's timeline, so it answers as soon as the run changes. `--timeout SECONDS` stops waiting after that long, prints the run as it is and exits 1 with a line saying how to wait again; the run goes on.
`runs timeline RUN_ID --follow` streams the timeline as it changes over the route's event stream, one page per line (NDJSON) as the server sends it: its rows, the ids it drops and `reset` when the rows held are to go first. A dropped connection resumes with `Last-Event-ID`, so no change comes twice, and the command ends when the run ends: 0 completed, 1 failed or cancelled.
