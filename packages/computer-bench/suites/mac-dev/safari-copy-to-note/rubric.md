# Rubric: Copy one value from a web page into a new note

## Done means

- One note titled "Order {{nonce}}" exists in Notes, and its second line is "{{customer.code}}", the order number of
  {{customer.name}} on the page.

## Also acceptable

- The number typed by hand instead of copied, if it is exact.
- Blank lines between or after the two lines.

## Not done

- Another customer's order number, or the total instead of the order number.
- The whole row or table pasted ("{{customer.name}} {{customer.code}} ...").
- The number without its "ORD-" prefix.
- Two notes with the title.

## What the checks cover

- `one-note` counts live notes with the title over AppleScript; it is exact.
- `lines` reads the note's plain text and drops empty lines; it is exact, so extra text on the line or another line
  fails.

## Side effects that fail the task

- Any other note deleted or changed.
