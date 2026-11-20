---
packages: @parcha/agentrun-serve
kind: fix
---
A computer whose every tool is set to deny is no longer started, so its provider no longer bills you for a phone, desktop, sandbox or browser the agent can't use. Saving such an agent answers a warning on `definition.computer`: "Every tool for this agent's phone is set to deny, so a run never starts it: allow one, or set the computer to none." Its runs go on without the computer, and the run's start no longer asks for that computer's keys or host setup. A computer with even one tool allowed starts as before. The console's agent editor lists such a warning under "Saved. A run of this revision goes on, as each line says:", apart from the warnings that refuse a run until the server has what they name.
Once a run's first call of its desktop, phone or browser tools is refused for a deny (a setting changed while the run goes), that computer is off for the rest of the run: the refusal says so once, and every later call of its tools is refused at once, in short words, without reaching the computer, even if the setting is allowed again. A person turning down an asked call does not turn the computer off.
