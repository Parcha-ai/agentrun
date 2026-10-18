---
packages: repo
kind: fix
---
The reference recorder takes the run's own machine out of every line and text blob, beside the exact secret values: the user name (as a whole token, in a path segment or an `ls -l` owner or group column, never as a word in a sentence), the home directory (`~`) and the paths under the run's directories (`<run>/...`). A tool result that listed a directory no longer carries the box's user name into a recording.
