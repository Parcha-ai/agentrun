# Rubric: Move an event to another time the same day

## Done means

- The event "{{title}} {{nonce}}" in the calendar "computer-bench {{nonce}}" is the day after tomorrow from {{slot.say}},
  one hour long, and it is the only event with that title.

## Not done

- The event dragged to another day, or left at 10:00 AM.
- The start moved but the end left at 11:00 AM, so the length changed.
- A copy made at the new time while the 10:00 AM event stays.
- The event turned into an all-day event.

## What the checks cover

- `one-event` counts the calendar's events with the title; it is exact.
- `when` reads the start and end over AppleScript and compares the day with today's date when the check runs, so a run
  that crosses midnight fails it; such a run is rare at this budget.

## Side effects that fail the task

- Any event of another calendar deleted or moved.
