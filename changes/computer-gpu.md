---
packages: @parcha/agentrun-computer, @parcha/agentrun-serve, @parcha/agentrun-client, @parcha/pi-durable-agent
kind: feature
---
GPU computers on Modal and Daytona. `ComputerSpec.gpu: { type, count }` asks for GPUs, by the vendor's own type names. `ComputerCapabilities.gpu` declares the ones a provider offers, `{ types, max }`. It also states where its GPU computers differ from its others: `isolation`, `preemptible`, `stopDeletes`, `region`, `perGpu` and `mounts`. The static `CAPABILITIES` of each configuration, and its entry in `PROVIDERS`, carry the same `gpu`. Every provider's `check()` uses the shared `checkGpu`. Before any vendor call it refuses, in words:
- a GPU type the provider does not offer;
- a count outside 1 to `max`;
- any GPU at all where a provider declares none;
- a mount whose kind its GPU computers have not proven (`gpu.mounts`).
- Modal: `T4`, `L4`, `A10`, `L40S`, `A100`, `A100-40GB`, `A100-80GB`, `RTX-PRO-6000`, `H100`, `H200`, `B200`, `B300`, up to 8.
  - A GPU computer runs on Modal's gVisor runtime, its only GPU runtime, so it declares `gpu.isolation: "gvisor"`. It is preemptible (`preemptible: true`).
  - The SDK gets `gpu` as one string (`"A100-80GB:2"`). The drift check holds the runtime from both sides, gVisor's kernel exactly on a GPU computer.
  - The spec tag records the GPUs, and `attach` reads them back.
  - `gpu.mounts` is empty, so a GPU with an Archil mount is refused as not proven.
  - Sometimes Modal refuses an exec because the sandbox is shutting down (its init exited). The create now fails as `gone` and waits up to `timeouts.endedMs` (30 s) for the sandbox to finish. It then reports init's exit code and words.
- Daytona: `H100`, `H200`, `RTX-PRO-6000`, `RTX-4090`, `RTX-5090`, `MI355X`, up to 8, sent as `gpu` and `gpuType`. The types come from the API's `GpuType` enum only, which leaves out the `L40S`, `B200` and `B300` its docs list. A Daytona GPU is preemptible (`preemptible: true`).
  - A GPU computer is created in region `earth` with `autoDeleteInterval: 0`. Stopping it deletes it (`stopDeletes`): there is no pause or snapshot, so nothing on it persists.
  - Each GPU comes with 16 vCPU, 192 GiB of memory and 512 GiB of disk by default (`perGpu`).
  - The org needs GPU credits.
  - The read-back's `gpu` and `gpuType` must match, and `attach` reports them.
- Conformance: `provider.check-refuses` holds every provider to the GPU rule. Two new Full cases in group `gpu` each make one computer with the GPU the run names (`--gpu <type>[:<count>]`). Without `--gpu` they skip, since a GPU bills by the second.
  - `gpu.present` checks attach's read-back and `nvidia-smi -L` run as the computer's user. It also records, with nothing mounted, what that user sees of FUSE.
  - `gpu.archil` makes the computer with the run's Archil folder too, and checks that the folder reads at `/workspace` and that a program's write there is on the disk after release. It skips where `gpu.mounts` leaves out `archil`.
- Serve: an agent's sandbox computer takes an optional `gpu: { type, count }`.
  - The save checks its shape, and only a sandbox takes one (422). The revision keeps it.
  - The run's start (409 `agent_not_runnable`) and the claim hold it to what the provider declares, in `checkGpu`'s words. The server's folder mode counts as the mount.
  - The claim passes it into the computer's spec.
  - `GET /v2/computers` shows each sandbox provider's `gpu`. Its `why` says when a run on this server cannot have those GPUs. In Mode 2 Modal's GPUs say so, since the run's folder is an Archil mount.
  - The OpenAPI document and the generated clients carry both.
