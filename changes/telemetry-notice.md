---
packages: repo
kind: docs
---
AgentRun counts itself anonymously: a random id, version and platform, never prompts, files or keys. Turn it off with `AGENTRUN_TELEMETRY=0` or `DO_NOT_TRACK=1`. Details: [docs/telemetry.md](https://github.com/Parcha-ai/agentrun/blob/main/docs/telemetry.md). The counts have been on since 0.1.0-beta.47 (#3191); the installer's help, the getting-started guide, the README and the setup skill now say so too.
