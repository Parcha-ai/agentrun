---
packages: @parcha/agentrun-computer, @parcha/agentrun-serve
kind: feature
---
A Linux box with no display pairs with `computerd pair` as a sandbox, and in Mode 2 holds a run's folder as a synced folder in its `/workspace`: serve pushes the folder in at the claim, syncs each change back before the call that made it answers and once more at release, all through the claim's epoch fence, and the next run on the box finds its folder. Its network is `open`; any other is refused. Mode 1 runs a sandbox only on Docker, as before.
- `/workspace` is a directory of computerd's user's own, mode 0700, never a link, made once as root with the tmpfiles.d line in spec/computer/attach.md (`d /workspace 0700 <user> <user> -`). A claim refuses a box whose `/workspace` is missing, a link, not a directory, another user's or open to others, in words naming that fix, and lets the box go. Each claim first ends every program an earlier run left running there and empties it of that run's files.
- The synced folder writes only under `/workspace` and never through a link: init extracts the push opening each name `O_NOFOLLOW`.
- `attachedProvider` gives a Linux box daemon `child`, `mount: ["sync"]` and no vendor agent ports, and reads its folder back as `{ kind: "sync", epoch }`.
- A desktop or a phone named as a sandbox computer is refused saying only a Linux box paired with no display can be one.
