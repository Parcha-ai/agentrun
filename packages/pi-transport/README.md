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
