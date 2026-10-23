---
packages: repo
kind: fix
---
Use npm 11.21.0 for CI, source and release installs. Install vision CI's native dependencies from Ubuntu's HTTPS archive. Pin the workspace, Docker runtime and packaged-consumer checks to Zod 4.6.6, including transitive copies, and document the application-root override for browser hosts. The reference kill ledger accepts a scan-only result with no browser session while rejecting duplicate creates, unreleased sessions and page operations without a session.
