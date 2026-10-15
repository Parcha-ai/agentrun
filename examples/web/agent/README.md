# The web example's agent

An agent that signs in to a website through a person, then reads the pages behind the sign-in and writes what it found
to files. A person asks it in a chat. It opens a real browser on Browserbase, asks the person to sign in in the browser's
live view, and waits. The person signs in there (the model never sees the password) and replies "done". The agent goes
on, writes `report.md` and `pages.csv` in its workspace, and releases the browser. The next run of the same agent starts
signed in, because both runs use the agent's Browserbase context.

| File | What |
| --- | --- |
| `agent.json` | The agent definition: `id`, `version`, `name`, `description`, `instructions`, `skills`, `tools`, `input_schema`, `output_schema`, `workflow`, `max_cost_usd`. It names no model: the host picks it. |
| `skills/*.md` | The skills `agent.json` names, added to the prompt in that order. |
| `app.ts` | The app `pi-durable-disk run --app` loads: the definition to Harness options, the model from the environment, the file tools and the browser. |
| `start-run.mjs` | Starts one run on a local directory, with its door on loopback. |
| `agent.test.mjs` | Offline tests: no network, no key, no model call. |

## Run one

Build the two packages the app uses, then start a run on a directory of its own:

```sh
npm ci --ignore-scripts
npm run build -w @parcha/pi-durable-disk -w @parcha/pi-browser
export BROWSERBASE_API_KEY=...                       # your Browserbase key
export AGENT_MODEL_BASE_URL=https://api.openai.com/v1 AGENT_MODEL=<model id> AGENT_MODEL_API_KEY=...
node examples/web/agent/start-run.mjs examples/web/.data/runs/run-1
```

The run is `pi-durable-disk run --dir <runs>/<id> --app examples/web/agent/app.ts --serve 0`. Its directory holds
`run.json`, `store/run.sqlite` and `work/`, the workspace and the only place the model's file tools reach. While
`run.json` says `running`, its `holder.serve` is the run's door on loopback:

```sh
door=$(node -p "require('./examples/web/.data/runs/run-1/run.json').holder.serve")
curl -s "$door/submit" -H 'content-type: application/json' \
  -d '{"requestId":"ask-1","content":"Log in to https://the-internet.herokuapp.com/login and read the secure area page. Write report.md and pages.csv.","wait":true}'
curl -sN "$door/events"
```

A submit without `conversationId` goes to the run's root conversation. The door creates it on the first request, with
the definition's prompt and tools and the browser's configuration in the commit that creates it. `GET /status` and
`POST /abort` are the door's too.

| Variable | Needed | What |
| --- | --- | --- |
| `BROWSERBASE_API_KEY` | yes | Browserbase key. `BROWSERBASE_PROJECT_ID` is optional; Browserbase infers the project from the key. |
| `AGENT_MODEL_BASE_URL` | yes | An OpenAI Responses endpoint. |
| `AGENT_MODEL` | yes | The model id at that endpoint. |
| `AGENT_MODEL_API_KEY` | no | Its key, when it needs one. |
| `AGENT_MODEL_PRICE` | no | `input,output,cacheRead[,cacheWrite]` in USD per million tokens, so the run's usage has a price. Unset, it is $0. |
| `AGENT_THINKING` | no | `minimal`, `low`, `medium` (default), `high` or `xhigh`. Thinking is never off. |
| `AGENT_HOME` | no | Where the agent keeps what outlives a run. Default: `agent-home` beside the runs directory. |

SIGTERM stops a run. It releases its Browserbase session first, so the sign-in is saved and nothing paid stays open, then
lets go of the run (`run.json` says `sleeping`) and exits 0. Starting the same directory again resumes it.

## Sign-in

- The first run creates a Browserbase context and saves its id in `<agent home>/browser.json` (mode 0600). Every run of
  the agent opens its browser on that context, and Browserbase saves the context when the session ends.
- When a session opens, and each time its page changes, the app writes `<run>/live.json` (mode 0600):
  `{ liveViewUrl, sessionId, change, updatedAt }`. `liveViewUrl` is Browserbase's interactive live view and carries a
  token, so it goes only to the person's page: never to the model, a log or a transcript. It is null once the session is
  released.
- The context id never reaches the model: the browser's redactor scrubs it from every tool result. It is in the run's
  store, in the browser's configuration document, which the model does not read.
- `loadSignIn` and `saveSignIn` in `app.ts` are the one place sign-ins are kept. A sign-in store shared by every host
  replaces them later.

## Limits

- `max_cost_usd` is in the definition for the host to enforce; this example does not stop a run at it yet.
- Two runs of one agent at the same time share one context, and the session that ends last is what Browserbase keeps.
  Run them one after the other.
- A sign-in lasts as long as the site keeps it. When a site has ended it by the next run, the agent finds the sign-in
  page and asks the person again.
