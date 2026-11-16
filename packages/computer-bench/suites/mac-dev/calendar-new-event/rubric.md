# Rubric: Add a timed event for tomorrow to a given calendar

## Done means

- The calendar "computer-bench {{nonce}}" holds one event "{{title}} {{nonce}}", tomorrow, from {{slot.say}}.

## Also acceptable

- A location, notes or an alert added to the event.

## Not done

- The event in another calendar (such as the default one), even with the right title and time.
- The right time on another day, or an all-day event.
- AM and PM swapped, or the end time left at Calendar's default length when it differs from the asked one.
- A typo or other capitalisation in the title.
- Two events with the title.

## What the checks cover

- `one-event` counts the calendar's events with the title; it is exact.
- `when` reads the event's start and end over AppleScript and compares the day with today's date when the check runs,
  so a run that crosses midnight fails it; such a run is rare at this budget.

## Side effects that fail the task

- Any event of another calendar deleted or moved.
