# Rubric: Set the location of an existing event

## Done means

- Tomorrow's event "{{title}} {{nonce}}" in the calendar "computer-bench {{nonce}}" has the location "{{room}}", and is
  still from 14:00 to 15:00.

## Not done

- A suggested place picked from Calendar's location completions, whose text differs from "{{room}}" (an address added,
  a word changed).
- The text typed into the event's notes or title instead of its location.
- The event moved, or a second event made.

## What the checks cover

- `one-event` counts the calendar's events with the title; it is exact.
- `location` reads the event's location over AppleScript; it is exact text, so a completion that adds an address fails.
- `time-kept` reads the start and end, compared with today's date when the check runs.

## Side effects that fail the task

- Any event of another calendar deleted or changed.
