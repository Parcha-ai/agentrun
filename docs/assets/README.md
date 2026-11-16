# README workflow illustration

`support-workflow.gif` is a silent, 12-second before/after illustration, 960 × 520 at 15 fps. `support-workflow.svg` is its static workflow alternative. It illustrates the control flow in `examples/support-answer.mjs`; it is not a recording of a model run or a cost benchmark.

The editable composition lives in `readme-animation/index.html`. It uses a paused, seekable GSAP timeline: an agent loop, a left-to-right wipe, then two traversals of the existing-answer path. The investigation path is shown as an optional, bounded branch.

To check and regenerate from the repository root (requires Chromium and FFmpeg supported by HyperFrames):

```sh
npx hyperframes@0.8.46 check docs/assets/readme-animation
npx hyperframes@0.8.46 render docs/assets/readme-animation --format gif --fps 15 --output docs/assets/support-workflow.gif
```

HyperFrames is only an asset-authoring tool; it is not a runtime dependency of AgentRun. The composition loads GSAP 3.14.2 from its pinned CDN URL during rendering. Its wipe uses the same clipped-layer pattern as HyperFrames' `before-after-wipe` component.

The original diagram and composition are covered by the repository's Apache-2.0 license. JetBrains Mono is redistributed under the SIL Open Font License; see `readme-animation/assets/FONT-LICENSE.txt`. The static SVG uses the viewer's monospace font.

## README screenshots and wordmark

`readme/` holds the images the root README shows. The console screenshots are the console itself, rendered in its
Storybook on the recorded fixtures in `apps/console/src/fixtures` (synthetic agents and companies, no live model run),
captured at 2x and framed on the console's background:

- `learning.png`: an agent's Learning tab on the `learning.*` fixtures. Its "since it learned" numbers are the fixtures'
  recorded values, not a benchmark.
- `workflow-run.png`: the `Workflow / Batch mid flight` story.
- `input-required.png`: the `Run detail / Input required` story.
- `mission-control.png`: the `Mission Control / With analytics` story.
- `workflow-decision.png`: the `Workflow / Kyb route` story.
- `api.png`: the `Start a run / Playground agentic` story.

`wordmark.png` sets `agent.run()` in JetBrains Mono 400, light on its own dark tile so it reads on GitHub's light and dark themes (SIL Open Font License; see
`readme-animation/assets/FONT-LICENSE.txt`), with `.run()` in #ff8700. The screenshots and wordmark are covered by the
repository's Apache-2.0 license.

`pill-render.png` and `pill-local.png` are the README's two buttons, set in Inter 600 and JetBrains Mono 500 (both SIL Open
Font License) on the same palette.

## Tutorial screenshots

`tutorials/cost-per-run.png` is the console's Cost per run chart on its invented sample
(`apps/console/src/components/CostPerRun.sample.json`: an invoice-sorter agent's 80 runs, no live model run), captured
by the `cost-per-run` real-browser flow at 1440 px in the light theme (`E2E_SHOTS=<dir> npm run test:e2e -- --only
cost-per-run` from the repository's root).

Both carry an "Example data" badge on the picture itself, drawn by the flow's shooting step (`markExample` in `apps/console/e2e/harness.mjs`), never by the product.

`tutorials/held-out-test.png` is the Learning tab's Held-out test card for the same invented agent, from a record the
`cost-per-run` flow posts through the API (200 jobs, 188 right), captured by that flow at 1440 px in the light theme.

`tutorials/composio-*.png` are the console on a local server for
[Connect Composio tools and triggers](../tutorials/composio.md), captured with headless Chrome at 1280 px in the light
theme and cropped to the panel. The toolkits' action lists and the saved servers are Composio's real answers for
`hackernews` and `github`; the API key field holds a stand-in, never a key, and the connect link behind "Connect your
github account" is not the real one. The trigger and run shots are from an event signed locally the way Composio signs
one, with a made-up issue.

## Case study cards and charts

`case-studies/` holds the cards the README's Case studies section shows and the charts on the pages under
`docs/case-studies/`. Each is an SVG set in Inter (SIL Open Font License), rendered at 2x. The
numbers are the ones each case study's page states and explains. They are covered by the repository's Apache-2.0
license.
