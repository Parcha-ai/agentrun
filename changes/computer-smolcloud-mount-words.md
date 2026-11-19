---
packages: @parcha/agentrun-computer
kind: fix
---
smol cloud's refusal of a synced folder now says why: smol cloud binds each machine's own storage disk at `/workspace`, and a synced folder can be held only where nothing is mounted there. It used to say a synced folder "needs nothing mounted there", which read as if one would work.
