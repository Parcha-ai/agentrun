---
packages: @parcha/agentrun-serve
kind: feature
---
With Archil on (Mode 2), uploads live on Archil and the server places a run's files in its folder at the run's start, so a runner reads no upload and needs no disk of the server's. `POST` and `PUT /v2/files` keep each file on the server's own uploads disk, `agentrun-<server id>-files` (made by the first upload), at `files/<file_id>/`, and listing, reading and deleting read it there. A run started with `file_ids` has each file copied into its folder at `work/inputs/<path>` before it is queued (2 files at a time across every start on the server, at most 45 s). Its launch records `files_placed` and the disk it used, and its claim copies nothing. A copy that fails refuses the start with `424 upstream_failed` in words, and no run is made.
In Mode 2, an uploaded file that no run names is deleted after `AGENTRUN_UPLOAD_RETENTION` (default `7d`, or `off`), swept hourly (`event=uploads_expired`). Mode 1 is unchanged: uploads stay in `DIR/files/`, are copied in at the claim, and are never deleted. Files uploaded under one mode are not seen under the other.
