# A Browser Agent

One agent, a task in a browser in one line of plain words. It reads each page before it acts and again after, hands the browser to the person for a step that is theirs (a choice, a sign-in, a CAPTCHA) with `browser_request_handoff` when the host can reach a person, and answers from what the pages showed. The examples beside this folder are a task and a README, nothing more:

```sh
npm ci --ignore-scripts && npm run build
npm run demo:browser -- examples/dropdown-handoff                          # on fakes, $0, no key, no network
npm run demo:browser -- examples/dropdown-handoff --live                   # real model, Browserbase
npm run demo:browser -- examples/dropdown-handoff --live --local-chrome    # real model, a Chrome on this machine
```

The agent is Google's **gemini-3.8-flash, thinking at medium**: one value in `demo.json` (`models.lead.default`) and the node's `thinking` in `agent.ts`. Thinking is shown when the model returns it. Besides the browser's tools the agent has `read`, `write`, `edit` and `bash` in its workspace, with your user's rights: run it in a container or a VM.

A local Chrome on real pages shows your machine's address to every site it opens. In a container with no capabilities Chrome cannot start its own sandbox: `PI_BROWSER_NO_SANDBOX=1` starts it without one, and the container is the boundary.

An example folder holds `question.md` (the task, one line) and a README. To ask something else, write another folder, or give `--input '{"question": "..."}'`.

| Flag | What it does |
|---|---|
| `--live` | the real model and a real browser (below) |
| `--local-chrome` | with `--live` and no Browserbase key: a Chrome on this machine (`CHROME_PATH`) |
| `--record <dir>` | keep the run as an `agentrun.recording/1` directory, with what the browser showed (`frame` lines and a `frame.track` video per session) |
| `--max-usd <n>` | stop a run past n dollars |

On fakes a scripted lead reads the page the fake browser opens on and submits what it read, whatever is asked; every answer says it is scripted.

## Keys and programs

| Name | For |
|---|---|
| `GEMINI_API_KEY` (or `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or a gateway's `MODEL_BASE_URL` and `MODEL_API_KEY`) | the lead; the default is one value in `demo.json` |
| `BROWSERBASE_API_KEY` and `BROWSERBASE_PROJECT_ID` | the browser of a live run, unless `--local-chrome` |
| `CHROME_PATH` | with `--local-chrome`: the Chrome to start |
| `PI_BROWSER_NO_SANDBOX` | `1` where Chrome cannot start its own sandbox |
| `LIVE_VIEW_DIR` | where the run's live view leaves the person's hand-off requests |
| `ffmpeg` | a recorded run's `frame.track` videos |

## Runtime dependencies

`@parcha/agentrun-reference` (the host: `demo()`, the recorder), `@parcha/pi-browser` (the browser's tools, its providers and the Stagehand driver), `@earendil-works/pi-ai` (the live model and the scripted lead's messages) and `@parcha/agentrun-dsl` (the workflow's types).
