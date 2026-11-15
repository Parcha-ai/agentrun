---
packages: @parcha/agentrun-computer, @parcha/agentrun-serve
kind: breaking
---
E2B starts from our public box template in any account. Its descriptor says `prepareImage`, and its provider's `prepareImage()` answers the public template `<publishing team>/agentrun-archil-<recipe hash>` by name, with no call and no wait: the release's `box-e2b` job builds that template from the box image and makes it public.
- In Mode 2, an E2B sandbox and an E2B desktop are ready once the key works: they mount the run's folder from the owner's Archil disk, on the box template.
- In Mode 1, an E2B desktop starts from the box template too, instead of E2B Desktop's `desktop`: computerd starts Xvfb and xfwm4 there, and the `apps` group lists the box's apps (Firefox ESR, Mousepad, the Xfce terminal).
- The conformance run keeps E2B's stock templates, `desktop` and `base` for kind linux, or `COMPUTER_E2B_TEMPLATE`.
- Breaking: `E2B_BASE_TEMPLATE` and `E2B_DESKTOP_TEMPLATE` are gone from `@parcha/agentrun-computer`, and E2B's descriptor has no `defaultImage`. Ask the provider's `prepareImage()` for its template.
