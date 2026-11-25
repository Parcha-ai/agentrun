---
packages: @parcha/agentrun-serve
kind: fix
---
A desktop, phone or sandbox turned off for the rest of a run (its tools refused for a deny) is no longer kept when the run parks: it is deleted at the park, as at the run's end, and its mount credential for the run's folder is revoked. Before, it was kept and billed for 10 minutes that no later part of the run could use.
