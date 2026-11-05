---
packages: repo
kind: fix
---
Console: every time it shows (a run's header, the Runs list, the Timeline, a run's files, learned notes, Mission Control, an agent's runs and revisions, tool keys' checks and the webhook's deliveries) reads in the viewer's own time zone, the browser's, instead of UTC. A run started at 20:50 UTC now reads 4:50 PM to a viewer in UTC-4. All of them go through one formatter, so the webhook's deliveries now read in the same short shape as the rest. Relative times and the analytics' days, which are the server's UTC days, are unchanged.
