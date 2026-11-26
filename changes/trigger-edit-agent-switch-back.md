---
packages: @parcha/agentrun-serve
kind: fix
---
In the console, editing a trigger, picking another agent and then picking the trigger's own agent again now brings back the input the trigger had. Before, the first pick discarded the stored input, so saving after the switch back sent the target again with the typed fields blank and without the keys no field shows (a `note` written through the API), and nothing on the page said so.
