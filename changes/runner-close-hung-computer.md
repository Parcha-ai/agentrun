---
packages: @parcha/agentrun-serve
kind: fix
---
A runner stopped while one of its runs waits on a computer that never answers (a box whose daemon hangs on a file call or an exec) now closes as soon as its drain is over: the shutdown's stop ends the run's computer call, and the run is handed back at once, its claim's attempt cut `drain`, its computer let go and its interval ended. Before, the call held the close for its whole window (40 s with the default drain), and the run was then left to its lease, its computer to the next claim. A run's end (its background processes ended, its scratch swept through the computer) is never cut that way: it keeps the close's window, as before.
- On SQLite, a runner reads the store's runner floor again within about a second of another process writing the store's file (a later server's upgrade among them), not only at each renewal (every 10 s), so it stops sooner once the floor rises above it.
