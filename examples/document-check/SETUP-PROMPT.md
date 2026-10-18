# Set up the document check demo for a live run

Paste this into your coding agent. It sets up `npm run demo:document-check -- --live`. A run on fakes (`npm run demo:document-check`) needs only the programs.

You are in a checkout of the agentrun repository. Do these steps in order and stop to ask me at any step that needs a decision or a secret.

1. Run `node --version`. It must be 22.19 or newer. If it is not, tell me and stop.
2. Run `pdftoppm -v`, `ffmpeg -version` and `ffprobe -version`. If any is missing, tell me how to install it on this system (`brew install poppler ffmpeg`, `sudo apt-get install poppler-utils ffmpeg`, or the system's packages) and stop; never install it yourself.
3. Run `npm ci --ignore-scripts && npm run build`, then `npm run demo:document-check` (no key, $0) and check it ends complete with 6 of 6 marks there.
4. A live run needs a Jev key: `TYPESAFE_API_KEY` (console.typesafe.ai), or `OPENROUTER_API_KEY` for Jev through OpenRouter (openrouter.ai/keys). Ask me which I have.
5. It also needs one key for the lead model. Ask me which I have: `OPENAI_API_KEY` (OpenAI), `ANTHROPIC_API_KEY` (Anthropic), `GEMINI_API_KEY` (Google), or an OpenAI-compatible gateway (`DEMO_MODEL_BASE_URL` and `DEMO_MODEL_API_KEY`, both). Tell me where to create a key if I have none: platform.openai.com, console.anthropic.com, aistudio.google.com.
6. Export them in my shell for this session only. Never write a key into a file in the repository, a commit or a log, and never print it.
7. Run `npm run demo:document-check -- --live --max-usd 0.10` (a few cents), then `npm run demo:document-check -- --live --input test-copy --max-usd 0.10`, the copy with the marks removed.
8. Nothing here needs sudo or a system change beyond step 2. If a step seems to, stop and ask me; never run one yourself.

When it finishes, show me the marks each run printed, and the recording directory if I passed `--record`.
