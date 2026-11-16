---
packages: @parcha/agentrun-serve
kind: feature
---
The console makes and edits a feed trigger. Triggers has New feed trigger (`#/triggers/new-feed`), and a first trigger card for it when there is no trigger yet.
- The form takes 1 to 20 URLs, one a line, and says each one that is not http or https, holds a user or password, or is there twice, under its place in the list sent (`source.urls[i]`, as the server names it). It reads them every 15 minutes unless told, and not under the server's floor (capabilities' `min_every_s`). A JSON list's `items` and `id` pointers sit behind a "JSON list" disclosure, and "Only when" conditions on the item become its filter (`accept: [{event: "item", where}]`).
- There is no Test button. PLAN-feed's "What a person sees" had one that read the feeds before saving; serve has no such route. Instead, the create lands on the trigger's page, which says its first check (the create waits for it) and the note of what it starts from ("Watching 2 feeds from now: the 130 items already there won't start runs.").
- A feed trigger's page shows its feeds, how often they are read, its pointers, its filter, and its last check: ok or failed, its words, and when. A trigger turned off because every feed stopped says to edit its feeds. The list says each trigger's last check under its last firing.
- Edit feed sends the URLs, the interval, the pointers and the filter as a PATCH of the source alone, and nothing when nothing changed. A line under the URLs says that a feed added starts from now: what is in it already won't start runs.
