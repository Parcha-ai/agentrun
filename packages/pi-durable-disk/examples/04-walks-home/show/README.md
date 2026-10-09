# show: the stage for "It Walks Home"

One page: the tab app (D3) on the left in a same-origin iframe, the multiverse panel, cost meter and machine timeline
on the right, the environment switcher across the top. It reads a `ShowState` and never talks to a cloud.

## The feed contract (D1 implements, this package consumes)

Types are in `types.ts`; the fold is `reduce.ts`. The server exposes:

| Route | Meaning |
| --- | --- |
| `GET /api/state` | the fold of every event so far: `ShowState` |
| `GET /api/events` | SSE; each `data:` is one `ShowEvent`, sent after the state the page just fetched (`Last-Event-ID` resumes) |
| `POST /api/command` | body `ShowCommand`: `kill` a universe, `switch` the run, `reset` the fake feed |

Rules a producer must keep:

- Times are ms since the run's origin (`run.origin` is the wall-clock ms of 0).
- `universe.host` is the driver's own machine label, the same string the agent's env.switch notice uses.
- Statuses: `spare starting training killed takeover winner sealed`. A killed universe keeps its `slot` until a spare
  takes it: send `{universe spare1 slot:3 status:takeover replaces:u3}` and `{universe u3 slot:null replacedBy:spare1}`.
- One `sample` per checkpoint with a strictly increasing `at`; `cost` on a sample is the universe's spend to date.
- A `stay` is a stretch on one machine. `lane` is `run` for the main line or `u:<id>` for a universe.

Pointing the stage at a live feed: `SHOW_API=http://host:port node serve.ts` proxies `/api/*` to it.

## Run it

    npm ci && npm run build && node serve.ts          # fake feed, http://127.0.0.1:8750/
    npm test && npm run typecheck
