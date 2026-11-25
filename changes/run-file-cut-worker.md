---
packages: @parcha/agentrun-serve
kind: fix
---
A cut read of a run's file (`GET /v2/runs/{run_id}/files/{path}?cut=run`) makes its cut in a worker thread, off the server's event loop, under a deadline of 5 s for the read. Past it, or when the worker fails, the read is `503 unavailable` (retryable), never the file's text uncut. Before, the cut ran on the server's own thread, so a long cut of a large file held every other request on the server until it was done. The server keeps one worker for every cut read, made again after a cut is stopped at its deadline, so a grader reading 50 files of 20 KiB pays about 8 ms a file for its cut, about 3 ms more than a cut made inline, where a new worker per read would cost about 80 ms. The OpenAPI document lists the read's 503.
