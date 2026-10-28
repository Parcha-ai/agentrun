---
packages: repo
kind: ci
---
**A demo test file that leaves a child, a server or a held pipe open fails by name in seconds, instead of hanging its CI shard**
- `node --test` waits for each file's process to exit before it reports the next file. One reference demo file whose tests all passed but whose process stayed alive held examples-2 until the 30-minute limit, with no name in the log.
- The shared demo-test helpers now check what is still open after a file's last test. Anything left after 10 seconds (a child by pid and argv, a server by address, or a pipe a child's own child still holds) is named and closed, and the file fails.
