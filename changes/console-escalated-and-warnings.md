---
packages: repo
kind: fix
---
The console no longer hides two things the server says. A run that ended escalated (`failed`, its error's code `escalated`) reads Escalated in the runs list, Mission Control and the run's header, never Failed, and its error card says the run escalated. An agent save's `warnings` (what this host lacks to run the revision, such as a provider's key) now show after the save: every one is listed above the form, and each also appears beside the field it names. A create's warnings show on the agent's page that opens after it.
