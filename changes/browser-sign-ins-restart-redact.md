---
packages: @parcha/agentrun-serve
kind: fix
---
A run a server takes up after a restart, its process still going, never shows its browser sign-in's pointer: the server reads the agent's pointer back, read only and without taking the save lease, among the values the run's answers, errors and timeline never show. Before, only a launch by the same server added it, so a run kept across a restart could show it.
- A run's end-of-run learning refuses a note that holds its browser sign-in's pointer, as it refuses a held key, so the pointer never reaches the agent's learning.
- The line a run's end keeps in the agent store (its answer, or its error) is cut of the same values its served answer is, whole.
- A run a restarted server loads, ended or going, has its pointer read back before its conversation is read, so a conversation that repeats it is cut from the first.
- A run still going that was handed its agent's sign-in, which the restarted server cannot read (its seal key changed or is missing, or the sign-ins file is damaged or unreadable), is not taken up: it is stopped (or, its process already gone, never opened again), ends failed saying why, and its rows are not read until the sign-in opens again. A run launched signed out is taken up as any other.
- A run that already ended, whose sign-in the restarted server cannot read, keeps how it ended, but none of what it said is served (its rows, answer, output and error words) and it can't be continued until the sign-in opens again; any ended run with a browser counts, so one from before servers kept the mark is withheld too.
- A workflow run whose sign-in the server cannot read serves no graph (`GET /runs/{id}/graph` answers 403 `forbidden`, saying why): its nodes, decisions and calls are read from its store and could repeat the pointer.
- A launch that can't save that it handed the run its sign-in hands none: the run browses signed out.
- A one-time limit of the upgrade: a run still going across it carries no mark that it was handed the sign-in, so if the upgraded server also can't read that sign-in at the same start, the run is taken up signed out and its text is not cut of the pointer.
- A hidden run is shown again only when the very sign-in it was handed opens (its serve.json keeps that pointer's SHA-256, never the pointer), never one made since in its place; and it stays failed, saying why, even when its server went during its end-of-run learning turn.
