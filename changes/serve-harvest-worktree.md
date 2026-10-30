---
packages: @parcha/agentrun-serve, @parcha/agentrun-learn
kind: feature
---
A run's learning can be harvested from its working copy: the host builds one commit on `runs/<run id>` from the files alone. The tree is the seed's, with the layout's paths as they are on disk: what the agent wrote or changed, and a seed file under those paths gone from disk as a deletion. A symbolic link (never followed), a path outside what a run may write, a file over its cap and the agent's own `.git` (never read or run) are left out and reported. The memo's front matter is the host's facts and its sections the agent's. The commit is dated the run's end, with a fixed message and the run's `Run-Id`, so a harvest again, on any host, is the same commit. `@parcha/agentrun-learn` exports the layout's `placeOf`, `isLocked` and `isHostOwned` for it. The harvest is not wired to a run's end yet.
