---
packages: @parcha/agentrun-serve
kind: fix
---
An installed server runs a learned workflow. Its model nodes run on agentrun-pi's host runner, which loads `@earendil-works/pi-coding-agent`, an optional peer of agentrun-pi that an installed server did not have, so a `learned_workflow` call failed with "Cannot find package '@earendil-works/pi-coding-agent'". The server now depends on it (1.5.0, the pi family's version). Upgrading: nothing to do; the install pulls it in.
