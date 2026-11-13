---
packages: repo
kind: breaking
---
The Mac demo tasks (`mini-demos.py`) leave nothing behind on a person's Mac. Each task works only in its own sandbox, `AgentRun demo <run id>`: a calendar, a Notes folder, or a folder under `/private/tmp/agentrun-demos`. The task's window is found by its title, so a person's own windows are never the target. AppleScript makes the sandbox and removes it in a teardown that runs however the task ends. A snapshot of names, counts and window ids, taken before and after, reports what each task left; the run ends `N/5 pass, K left behind` and exits 1 unless both are clean. A run first sweeps the sandboxes an earlier, killed run left. Breaking: the script needs Computerd's Automation grant for Calendar, Notes, Finder, TextEdit and Safari (`--ask-grants`, answered once by a person at the Mac), and `--keep` is gone.
