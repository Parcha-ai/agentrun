---
packages: @parcha/agentrun-serve
kind: fix
---
A run that resumes on a new computer says so. After a lost runner or a crash (any kind), or a server stop (a desktop or a phone), the claim that starts a fresh computer for the run adds to its ready line that it's a new one and what was on the old one is gone (in Mode 2, that the run folder is kept). The model's next request carries one server message saying its computer was replaced, once, and a `computer_act` that names a ref or a state the new computer never gave, or a point before the model looked again, is refused in words and never reaches the computer. An agent's own (persistent) computer and a paired one get neither.
