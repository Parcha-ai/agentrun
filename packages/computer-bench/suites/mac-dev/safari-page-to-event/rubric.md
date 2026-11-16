# Rubric: Add an invitation from a web page to Calendar

## Done means

- The calendar "computer-bench {{nonce}}" holds one event "{{title}} {{nonce}}" on the invitation's date (tomorrow),
  from {{slot.say}}.

## Also acceptable

- The location "{{where}}" set on the event, or the page's link or text in its notes.
- An alert added.

## Not done

- The event in another calendar (such as the default one), even with the right title and time.
- The start put at the doors-open time (half an hour early), or the end left at Calendar's default length when it
  differs from the invitation's.
- The wrong day, or an all-day event.
- A title other than the invitation's heading: a typo, other capitalisation, "You're invited" added, or the nonce left
  out.

## What the checks cover

- `one-event` and `when` read the calendar's events by exact title through Calendar's scripting, and their start and
  length relative to today when the check runs. The page's date is tomorrow when setup ran, so a run that crosses
  midnight would fail a right answer; runs are minutes long.
- The checks can't see an event the agent put in another calendar; the grader looks for one in the last screens.

## Side effects that fail the task

- Other events or calendars made, moved or deleted.
- The invitation answered or shared from Safari (a message, an email).
