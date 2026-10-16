---
packages: @parcha/pi-git-remote
kind: feature
---
New held package `@parcha/pi-git-remote`: a git repository a host keeps for its agent. `openRepo({ dir, remote })` opens
the host's own bare repository and keeps it in step with a remote (`local(path)`, a bare repository on this machine, in
this release; the `Remote` object takes an https URL, a push URL and a credential callback). `commitTo` builds one commit
through plumbing on a temporary index and is idempotent by a `Run-Id` trailer found here or on the remote, so a restarted
host commits nothing twice; `push` sends a commit by sha and is never forced; `merge` and `revert` use `git merge-tree`
and change nothing on a conflict; `checkout` copies regular files only, never executable; `read`, `list`, `resolve` and
`log` read. No hook, filter, merge driver, fsmonitor or credential helper of either repository runs, an https credential
reaches git only on file descriptor 3 (never argv, the environment, a URL or a file), and a URL with userinfo is refused.
A `.git` segment in any spelling, `..`, symlinks, submodules, case collisions and files over the caps are refused or
skipped and named. Every failure is a `GitRemoteError` with a `code`. Needs git 2.40 or later.
`branches(prefix)` lists the branches under a prefix (`runs/`), here and on the remote, at the commit `resolve` gives;
`commitTo(branch, { allowEmpty: true })` makes a commit that changes no file, for a commit whose message and trailers are
the record.
