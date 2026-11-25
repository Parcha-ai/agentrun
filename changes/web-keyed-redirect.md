---
packages: @parcha/agentrun-web, @parcha/agentrun-decisions
kind: fix
---
Requests that carry a provider's key never follow a redirect. That covers Exa, Firecrawl, Parallel's search and extract, and the Anthropic, Parallel and OpenRouter deciders: a redirect fails the request, so the key never reaches another address.
