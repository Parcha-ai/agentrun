---
packages: repo
kind: ci
---
**A test that reads a pid from a file can no longer signal its own process group by reading the file mid-write**
- A test that waited for a pid file to exist and then read it could read it in the moment between the file being made and the pid landing in it. The empty read was taken as pid 0, and `process.kill(0, "SIGKILL")` killed the test's whole process group: npm, the test runner and every test file still running. The shard then ended with no summary and no failing test named.
- serve's crash-mid-request cap tests and ci-shard's cancel test now wait until the file holds a whole pid, and their fixtures write the pid to a file beside it and rename it into place. pi-browser's ffmpeg-timeout test reads its stub's pid file the same way in its cleanup.
- Before any signal, each of these tests refuses a pid that is not an integer above 1, or that is the test's own: the test fails with a message naming the pid, and nothing is signalled.
