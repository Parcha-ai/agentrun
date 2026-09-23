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
