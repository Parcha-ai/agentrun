# Working on AgentRun Server's page

The page at `/` is the UI people use to make agents, change them and watch their runs. This folder is the kit for
working on it: sample data, a dev loop, and a storyboard of every screen and the states each must handle. Nothing here
ships: the package's `files` leave `dev/` out, and so does the image's `.dockerignore`.

## Run it

Node 22.19 or later, from the repository's root:

```sh
npm ci --ignore-scripts && npm run build
npm run dev -w @parcha/agentrun-serve
```

The first start seeds `packages/serve/dev/.data` (about 20 seconds), then prints:

```
agentrun-serve on http://127.0.0.1:7342/v2 over .../packages/serve/dev/.data (sample model: dev/faux.mjs)
The page, with its files read from src on every request: http://127.0.0.1:7341/
Open http://127.0.0.1:7341/?token=...
```

Open the last link once. Then edit `packages/pi-durable-agent/src/serve/page.{js,css}`, `graph.js` or
`packages/serve/src/page/{serve.js,serve.css,index.html}` and reload: the dev loop reads those files from the source on
every request, with the same security headers the server sends. A change to the server's TypeScript needs
`npm run build -w @parcha/agentrun-serve` and a restart.

- `--port N` (default 7341) is the page's port, `--api-port N` (default 7342) the server's, and `--data DIR` another
  data directory. Everything listens on 127.0.0.1 only.
- `npm run dev:seed -w @parcha/agentrun-serve` throws the sample data away and seeds it again. It removes only a
  directory the seed made (it leaves a `.dev-seed` file there) and refuses any other.
- The storyboard is at `/storyboard.html` on the dev loop's port: every screen live, at desktop and phone width.

## The sample data

`dev/seed.mjs` makes everything through `/v2` on `dev/faux.mjs`, a scripted model: no key, no network, synthetic
content only. Six agents, both kinds, 11 revisions with notes, 35 runs:

| Agent | Kind | What its runs show |
| --- | --- | --- |
| Invoice checker | agentic, 3 revisions | tool calls (`write`), thinking, Markdown tables, a skill added, `ask_person` waiting and answered, a run the spend cap stopped, an archived run |
| Release notes writer | agentic, 2 revisions | `write` then `edit`, a long Markdown answer, a model failure |
| Meeting notes | agentic, 2 revisions | a run still working, a cancelled run, a stopped run, a stopped run followed up, a failure |
| Support triage | workflow, 2 revisions | two model nodes and an escalation gate: completed, escalated, still working, cancelled |
| Lead scorer | workflow | `extract` and `decide` nodes on two tiers |
| Recipe scaler | agentic, archived | an archived agent and its runs |

The runs still working stay working across restarts (the faux model waits six hours), so the live views always have
something to follow. Costs use sample prices (`cost` in `faux.mjs`). To add a state, add a run to `AGENTS` in
`seed.mjs`, and a reply to `faux.mjs` keyed on its input.

## Test

```sh
npm test -w @parcha/agentrun-serve                      # every serve test, the page's included
node --test packages/serve/test/dev-kit.test.mjs        # the seed and the dev loop alone
node --test packages/pi-durable-agent/test/serve-*.test.mjs
```

`test/page.test.mjs` and `test/page-views.test.mjs` hold the page to its contract: the cookie, the CSP, the routes it
calls. A new view gets a test there that reads what it calls through `/v2`, on the faux model. Look at the page in a
browser too, at 1440 and 390 pixels wide, light and dark, on the sample data, before you ask for a review.

## House style

- **Square corners.** No `border-radius` anywhere, on any element. Circles only in illustrations.
- **Mono for labels, data and controls;** a plain sans for prose people read (answers, descriptions).
- **Colors come from the tokens** in `page.css` (`--bg`, `--panel`, `--ink`, `--muted`, `--line`, `--accent`, `--green`, `--red`, and the rest), in light
  and dark. No color literal in a view.
- **Plain words.** Say what happened and what to do next. No HTTP codes, internal names or ids in the first line of a
  message; put the id in a small detail.
- **Every view handles** empty, loading, error, long text (no horizontal page scroll; tables scroll in their own box)
  and phone width (390 pixels).
- **No data in the page's files.** Everything the page shows comes through `/v2` or the server's own routes, with the
  page's cookie. Values reach the DOM as text nodes and input values, never as markup.
- **Nothing from the network.** The CSP allows this origin only: no CDN, no web font, no analytics.
