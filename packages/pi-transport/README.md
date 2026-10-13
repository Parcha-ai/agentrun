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
that its provider enforces, so a host that dies does not leave boxes behind. A program in a box never receives the
host process's environment.

| Provider | Import | Isolation |
| --- | --- | --- |
| This machine | `@parcha/pi-transport/box/local` | none: for development and tests |
| Docker | `@parcha/pi-transport/box/docker` | a container per box |

## Writing a provider

Fill `BoxProvider` and `Box`, then run the conformance suite against real boxes:

```ts
import { describe, expect, it } from "vitest";
import { registerBoxConformance } from "@parcha/pi-transport/testing";

registerBoxConformance({ describe, expect, it }, "my boxes", (use) => use(myBoxes()));
```

A box whose `exec` carries input and streams output can take `uploadByExec` and `downloadByExec` as its file calls.
