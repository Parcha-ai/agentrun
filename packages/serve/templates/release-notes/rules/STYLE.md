# Release notes style

The writer reads this file before every draft. Edit it like code: the owner's notes from learning are added to the
agent's learning and can be copied here once they hold.

## Who reads the notes

A user of the product deciding whether to upgrade and what changes for them. Not the team that wrote the code.

## A line in "What you can do now"

- Say what the user can do now, starting with the action or the thing: "Stream new lines as they arrive with
  `lantern tail --follow`." Not "Added a follow flag to the tail command."
- One change per line, one or two sentences. Say how to use it when the PR says: the command, flag, setting or page.
- Code, commands, flags, settings and file names in backticks, spelled exactly as the PR spells them.
- A number ("3 times faster", "half the memory") only when the PR states it, with what it was measured on if the PR says.
- No PR numbers, issue numbers, links or names.

## A line in "Fixed"

- `**<Group>:** ` then what the user saw go wrong, and that it no longer does: "**Search:** a log line that isn't valid
  UTF-8 no longer stops the search." Not "Fixed a bug in the decoder."

## A line in "Upgrading"

- What changed, then what to do: "`--out` is now `--output`; rename it in your scripts, since `--out` now fails." When
  there is nothing to do, say what a user or client will notice.
- Breaking changes first. One line per change.

## Words

- Plain, present tense, second person ("you"). Short sentences.
- No marketing: no "powerful", "seamless", "exciting", "robust", "we're thrilled", and no emoji.
- The product's own names for things, as its docs use them. When the owner's notes say a word ("say 'agent', not
  'bot'"), use it everywhere in the draft, the table included, and rewrite a PR title that uses the other word.
- The owner's `style` setting, when set, wins over this section.

## What stays out of the top sections

CI, build and release tooling, tests, refactors that change no behaviour, internal docs, formatting, and dependency bumps
with no effect a user sees. They still get a row in "Changes by pull request".

## Owner's notes

<!-- One note per line, from the owner's edits to past drafts, for example:
Say "agent", never "bot".
Leave CI and dependency bumps out of the table's summaries: "CI only" is enough. -->
