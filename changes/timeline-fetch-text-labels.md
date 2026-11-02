---
packages: repo, @parcha/pi-durable-agent
kind: fix
---
A fetch that a tool answered as refused or failed reads as that on the timeline, never as "ok". `web_fetch` and `fetch_page` answer a refusal (`{ok: false, refused}`, the public-host guard's) or a failure (`{ok: false, error}`) as their result rather than as an error, and the timeline read any returned call as "Fetched …: ok". Now such a call reads "Tried to fetch …", its result row says "refused: …" or "failed: …" with `tool_status` `failed`, and the text render lists it as failed, outside a fold of fetched pages. `fetch_page` gets the same label as `web_fetch` in place of "Using tool: fetch_page". A host registers how its own tools' results tell their outcome with `registerOutcome`, beside `registerLabel`. The console labels a `text_block` row "Text", with its own icon, in place of its kind's name.
