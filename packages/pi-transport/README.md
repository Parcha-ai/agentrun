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
| Modal | `@parcha/pi-transport/box/modal` | a gVisor sandbox, or a VM (`isolation: "vm"`) |

## Modal

`modalBoxes(sdk, { appName })` takes the host's own Modal client, so this package depends on no Modal SDK. The
client is typed structurally (`ModalSdk`); the `ModalClient` of the `modal` package, version 0.11.0, fits it.

```ts
import { ModalClient } from "modal";
import { modalBoxes } from "@parcha/pi-transport/box/modal";

const provider = modalBoxes(new ModalClient(), { appName: "my-boxes" });
await provider.create({ maxLifetimeMs: 10 * 60_000, isolation: "vm" }, BACKGROUND_CONTEXT);
```

- `isolation: "vm"` starts a VM with its own kernel. `"gvisor"` or no value starts Modal's default sandbox. Any other
  value is refused with `unsupported`.
- `gpu: "T4"` works on the default sandbox only; a GPU with `isolation: "vm"` is refused with `invalid`.
- `maxLifetimeMs` is Modal's own timeout, rounded up to whole seconds and capped at 24 hours. Modal ends the box when
  it passes, whatever happens to the host.
- The live suite spends money and runs only when asked. It needs `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` in the
  environment and the SDK, which is not installed with this package:
  `npm install --no-save modal@0.11.0`, then `npm run test:live:modal -w @parcha/pi-transport`. It names its Modal
  app and labels from `PI_TRANSPORT_LIVE_PREFIX` and `PI_TRANSPORT_LIVE_LABELS`, and `PI_TRANSPORT_LIVE_MODAL_KINDS`
  (`sandbox,vm,gpu`; default `sandbox,vm`) picks the kinds.

## Writing a provider

Fill `BoxProvider` and `Box`, then run the conformance suite against real boxes:

```ts
import { describe, expect, it } from "vitest";
import { registerBoxConformance } from "@parcha/pi-transport/testing";

registerBoxConformance({ describe, expect, it }, "my boxes", (use) => use(myBoxes()));
```

A box whose `exec` carries input and streams output can take `uploadByExec` and `downloadByExec` as its file calls.
