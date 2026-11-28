---
packages: @parcha/agentrun-web
kind: fix
---
While a search provider is held to a reset it named (a keyless daily allowance spent, a 429 naming hours to wait), web_search tells the model which provider is held and until when, for example `search is unavailable: firecrawl-keyless is out of quota until 2026-11-29T00:00:00Z; exa-keyless is rate-limited until 2026-11-29T00:00:00Z; answer from what you have`. Before, it answered `search is unavailable for the rest of this run`, which named no provider and no reset and stopped being true at the reset. A search whose next provider found nothing while another was held now answers an error saying both, instead of an empty result list that read as "nothing exists"; its receipt still names the provider that was asked, and its fee and search count are unchanged. A quota that names no reset still answers `search is unavailable for the rest of this run`.
