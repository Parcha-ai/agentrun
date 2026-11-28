# Provider scorecard

AgentRun is an open-source platform for running AI agents, and it gives each agent a computer on a vendor's machines.
This page reads 26 sandbox and machine vendors against the provider contract in [PROVIDERS.md](PROVIDERS.md) and
[spec/computer/provider.md](../../spec/computer/provider.md). For each it says whether a provider fits on the shared
machine-host adapter, what the provider would take, and what is still open. It is for a vendor's engineer, or a
contributor, deciding whether to write one.

As of main `1fcb4d34cd`, 2026-11-16, from the vendors' public documentation and SDK source; nothing here was run on a
vendor's account.

**The bar for a clean fit.** Every host member ([the eleven members](PROVIDERS.md#the-eleven-members)) fits with what's
on main, and nothing of AgentRun's runs on the vendor beyond computerd and the box image.

**Fits if** means no workaround code is left, but a fact about the vendor hasn't been checked on a real account. Those
facts are marked **unverified** everywhere on this page. Most of them are lines the
[exec pre-check](PROVIDERS.md#step-one-run-the-exec-pre-check) prints from one machine: whether its exec keeps the
[five rules](PROVIDERS.md#exec-shapes-that-work), whether root can make a network namespace, the arch and the listeners.

**Needs a workaround** names the code a provider would carry that the contract has no shared piece for. **Blocked**
names the member that can't be written on the shared adapter today. Sizes are estimates of the provider file, from the
documented calls, not from written code. The size column is an estimate, and size alone doesn't change a verdict.

## The table

Of 30 rows (26 vendors; Google, Fly.io, Beam and boxes.dev have two rows each): 0 clean, 5 fit if unverified facts hold,
15 need a workaround, 10 are blocked. Render's row is built since (`src/render.ts`, a dial sandbox), and so is Fly.io
Sprites' (`src/sprites.ts`, a hosted sandbox whose unverified facts wait on its live run).

| Vendor | Rents | Fit | Size (estimate) | Shared pieces it would use |
| --- | --- | --- | --- | --- |
| [Alibaba Cloud AgentBay](https://www.alibabacloud.com/help/en/agentbay/developer-reference/core-concept) | sessions of a cloud desktop, browser or phone | blocked (`exec`: no two-way exec stream) | 800-1200 outside the adapter | none |
| [AWS Bedrock AgentCore Runtime](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-how-it-works.html) | a microVM per runtime session, arm64 | needs a workaround (exec through a relay of ours in the image) | 500-700, plus a relay of about 150 | [packed labels][pl], [prepareImage][pi] |
| [Azure Container Apps Sandboxes](https://learn.microsoft.com/en-us/azure/container-apps/sandboxes-overview) | microVMs in a regional sandbox group | blocked (`exec`: no two-way exec stream) | 250-350, plus a relay | [prepareImage][pi] |
| [Baseten Sandboxes](https://docs.baseten.co/sandboxes/overview.md) | microVMs | needs a workaround (the desktop image needs Baseten's sandbox API server as its entrypoint, a layer of ours) | 260-280 | [framedExec][fe], [prepareImage][pi] |
| [Beam Sandbox](https://docs.beam.cloud/v2/sandbox/overview) | disposable containers with a TTL | blocked (`exec`: no live stdin) | n/a | none |
| [Beam VM](https://docs.beam.cloud/v2/vm/overview) | persistent microVMs | needs a workaround (`extend` rewrites the whole metadata map, or is left out) | 300-350 | [ssh-exec][se], [prepareImage][pi] |
| [Blaxel Sandboxes](https://docs.blaxel.ai/Sandboxes/Overview.md) | microVMs with standby | needs a workaround (the box image needs Blaxel's sandbox-api added by hand; a size rule held by hand) | 250-280 | [framedExec][fe], [packed labels][pl], [prepareImage][pi] |
| [boxes.dev](https://boxes.dev/help) as a provider | devboxes, Firecracker VMs on E2B | blocked (no public create, exec or delete API; the CLI is tied to a signed-in user; exec is one-shot; a box sleeps after 5 minutes idle and stays awake 4 hours at most; the VMs are E2B's, which AgentRun already drives) | none | none |
| [boxes.dev](https://boxes.dev/help) as a bring-your-own machine | the user's own devbox, with computerd dialing in | needs a workaround (Linux pairing, which is planned and not built; unverified: an open outbound connection keeps the box awake) | no provider file | [attach binding](../../spec/computer/attach.md) |
| [Cloudflare Sandbox](https://developers.cloudflare.com/sandbox/) | containers in Firecracker microVMs, driven from a Worker | needs a workaround (on the dial path, a relay Worker of ours in the user's account carries create, get, list and delete, and no exec; an alarm keeps the container alive, since an open outbound socket is not activity; the image is fixed at deploy) | 250-330, plus a relay Worker | none |
| [Cube Sandbox](https://github.com/TencentCloud/CubeSandbox) | self-hosted KVM microVMs behind an E2B-compatible API | needs a workaround (a copy of E2B's host, which takes no API URL; one arch per deployment) | about 320 | [prepareImage][pi] |
| [DigitalOcean MicroVMs](https://docs.digitalocean.com/products/microvms) | a microVM running one OCI image | blocked (the idle pause can't be switched off; exec would also need a shim of ours over the pty console) | about 300 if the pause could be switched off | [packed labels][pl], [prepareImage][pi] |
| [Fly Machines](https://docs.fly.io/machines/api/machines-resource) | KVM microVMs from an OCI image | blocked (`exec`: answers once the command ends) | n/a | none |
| [Fly.io Sprites](https://docs.fly.io/sprites) | persistent Linux VMs that sleep when idle | built (`src/sprites.ts`, a sandbox alone: no image or snapshot a create can name, so no desktop or Archil; `extend` left out; unverified until the live run: amd64, a label string's 64 bytes, a taken name's 409, root and its network namespace, 75 s of exec silence, an exec keeping a sprite awake) | 304, built | [framedExec][fe], [packed labels][pl] |
| [Freestyle VMs](https://www.freestyle.sh/docs/vms.md) | Linux VMs | needs a workaround (a per-VM SSH identity made and deleted outside create, delete and the sweep) | about 280 | [ssh-exec][se], [packed labels][pl], [prepareImage][pi] |
| [Google Agent Platform sandboxes](https://docs.cloud.google.com/gemini-enterprise-agent-platform/scale/sandbox?hl=en) | Google-managed gVisor containers | blocked (`exec`: one-shot, not root) | n/a | none |
| [Google GKE Agent Sandbox](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/agent-sandbox) | gVisor pods on the user's cluster | needs a workaround (a Kubernetes client and GKE auth in the host; unverified: root makes a network namespace under GKE's gVisor, the exec stream has no idle cut) | 300-380 | [framedExec][fe], [packed labels][pl], [prepareImage][pi] |
| [Hugging Face Sandboxes](https://huggingface.co/docs/huggingface_hub/main/concepts/sandbox) | a VM per Job | blocked (network fence: no nested namespaces, per the vendor's docs) | about 240 if the fence held | [ssh-exec][se], [packed labels][pl], [backstopAt][bs], [prepareImage][pi] |
| [Hyperbrowser Sandboxes](https://hyperbrowser.ai/docs/sandboxes/introduction.md) | Firecracker microVMs | blocked (the sandbox record has no name or label, per the vendor's OpenAPI, so a listing finds nothing of ours: the vendor, or our side, would have to keep the labels) | 230-260 if labels were kept | [framedExec][fe] with [sse][ss], [prepareImage][pi] |
| [Kasm Workspaces](https://docs.kasm.com/docs/reference/developer-api) | a container session streamed to a person | blocked (`exec`: no two-way exec stream) | n/a | none |
| [Koyeb Sandboxes](https://www.koyeb.com/docs/sandboxes) | microVMs as Koyeb services | fits if (unverified: `idle_timeout` 0 never sleeps; the exec WebSocket has no idle cut and runs as root; root makes a network namespace; a taken name's status; labels kept on our side or by the vendor, since a service has the name and no label) | 260-300 | [framedExec][fe] |
| [microsandbox](https://docs.microsandbox.dev/cloud/overview.md) | libkrun microVMs (hosted cloud in private beta) | needs a workaround (exec only through an SDK whose backend and key are process-wide) | 220-240 | [prepareImage][pi] |
| [Morph Cloud](https://cloud.morph.so/docs) | VM instances booted from snapshots | fits if (unverified: SSH lands as root; `/ttl` counts from now; `morphvm-minimal` runs `install.sh`; root makes a network namespace) | 240-270 | [ssh-exec][se], [packed labels][pl], [prepareImage][pi] |
| [Northflank Sandboxes](https://northflank.com/docs/v1/application/sandboxes) | microVMs as Northflank services | fits if (unverified: root makes a network namespace in the microVM; the exec proxy has no idle cut) | 280-300 | [framedExec][fe] (pid wrapper), [backstopAt][bs] |
| [OpenSandbox](https://github.com/opensandbox-group/OpenSandbox) | self-hosted containers, or microVMs with Kata | needs a workaround (an exec of ours over execd's PTY socket; isolation set per deployment; the fence needs user namespaces allowed) | about 280 | [packed labels][pl], [prepareImage][pi] |
| [Railway Sandboxes](https://docs.railway.com/sandboxes) | VMs in a project environment | needs a workaround (no name or labels: labels kept in create's variables and read by exec; errors mapped by message text) | 420-470 | [prepareImage][pi] |
| [Render Sandboxes](https://render.com/docs/sandboxes) | Firecracker microVMs | needs a workaround (built as a dial sandbox, `src/render.ts`: no stdin, so the sandbox dials the server, `agentrun-dial` started by one `runs/sync` call; no label, so the labels live in a file in the sandbox; Core passed live over dial) | 505, built | [dial][dl], [prepareImage][pi] |
| [Runloop Devboxes](https://docs.runloop.ai/docs/devboxes/overview.md) | VMs | needs a workaround (two SSE feeds merged by hand) | 270-290 | [framedExec][fe] with [sse][ss], [backstopAt][bs], [prepareImage][pi] |
| [Together Code Sandbox](https://docs.together.ai/docs/together-code-sandbox.md) | Firecracker microVMs booted from snapshots | fits if (unverified: root makes a network namespace; the SSE feed holds 75 s of silence; the `ttl` cap; the tag value limit; amd64) | 240-270 | [framedExec][fe] with [sse][ss], [packed labels][pl], [prepareImage][pi] |
| [Vercel Sandbox](https://vercel.com/docs/sandbox) | Firecracker microVMs | fits if (unverified: the log stream keeps a character split across two chunks whole and holds 75 s of silence; a taken name's status reads as `exists`; root makes a network namespace) | 230-290 | [framedExec][fe], [packed labels][pl], [prepareImage][pi] |

## Each vendor

Every vendor fact below links the vendor's own page or SDK source. Every contract claim links PROVIDERS.md or the
provider spec.

### Alibaba Cloud AgentBay

- **Rents:** sessions from images by id: `linux_latest`, `windows_latest`, `browser_latest`, `code_latest` and
  `mobile_latest` ([core concepts](https://www.alibabacloud.com/help/en/agentbay/developer-reference/core-concept)).
- **Exec:** a shell is an MCP tool called through the session's link URL: one request, one answer, with no stdin
  ([SDK](https://github.com/agentbay-ai/wuying-agentbay-sdk), `session.py`, `command.py`). A request and response
  exec can't carry the daemon ([exec shapes](PROVIDERS.md#exec-shapes-that-work)), so `exec` is blocked, and the
  computerd connection and the network fence with it.
- **Labels and lifetime:** `ListSession` filters by labels ([SDK](https://github.com/agentbay-ai/wuying-agentbay-sdk));
  create takes no name.
- **Other route:** a provider with daemon `none` that answers screen and input itself, the last row of
  [exec shapes](PROVIDERS.md#exec-shapes-that-work), at about 800-1200 lines.
- **Open:** ours, dial-out ([below](#what-would-change-a-row)). The vendor's: whether `linux_latest` runs commands as
  root (unverified), a streaming process tool.

### AWS Bedrock AgentCore Runtime

- **Rents:** each runtime session gets a dedicated microVM, for up to 8 hours
  ([how it works](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-how-it-works.html)); the
  container is ARM64 ([HTTP protocol contract](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-http-protocol-contract.html)).
- **Exec:** `InvokeAgentRuntimeCommand` takes a command and a timeout, and no stdin
  ([API](https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_InvokeAgentRuntimeCommand.html)), and a
  stream lasts at most 60 minutes ([quotas](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/bedrock-agentcore-limits.html)).
  So exec is a relay of ours in the image; if no stream outlives 60 minutes (unverified), the daemon's connection is
  blocked.
- **Labels and lifetime:** one runtime per computer, listed by prefix and tags; tag values packed
  (`labels: { packed }`, [create](PROVIDERS.md#the-eleven-members)). The idle and maximum lifetimes go up to 28800 s
  ([lifecycle settings](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-lifecycle-settings.html)),
  so the idle timeout is set to the lifetime. A session's end can't be read without reviving it
  ([sessions](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-sessions.html)).
- **Image:** an arm64 build of the box image pushed to the user's ECR under `agentrun-box:<hash>`, the registry path
  of [prepareImage](PROVIDERS.md#wire-it-up).
- **Open:** ours, dial-out. The vendor's: a session read that doesn't revive it, a stream with stdin and no cap.

### Azure Container Apps Sandboxes

- **Rents:** a microVM per sandbox in a regional sandbox group, booted from a disk image or a snapshot
  ([overview](https://learn.microsoft.com/en-us/azure/container-apps/sandboxes-overview)).
- **Exec:** `executeShellCommand` answers once the command ends, with no stdin, stream or kill
  ([SDK source](https://unpkg.com/@azure/containerapps-sandbox/)); the Python SDK has no PTY shell API either
  ([interactive shell](https://sandboxes.azure.com/docs/sandboxes/sandbox/interactive-shell)). No two-way exec stream,
  so `exec` is blocked. A relay of ours in the image would need the ingress to carry a long, silent WebSocket
  (unverified).
- **Labels and lifetime:** a server-side label filter ([labels](https://sandboxes.azure.com/docs/sandboxes/sandbox/labels));
  the vendor never ends a running sandbox, so the deadline is the janitor's. Auto-suspend is a lifecycle setting
  ([lifecycle](https://sandboxes.azure.com/docs/sandboxes/sandbox/lifecycle)), which create switches off, as every
  timer that ends a quiet machine must be ([create](PROVIDERS.md#the-eleven-members)); unverified that it can be.
- **Image:** a disk image made from the published box image in [prepareImage](PROVIDERS.md#wire-it-up)
  ([disk images](https://sandboxes.azure.com/docs/sandboxes/disk-images)).
- **Open:** ours, dial-out: a sandbox boots our entrypoint, so computerd could dial out. The vendor's: a streaming exec
  with stdin and kill.

### Baseten Sandboxes

- **Rents:** a microVM per sandbox; idle sandboxes go to standby
  ([launch post](https://www.baseten.co/blog/building-the-agent-cloud-introducing-baseten-sandboxes)).
- **Exec:** split calls on the sandbox's own runtime API: start a process, stream its logs, write stdin, kill
  ([execute](https://docs.baseten.co/reference/sandbox-api/process/execute-a-command.md),
  [stdin](https://docs.baseten.co/reference/sandbox-api/process/write-to-a-processs-stdin.md),
  [logs](https://docs.baseten.co/reference/sandbox-api/process/stream-process-logs-in-real-time.md)), which
  [framedExec](PROVIDERS.md#a-text-exec-in-split-calls) takes as they are. The runtime token lasts 2 hours
  ([authentication](https://docs.baseten.co/sandboxes/authentication.md)); whether a held stream outlives it is
  unverified.
- **Lifetime:** `TTL_MAX_AGE` counts from creation, and a process started with keep-alive keeps the sandbox active
  ([lifecycle](https://docs.baseten.co/sandboxes/lifecycle.md)).
- **Image:** "every sandbox image must include the sandbox API server and start it as the entrypoint"
  ([images](https://docs.baseten.co/sandboxes/manage-images.md)), so the box image needs a Baseten layer of ours. The
  sandbox kind on Baseten's stock image needs none.
- **Open:** ours, a "vendor agent as entrypoint" recipe beside `box/install.sh`. Unverified: the runtime user, label bounds, root's network namespace.

### Beam

- **Rents:** a VM is a named, persistent microVM; a Sandbox is a disposable container with a TTL
  ([VM overview](https://docs.beam.cloud/v2/vm/overview), [Sandbox overview](https://docs.beam.cloud/v2/sandbox/overview)).
- **VM exec:** the guest runs OpenSSH on port 2222, reached through the SDK's tunnel
  ([beam-js](https://github.com/beam-cloud/beam-js), `vm-assets/install`, `vm-tunnel.ts`), so exec is
  [`SshExec`](PROVIDERS.md#exec-shapes-that-work) over that tunnel.
- **VM labels and lifetime:** a `metadata` map with a server-side filter; the deadline is the janitor's.
  `extend` would update the whole metadata map at once ([configuration](https://docs.beam.cloud/v2/vm/configuration)),
  a read-merge-write, or be left out ([optional hooks](PROVIDERS.md#the-eleven-members)).
- **VM image:** the box image built in [prepareImage](PROVIDERS.md#wire-it-up). Unverified: one arch per pool, and how
  soon sshd answers after the VM runs.
- **Sandbox exec:** stdin is uploaded before the command runs, then ends: "this is not an interactive input stream"
  ([processes](https://docs.beam.cloud/v2/sandbox/processes)). With no live stdin, the exec can't carry the daemon's
  connection: blocked until dial-out.

### Blaxel Sandboxes

- **Rents:** microVMs ([generations](https://docs.blaxel.ai/Infrastructure/Gens.md)); with no connection for about
  15 s a sandbox goes to standby and resumes on the next one ([overview](https://docs.blaxel.ai/Sandboxes/Overview.md),
  [standby](https://docs.blaxel.ai/Sandboxes/Standby-control.md)).
- **Exec:** the in-VM sandbox-api's process calls ([processes](https://docs.blaxel.ai/Sandboxes/Processes.md),
  [log streaming](https://docs.blaxel.ai/Sandboxes/Log-streaming.md)) as
  [framedExec](PROVIDERS.md#a-text-exec-in-split-calls) pieces.
- **Labels and lifetime:** labels packed (`labels: { packed }`); an `expires` date set at create
  ([expiration](https://docs.blaxel.ai/Sandboxes/Expiration.md)) and moved by an update
  ([update](https://docs.blaxel.ai/api-reference/compute/update-sandbox.md)).
- **Image:** a template image carries Blaxel's sandbox-api, marked "required"
  ([templates](https://docs.blaxel.ai/Sandboxes/Templates.md)), so the box image gets it by hand. The size rule
  (memory as a multiple of cpus) is held in the host's `check`.
- **Open:** ours, a "vendor agent as entrypoint" image case and a size rule in `facts`. Unverified: root's network namespace, arch, listeners, the label charset.

### boxes.dev

- **Rents:** devboxes for coding agents, cloned from a project's template snapshot (disk and RAM). The vendor's founders
  say the machines are Firecracker VMs on E2B ([Show HN thread](https://hn.svelte.dev/item/48399358)); the
  [CLI](https://boxes.dev/help/agent-command-reference) is `dvb`.
- **As a provider, blocked.** The only public REST call is the automation API, which starts an agent run
  ([automation API](https://boxes.dev/help/automation-api)); it has no list, delete, exec or image. Create, list and
  delete exist only in the CLI, which is bound to a signed-in user
  ([manage devboxes](https://boxes.dev/help/manage-devboxes)). `dvb exec` is one-shot with a timeout and literal argv, so
  there is no stdio bridge. A box sleeps after about 5 minutes idle, "Keep awake" runs 1 to 4 hours, and "nothing runs
  while it sleeps" ([sleep, wake, recover](https://boxes.dev/help/sleep-wake-recover)). The machines are E2B's, which
  AgentRun already drives, so a provider adds no compute.
- **As a bring-your-own machine, needs Linux pairing, which is planned.** The user runs one command in their box and computerd
  dials in ([attach binding](../../spec/computer/attach.md#pairing-bring-your-own-machine)), inside boxes.dev's sleep
  and 4 hour limits. Linux pairing is planned, not built.
- **Unverified:** whether an open outbound connection from inside the box keeps it awake. The help pages list what does:
  an agent working, a hold an agent requests, background commands an agent starts (up to 1 hour, or a declared timeout
  capped at 4 hours), and a person using the machine; traffic through desktop localhost forwarding does not count
  ([sleep, wake, recover](https://boxes.dev/help/sleep-wake-recover)). Neither that page, [computer
  access](https://boxes.dev/help/computer-access), [manage devboxes](https://boxes.dev/help/manage-devboxes) nor the
  [agent command reference](https://boxes.dev/help/agent-command-reference) says an open connection or a bare process
  counts. One box left idle past 5 minutes with computerd connected settles it: it stays attached, or it sleeps.

### Cloudflare Sandbox

- **Rents:** containers, each in its own Firecracker microVM
  ([architecture](https://developers.cloudflare.com/containers/platform-details/architecture/)).
- **Exec and the rest:** every container call is a binding inside a Worker's Durable Object
  ([container class](https://developers.cloudflare.com/containers/container-class/)); there is no REST call that
  makes, lists or deletes one. On the dial path a provider needs a relay Worker of ours in the user's account that
  carries create, get, list and delete. It has no exec: computerd inside the container dials AgentRun.
- **Lifetime:** an inactivity window of at most 6 hours, which can't be switched off
  ([lifetime](https://developers.cloudflare.com/sandbox/concepts/lifetime/)). Requests, alarms and accepted
  WebSockets count as activity and a container's processes don't, so an open outbound socket from computerd does not
  keep the container alive. The relay's own alarm does: it renews the window about hourly and ends the container at its
  deadline. That alarm, the relay's, is the only timer that outlives AgentRun.
- **Image:** fixed at Worker deploy ([image management](https://developers.cloudflare.com/containers/platform-details/image-management/)),
  so [prepareImage](PROVIDERS.md#wire-it-up) can't build or pull one at run time.
- **Open:** ours, dial-out, or a documented vendor-hosted relay shape. The vendor's: a REST API for container instances.

### Cube Sandbox

- **Rents:** software you run: KVM microVMs restored from template snapshots, behind a REST API that speaks E2B's
  control-plane API, with E2B's envd in the guest ([README](https://github.com/TencentCloud/CubeSandbox)).
- **Exec:** envd, as E2B's host reads it ([exec shapes](PROVIDERS.md#exec-shapes-that-work), first row). `src/e2b.ts`
  takes no API URL and doesn't export its host, so a Cube provider copies it.
- **Lifetime:** the janitor's, by its label. Cube's only timer is an idle window that a call re-sets, and a create's
  `timeout: -1` switches it off ([lifecycle](https://github.com/TencentCloud/CubeSandbox/blob/master/docs/guide/lifecycle.md)),
  as every timer that ends a quiet machine must be ([create](PROVIDERS.md#the-eleven-members)). With no other timer, a
  VM whose server is gone stays until the janitor or a person deletes it.
- **Image:** the published box image registered as a template in [prepareImage](PROVIDERS.md#wire-it-up)
  ([templates](https://github.com/TencentCloud/CubeSandbox/blob/master/docs/guide/templates.md)). Unverified: that the
  template API injects envd, and whether envd calls need a per-sandbox token.
- **Open:** ours, `e2b.ts` taking an API URL and exporting its host (about 120 lines then), and a docs line for a
  cluster of mixed arch.

### DigitalOcean MicroVMs

- **Rents:** a VM with its own kernel running one OCI image, in public preview
  ([MicroVMs](https://docs.digitalocean.com/products/microvms)); `linux/amd64` images only
  ([limits](https://docs.digitalocean.com/products/microvms/details/limits/index.html.md)).
- **Exec:** an API exec and a console WebSocket
  ([run commands](https://docs.digitalocean.com/products/microvms/how-to/run-commands/index.html.md)). The console is a
  pty with stdout and stderr merged, so a shim of ours sets raw mode, frames stderr apart and kills by pid. Unverified:
  whether the console's idle and connection caps cut a quiet bridge; if they do, it's blocked until dial-out.
- **Labels and lifetime:** tags, packed (`labels: { packed }`); the janitor's deadline.
- **Blocked:** a MicroVM pauses after an idle timeout of up to 4 hours, and "You cannot turn auto-pause off"
  ([lifecycle](https://docs.digitalocean.com/products/microvms/concepts/lifecycle/index.html.md)). A host switches off
  every vendor timer that ends a quiet machine, and where one can't be switched off the vendor doesn't fit yet
  ([create](PROVIDERS.md#the-eleven-members)).
- **Image:** the published box image by reference ([create](https://docs.digitalocean.com/products/microvms/how-to/create/index.html.md));
  unverified that ghcr.io is accepted.
- **Open:** the vendor's, an auto-pause that a create can switch off. Ours, dial-out, or a pty helper beside
  `framedExec`. Unverified: root in the console, the tag charset.

### Fly.io

- **Sprites rent** a persistent Linux VM that goes warm after about 30 s idle
  ([lifecycle](https://docs.fly.io/sprites/concepts/lifecycle.md)). A create names a runtime, not an image
  ([sprites-js types](https://raw.githubusercontent.com/superfly/sprites-js/main/src/types.ts)).
- **Sprites exec:** a WebSocket exec ([execute command](https://docs.fly.io/sprites/api/websockets/execute-command.md))
  as [framedExec](PROVIDERS.md#a-text-exec-in-split-calls) pieces, with a kill by session id
  ([kill](https://docs.fly.io/sprites/api/exec/kill-exec-session.md)).
- **Sprites labels and lifetime:** labels are a list of strings, replaced whole on update, and the listing filters by
  name prefix ([list](https://docs.fly.io/sprites/api/sprites/list-sprites.md)); no delete timer is documented, so the
  deadline is the janitor's. `extend` is a read-modify-write of the list, or is left out.
- **Sprites, what's open:** with no image or snapshot to name, [prepareImage](PROVIDERS.md#wire-it-up) can't give a
  desktop or an Archil mount; ours, a post-boot step that runs `box/install.sh` on a running machine. For the sandbox
  kind, unverified: root's network namespace, whether a silent exec keeps a Sprite awake, whether a read wakes one.
- **Sprites, built:** `src/sprites.ts`, key `SPRITES_TOKEN`; its tests run on a fake of the REST API and the exec
  socket's binary frames, the exec pre-check and the provider's Core cases included.
- **Machines:** `exec` returns stdout, stderr and the exit code in one response
  ([execute command](https://docs.fly.io/api/machines/machines/execute-command.md)): blocked until dial-out.

### Freestyle VMs

- **Rents:** full Linux VMs with a guest kernel ([VMs](https://www.freestyle.sh/docs/vms.md)).
- **Exec:** SSH through Freestyle's proxy ([SSH](https://www.freestyle.sh/docs/vms/ssh.md)), with
  [`SshExec`](PROVIDERS.md#exec-shapes-that-work). The login is a per-VM identity and token, which the host makes at
  create and deletes at delete, outside the adapter's sweep.
- **Labels and lifetime:** metadata, packed (`labels: { packed }`); a TTL set at create and moved by update
  ([lifecycle](https://www.freestyle.sh/docs/vms/lifecycle.md)).
- **Image:** the box image built on Freestyle's base and kept as a snapshot in [prepareImage](PROVIDERS.md#wire-it-up)
  ([base snapshots](https://www.freestyle.sh/docs/vms/base-snapshots.md)).
- **Open:** ours, a pattern for a per-machine credential, and a word for isolation when a vendor names no hypervisor.
  Unverified: an exec channel without a pty that holds 75 s of silence through the proxy, root's network namespace,
  `install.sh` on the base, the status of a taken name.

### Google

- **GKE Agent Sandbox rents** one pod per `Sandbox`, on a gVisor node pool of the user's cluster
  ([how-to](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/agent-sandbox),
  [agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox)).
- **GKE exec:** the Kubernetes pod-exec WebSocket, as [framedExec](PROVIDERS.md#a-text-exec-in-split-calls) pieces,
  with a kill by pid.
- **GKE labels and lifetime:** Kubernetes labels, packed (`labels: { packed }`); `shutdownTime` with a delete policy,
  moved by `extend` ([lifecycle](https://agent-sandbox.sigs.k8s.io/docs/sandbox/lifecycle/)).
- **GKE image:** the published box image's tag in the pod template, from [prepareImage](PROVIDERS.md#wire-it-up).
- **GKE, what's open:** the host carries a Kubernetes client and GKE auth, code no shared piece covers. Unverified:
  root's network namespace under gVisor, and idle limits on a silent exec stream.
- **Agent Platform:** a sandbox's command is one-shot and runs without root
  ([shell quickstart](https://docs.cloud.google.com/gemini-enterprise-agent-platform/scale/sandbox/shell-sandbox-quickstart)):
  blocked on `exec`. Whether `bidiExecute` keeps a process open is unverified
  ([REST](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/rest/v1beta1/projects.locations.reasoningEngines.sandboxEnvironments)).

### Hugging Face Sandboxes

- **Rents:** a sandbox is a Job, a VM running a small static server
  ([concepts](https://huggingface.co/docs/huggingface_hub/main/concepts/sandbox)).
- **Blocked:** "A stock Job runs as root inside a user namespace ... without `CAP_SYS_ADMIN` / `CAP_NET_ADMIN` ... no
  nested namespaces" ([concepts](https://huggingface.co/docs/huggingface_hub/main/concepts/sandbox)). Where root can
  make no network namespace, init can't fence and refuses to start, so the adapter doesn't fit
  ([network forms](PROVIDERS.md#wire-it-up)).
- **Otherwise:** exec over SSH with [`SshExec`](PROVIDERS.md#exec-shapes-that-work), labels packed, a Job timeout set
  from [backstopAt](PROVIDERS.md#the-eleven-members) ([Jobs](https://huggingface.co/docs/huggingface_hub/guides/jobs)),
  and the published box image ([Jobs images](https://huggingface.co/docs/hub/jobs-images)): about 240 lines.
- **Open:** the vendor's, a Job where root can make a network namespace, alone or inside a user namespace
  ([pre-check](PROVIDERS.md#step-one-run-the-exec-pre-check)). A vendor egress policy doesn't stand in for it: init
  refuses to start without the fence ([network forms](PROVIDERS.md#wire-it-up)).

### Hyperbrowser Sandboxes

- **Rents:** CPU sandboxes on Firecracker by default; also GPU and macOS (beta) runtimes
  ([OpenAPI](https://hyperbrowser.ai/docs/openapi.json), `runtimeClass`; [macOS](https://hyperbrowser.ai/docs/sandboxes/macos.md)).
- **Exec:** the runtime's process calls: start a process, stream its output, write its stdin, kill it
  ([processes](https://hyperbrowser.ai/docs/sandboxes/processes.md)), as
  [framedExec](PROVIDERS.md#a-text-exec-in-split-calls) pieces. Output comes as "server-sent events"
  ([processes](https://hyperbrowser.ai/docs/sandboxes/processes.md)), which `sse` reads; PROVIDERS.md's worked
  example for [server-sent events](PROVIDERS.md#output-as-server-sent-events) is this API.
- **Labels and lifetime:** a sandbox has no name or label field ([OpenAPI](https://hyperbrowser.ai/docs/openapi.json)).
  `timeoutMinutes` at create ends it ([lifecycle](https://hyperbrowser.ai/docs/sandboxes/lifecycle.md)); no call
  moves it, so `lifetime: "vendor"` and no `extend`.
- **Blocked:** with no name or label on the record, a listing can't tell our sandboxes from the team's others. The
  vendor would add a label or name field, or the labels would be kept on our side.
- **Image:** the box image built from `box/Dockerfile` on Hyperbrowser's side as a team image, found by listing the
  team's images, in [prepareImage](PROVIDERS.md#wire-it-up)
  ([custom images](https://hyperbrowser.ai/docs/sandboxes/custom-images.md)).
- **Open:** the vendor's, a name or label on the sandbox record. Unverified: a process started without a timeout has none,
  exec runs as root, root makes a network namespace; the docs give `timeoutMs`, a process's "Maximum runtime in
  milliseconds", no default ([processes](https://hyperbrowser.ai/docs/sandboxes/processes.md)). The macOS runtime
  would be a direct `ComputerProvider`, outside the adapter.

### Kasm Workspaces

- **Rents:** a container session on an agent host, streamed to a person over KasmVNC
  ([developer API](https://docs.kasm.com/docs/reference/developer-api)).
- **Blocked:** `exec_command_kasm` takes a command and answers the container's details and the time: no output, no
  stdin and no exit code ([developer API](https://docs.kasm.com/docs/reference/developer-api)). No two-way exec stream, so `exec` is blocked,
  and the daemon's upload falls with it.
- **Labels:** none on a session; one Kasm user per request name would stand in.
- **Open:** ours, dial-out. The vendor's: a streaming exec, per-session labels.

### Koyeb Sandboxes

- **Rents:** a Koyeb service on a microVM ([instances](https://www.koyeb.com/docs/reference/instances)) that goes to
  deep sleep after `idle_timeout` ([lifecycle](https://www.koyeb.com/docs/sandboxes/sandbox-lifecycle)).
- **Exec:** the platform's exec WebSocket that the CLI uses
  ([koyeb-cli](https://github.com/koyeb/koyeb-cli), `pkg/koyeb/exec.go`), as
  [framedExec](PROVIDERS.md#a-text-exec-in-split-calls) pieces with a kill by pid.
- **Labels and lifetime:** the service is named `req.name`, and it has no label to list by, so the labels would be kept
  on our side or by the vendor. `delete_after_delay` counts from creation, 60 s to 24 hours
  ([lifecycle](https://www.koyeb.com/docs/sandboxes/sandbox-lifecycle)), so `lifetime: "vendor"` and no `extend`.
- **Network:** the vendor's egress list takes CIDRs only ([Python SDK](https://github.com/koyeb/koyeb-python-sdk),
  `egress.py`), so `allow` is init's proxy; blocking the network is hardening.
- **Open:** ours, a docs line on finding the exec in a vendor's CLI, and a listing hint if a rate limit bites. The
  facts in the table are unverified.

### microsandbox

- **Rents:** libkrun microVMs with their own guest kernel ([isolation](https://docs.microsandbox.dev/security/isolation.md));
  the hosted cloud is a private beta, by request ([cloud](https://docs.microsandbox.dev/cloud/overview.md)).
- **Exec:** the cloud REST API has no exec: commands ride the SDK's command channel
  ([cloud](https://docs.microsandbox.dev/cloud/overview.md)), the [SDK exec shape](PROVIDERS.md#exec-shapes-that-work).
  The SDK picks its backend and key process-wide ([repository](https://github.com/superradcompany/microsandbox)), so two
  providers in one process collide.
- **Lifetime:** a hard cap on total lifetime, `max_duration_secs`
  ([OpenAPI](https://docs.microsandbox.dev/api-reference/openapi.json)); unverified whether it counts from start or
  creation.
- **Image:** the published box image's tag from [prepareImage](PROVIDERS.md#wire-it-up), with no call.
- **Open:** ours, a rule for a vendor whose SDK keeps keys process-wide, and a Core check for a vendor agent reached
  over a device rather than TCP. Unverified: arch, root's network namespace, label limits.

### Morph Cloud

- **Rents:** instances booted only from snapshots of a Morph base image
  ([OpenAPI](https://cloud.morph.so/api/openapi.json)).
- **Exec:** the REST exec runs over SSH and takes no stdin ([OpenAPI](https://cloud.morph.so/api/openapi.json)); SSH to
  Morph's gateway with the instance id and API key as the username
  ([Python SDK](https://github.com/morph-labs/morph-python-sdk), `api.py`) is a two-way channel, with
  [`SshExec`](PROVIDERS.md#exec-shapes-that-work), which takes that login and keeps the key out of errors.
- **Labels and lifetime:** instance metadata with a list filter ([metadata](https://cloud.morph.so/docs/documentation/instances/metadata));
  a TTL with a stop action at create, moved by `/ttl` ([TTL](https://cloud.morph.so/docs/documentation/instances/ttl)).
  The docs state no maximum, so the cap is measured ([facts](PROVIDERS.md#the-eleven-members)).
- **Image:** `install.sh` run on `morphvm-minimal` and kept as a snapshot in [prepareImage](PROVIDERS.md#wire-it-up)
  ([snapshot setup](https://cloud.morph.so/docs/documentation/instances/snapshot-setup)).
- **Network:** the OpenAPI has no egress setting, so all three forms are init's.
- **Open:** the facts in the table, all unverified; nothing of ours.

### Northflank Sandboxes

- **Rents:** a Northflank service; on Northflank's cloud a CPU sandbox runs in a microVM
  ([sandboxes on Northflank Cloud](https://northflank.com/docs/v1/application/sandboxes/sandboxes-on-northflank-cloud.md)).
- **Exec:** a command stream through Northflank's exec proxy, from its JavaScript client
  ([execute command](https://northflank.com/docs/v1/api/execute-command.md)), the
  [SDK exec shape](PROVIDERS.md#exec-shapes-that-work), with a kill by pid.
- **Labels and lifetime:** annotations hold the labels; the service list carries none, so each pass reads every
  `computer-` service. A janitor host whose create sets the service's `expiryTime`, after which it "is paused and
  scheduled for deletion", from [backstopAt](PROVIDERS.md#the-eleven-members)
  ([create service](https://northflank.com/docs/v1/api/services/create-deployment-service)).
- **Network:** network policies are documented for your own cluster
  ([network policies](https://northflank.com/docs/v1/application/network/configure-network-policies.md)), so `none`
  rests on init's fence.
- **Open:** ours, a requests-per-hour hint for the adapter's polling. Unverified: the facts in the table.

### OpenSandbox

- **Rents:** software you run: containers under Docker or Kubernetes, or microVMs with Kata or Firecracker, with execd
  injected in each ([repository](https://github.com/opensandbox-group/OpenSandbox),
  [secure container](https://github.com/opensandbox-group/OpenSandbox/blob/main/docs/guides/secure-container.md)).
- **Exec:** execd's PTY WebSocket in pipe mode ([PTY](https://github.com/opensandbox-group/OpenSandbox/blob/main/components/execd/PTY.md)),
  which execd's API spec doesn't list; a frame demux of ours. `framedExec` has no one-socket form.
- **Labels and lifetime:** labels packed (`labels: { packed }`); a timeout at create, renewed to an absolute time.
- **Image:** the published box image's tag from [prepareImage](PROVIDERS.md#wire-it-up), with no call.
- **Network:** isolation and the fence depend on the operator's runtime: on a stock Docker deployment root can't make a
  network namespace, so `none` is blocked there.
- **Open:** ours, a one-socket exec helper and facts set from options. The vendor's: the pipe-mode route in execd's
  API spec, a default that allows user namespaces.

### Railway Sandboxes

- **Rents:** isolated VMs in a project environment, with a GraphQL API and WebSockets for exec and files; a sandbox has
  no name, labels or tags ([sandboxes](https://docs.railway.com/sandboxes),
  [railway-ts-sdk](https://github.com/railwayapp/railway-ts-sdk)).
- **Exec:** the exec WebSocket read by the host, as E2B's is: binary frames, stdin close, a kill signal and the exit code.
- **Labels and lifetime:** the only vendor timer is an idle destroy. On the Hobby and Pro plans a create's
  `idleTimeoutMinutes: 0` switches it off, as every timer that ends a quiet machine must be
  ([create](PROVIDERS.md#the-eleven-members)); on Trial and Free it can't be (1 to 5 minutes), so Railway doesn't fit
  on those plans ([sandboxes](https://docs.railway.com/sandboxes)). The deadline is then the janitor's. The labels go
  in create's variables and are read back by exec. Errors carry only a message, so they map by text.
- **Image:** the box image built on Railway's base in [prepareImage](PROVIDERS.md#wire-it-up).
- **Open:** the vendor's, a name or label field on a sandbox, or a delete timer a create sets. Unverified: exec user,
  root's network namespace, a 75 s silent stream.

### Render Sandboxes

- **Rents:** a Firecracker microVM per sandbox, in public beta
  ([announcement](https://render.com/blog/introducing-render-sandboxes)).
- **Built:** [`src/render.ts`](src/render.ts), a [dial](PROVIDERS.md#machines-that-dial-in) host, kind linux.
- **Exec:** a run takes a command and answers its output, with no stdin call
  ([executing](https://render.com/docs/sandboxes-executing)), so there is no `exec`: the sandbox dials the server. The
  API names no command a sandbox runs at boot, so once it reads `running`, create starts `agentrun-dial` under `setsid`
  in one `runs/sync` call (a live probe saw such a process outlive the call); `dialLog`, `dialExit` and `redial` go
  through `runs/sync` too.
- **Labels and lifetime:** a native name and no label
  ([SDK](https://www.npmjs.com/package/@renderinc/sdk) 1.11.0, `dist/generated/schema.d.ts`): the computer's name gives
  its own two labels, and create writes the rest to a file only root reads, which `get` and `list` read back once. A
  timeout at create, which can't move, so `lifetime: "vendor"`, no `extend`, and a day at most
  ([creating](https://render.com/docs/sandboxes-creating)). `idleTimeoutSeconds: 0` switches the idle suspend off.
- **Image:** the box image imported once as a sandbox build of the workspace, `agentrun-box-<tag>`, in
  [prepareImage](PROVIDERS.md#wire-it-up); a create names it as `buildName`, or a build id (`sbb-…`) as `buildId`.
- **Network:** the sandbox's own policy is allow-all, since it must reach the server; `none`, `open` and an allow list
  are init's.
- **Verified live** (Core over dial, 11-25): the sandbox's env reaches a run's processes, root makes network namespaces
  in the microVM (every `provider.network-*` case), the build imports the public box image with no credential, and a
  process escaped with `setsid` ends with the release.
- **Open:** the vendor's, a label on the sandbox record, and a stdin call.

### Runloop Devboxes

- **Rents:** devboxes isolated by virtual machine technology
  ([overview](https://docs.runloop.ai/docs/devboxes/overview.md)).
- **Exec:** async execute with stdout and stderr on two SSE feeds
  ([execute commands](https://docs.runloop.ai/docs/devboxes/execute-commands.md)), each read by
  [`sse`](PROVIDERS.md#output-as-server-sent-events) and merged by the host into
  [framedExec](PROVIDERS.md#a-text-exec-in-split-calls)'s one feed.
- **Labels and lifetime:** metadata; a janitor host that sets `keep_alive_time_seconds`, after which the devbox shuts
  down (48 hours at most), from [backstopAt](PROVIDERS.md#the-eleven-members)
  ([create](https://docs.runloop.ai/api-reference/devbox/create-a-devbox.md)). A
  shut-down devbox stays readable, and the host's `get` answers `undefined` for it, as for any vendor's kept record of
  a deleted machine ([get](PROVIDERS.md#the-eleven-members)).
- **Image:** a blueprint built in [prepareImage](PROVIDERS.md#wire-it-up).
- **Open:** ours, a shared merge of separate stdout and stderr feeds. Unverified: listeners, SSE silence, metadata
  limits, root's network namespace.

### Together Code Sandbox

- **Rents:** a Firecracker microVM per sandbox, created from a snapshot
  ([legacy docs](https://docs.together.ai/docs/together-code-sandbox-legacy.md),
  [Code Sandbox](https://docs.together.ai/docs/together-code-sandbox.md)). The SDK is enabled per organization.
- **Exec:** the in-VM API's exec calls, with output as SSE
  ([API spec](https://raw.githubusercontent.com/togethercomputer/together-sandbox/main/sandbox-openapi.json)), as
  [framedExec](PROVIDERS.md#a-text-exec-in-split-calls) pieces, with the output read by
  [`sse`](PROVIDERS.md#output-as-server-sent-events).
- **Labels and lifetime:** tags packed (`labels: { packed }`); a `ttl` set at creation that counts from creation
  ([migrating](https://raw.githubusercontent.com/togethercomputer/together-sandbox/main/docs/migrating-from-codesandbox.md));
  no call that moves it is documented, so no `extend`.
- **Image:** a snapshot made from the box image in [prepareImage](PROVIDERS.md#wire-it-up).
- **Open:** the facts in the table, all unverified; nothing of ours.

### Vercel Sandbox

- **Rents:** Firecracker microVMs with their own kernel, root through `sudo`
  ([security](https://vercel.com/docs/sandbox/concepts/security)).
- **Exec:** the SDK's detached command, its log stream as text, a stdin write per call and kill
  ([SDK](https://github.com/vercel/sandbox)), as [framedExec](PROVIDERS.md#a-text-exec-in-split-calls) pieces.
- **Labels and lifetime:** at most 5 tags, values up to 256 characters
  ([tags](https://vercel.com/docs/sandbox/concepts/tags)), so packed (`labels: { packed }`); a native name; the
  session timeout, moved by `extendTimeout`.
- **Image:** the box image pushed to Vercel's registry under `agentrun-box:<hash>`
  ([images](https://vercel.com/docs/sandbox/concepts/images)), the registry path of
  [prepareImage](PROVIDERS.md#wire-it-up).
- **Network:** the vendor's `deny-all` drops all egress ([firewall](https://vercel.com/docs/sandbox/concepts/firewall));
  it is optional hardening under init's fence.
- **Open:** the facts in the table, all unverified; nothing of ours blocks.

## What would change a row

The open gaps on our side, by how many rows they hold back:

| Gap | Rows | Kind |
| --- | --- | --- |
| No two-way exec stream: a computer that dials out to AgentRun instead | 9: Alibaba, AWS, Azure, Beam Sandbox, Cloudflare, DigitalOcean (if its caps cut the bridge), Fly Machines, Google Agent Platform, Kasm | planned |
| Exec shapes `framedExec` doesn't take: a one-socket PTY, stdout and stderr on two feeds | 3: DigitalOcean, OpenSandbox (PTY); Runloop (two SSE feeds) | adapter helper |
| An image that isn't one of [prepareImage](PROVIDERS.md#wire-it-up)'s paths: a deploy-time digest, or the vendor's agent as entrypoint | 4: Cloudflare, Blaxel, Baseten, Fly Sprites | docs and box |
| One each: a per-machine credential (Freestyle); `e2b.ts` taking an API URL (Cube); an SDK that keeps keys process-wide (microsandbox) | 3 | adapter or docs |

Two blocks are the vendor's to lift: DigitalOcean's auto-pause, which can't be switched off, and Hyperbrowser's sandbox
record, which carries no name or label.

Dial-out is planned: computerd in the machine would connect to AgentRun, so the vendor needs no exec stream. The
[attach binding](../../spec/computer/attach.md), a draft today, is that connection for a person's own machine.

A vendor can move its row:

- **Run the exec pre-check** on one machine of your account and send its output in
  [an issue](https://github.com/Parcha-ai/agentrun/issues): it settles most unverified facts above
  ([step one](PROVIDERS.md#step-one-run-the-exec-pre-check)).
- **Write the provider**, as [PROVIDERS.md](PROVIDERS.md#how-to-contribute-a-provider) says, and send the conformance
  report with it.

[fe]: PROVIDERS.md#a-text-exec-in-split-calls
[se]: PROVIDERS.md#exec-shapes-that-work
[pl]: PROVIDERS.md#the-eleven-members
[bs]: PROVIDERS.md#the-eleven-members
[pi]: PROVIDERS.md#wire-it-up
[ss]: PROVIDERS.md#output-as-server-sent-events
[dl]: PROVIDERS.md#machines-that-dial-in
