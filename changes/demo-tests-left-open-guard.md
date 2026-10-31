---
packages: repo
kind: ci
---
**A demo test file that leaves a child, a server or a held pipe open fails by name in seconds, instead of hanging its CI shard**
- `node --test` waits for each file's process to exit before it reports the next file. One reference demo file whose tests all passed but whose process stayed alive held examples-2 until the 30-minute limit, with no name in the log.
- The shared demo-test helpers now check each file that is still alive 10 seconds after its hooks start, after the file's own `after()` hooks have run. What is still open is named, closed, and the file fails: a child (by pid and argv) with the processes it started, a server (by address), or a pipe that a child's own child still holds.
