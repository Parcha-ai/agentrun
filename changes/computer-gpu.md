---
packages: @parcha/agentrun-computer
kind: feature
---
GPU computers on Modal and Daytona. `ComputerSpec.gpu: { type, count }` asks for GPUs, and `ComputerCapabilities.gpu: { types, max }` declares the ones a provider offers, by the vendor's own names. The static `CAPABILITIES` of each configuration, and its entry in `PROVIDERS`, carry the same `gpu`. The shared `checkGpu` refuses, in words and before any vendor call, a GPU of a type the provider does not offer, a count outside 1 to `max`, or any GPU at all where a provider declares none. Every provider's `check()` now uses it.
- Modal: `T4`, `L4`, `A10`, `L40S`, `A100`, `A100-40GB`, `A100-80GB`, `RTX-PRO-6000`, `H100`, `H200`, `B200`, `B300`, up to 8. A GPU computer runs on Modal's gVisor runtime, its one GPU runtime, with the SDK's `gpu` (`"A100-80GB:2"`). The drift check holds the runtime from both sides, gVisor's kernel exactly on a GPU computer. The spec tag records the GPUs, and `attach` reads them back. A GPU with an Archil mount is refused for now.
- Daytona: `H100`, `H200`, `RTX-PRO-6000`, `RTX-4090`, `RTX-5090`, `MI355X`, up to 8, sent as `gpu` and `gpuType`. The read-back's `gpu` and `gpuType` must match, and `attach` reports them.
- Conformance: `provider.check-refuses` holds every provider to the GPU rule, and a new Full case, `gpu.present` (group `gpu`), makes one computer with the GPU the run names (`--gpu <type>[:<count>]`). It checks attach's read-back and `nvidia-smi -L` as the computer's user. Without `--gpu` the case skips, since a GPU bills by the second.
