---
packages: @parcha/agentrun-serve
kind: fix
---
Imports now skip hidden paths. A template import from a GitHub source (`POST /v2/templates/import` with `source`) no longer stores a hidden file or folder of the package, such as a committed `.env` or a tool's `.cache/`, the same as an upload. Before, the import kept such a file in the stored package, though no part of the server read it. Now it is skipped unread: never counted against the import's file and byte limits, never shown by a dry run, never stored. A hidden symbolic or hard link still refuses the import (422). The stored template's id and `sha` (the commit read) mean what they did. A package stored before this change keeps any hidden file until it is imported again or deleted.
