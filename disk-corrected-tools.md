# Durable-disk corrected tools proof

PASS on checkout `d9ff826df3195a2fb94530ad95d39186168341c8`. The unchanged full `@parcha/pi-durable-disk` test suite completed with **988 tests, 980 passed, 0 failed, 8 skipped, 122 suites**, in 30.26 seconds.

The original tools-image run reported the same 988 tests, with 968 passed, 12 failed and 8 skipped. Its failures included direct `spawnSync ps ENOENT` errors and dependent command-recording, zombie-process and watchdog assertions. Adding `procps` to the temporary tools image resolves all twelve failures without changing repository code or tests.

Only the local temporary Dockerfile changed: `procps` was added to its apt package list and a build step verifies `command -v ps && ps --version`. The same local tag `gre4118-check-tools:node22` was rebuilt with an isolated Docker configuration containing empty auths. It now identifies as `sha256:6ad01f2cc3009a227831792982e055053428f739a4c6e9b1ce7ffd337249f4d8`.

The test container independently reported `/usr/bin/ps`, procps-ng **4.0.4**, Node **22.23.2** and npm **11.21.0**. It ran with `--init`, the checkout mounted at its existing absolute path, its Git common directory mounted read-only, and a checked HEAD matching the commit above. The command was the unchanged `npm run test --workspace @parcha/pi-durable-disk`; no build or dependency installation ran against the shared checkout.

The original full-check container was not stopped, restarted or modified. The isolated disk-test container used `--rm`; exact-name readback confirms it is absent. No data volume was created. The corrected local tools image and temporary Dockerfile are retained for subsequent checks. Repository status remained clean, and no host package or production resource changed.

Evidence: [corrected suite log](gre4118-disk-corrected-tools.log), [tools image build log](gre4118-clean-gate-image-procps.log), and [original disk failure excerpt](gre4118-disk-original-failure-excerpt.log).
