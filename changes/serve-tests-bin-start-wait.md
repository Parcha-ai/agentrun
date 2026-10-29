---
packages: repo
kind: ci
---
**serve's tests that start the bin in a process of its own wait for it to start, within their budget, and say why when it does not**
- harness-run, recovery and operability polled the child's stdout for 10 s, inside tests that allow themselves 60 to 120 s. A start slower than 10 s on a loaded machine failed "the server did not start:" with nothing after it, since stderr was not kept.
- One helper in test/support.mjs, `startBin`, now does it for all three: it resolves on the banner line, rejects at once with all of stdout and stderr (read to their end, on `close`) if the child exits first, and gives up after 20 s, so two starts fit inside a 60 s test.
