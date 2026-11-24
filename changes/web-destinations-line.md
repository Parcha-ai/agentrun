---
packages: @parcha/agentrun-web, @parcha/agentrun-serve
kind: feat
---
Each run writes one start line naming where its web tools go: `event=web_destinations search="exa (keyed) > firecrawl-keyless (keyless) > exa-keyless (keyless)" fetch="parallel (keyed, no key) > firecrawl-keyless (keyless, rate-limited until 12:01 UTC) > direct"`. It gives each tool's order, whether each provider is keyed (and whether the run holds its key) or keyless, and any hold known when the run's Web is made. It never includes a key. The line comes from `Web.destinations()` (new), `destinationsWords` and `destinationsLine`. serve writes it once per run's Web, which is now made as web_fetch is bound for every run, not only one whose web_fetch asks a keyed provider.
