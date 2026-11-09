---
packages: repo
kind: fix
---
A run a trigger started names the trigger by its kind on its chip, in the runs list and on the run's page: "Webhook: inbound-lead" for a webhook's run, "Schedule: nightly" for a schedule's, where it read "Schedule:" for every trigger. A trigger the console's list doesn't hold (deleted since, or not read yet) reads "Trigger: <id>".
