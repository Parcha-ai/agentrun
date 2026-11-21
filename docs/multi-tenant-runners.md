# Threat model: a runner shared by many customers

This page is for an operator who runs AgentRun runners that hold many customers' runs at once. It says what keeps one
run from another and from the operator's network, what does not, and what to set. Written 2026-11-20 against
`main` at the commit this page landed in; each control names the code or test that holds it.

**The rule:** a run reaches only its own folder, its own box (sandbox) and its own grants.

## Who attacks what

| Actor | Can | Wants |
| --- | --- | --- |
| A customer's agent, steered by a page, an email or a file it read (prompt injection) | Call the tools its agent was granted, with any arguments | Another customer's files, keys or memory; the operator's network (cloud metadata, internal services) |
| A customer's code in its box | Anything inside the box | The same, from the box |
| Another run on the same runner | The same as the first | The same |

The operator, the runner's image and the store are trusted. A runner that is itself compromised reaches every run it
holds: nothing below defends against that.

## Controls

| Boundary | Control | Where it is held |
| --- | --- | --- |
| Run ↔ run, on one runner | Each run is a process of its own, as a uid of its own (slot `s` is uid and gid `1001 + s`), in its own group alone, no capability, `no_new_privs`. The runner's user is in one group (its own) and in no slot's. While a run holds its slot, its folders are the slot's uid's and the runner's group's (`2770`, setgid), so no other slot can enter them. At the run's end every process of the uid is killed, its files in the shared temporary folders removed, and its folders given back to the runner, so the slot's next run cannot enter them. | `packages/serve/runas` (`own`, `reap`, `run`), `runner/run-child-host.ts`; `runas/privileged_test.go` (real helper, as root in CI); `docker/image-custody.sh` (the built image) |
| Run ↔ store | A run's process reads and writes the store only over a channel to its runner, each call checked against its claim (its own run, its own agent). The store URL, seal key and API token stay in the runner. | `runner/run-child-host.ts` (`storeCall`), `test/run-isolation.test.mjs` |
| Run ↔ keys | A run's process is handed its own keys on a pipe; secrets are never in an environment or a command line. | `secrets.ts`, `image-custody.sh` (canaries) |
| Run ↔ runner's disk | Shell and the coding tools run in the run's box. Claude's own built-in tools are off; Claude's file tools are the host's (`mcp__hands__read`, `write`, `edit`, `bash`), which act on the box. | `run-adapters-claude-agent/test/tool-off.test.mjs`, `serve/test/claude-box-files.test.mjs` |
| Run ↔ operator's network, by URL | `web_fetch` and `web_save` refuse loopback, private ranges, carrier-grade NAT (100.64/10), link-local (169.254/16, cloud metadata), unique-local and multicast addresses, by name (`localhost`, `*.local`, `*.internal`) and by every address a name resolves to; each redirect hop is checked again and the connection is dialled at the address checked, so a second DNS answer is never used. Ports 80 and 443 only. | `pi-browser/src/core/public-fetch.ts`; `pi-browser/test/public_fetch.test.mjs`; `serve/test/runner-web-guard.test.mjs` (on a runner apart from its server) |
| Run ↔ operator's network, by MCP server or calendar | Same address check, https only. An owner may allow named private-network hosts (Settings → MCP servers). **On a shared runner set `AGENTRUN_PRIVATE_HOSTS=none`**: no owner's list is then read or saved, so an owner cannot point an MCP server or a calendar at the operator's private network. A range list (`10.20.0.0/16`) narrows the allowance instead. Loopback, link-local and the machine's own addresses stay refused either way. | `serve/src/mcp-private-hosts.ts`, `serve/test/mcp-private-hosts.test.mjs` |
| Box ↔ operator's network | The box's own egress policy: Daytona's network policy, or `AGENTRUN_BOX_ALLOW` for a Docker box. The URL guard above does not apply to code in a box. | The box provider; the operator's network policy |

## What is not covered

- **Keys the whole account shares** (Archil, Daytona, monid, Parallel) can reach a run's process today. Moving them out is
  the next isolation step.
- **One kernel.** Runs on a runner share the kernel and the process table: a run sees that other processes exist and
  their command lines (never a secret: the custody check holds that), not their memory, environment or descriptors.
  There is no VM boundary between runs.
- **A folder a run shuts.** A run that does `chmod 700` on one of its folders drops its setgid bit (the runner's group is
  not the run's), so the runner cannot read that folder until the run ends and the folder is given back.
- **Docker boxes (Mode 1) are on the runner's disk.** A Docker box's `/workspace` is a bind of the run's folder under the
  runner's data directory. A shared runner should run boxes in a sandbox provider on a remote folder (Mode 2), never
  Docker boxes beside the runner.
- **Skills are read on the runner.** Claude's `Skill` tool and `read_skill_file` read the run's own copy of its agent's
  skills on the runner, read-only and by the names the skill lists.
- **SysV IPC objects** a run leaves are not removed at its end.
- **Noisy neighbours.** CPU, memory and disk are shared; `AGENTRUN_MAX_RUNS` bounds the count, not the size.

## What to set on a shared runner

1. Keep per-run users on: leave `AGENTRUN_RUN_USER` unset, and let the platform keep the image's file capabilities
   (no `no-new-privileges`, Kubernetes `allowPrivilegeEscalation` not false). The runner refuses to claim, in words,
   when it cannot switch users.
2. Hold at most the helper's 256 slots: `AGENTRUN_MAX_RUNS` ≤ 256 (minus `AGENTRUN_RUN_SLOT_FIRST`).
3. Set `AGENTRUN_PRIVATE_HOSTS=none` on the server and on every runner. Each process reads its own environment.
4. Leave `AGENTRUN_MCP_ALLOW_LOOPBACK` and `AGENTRUN_WEBHOOK_PRIVATE_TARGETS` unset.
5. Run agents in a sandbox place on a remote folder (Mode 2), not in Docker boxes beside the runner.
6. Give the runner a network policy that reaches only its real destinations: the store, the model gateway, the box
   provider and the remote folder.

`GET /v2/capabilities` lists the switches the server started with under `switches`, and says `run_isolation: "uid"` when
per-run users are on.
