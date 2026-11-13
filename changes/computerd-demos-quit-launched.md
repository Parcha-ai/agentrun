---
packages: repo
kind: fix
---
The Mac demo tasks quit each app the run started (one not running before the run) at the end of its own task's teardown, and after the sweep, so its window no longer sits in front of a later task's and paints that task's frames black. An app that was running before the run is left as it is. The snapshot and the teardown ask Calendar and Notes only while they run, since asking started them; an app that did not quit, or Calendar or Notes started or quit during a task, counts as left behind.
