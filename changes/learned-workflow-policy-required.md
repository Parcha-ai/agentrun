---
packages: @parcha/agentrun-serve
kind: fix
---
A learned workflow's call nodes never run a tool on a default of allow: its run must give the tool policy (and where each setting came from) that its call nodes are held to, and one given none runs nothing and says so. Every caller passes one already. Upgrading: nothing to do.
