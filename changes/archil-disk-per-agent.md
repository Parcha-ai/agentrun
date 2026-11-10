---
packages: @parcha/agentrun-serve
kind: feature
---
In Archil mode, every agent gets its own disk (#2261):
- **One disk per agent.** The disk is made on the agent's first run that uses it, in the account key's region, named `agentrun-<server id>-<agent id>`. A run's mount credential is minted on its run's disk, so Archil refuses the token on any other agent's disk. `GET /v2/agents/{agent_id}/archil` shows the agent's disk.
- **Disk named at launch.** A run's start can name another disk: `"archil_disk": {"disk_id": "dsk-…"}` on `POST /v2/agents/{agent_id}/runs` and on the inline `POST /v2/runs`, for example one disk per customer. agentrun never makes, renames or removes that disk. A disk in another region, or one that doesn't exist, fails the run in words that name the region.
- **Disk survives a restart.** The run's launch record keeps the disk it used, so every claim, revoke and reclaim acts on that disk after a restart.
- **Plan limit.** When Archil's plan disk limit refuses a new disk, the run fails with "your Archil plan allows N disks; upgrade or delete an agent". There is no shared-disk fallback.
- **Removing a disk.** `DELETE /v2/agents/{agent_id}/archil` deletes an archived agent's own disk at Archil.
- **Settings change.** The Archil settings are now the key, its region and the S3 URL. `diskId` is gone. A server that had a disk gives it to its existing agents at start, so their files stay where they were.
