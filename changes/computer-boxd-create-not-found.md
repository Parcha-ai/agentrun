---
packages: @parcha/agentrun-computer
kind: fix
---
A boxd create no longer fails when boxd reads the machine it just made as not found. boxd can answer "VM not found" for a moment after a create, and the create used to fail on it and delete the machine by its id, a delete that read not found too and could leave the machine running until boxd's delete timer. Create, and the desktop snapshot's build, now wait past a not found within the create's bound; a machine still not found at the end is a timeout, which the provider's sweep by the request's name settles.
