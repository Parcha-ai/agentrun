---
packages: repo
kind: fix
---
The console says a schedule's time once, in your own time: a weekly schedule at 08:00 UTC seen from New York reads "At 3:00 AM your time (08:00 UTC), only on Monday · next Mon Nov 16, 3:00 AM EST" on the Triggers list, the trigger's page and a template's Apply result, where it read "At 08:00, only on Monday · UTC · next Nov 16, 3:00 AM" (two clocks, the second with no zone). The schedule's own time and zone are in parentheses only when its zone is not yours; the next run carries its day and your zone's name, the hour following a clock change. A cron line with more than one time ("Every 15 minutes") keeps its words, its zone said once. A one-time schedule set in the past says the time you picked, in your own time ("Pick a time in the future: 9:00 AM today has already passed."), not the API's ISO time.
