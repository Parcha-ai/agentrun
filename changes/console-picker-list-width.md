---
packages: @parcha/agentrun-serve
kind: fix
---
In the console, a search field's list is as wide as its field from the moment it opens: the app trigger's Event field and the Composio Toolkit field. The first time such a list opened it was drawn at its minimum width (192 px) for a frame or more, then jumped to its field's width. That jump is also why the console's `event-search` browser flow failed about one run in two: it read the list's width while the list was still narrow. The flow now reads every width the list has had on the page, so it fails on the jump itself and no longer depends on when it reads.
