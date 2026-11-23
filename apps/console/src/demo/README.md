# Demo mode

Settings → Demo turns the console into a tour over sample data. This folder is all of it, and is loaded only once the
switch is on.

- `mode.ts`: the switch, kept in this browser (`localStorage`).
- `tale.ts`: the story. Larkspur, an invented marketplace: nine agents (two of them connected Claude Code and Codex setups), a month of runs, and the runs the tour stops at.
- `script.ts`: turns a run's story (beats: thought, said, called, asked) into timeline rows, a trace and a cost, up to any
  moment, so a run plays live and waits at a question or an approval.
- `world.ts`: the story as the server's reads would say it now: runs, stats, triggers and learning, all counted from the
  same runs, held in the page's memory.
- `backend.ts`: a `fetch` for the console's client that answers `agentrun.v2/0` from the world.
- `dwf/`: the sample workflow graphs (see its README).
- `DemoPage.tsx`: the Settings page with the switch and the tour, and the strip across every page.

## What holds

- Nothing in the demo is real: people, companies, orders and figures are invented, and hosts end in `.example`.
  `backend.test.ts` checks the story for addresses, hosts and anything shaped like a credential, and the build's
  credential gate reads the bundle.
- Nothing a person does in the demo reaches the server. The only requests that do are the session's (`/auth/…`) and two
  reads of the product's own catalogue: `/capabilities` (shown without the server's secrets' names or switches) and
  `/templates` (the bundled ones). `e2e/flows/demo-mode.mjs` holds that in a real browser.
- A write the tour does not make is refused with `demo_mode`, never silently dropped.
- The answers are typed by `src/lib/v2.ts`, so a change to the served contract that the demo's data no longer fits fails
  the typecheck.

## Adding a stop to the tour

Add a run to `heroes()` in `tale.ts` (or an agent to `AGENTS`), then a stop to `TOUR` in `DemoPage.tsx`.
`DemoPage.test.tsx` fails a stop that names a run or an agent the story lacks.
