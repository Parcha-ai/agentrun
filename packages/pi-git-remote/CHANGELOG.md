# Changelog

## [Unreleased]

## 0.1.0-beta.23 (2026-10-22)

- The README's pi install line for the coding-agent session pins `@earendil-works/pi-coding-agent@1.3.0`, because pi 1.4 is not supported yet.

## 0.1.0-beta.22 (2026-10-21)

First release of `@parcha/pi-git-remote`, versioned with the other packages of the repository it is published from.

- `https(url, credential, { pushUrl? })` and `codeStorage({ origin, repo, token, hidden? })` make the remotes a host needs beyond `local`. `https` takes any https git host and a credential callback asked once for each git process, so a short-lived token is minted fresh each time; a URL with userinfo, a query or a fragment is refused before any git process starts. `codeStorage` builds `<origin>/<repo>.git` from a host-supplied origin (there is no default hostname) and sends the JWT `token()` returns as the Basic password of user `t`, over plain git with no SDK; with `hidden: true`, pushes go to `<repo>+ephemeral.git`, a namespace a normal clone does not see, while reads fetch `<repo>.git`. The tests run a TLS smart-HTTP server over `git http-backend` that requires the generated token and refuses `main` for the run's identity in a pre-receive hook: the token stays in the fd-3 file (never argv, the environment, a URL or a file), and a refused push is a `refused` error whose message holds `[credential]` where a server's reason repeats the token.
- New package `@parcha/pi-git-remote`: a git repository a host keeps for its agent. `openRepo({ dir, remote })` opens
  the host's own bare repository and keeps it in step with a remote (`local(path)`, a bare repository on this machine, in
  this release; the `Remote` object takes an https URL, a push URL and a credential callback). `commitTo` builds one commit
  through plumbing on a temporary index and is idempotent by a `Run-Id` trailer found here or on the remote, so a restarted
  host commits nothing twice; `push` sends a commit by sha and is never forced; `merge` and `revert` use `git merge-tree`
  and change nothing on a conflict; `checkout` copies regular files only, never executable; `read`, `list`, `resolve` and
  `log` read. No hook, filter, merge driver, fsmonitor or credential helper of either repository runs, an https credential
  reaches git only on file descriptor 3 (never argv, the environment, a URL or a file), and a URL with userinfo is refused.
  A `.git` segment in any spelling, `..`, symlinks, submodules, case collisions and files over the caps are refused or
  skipped and named. Every failure is a `GitRemoteError` with a `code`. Needs git 2.40 or later.

  The package is also a pi package: its `./coding-agent` subpath, `createGitRemoteExtension`, is a pi coding-agent extension
  that gives a session a repository it commits to at the end, with the host holding git and the model getting no tool. On
  `session_start` it checks a ref out into a directory outside the session's working directory with no `.git` in it, and pi loads
  the repository's `.agents/skills` (through `resources_discover`) and its `AGENTS.md` (through `before_agent_start`, as the seeded
  commit has it). On `session_shutdown` it commits the changes an allowlist of globs names to `sessions/{sessionId}`, built on the
  seeded commit with `Session-Id` and `Seeded-From` trailers, and pushes by sha; it never pushes `main`, refuses the whole end for a
  symlink or anything the package's limits refuse, compares the directory with what it held at the last save, and commits nothing
  the second time. Options, `--git-remote`, `--git-ref`,
  `--git-allow`, `--git-branch` and `--git-checkout-dir`, or the `gitRemote` key of pi's settings configure it.
- `branches(prefix)` lists the branches under a prefix (`runs/`), here and on the remote, at the commit `resolve` gives;
  `commitTo(branch, { allowEmpty: true })` makes a commit that changes no file, for a commit whose message and trailers are
  the record.
- The hostile-corpus control for `limit-git-config-filter` triggers the planted clean filter with `git add --renormalize`, so it no longer depends on whether the freshly cloned file is racily clean; it failed a required check on a slow runner.
- The hostile-corpus control for `attr-filter-operator-driver` triggers the operator's clean filter with `git add --renormalize`, as `limit-git-config-filter` already does: a plain `add` skips the clean filter when the clone left the file stat-clean, so the case failed a required check on a slow runner. Both filter cases now share that trigger and run from the stat-clean state (the index newer than the file), so a trigger that depends on timing fails every time instead of now and then.
- A git that times out, or fails in any other way, while the repository asks whether a commit exists or whether one commit is an ancestor of another is now a `git` error. It is no longer read as "no". Read as "no", a `merge-base` that timed out while `commitTo` picked a branch's tip made the remote's tip win over a local commit not yet pushed. The write then built on the remote's tip and moved the branch off the local commit, so that commit was lost. Exit 1 stays the only "no". A `rev-parse` that timed out reads as a git failure too, not as a missing ref.
- The README's coding-agent walkthrough says what it needs before it starts (pi on the `PATH`, and a model, given one of three ways: `/login`, a provider key in the environment, or `~/.pi/agent/models.json`; without one pi stops at "No API key found for the selected model"), seeds the example repository with its own commit identity, so it works where git has no identity configured and cannot guess one, and runs pi once with `-p`, so the session's commit is on its branch when the command returns; the interactive way is one sentence below it.
