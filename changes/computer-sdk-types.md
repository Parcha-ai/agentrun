---
packages: @parcha/agentrun-computer
kind: breaking
---
The E2B and Modal providers take the SDKs' own types (`import type` from `e2b` and `modal`, erased at build, so nothing loads from them and the package still has no runtime dependency; `e2b` and `modal` are now optional peer dependencies, installed for nobody) instead of hand-typed slices. Breaking, for TypeScript callers: `E2BSandboxClass` is the SDK's `Sandbox` class and `ModalSdk` is the SDK's `ModalClient`, so a stand-in must match the real class, not a slice; `E2BSandbox`, `E2BSandboxInfo`, `E2BListedSandbox`, `E2BCreateOptions`, `E2BCommandResult`, `E2BCommandHandle`, `E2BRunOptions`, `E2BPaginator`, `ModalApp`, `ModalImage`, `ModalCreateParams`, `ModalByteSink`, `ModalProcess` and `ModalSandbox` are gone (use the SDK's `Sandbox`, `SandboxInfo`, `SandboxOpts`, `CommandResult`, `App`, `Image`, `SandboxCreateParams`). JavaScript callers and the tests' fakes are unaffected.
