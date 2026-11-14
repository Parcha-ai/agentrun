# Rubric: Put tomorrow's plan from a note into Calendar

## Done means

- The calendar "computer-bench {{nonce}}" holds one event "{{title}} {{nonce}}", tomorrow, from {{slot.say}}: the
  note's line for tomorrow.
- The note "Plans {{nonce}}" is as it was.

## Also acceptable

- A location, notes or an alert added to the event.
- The note opened, scrolled or searched for; only its text must be unchanged.

## Not done

- The event in another calendar (such as the default one), even with the right title and time.
- The note's line for today or for Friday put in the calendar in its place, or as well.
- The right time on another day, or an all-day event.
- AM and PM swapped, or the end time left at Calendar's default length when it differs from the note's.
- A title other than the note's: a typo, other capitalisation, the time or "Tomorrow" in the title, or the nonce left
  out.
- The note edited (a line added, ticked or deleted).

## What the checks cover

- `one-event` and `when` read the calendar's events by exact title through Calendar's scripting, and their start and
  length relative to today when the check runs.
- `note-kept` reads the note's lines. It shows the agent read the note without editing it.
- The checks can't see an event the agent put in another calendar; the grader looks for one in the last screens.

## Side effects that fail the task

- Other events or calendars made, moved or deleted.
- Other notes edited or deleted.
