---
packages: @parcha/agentrun-serve
kind: ci
---
Three serve test areas run faster and check the same things. Eleven of the work/ read checks in `workspace-reads.test.mjs` call the workspace module straight on a scratch work/ directory, laid out as a run's, with the server's own canary file beside it. They used to start a server and finish a run first, about 7 s each on a loaded machine; now they take milliseconds. The tests that go through the file view over HTTP still use a server, and every assertion stays. The mid-map pause test in `dwf.test.mjs` uses a 300 ms fake decision instead of 1.5 s; a pause that let calls through still fails it. The retried start sweep in `box-sweep.test.mjs` uses one server and no earlier run. The start's own sweep and the first run's sweep both fail, and the next run's sweep succeeds. Locally, under load, this saves about 90 s of test time on `workspace-reads`, 9 s on the pause test and 6 s on the sweep retry.
