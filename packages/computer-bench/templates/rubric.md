# Rubric: <task title>

<!--
A rubric tells the grader what success means for this task, in a few short lines. It is read by the grader together
with the task's instruction, the check outputs, the agent's last steps, the last 3 screenshots and the app's tree.
The grader's general rules (how to weigh evidence, the failure loci, the output format) live in the grader prompt and
are never repeated here. Write only what is specific to this task. Delete every comment before you commit.
-->

## Done means

<!-- The end state, as someone looking at the computer would see it. One to four bullets. Name exact values with their
     {{param}} placeholders; the runner fills them in before the grader reads them. -->
- The note "{{title}} {{nonce}}" exists in Notes, and its second line reads "{{line}}".

## Also acceptable

<!-- Outcomes that look different but meet the instruction. Leave the section out when there are none. -->
- Extra blank lines after the second line.
- The note in any folder of the account.

## Not done

<!-- Near misses that must fail, so the grader doesn't round them up. -->
- The title or the line typed with a different word, a typo, or other capitalisation.
- Two notes with the title (the agent made it twice).
- The text left in the editor without a note being saved: Notes saves as you type, so a note that is not in the list
  is not done.

## What the checks cover

<!-- Which part of "done" the structural checks prove, and what they can't see. The grader uses this to decide how far
     to trust a check that disagrees with the screen. -->
- `one-note` counts notes with the title over AppleScript; it is exact.
- `body-line` reads the note's plain text; it can't see formatting, which the task doesn't ask about.

## Side effects that fail the task

<!-- Damage outside the goal: deleting or changing other data, leaving a dialog open that blocks the app, sending
     anything outside the computer. Leave the section out when nothing specific applies. -->
- Any other note deleted or changed.
