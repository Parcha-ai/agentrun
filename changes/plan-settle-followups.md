---
packages: @parcha/agentrun-serve
kind: fix
---
A server's start lists the ChatGPT plan's models only with an access token OpenAI takes. The start never renews the token itself, so a stop right after it can't spend the refresh token and lose the sign-in. Until a run renews the token, the fallback list stays. Once one has, the server's next read of the sign-in (`GET /capabilities`, which the console reads, or the ChatGPT sign-in page) lists the models while that token is fresh, with no restart. A server's stop now also waits, within its 2 s, for the change its start's model list tells it. A renewal that loses its write-back to a new sign-in, and whose new pair OpenAI doesn't confirm revoked, now carries that pair in the saved row. If another process is renewing that row, it waits for that renewal first. The server's next start revokes the pair.
