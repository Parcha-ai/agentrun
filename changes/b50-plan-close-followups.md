---
packages: @parcha/agentrun-serve, @parcha/agentrun
kind: fix
---
A read of the ChatGPT sign-in that was out while a sign-in was kept, or while a sign-out removed it, no longer undoes their state: the server stays signed in or signed out as they left it. A server that stops while a pasted sign-in is still listing its models waits up to 2 seconds for it, so the sign-in is saved before the store closes.

`agentrun start` keeps in `start.log` only a line in the server's exact shape of a sign-in's failure, at most 64 KiB of them after the start. A second start on the same data folder no longer leaves the first's later lines over its log or after a run of NUL bytes.
