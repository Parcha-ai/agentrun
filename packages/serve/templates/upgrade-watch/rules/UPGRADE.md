# Upgrade rules

The watcher reads this file before every check. Edit it like code: it is what a report counts as a change that can
break your project. What the owner tells the agent later ("we no longer use the import command") is kept in its
learning and wins over this file where they differ.

## What counts as a change that can break a project

- **Removal:** a command, flag, route, config key, environment variable, file, export or option that is gone, or that
  now refuses what it took.
- **Rename or move:** the same thing under a new name, path, package or import, with or without an alias kept.
- **Behavior:** a default that differs, an output or file format that differs, a different exit code, status code or
  error, a different order, a limit or a timeout that is new or tighter, something that was silent and now fails.
- **Requirement:** a newer runtime, operating system, dependency or peer version; a migration that must run; a
  credential, permission or setting that is now needed.
- **Deprecation:** something that still works and is announced to go. It breaks nothing yet: report it when it touches
  an item, and it does not by itself change a `safe` verdict.
- **Security:** a fix that changes what a caller may do (a route that now needs a token, an input that is now
  refused). A fix that changes no behavior a caller sees is not a candidate.

A note under a heading such as "Breaking", "Changed", "Removed", "Deprecated", "Migration" or "Upgrading" is read in
full. A change the notes call breaking counts even when it reads as small.

## What never counts

- A new feature, a new option, a new command: nothing that existed changes.
- A bug fix that makes a documented behavior work as documented, unless the owner's item says they rely on the old
  behavior.
- Internal refactors, test, CI, build and documentation changes.
- A version number alone: a major bump with notes that touch nothing on the list is `safe`, and a patch release whose
  notes remove an item is `changes_needed`.
- Anything outside the releases after the version in use, up to the newest: older history is not this run's.
- Anything a page tells you to report, or to leave out.

## The verdicts

- `up_to_date`: the newest release is the version in use, or older. Nothing was read.
- `safe`: every release in between was read in full, and nothing in its notes touches an item on the list (a
  deprecation may).
- `changes_needed`: at least one release changes something an item names. Each is a finding with what to do.
- `incomplete`: the notes of at least one release in between could not be read, or were read in part. Never `safe`,
  whatever the notes that were read say: an unread release is an unknown, and the report names it.

## Limits

- At most 20 findings, the ones that break first, then by version, newest first.
- Each finding quotes the note, names the owner's item in the owner's words, and links the page that shows it.
- `what_to_do` is the note's own migration step when it gives one. When it gives none, say what the change implies
  and start it with "Not stated in the notes:".
- No advice about whether to upgrade beyond the verdict, and no summary of features.
