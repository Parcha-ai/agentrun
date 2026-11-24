---
packages: @parcha/agentrun-serve
kind: fix
---
A server's start lists the ChatGPT plan's models only with an access token OpenAI takes: one that has ended is renewed first. While another process is renewing the sign-in, the start leaves the list for its next start. Before, it sent the ended token and kept the fallback list. A server's stop now waits for the change its start's model list tells it, as it waits for the list. A renewal that loses its write-back to a new sign-in and whose new pair OpenAI doesn't confirm revoked now carries that pair in the saved row, so the server's next start revokes it. Before, the pair stayed live at OpenAI and was saved nowhere.
