---
packages: @parcha/agentrun-serve
kind: fix
---
The server stops once on SIGINT or SIGTERM. A terminal's Ctrl-C reaches it twice within milliseconds (the terminal's process group and `npx @parcha/agentrun` passing it on), and the second one killed it before its runs drained, leaving its stop record behind. A repeat within a second is now that same stop; a second Ctrl-C after that stops at once, saying "stopping now; runs resume on the next start". A stop that outlasts its runs' drain by 15 seconds stops the same way.
