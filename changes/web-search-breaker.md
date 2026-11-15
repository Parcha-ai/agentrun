---
packages: @parcha/agentrun-serve
kind: fix
---
web_search stops asking a provider that has said no for the rest of the run. Once a run's search provider answers that the run is rate-limited or out of quota, every later web_search call in that run answers "search is unavailable for the rest of this run; answer from what you have" and the provider isn't called again. That covers keyless Exa's free limit, Parallel's 429 or 402, and the model provider's own hosted search: a 429, Anthropic's rate_limit_error or billing_error, OpenAI's rate_limit_exceeded or insufficient_quota. The timeline shows each of those calls as a failed search in those words. One run had kept searching 520 times against Exa's limit. The breaker belongs to the run, so another run on the same server searches as before. Other failures leave it closed: a 5xx, a timeout, or Exa refusing the connection.
