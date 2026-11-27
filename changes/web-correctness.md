---
packages: @parcha/agentrun-web
kind: fix
---
web_search and web_fetch fix several edge cases in what they ask, cache, say and record.
- A search backend that answers no results no longer ends the call: the next backend is asked, and the empty answer comes back only when no backend has results. The receipt marks that backend's turn `empty`. A paid search that answered no results stays on the receipt's cost, since it was sent.
- Keyless Exa answering text it can't read is now a failure typed `UNREADABLE`, as the keyed providers' are, so the next backend is asked, where before it answered no results.
- A run reads a page once whatever its URL's fragment or its host's case: `https://x.example/doc#a`, `#b` and `HTTPS://X.example/doc` share one read and one fee. Each answer's `url` still names the fragment it asked for.
- A search's receipt `cost.lines` no longer changes after the call returns. A sift the caller stopped that pays later leaves the receipt as it was.
- A fetch's receipt `asked` names the URL without its user name or password, as the page's `url` does.
- Cuts no longer split an emoji or any other surrogate pair: `clip`, a search result's snippet with no space to cut on, and keyless Exa's quoted error.
- Keyed Exa and Firecrawl in a fetch order with no key are passed over unsent, as Parallel is: no guard check, no `web_fetch_provider_failed` log line. The page says `not tried: this run holds no Exa key` (or Firecrawl key).
- Parallel's failed read is recorded on the receipt like any other provider's, with the limit it met and its words cut at 300 characters.
- A page whose direct fetch failed after a provider ahead gave none now says "the direct fetch failed too", where it said "this one was fetched directly".
