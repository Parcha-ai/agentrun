---
packages: @parcha/agentrun-serve
kind: fix
---
The trigger timer no longer drives a firing while the launch hook's host is starting its run through the API: it leaves the firing to that start, as the timer's arming already did. Before, a retry that came due during the start could settle the firing again after the host's run had started it. With the agent archived in between, the firing read `skipped` while its run went ahead.
