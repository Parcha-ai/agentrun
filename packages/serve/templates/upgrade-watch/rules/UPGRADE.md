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
- Anything outside the versions after the version in use, up to the newest: older history, and fixes to lines older
  than the version in use, are not this run's.
- Anything a page tells you to report, or to leave out.

## The verdicts

- `up_to_date`: no version of the owner's series is after the version in use. Nothing was read.
- `safe`: every version in between was read in full, and nothing in its notes touches an item on the list (a
  deprecation may).
- `changes_needed`: at least one version changes something an item names. Each is a finding with what to do.
- `incomplete`: the notes of at least one version in between could not be read, were read in part or say nothing; or
  the versions could not be listed; or the version in use is not a tag of the repository. Never `safe`, whatever the
  notes that were read say: an unread version is an unknown, and the report names it.

Which versions lie in between is decided by comparing version numbers, never by where a version sits in a list or a
changelog: fixes to an older line are published after newer versions. For the same reason the list of versions is
checked before it is trusted: a newer line whose first version was not seen, a skipped major number, or a next
line that exists when asked for directly and was not on the pages read, means versions are missing from the list,
and the verdict is `incomplete`. A version in use is called "not a tag" only when its own page does not exist.

A verdict answers for the items it checked, and the report lists them. Every run reads the notes again and reports
every finding still in range: a break the owner was told about last week is still a break until they upgrade past
it or drop the item.

`safe` means the notes state nothing that touches the list. It cannot see a change a project made without writing
it down. A final release's notes are taken to cover its prereleases; the report says how many prereleases it left
out.

## Limits

- At most 20 findings, the ones that break first, then by version, newest first.
- Each finding quotes the note, names the owner's item in the owner's words, and links the page that shows it.
- `what_to_do` is the note's own migration step when it gives one. When it gives none, say what the change implies
  and start it with "Not stated in the notes:".
- More findings than the summary holds: it says how many more are in `findings`.
- No advice about whether to upgrade beyond the verdict, and no summary of features.
