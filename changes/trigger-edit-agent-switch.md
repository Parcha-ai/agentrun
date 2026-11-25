---
packages: @parcha/agentrun-serve
kind: fix
---
Editing a trigger in the console and picking another agent now starts that agent's input afresh. Before, the trigger's stored input came along: keys the new agent's form has no field for were sent, so a schema that refuses extra keys answered "Remove target.input.<key>" with no field to clear it, and one that allows them got the old values unseen.
