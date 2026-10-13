# @parcha/pi-transport

**Experimental.** The API changes without notice between releases.

Run a [pi-durable](https://github.com/earendil-works/pi) session's tools in another machine, or move the session
there. This release holds the first layer: the `Box` interface, two providers and a conformance suite.

## A box

A `Box` is one running machine: a directory on this machine, a container, a sandbox, a VM. A `BoxProvider` creates
boxes, finds them again by id and lists them by label.

```ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { finish } from "@parcha/pi-transport";
import { dockerBoxes } from "@parcha/pi-transport/box/docker";

const provider = dockerBoxes();
const created = await provider.create({ maxLifetimeMs: 10 * 60_000 }, BACKGROUND_CONTEXT);
if (!created.ok) throw created.error;
const box = created.value;

const started = await box.exec(["uname", "-a"], undefined, BACKGROUND_CONTEXT);
if (started.ok) console.log(await finish(started.value));
await box.destroy(BACKGROUND_CONTEXT);
```

Expected failures are returned as `Result` values with a `BoxError` and a code. Every box has a maximum lifetime
that its provider enforces with no call from the host, so a host that dies does not leave boxes behind. A program in
a box never receives the host process's environment. A provider refuses a spec field it cannot honour instead of
ignoring it.

| Provider | Import | Isolation |
| --- | --- | --- |
| This machine | `@parcha/pi-transport/box/local` | none: for development and tests |
| Docker | `@parcha/pi-transport/box/docker` | a container per box |

`localBoxes` gives a program a fixed `PATH` (`/usr/local/bin:/usr/bin:/bin`, or the `path` option), a private `HOME`
and `TMPDIR`, and the spec's `env`. A detached watchdog ends a box when its lifetime has passed. On Linux, `destroy`
and the watchdog end every program of the box, also one that went to the background or left its process group. Where
`/proc` is missing they end only the programs the calling process started, and the watchdog removes the directory only.
It refuses `image`, `snapshot`, `cpus`, `memoryMb`, `gpu`, `region` and any `isolation` but `none`.

`dockerBoxes` runs `sleep` for the lifetime in place of the image's own entrypoint, so Docker ends the box. It refuses
`snapshot`, `region` and any `isolation` but `container`. Docker cannot choose a GPU model: any `gpu` gives the
container every GPU of the host.

## Moving a home: a store and a workspace

`@parcha/pi-transport/home` holds the two movers a session needs when there is no disk the boxes share. They know
nothing of sessions beyond "a SQLite file and a directory". Node only.

- **A store.** `sealStore(path)` returns a `Seal` (head, SHA-256, size) of a store its owner has closed; a store with a
  write-ahead log that holds content is refused with `not_sealed`. `checkpointStore(path, to)` takes a consistent copy
  of a store that is still open, with `VACUUM INTO` through a second read-only connection; the copy appears whole or
  not at all. `verifyStore(path, seal)` checks size, hash, SQLite's quick check and the head, in that order. The head is
  one read of `durable_metadata.next_seq`, the only knowledge of pi's schema here.
- **A file.** `moveFile(from, path, to, path, seal)` copies one file between boxes through this process and checks it by
  hash on the way and on the target; it appears at its path whole or not at all.
- **A directory.** `manifestOf(box, root, { exclude })` lists a directory in the box: every path with its kind, size,
  mode, link target and, for files, SHA-256. `moveWorkspace(from, to, { fromRoot, toRoot, exclude, maxBytes })` copies it
  as a `tar` stream, relayed a chunk at a time with no temporary file, then checks the target against the source:
  `too_large` and `unsupported_entry` (a socket, device or pipe, named) are decided from the listing before a byte
  moves; `changed` says the source changed during the copy; `mismatch` names the first path where the target differs.
  The receipt has bytes, files, the time of each part, MB per second and which side the relay waited on more.

Kept: file contents, permission bits, symbolic links as links, empty directories, modification times in whole
seconds, names with any bytes. Not kept: owners and groups, extended attributes, ACLs, and the access times. A target
that already holds other files fails the check. The boxes need `tar`, `find`, `xargs`, `split` and `sha256sum` from GNU
coreutils and findutils, as `boxEnv` does.

**How the bytes travel.** Each side of a move decides for itself by its box's `facts().bulk`: `stream` moves the
archive through the streams of `exec`, and is what `localBoxes` and `dockerBoxes` say; anything else, including a box
that says nothing, moves it as files through `upload` and `download`, because a remote provider's streams can be far
slower than its file calls (measured: Daytona's at 0.1 to 2.8 MB/s against 25 to 40 MB/s for files, a Modal sandbox's
at 2 MB/s against 31 to 35). Out of Docker into Daytona the archive streams out and arrives as files. A host can
override either side in the options (`fromPipe`, `toPipe`) and set the size of the parts (`chunkBytes`, default
32 MiB). With files, the archive is cut into parts in a directory of its own under the box's temporary directory
(`TMPDIR`, else `/tmp`); every part is hashed where it is made and checked where it lands, so a part that is missing,
short or flipped is `mismatch`; the directories are removed on success, on failure and on abort.

**Disk a move needs.** A side that moves files holds the archive once more: the source box needs free space for the
archive next to the tree it is packing (about the size of the files), and the target box for the archive next to the
tree it unpacks (the same again). A side that streams needs none. The host holds one part in memory at a time.

## Writing a provider

Fill `BoxProvider` and `Box`, then run the conformance suite against real boxes:

```ts
import { describe, expect, it } from "vitest";
import { registerBoxConformance } from "@parcha/pi-transport/testing";

registerBoxConformance({ describe, expect, it }, "my boxes", (use) => use(myBoxes()), {
	// One box is left alone for its lifetime. `ended` must ask the vendor's own API, never the provider under test.
	lifetime: { maxLifetimeMs: 60_000, graceMs: 120_000, ended: (box) => myVendorSaysGone(box.id) },
});
```

A box whose `exec` carries input and streams output can take `uploadByExec` and `downloadByExec` as its file calls.
