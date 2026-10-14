---
packages: @parcha/pi-durable-disk
kind: ci
---
An example's test can no longer hang past its timeout: `runExample` waits for the example's output only until the timeout
and a 2 s grace, then drops the pipes a process outside the example's group still holds and reports the run as timed out.
The package's tests run with `--test-timeout=240000`, so a test that hangs fails with its name.
