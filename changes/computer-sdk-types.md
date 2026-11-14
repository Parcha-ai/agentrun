---
packages: @parcha/agentrun-computer
kind: breaking
---
The E2B and Modal providers read the SDKs' own types (`import type` from `e2b` and `modal`, erased at build, so nothing loads from them, the published types name neither, and the package still has no dependency on them) instead of hand-typed slices. Breaking, for TypeScript callers: `E2BSandboxClass` and `ModalSdk` are now `object` (the host's own `Sandbox` class and `ModalClient` are passed as before, and checked at run time as before); `E2BSandbox`, `E2BSandboxInfo`, `E2BListedSandbox`, `E2BCreateOptions`, `E2BCommandResult`, `E2BCommandHandle`, `E2BRunOptions`, `E2BPaginator`, `ModalApp`, `ModalImage`, `ModalCreateParams`, `ModalByteSink`, `ModalProcess` and `ModalSandbox` are gone (use the SDK's own `Sandbox`, `SandboxInfo`, `SandboxOpts`, `CommandResult`, `App`, `Image`, `SandboxCreateParams`). JavaScript callers and the tests' fakes are unaffected.
