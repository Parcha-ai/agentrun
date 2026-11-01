---
packages: @parcha/agentrun-serve
kind: ci
---
serve's recovery tests wait on what they wait for, not on a count of polls. A server started in a process of its own is ready when it prints its banner (its address and key lines), and one that exits before that fails the test at once with what it printed; a run is working, adopted or stopped when its timeline, long-polled, says so, and one that ends in another status fails the test at once. Before, both waits gave up after a fixed number of 50 ms polls (about 10 s for a server, about 15 s for a run), which a slow start on a loaded machine could pass, failing a test whose behaviour was right.
