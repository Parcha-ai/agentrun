---
packages: @parcha/agentrun-computer
kind: feature
---
`ModalProvider` makes computers that are Modal sandboxes on the VM runtime, through the host's own Modal client: the package names the slice of the JS SDK it calls (`ModalSdk`) and imports nothing from it. It has not run against real Modal yet; its tests use a fake of that slice.
- The daemon comes in as a layer of the computer's image (`COPY --from=<daemonImage>`, a registry image pinned by digest) and is the sandbox's command, `computerd init --deadline <iso> --user <uid:gid>`. `connect()` runs `computerd stdio` through `exec`, so a computer with network none is reached.
- Capabilities: lifetime `vendor` (Modal's timeout, at most 24 hours; a longer lifetime is refused in words), network `none` or `open` with `networkReadBack: false`, isolation `vm`, os `linux`, user `root` or `uid`. An allowlist, `pids`, a GPU and a change of network are refused in words. `release(ref, "stop")` is refused: Modal has no stop that keeps a sandbox; `delete` terminates and is idempotent.
- The drift check after `create()` and in `attach()`: the sandbox runs, its tags read back as given, hello matches, and `computerd probe`, run through the daemon, reports the computer's user, a kernel that is not gVisor's, and, for network none, no connection to its public addresses. A mismatch terminates the sandbox at create; `attach()` refuses and leaves it running. `network(ref)` reads network none back with the same probe.
- Every SDK call is bounded by a timeout and takes the caller's signal; a create that gives up has its sandbox terminated if one lands later.
- `computerd init` takes `--user <uid:gid>`: it starts as root, gives `$HOME` and the socket's directory to that user (0700), sets `no_new_privs` and becomes it. `computerd probe [--connect <host:port>]...` prints the uid, gid, kernel release and the addresses it reached.
- `ComputerCapabilities.networkReadBack` says whether `network()` reads the policy back from outside the computer (Docker: true). `ComputerErrorCode` gains `"modal"`.
- `dist/conformance/modal.js` is a provider module for the conformance CLI, and `npm run test:modal` the live suite; both run only with `AGENTRUN_COMPUTER_LIVE_MODAL=1`, `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` set.
