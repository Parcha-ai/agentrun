---
packages: @parcha/agentrun-serve
kind: fix
---
A server whose build has no pack directory starts again: the packs it ships are read the first time a run or capabilities asks for them, not when the server loads, so a run that asks for an output type then gets the `422` that says the server ships no default pack. A pack the server ships that names a skill its build does not ship is now a `500 internal` that names the pack and the skill as this server's packaging error (`details.pack`, `details.skills`), with `retryable: false`, since the same build answers a retry the same way, where it was a `422` telling the caller to add the skill to the agent's revision. A pack object a run brings that names a skill nothing holds is still a `422` on `profile`.
