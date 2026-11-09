---
packages: repo
kind: ci
---
`actions/setup-go` is pinned by commit (v5) in the release's publish job, which holds the npm OIDC token, and in CI's build and computer-docker jobs. The `@parcha/agentrun-computer` README states what every install carries (both daemons and the conformance code) and the archive's size.
