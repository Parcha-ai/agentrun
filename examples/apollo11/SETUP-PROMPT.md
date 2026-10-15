# Set up and run "Apollo 11, read whole" (paste this into a coding agent)

You are setting up an example on this machine and running it. Do each step, check its result, and stop to ask me when a step
needs something only I can give (a key). Never print a key, never write one into a file in the repository, and never commit
anything.

## What it is

An agent that is never shown an image reads NASA's Apollo 11 archive through `@parcha/pi-vision`'s eyes (the mission's film,
the scanned 1969 air-to-ground transcript, sixty Hasselblad photographs) and writes the landing minute by minute, every sentence
citing what was read. It can be killed inside the evidence sink and resumes without paying for a look twice. Its data set is
NASA's own files, downloaded once and checked by SHA-256.

## What the machine needs

- Node.js 22.19 or newer, npm, and git. Check with `node --version`.
- `ffmpeg` and `ffprobe` on `PATH`, for the film's frames (`brew install ffmpeg`, `sudo apt-get install ffmpeg`, or your
  system's package).
- `pdftoppm` (poppler) is optional: without it the scanned pages are rendered by PDFium, which installs with the repository.
- About 400 MB of free disk for NASA's files, and network access to `www.nasa.gov` and `images-assets.nasa.gov`.

## Keys (only for a live run; the first run needs none)

For now a live run uses your own model provider key. The run names every model by its provider and public model id. By default
it uses the models the published replay was recorded with: the lead `openai/gpt-6-luna` and the eyes `google/gemini-3.7-flash`.
Set one of these, as environment variables in the shell that runs the example:

| Variable | Provider | Where to get it |
| --- | --- | --- |
| `OPENAI_API_KEY` | OpenAI (the default lead) | https://platform.openai.com/api-keys |
| `GEMINI_API_KEY` | Google (the default eyes) | https://aistudio.google.com/apikey |
| `ANTHROPIC_API_KEY` | Anthropic | https://console.anthropic.com/settings/keys |

With only one provider's key, the run uses that provider's own models: OpenAI `gpt-6-luna` and `gpt-6-sol` as the eyes, Google
`gemini-3.7-flash` for both, Anthropic `claude-haiku-5-5` for both. Name others with `--lead provider/id` and
`--eyes provider/id` (the eyes must take images). Only the default pair and `openai/gpt-6-luna` as the eyes were tested end to
end; the other defaults are image-taking models from pi-ai's catalog, not yet run here.

Instead of provider keys, an OpenAI-compatible gateway that serves the models under their public ids works too: set both
`APOLLO_MODEL_BASE_URL` (its base URL, ending in `/v1`) and `APOLLO_MODEL_API_KEY` (its credential).

## Steps

1. Get the code and build it:

   ```sh
   git clone https://github.com/Parcha-ai/agentrun.git && cd agentrun
   npm ci --ignore-scripts && npm run build
   ```

2. First run, no key, $0: a scripted lead and scripted eyes over the real files. It downloads and checks NASA's files the first
   time (a few minutes), then runs for a few minutes.

   ```sh
   npm run demo:apollo11
   ```

   It ends with the landing's entries and cites resolved, the photo sort against NASA's captions, and a `looks:` line with
   `repeated 0`. Its answers are scripted; nothing a model said.

3. The live run, with a key above, about $0.55 and five minutes; it stops for good if it passes $1.10 (`--max-usd` changes that):

   ```sh
   npm run demo:apollo11 -- --live
   ```

   Report back: the number of entries and cites resolved, the photo sort's score, how many times read off the scans are in NASA's
   typed transcript, and the looks line. The result is `result.json` in the run directory the first line names.

4. Optional: the same run killed inside the evidence sink at its 40th filing; it resumes, and the looks held there come back
   kept, not paid again (about $0.55):

   ```sh
   npm run demo:apollo11 -- --live --kill
   ```

5. Optional: the whole archive, every one of the transcript's 626 pages (about $3.50 and 40 minutes):

   ```sh
   npm run demo:apollo11 -- --live --input examples/apollo11/inputs/full.json --max-usd 5
   ```

If a step fails, show me its last lines and the command, and do not retry a live run more than once without asking.
