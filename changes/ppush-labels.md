---
packages: @parcha/agentrun-computer
kind: feature
---
The shared machine-host adapter takes vendors that keep no labels. Such a host declares `HostFacts.labels: "machine"`, and the adapter keeps the labels in the machine itself.
- Once the machine runs, before anything else of the create's, the adapter writes the request's labels as JSON to `/var/lib/agentrun/labels.json`. The file is root's, 0600 in a 0700 directory. `get`, `list` and `attach` read the labels back from it, and `extend` moves the deadline label in it once the vendor's timer moves. Such a host must declare `lifetime: "vendor"`: a machine whose labels were never written has none the janitor lists, so only the vendor's timer ends it.
- The host gives each machine the request's name (`Machine.name`) where the vendor takes a name. A machine of the request's name whose labels aren't written yet is the request's. A later create's sweep leaves it while it is younger than any create could take to write them (11.5 minutes on the default timeouts), then deletes it.
- The new Core case `isolation.label-file` checks that the computer's user can't read the file: it passes on `not_found` or `denied`.
