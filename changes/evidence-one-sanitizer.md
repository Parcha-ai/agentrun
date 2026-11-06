---
packages: @parcha/agentrun-dsl, @parcha/agentrun-decisions
kind: fix
---
Every decision provider's evidence, a third party's included, goes through one sanitizer at the provider seam: `evidenceOf` in `@parcha/agentrun-dsl` (with its `EVIDENCE_*` caps), which the Parallel and OpenRouter providers call too. A kept URL is the parser's `.href` (an interior newline, a control or direction character in the path comes out normalized), and every cap and the shared budget count code points, so non-BMP text counts once and the total never passes `EVIDENCE_TEXT_MAX`. When a later step's prompt reads the workflow state whole, evidence is wrapped as data wherever the engine wrote it: any `<as>$answers` sidecar at any depth (inside a map's item states or a child workflow's output too) and a sift's item sidecars (`<as>.answers[i].evidence`).
