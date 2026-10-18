# Set up the hear-and-find demo for a live run

Paste this into your coding agent. It sets up `npm run demo:hear-and-find -- --live`. A run on fakes (`npm run demo:hear-and-find`) needs only the programs.

You are in a checkout of the agentrun repository. Do these steps in order and stop to ask me at any step that needs a decision or a secret.

1. Run `node --version`. It must be 22.19 or newer. If it is not, tell me and stop.
2. Run `ffmpeg -version` and `ffprobe -version`. If either is missing, tell me how to install it on this system (`brew install ffmpeg`, `sudo apt-get install ffmpeg`, or the system's package) and stop; never install it yourself.
3. Run `npm ci --ignore-scripts && npm run build`, then `npm run demo:hear-and-find` (no key, $0) and check it ends complete.
4. A live run needs three keys. Ask me which I have: a model key (`OPENAI_API_KEY`, `GEMINI_API_KEY` or `ANTHROPIC_API_KEY`, or an OpenAI-compatible gateway's `VIDEO_MODEL_BASE_URL` and `VIDEO_MODEL_API_KEY`); a Jev key, `TYPESAFE_API_KEY` (or `OPENROUTER_API_KEY` when OpenRouter serves jev-1.14.0, which the box needs); and `FAL_KEY` for Scribe v2 (not needed when the gateway passes fal's queue through). Tell me where to create a key if I have none: platform.openai.com, aistudio.google.com, console.anthropic.com, typesafe.ai, openrouter.ai, fal.ai.
5. Export them in my shell for this session only. Never write a key into a file in the repository, a commit or a log, and never print one.
6. Run `npm run demo:hear-and-find -- --live --max-usd 2`. It downloads NASA's film once (120 MB) and checks it; the run costs about $0.40.
7. Nothing here needs sudo or a system change beyond step 2. If a step seems to, stop and ask me; never run one yourself.

When it finishes, show me the rows it printed and the recording directory if I passed `--record`.
