---
packages: @parcha/pi-browser
kind: fix
---
`@parcha/pi-browser`: Security: a `web_search` answer's snippets are screened before the model sees them. Each hit that carries a snippet is judged like a fetched page by the host's `classifyPage`, and one at or over the injection threshold comes back with its title and snippet withheld (`withheld: "injection"`). With no judge, a judge that fails, or a screen that runs out of time (`snippetScreenMs`, 30 s by default), the list is marked `page_guard: unjudged`. `classifyPage` now receives an optional abort signal, aborted when the screen ends early.
