---
packages: @parcha/agentrun-web
kind: fix
---
A web_fetch turn that a provider's breaker held now appears on the receipt the same way web_search's does: `{provider, outcome: "held", failure: {class: <limit kind>, code: "HELD", message}, ms: 0}`. Before, keyless Firecrawl and keyed Exa or Firecrawl left it off the receipt, and Parallel recorded it as a failed turn. Every other turn that was not asked is now a failed turn on the receipt for every provider, as web_search's is and as Parallel's already was: an unready provider (its key refused earlier in the run: refused `KEY_REFUSED`), or a URL the guard refused (refused `GUARD`). Before, keyless Firecrawl and keyed Exa or Firecrawl left these off the receipt. The page and the log lines are unchanged.
