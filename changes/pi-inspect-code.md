---
packages: @parcha/agentrun-pi
kind: fix
---
An inspection that `WorkflowExtensionService` refuses now reaches the caller as an `ExtensionServiceError` with the service's `code` (`admission`, `invalid_workflow`, ...), its message prefixed `Cannot inspect workflow:` as before, and the refusal as its `cause`. Before, inspection rewrapped it as a plain `Error` with the message only, so a host could branch on the code of a refused run but not of a refused inspection. Any other inspection failure keeps its original error as its `cause`.
