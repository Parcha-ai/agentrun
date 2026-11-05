---
packages: repo
kind: fix
---
The console's timeline shows a message the server wrote into a run (an approval's resume, a raised cap's follow-up: a `phase` row with `origin: "server"`) as AgentRun's: labelled "AgentRun", its first line as the title without the "AgentRun:" prefix, muted. It never reads as the person's. A plain phase row keeps "Phase".
