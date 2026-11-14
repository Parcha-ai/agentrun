# Source provenance

The observer implementation, private state store, origin-bound transport, keyboard picker, telemetry configuration and Python wheel builder originate in AgentRun CLI 0.1.10. That release's public source snapshot is distributed with [Parcha-ai/agentrun cli-v0.1.10](https://github.com/Parcha-ai/agentrun/releases/tag/cli-v0.1.10). Parcha Labs owns this code; it is maintained here under the repository's Apache-2.0 license.

`remote.py` and the OSS native worker bridge extend that CLI for explicit remote execution. They do not change the metadata-only behavior of the existing hosted observer. This tree identifies itself as the unpublished development version 0.1.11.dev0; publishing it requires the repository's reviewed release process.
