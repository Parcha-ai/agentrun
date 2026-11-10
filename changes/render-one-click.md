---
packages: @parcha/agentrun-serve
kind: fix
---
A Render deploy now points its owner to the token first: the console's setup page leads with pasting `AGENTRUN_TOKEN` from the service's Environment tab, the printed setup line ends with "(or paste AGENTRUN_TOKEN)", and `render.yaml` asks for `OPENROUTER_API_KEY` first. The README puts the Render button first under "Start it", before `npx`, with what it costs and the two things to paste. The console's model keys (Settings → Keys, and the first screen's card when no key is set) recommend an OpenRouter key with a dollar cap and an expiration date.
