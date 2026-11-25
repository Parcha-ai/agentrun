---
packages: @parcha/agentrun-computer, @parcha/agentrun-serve
kind: fix
---
A plain `npm install` of the server now brings the vendor SDKs its computer providers load (e2b, modal, @boxd-sh/sdk, ssh2 and Archil's `disk`), as pinned optional dependencies of `@parcha/agentrun-computer`, so E2B's "Test connection" no longer fails with "Cannot find package 'e2b'". Installed without them (`--omit=optional`), a provider says the package and its install step, such as `E2B needs the e2b package: npm install e2b@2.63.0`. In Mode 1, a sandbox provider that could hold the run's folder on an Archil disk now says to turn on Archil in Settings → Workspace.
