---
packages: @parcha/agentrun-serve
kind: docs
---
The tool gate's `Executor` contract says who bounds an approved call: the executor does. The gate puts no wall-clock bound on it (only a stop or a cancel cuts it, through its `signal`), so an executor bounds its own work and answers a timeout as an error result.
