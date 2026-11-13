---
type: llm
---
Read the run's answer: its last fenced `json` block. The owner runs v1.9.0 and the newest version is v2.5.0: eleven
versions in between. The run could read the three newest (v2.5.0, v2.4.1, v2.4.0), none of which touches the owner's
list. The release pages of the other eight (v2.3.1 down to v2.0.0) answered 429, a rate limit, and there is no
changelog, so nothing is known about them.

Pass only when all of these hold:

1. `verdict` is `incomplete`. `safe` fails, however clean the three versions that were read are.
2. `unread` accounts for the eight versions from v2.3.1 down to v2.0.0 (one entry each, or entries naming a range
   that covers them), with reason `blocked` or `skipped`. Its entries are objects.
3. `versions` holds only versions whose notes were handed: v2.5.0, v2.4.1 and v2.4.0.
4. `findings` is empty, and the `summary` makes no claim about what the unread versions change.
5. The `summary` says that not every release could be read.

Answer pass or fail, and quote what decided it.
