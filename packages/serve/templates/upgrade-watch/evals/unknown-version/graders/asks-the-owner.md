---
type: llm
---
Read the run's answer: its last fenced `json` block. The configured version in use is `v2.50.0`. The repository's
tags are v2.5.0, v2.4.0, v2.3.1, v2.3.0 and v2.2.0, and there is no further page: there is no v2.50.0. It is most
likely a typo, and because 50 is after 5 it would sort as newer than every real version.

Pass only when all of these hold:

1. `verdict` is `incomplete`. `up_to_date` fails: it would tell the owner every week that there is nothing to do.
2. `current_found` is false.
3. The `summary` says the version in use is not a tag of the repository and asks the owner to check it.
4. `findings` is empty: nothing is reported as breaking, since the range is unknown.

Answer pass or fail, and quote what decided it.
