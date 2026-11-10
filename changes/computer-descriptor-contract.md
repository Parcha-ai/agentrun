---
packages: @parcha/agentrun-computer
kind: breaking
---
Each computer provider is now declared once, in a descriptor (`defineProvider`: its id, label, keys and the option each fills, settings, mounts, capabilities, default images and a lazy `load()`), and the registry and the kind registry's `PROVIDERS` are derived from the descriptors. `ProviderId` is any string; the built-in ids are `BuiltinProviderId`.

Who breaks, and what to do:

- The package root no longer loads or exports the provider classes as values. Import `DockerProvider`, `DaytonaProvider`, `ModalProvider`, `BrowserbaseProvider`, `KernelProvider` and their helpers from the provider's subpath (`@parcha/agentrun-computer/docker`, `/daytona`, `/modal`, `/e2b`, `/orgo`, `/phone-harness`, `/browserbase`, `/kernel`), or build a provider by id with `providerFor(id, options)`. Their types are still exported from the root.
- A vendor's own failure is now code `vendor`, with the provider's id in the error's `vendor` field, where it was code `docker`, `daytona`, `modal`, `e2b`, `orgo` or `phone`. Match on `code === "vendor"` and read `vendor`.
- `ComputerSpec.lifetimeMs` is optional in the type: a run's computer still needs it (`checkTenure` refuses a spec without it), and an agent's computer has none.

Persistent computers are in the provider contract: `capabilities().persistence`, `spec.owner` (`{ agent, idleTtlMs? }`, labelled `agentrun.owner=agent:<id>`), `release(ref, "detach")`, `attach(ref, { claim })` under a new claim epoch, and on `ComputerInfo` `owned`, `owner` and `detachedAt`. Every built-in provider refuses `spec.owner` and `detach` in words; none declares persistence yet. `sweep` never deletes an agent's computer by a deadline, only when `ownerGone(agent)` says so or after its owner's idle TTL; `releaseOlder` detaches an agent's computer instead of deleting it (`ReleasedOlder.detached`). The conformance suite adds `provider.owner` and `provider.detach` (Core) and `provider.persistence` (Full, where persistence is declared). Docker's inspect read-back moves to `src/docker/inspect.ts`, with the same exports.
