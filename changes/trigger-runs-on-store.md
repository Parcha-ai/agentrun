---
packages: @parcha/agentrun-serve
kind: fix
---
A trigger's runs on the store read as main's did. A trigger's Timeline row names the trigger by its name as it is now, read by its id at each read (a rename shows at once; a deleted trigger is named by its id; a held value in the name is cut), and a trigger's run is titled from its trigger, never from its input. A trigger's message to a run is queued as a command row with its firing marked sent in one write, within the trigger's bound per run, so a server that goes down after it never sends it twice, and a run that has ended takes none. `GET /v2/triggers` no longer documents a triggers.json that does not read: a store busy with another write answers 409 home_busy.
