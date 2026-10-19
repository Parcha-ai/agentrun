---
packages: @parcha/agentrun-dsl
kind: feature
---
`WorkflowDeps["runJudge"]`'s parameters declare two optional fields the judge seam already carried at runtime: `assets` (a reference written in the state or a question, to `{ bytes: Uint8Array, mime: "image/png" | "image/jpeg" }`, the new exported type `JudgeImage`) and `model` (the model this call asks). The interpreter never sets either, so its calls are unchanged; a host judge that is asked about images (the runner `createJevRunner` returns, a package such as pi-vision's `vision.judge`) can now type the image bytes it reads without a cast.
