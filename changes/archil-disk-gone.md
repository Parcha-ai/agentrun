---
packages: @parcha/agentrun-serve
kind: fix
---
A run on an Archil disk that Archil no longer has fails at its claim, before any file call, saying so: the agent's disk is read at Archil at every claim (one GET), as a launch's disk already was, and a disk that is gone, or one in another region than the key's, refuses the run naming the disk, the region and the way out (`DELETE /v2/agents/{id}/archil` drops it, and the agent's next run makes a new one). No new disk is made in its place: the agent's learning and its runs' folders were on it. Before, such a run failed at its first claim with `".agents/skills" is not there`, since every call on the missing disk answered 404 and a 404 read as a folder that was not there.
- An Archil workspace keeps Archil's own words in a failure: a missing file or folder is still `NOT_FOUND`, with what Archil said after it, and a disk Archil has no record of is `UNAVAILABLE` naming the disk and its region, never a missing folder.
- A run's folder on its Archil disk that can't be made fails the claim with the reason, where it was a log line; a folder already there is not put again, so a later claim whose kept computer holds it opens at once.
