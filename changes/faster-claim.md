---
packages: @parcha/agentrun-serve
kind: fix
---
A run starts sooner: a runner in the server's process claims a new run as soon as it is queued (it waited up to a second for its next poll), and a run's first claim makes its desktop, phone, sandbox or browser without first asking the vendor to list older computers of the run (there can be none). On a fake desktop the time from the run's start to the vendor's create went from 0.78-0.93 s to 0.07-0.11 s; on a vendor's desktop it also saves that vendor's list round trip.
