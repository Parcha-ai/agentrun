# Set up the video chapters demo for a live run

Paste this into your coding agent. It sets up `npm run demo:video-chapters -- --live`. A run on fakes (`npm run demo:video-chapters`) needs only the programs.

You are in a checkout of the agentrun repository. Do these steps in order and stop to ask me at any step that needs a decision or a secret.

1. Run `node --version`. It must be 22.19 or newer. If it is not, tell me and stop.
2. Run `ffmpeg -version` and `ffprobe -version`. If either is missing, tell me how to install it on this system (`brew install ffmpeg`, `sudo apt-get install ffmpeg`, or the system's package) and stop; never install it yourself.
3. Run `npm ci --ignore-scripts && npm run build`, then `npm run demo:video-chapters` (no key, $0) and check it ends complete.
4. A live run needs one model key. Ask me which I have: `OPENAI_API_KEY` (OpenAI), `GEMINI_API_KEY` (Google; its eyes take each window as video with its sound), `ANTHROPIC_API_KEY` (Anthropic), or an OpenAI-compatible gateway (`VIDEO_MODEL_BASE_URL` and `VIDEO_MODEL_API_KEY`, both). Tell me where to create a key if I have none: platform.openai.com, aistudio.google.com, console.anthropic.com.
5. Export it in my shell for this session only. Never write it into a file in the repository, a commit or a log, and never print it.
6. Run `npm run demo:video-chapters -- --live --input examples/video-chapters/inputs/short.json --max-usd 0.20` first: three minutes of the film, a few cents. It downloads NASA's film once (120 MB) and checks it.
7. Then, if I want the whole film: `npm run demo:video-chapters -- --live --max-usd 1` (about $0.40). Or `npm run demo:video-chapters -- --serve --live` and open the address it prints, to drop a film of my own.
8. Nothing here needs sudo or a system change beyond step 2. If a step seems to, stop and ask me; never run one yourself.

When it finishes, show me the chapters it printed and the recording directory if I passed `--record`.
