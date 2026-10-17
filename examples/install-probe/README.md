# The install probe

`npm install <name>@<version>` with lifecycle scripts **on**, in a throwaway Docker box, and the connections `strace`
saw the install's processes make. The install, its scripts and everything they start live in the box: nothing from the
package runs on the host. It is an example over `@parcha/pi-transport` (`BoxProvider`, `dockerBoxes`), not part of the package.

```ts
import { installProbe } from './install-probe.ts';

const result = await installProbe('is-number', '7.0.0');
// { exitCode, scriptLog, durationMs, seen: 'connections seen by strace',
//   outbound: [{ host: 'registry.npmjs.org', ip, port: 443, at }, ...] }
```

- `installProbe(name, version, options?)` starts the box, waits for the install and returns the result.
- `startInstall` returns the box's id once the install is going. The install runs detached in the box, so it goes on if the
  process that started it dies. `attachInstall(id)` can be called from any process: it returns the result, `{ running: true }`
  while the install has not ended, or `{ gone: true }` when the box no longer exists (killed, ended, or already read).
  Only `{ gone: true }` calls for a fresh `startInstall`, which is safe to repeat: boxes share nothing. There is no retry
  and no dedupe, so a second `startInstall` is a second box.
- `killBox(id)` ends one box.
- Without Docker, `startInstall` throws `DockerUnavailable` (`code: 'DOCKER_UNAVAILABLE'`). A name or version that is not
  an npm package name or version is refused before any box starts.

## What it is not

- **Not a verdict.** `outbound` is what `strace` saw (`connect` calls). A host name comes first from the DNS answers the
  install itself received. An address no answer named is matched by resolving the queried names again in the same box after
  the install ended; that is a fallback (a CDN's addresses rotate) and a best effort, so a name is left out when nothing
  matches or the lookup fails. The trace the host reads is capped at `traceLimitBytes` (4 MiB by default): past it
  `traceTruncated` is `true` and the connections after the cut are not listed. It is what was seen, not a proof of what
  was not.
- **Not a sandbox for the host's trust.** The box has network access by design (the install needs the registry), so a
  package's script can reach the internet from the box.
- **Not a scanner.** It reads no source and judges nothing; what the connections mean is the caller's to decide.

## Run the test

```sh
node --test examples/install-probe.test.mjs
```

The parsers run anywhere. The cases that start a box need Docker and the network and are skipped without Docker
(`INSTALL_PROBE_SKIP=1` skips them anyway).
