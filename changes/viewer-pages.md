---
packages: repo
kind: feature
---
**`apps/viewer`: the gallery is hosted on GitHub Pages**
- `.github/workflows/pages.yml` builds the viewer and publishes it to https://parcha-ai.github.io/agentrun/ on each
  push to `main` that touches `apps/viewer/`, or by hand. It publishes nothing unless every bundled recording passes
  the recording validator, whose scan refuses credential-shaped values and machine paths, and an empty gallery fails
  too. Its token reads the repository and writes Pages; it names no secret.
- `scripts/recording/validate.mjs` takes several recording directories, reports each, and fails if any has a problem.
- `scripts/pages-workflow.test.mjs` holds the workflow's triggers, permissions and step order, and runs its gate on
  the bundled recordings and on copies it must refuse.
