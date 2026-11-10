---
packages: @parcha/agentrun-computer
kind: breaking
---
The E2B provider takes no `publicStream` option and has no `stream()`: a screen is streamed through agentrun, never through a vendor URL. `publicStream` let public traffic into the sandbox, which opened every port in the computer to anyone with its address. Making an `E2BProvider` with `publicStream` (either value) now throws in words, and the conformance module no longer reads `COMPUTER_E2B_PUBLIC_STREAM`. Drop the option and the setting; every E2B sandbox is made with public traffic off. `provider.stream` stays on `ComputerProvider` for the browser kinds (Browserbase and Kernel).
