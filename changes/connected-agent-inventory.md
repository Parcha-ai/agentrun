---
packages: repo, @parcha/agentrun-serve
kind: fix
---
Show connected coding agents in the same searchable inventory and count as registered agents, with
project, session, model, activity and token details. Preserve loaded cards when another source is
loading or unavailable, and exclude nonarchivable connections from the archived view.

Identify coding sessions by their native title, project basename or delegated task name, with a stable
ID suffix for unnamed sessions. Names refresh even while idle. The observer sends bounded labels only
to receivers advertising support; prompts, conversation previews, full paths and obvious credentials
are excluded. Token accounting and selection scopes stay unchanged.
Unicode labels respect queue and delivery byte limits so long multilingual names cannot stall delivery.
