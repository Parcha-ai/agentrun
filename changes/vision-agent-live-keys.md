---
packages: repo
kind: fix
---
The vision agent example (`examples/vision-agent`) with a gateway set (`VIDEO_MODEL_BASE_URL`) no longer asks for `TYPESAFE_API_KEY`: Jev goes through the gateway's `/typesafe`, so its key is `TYPESAFE_API_KEY` when given and the gateway's `VIDEO_MODEL_API_KEY` otherwise; without a gateway `TYPESAFE_API_KEY` is still required. A live run now checks every key before it starts anything, naming each one that is missing and what it is for (`--live is missing TYPESAFE_API_KEY (typesafe.ai: ...); OPENAI_API_KEY (the lead openai/gpt-6-luna)`), and stops with a failing code, a message and nothing written: no recording, no run directory and no `cost: unknown` line, where it used to start the recorder first and leave a recording of the refusal behind. `demo.json`, the README and the setup prompt say the same.
