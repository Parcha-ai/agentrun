---
packages: @parcha/agentrun-computer
kind: fix
---
`DockerProvider` takes two options for tests, `settleMs` and `settleQuietMs`. `settleMs` is the bound on the clean-up after a create that failed or was cut off, and on waiting for a removal Docker says is already under way. `settleQuietMs` is how long the looks after a cut-off `docker run` must find nothing in a row. Each is a whole number of milliseconds above 0; the defaults (10 s and 3 s) are unchanged, and nothing else should set them. A removal still there when the bound runs out fails in words naming the bound actually used ("still there when the 0.3 s bound ran out"), not the default. The package's own tests of a removal that never ends now set a bound of their own instead of waiting out 10 s each. `@parcha/agentrun-computer/docker` also exports `SETTLE_MS`, `SETTLE_QUIET_MS` and `settleBoundsOf`, the defaults and the check the provider applies to these two options.
