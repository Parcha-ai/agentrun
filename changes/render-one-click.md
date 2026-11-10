---
packages: @parcha/agentrun-serve
kind: fix
---
A Render deploy now points its owner to the token first: the console's setup page leads with pasting `AGENTRUN_TOKEN` from the service's Environment tab, the printed setup line ends with "(or paste AGENTRUN_TOKEN)", and `render.yaml` asks for `OPENROUTER_API_KEY` first. The README puts the Render button first under "Run it on a server", with what it costs and the two things to paste.
