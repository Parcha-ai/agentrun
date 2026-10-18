# Set up the vision agent for a live run

Paste this into your coding agent. It sets up `npm run demo:vision -- examples/<folder> --live`. A run on fakes (`npm run demo:vision -- examples/document-check`) needs only the programs.

You are in a checkout of the agentrun repository. Do these steps in order and stop to ask me at any step that needs a decision or a secret.

1. Run `node --version`. It must be 22.19 or newer. If it is not, tell me and stop.
2. Run `ffmpeg -version`, `ffprobe -version`, `pdftoppm -v` and `pdftotext -v`. If one is missing, tell me how to install it on this system (`brew install ffmpeg poppler`, `sudo apt-get install ffmpeg poppler-utils`, or the system's packages) and stop; never install it yourself.
3. Run `npm ci --ignore-scripts && npm run build`, then `npm run demo:vision -- examples/document-check` (no key, $0) and check it ends complete.
4. A live run needs a model key and a Jev key. The examples' agent is Google's gemini-3.8-flash, thinking at medium, which needs `GEMINI_API_KEY`. Ask me which I have: a model key (`GEMINI_API_KEY`, or else `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`, which run other models, or an OpenAI-compatible gateway's `VIDEO_MODEL_BASE_URL` and `VIDEO_MODEL_API_KEY`); a Jev key, `TYPESAFE_API_KEY` (not `OPENROUTER_API_KEY`: Jev through OpenRouter takes no images, and every question this agent asks Jev is about an image; not needed when I use a gateway, which passes Jev through itself and whose `VIDEO_MODEL_API_KEY` is then Jev's key unless I set this one), with `TYPESAFE_BASE_URL` only if I reach TypeSafe through a proxy of my own; and, for a question about what a recording says, `FAL_KEY` for Scribe v2 (not needed when the gateway passes fal's queue through). Tell me where to create a key if I have none: aistudio.google.com, platform.openai.com, console.anthropic.com, typesafe.ai, fal.ai.
5. Export them in my shell for this session only. Never write a key into a file in the repository, a commit or a log, and never print one.
6. Ask me which example to run (`examples/video-chapters`, `examples/hear-and-find` or `examples/document-check`), then run `npm run demo:vision -- examples/<folder> --live --max-usd 5`. It downloads the example's files once and checks each by size and SHA-256 before the agent reads it.
7. The agent runs shell commands with my user's rights. If this checkout is not in a container or a VM, tell me so before step 6 and wait for my go.
8. Nothing here needs sudo or a system change beyond step 2. If a step seems to, stop and ask me; never run one yourself.

When it finishes, show me the answer it printed, the report under the run's `work/report/`, and the recording directory if I passed `--record`.
