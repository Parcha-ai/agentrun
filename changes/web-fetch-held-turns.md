---
packages: @parcha/agentrun-web
kind: fix
---
A web_fetch turn that a provider's breaker held now appears on the receipt the same way web_search's does: `{provider, outcome: "held", failure: {class: <limit kind>, code: "HELD", message}, ms: 0}`. Before, keyless Firecrawl and keyed Exa or Firecrawl left it off the receipt, and Parallel recorded it as a failed turn. Other turns that were not asked are unchanged: an unready provider, or a URL the guard refused, is still a failed turn for Parallel and still off the receipt for the others.
