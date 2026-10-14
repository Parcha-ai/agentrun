---
packages: @parcha/pi-transport
kind: feature
---
The link of a home in a box (`./home`): `connectHome` on the host, `createRunner` and `runMain` in the box, frames
over the box's own `exec`. The runner's models mirror the host's catalog and hold no credential; the host answers
each request, refuses one from an epoch the lease left behind, and keeps an answer's frames so a link that drops
costs no second request (`connectHome`'s `server`: one `serveModels` server for every link to a runner). An order
the host gives up on is cancelled in the runner, and one whose context ended already is not sent. The runner says
ready only with its home open. A line longer than `maxLineLength` (64 Mi characters by default) closes a link.
`@earendil-works/pi-ai` is a peer dependency, `*` like every package Pi provides.
