---
packages: @parcha/pi-durable-agent
kind: fix
---
The spend cap's wrap-up row (`CAP_WRAPUP`) is the server's: `origin: "server"`, so a host shows it as an AgentRun row, and its id ends in the new `NOTE_SUFFIX`, so `isMessageRow` never counts it as a message its turn took.
