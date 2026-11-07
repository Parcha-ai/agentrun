---
packages: repo
kind: breaking
---
`@parcha/pi-vision` is gone from this repository, with the reference host it served. No package of the open platform imported it. It gets no new release, and its versions on npm are deprecated. The same change removes:
- `@parcha/agentrun-harness`, the reference host for the demos. It was held and never published.
- `apps/viewer`, the recording player, and the GitHub Pages gallery that published it.
- the examples that ran on the reference host or on pi-vision: `examples/reference`, `hero`, `issue-triage`, `vision-agent`, `web` and the vision question folders.
- the `demo:reference`, `demo:kill`, `demo:hero`, `demo:issue-triage`, `demo:vision` and `test:viewer` scripts.

A program that imports `@parcha/pi-vision` can keep the last published version, which stays installable.
