---
packages: @parcha/agentrun-serve
kind: fix
---
An agent with no computer is no longer shown bash and the background tools it can't use (#2141). The agent's read, capabilities, the computer list and the save check all read where a run has its shell by the claim's own rule (`runShellOf`, on the agent's computer setting, else its place, and the server's folder mode now):
- `GET /v2/agents/{id}`: a tool of bash's family the run would not have carries `resolved: "unavailable: ..."` in the words a call of it gets there. With no computer that mounts the run's folder the background tools are not there, and bash neither when run folders are on the server's own disk.
- `GET /v2/capabilities`: bash shows available on a server with no box when its folders are on Archil, whose exec runs it; the background tools still need a box.
- `GET /v2/computers`: each provider, and the one "no computer" choice (kind `none`), carries `shell` (`computer`, `local` or `none`), `host_tools` (exactly the tools a run of that choice gets: the file tools always, `bash` with a shell, the five background tools on a computer) and, unless its shell is `computer`, a `shell_note` saying what it leaves out.
- Saving an agent: with Archil storage, an agent with no computer saves with `bash` and is refused the background tools; with run folders on the server's own disk, it is still refused `bash`. Each refusal uses the choice's `shell_note` words.
Upgrading: nothing to do. A client that read bash as available on an agent with no computer now reads it unavailable, with the reason.
