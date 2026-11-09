---
packages: repo
kind: fix
---
The console's run timeline shows a trigger's message (a webhook's input, a schedule's) as the trigger's: labelled "Trigger", its first line as the title, never as "You". Before, it read as a bare "Phase" row titled "Trigger <its id>: …".
