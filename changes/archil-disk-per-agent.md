---
packages: @parcha/agentrun-serve
kind: breaking
---
`PUT /v2/workspace/archil` no longer accepts `diskId`; sending it is a 422. Drop `diskId` and send `{ region, s3Url, image?, keys? }`. In Archil mode there is no server-wide disk anymore: each agent gets its own (#2261). Before you upgrade: in Archil mode, an agent's files from before this release stay on the old server disk at Archil; the agent starts on a new disk of its own.
- **One disk per agent.** The disk is made on the agent's first run that uses it, in the account key's region, named `agentrun-<server id>-<agent id>`. Existing agents get theirs the same way. A run's mount credential is minted on its run's disk, so Archil refuses the token on any other agent's disk. `GET /v2/agents/{agent_id}/archil` shows the agent's disk.
- **Disk named at launch.** A run's start can name another disk: `"archil_disk": {"disk_id": "dsk-…"}` on `POST /v2/agents/{agent_id}/runs` and on the inline `POST /v2/runs`, for example one disk per customer. The id is the one Archil returned when the disk was made. agentrun never makes, renames or removes that disk. The server reads it at Archil before the run is made: a disk in another region, or one that doesn't exist, is a 422 that names the region, and no run is made.
- **Disk survives a restart.** The run's launch record keeps the disk it used, so every claim, revoke and reclaim acts on that disk after a restart.
- **Plan limit.** When Archil's plan disk limit refuses a new disk, the run fails with "your Archil plan allows N disks; upgrade or delete an agent". There is no shared-disk fallback.
- **Removing a disk.** `DELETE /v2/agents/{agent_id}/archil` deletes an archived agent's disk at Archil.
- **API-only mode.** An API-only server (`AGENTRUN_API_ONLY=1`) serves both agent disk routes.
