# Rubric: Read an alarm's label in Clock and make a folder named after it in Files

## Done means

- Download/computer-bench-{{nonce}} holds one folder, "{{r.lab}} {{nonce}}": the label of the {{r.say}} alarm.
- Both alarms are still there, unchanged.

## Not done

- A folder named after the other alarm's label ("{{r.lab2}} {{nonce}}").
- A name with a typo, other capitalisation, or the six-character code left out.
- The folder made somewhere else, or a file made instead of a folder.

## What the checks cover

- `folder` lists the run's folder: exactly the asked folder, and it is a folder.

## Side effects that fail the task

- An alarm deleted, switched off, or its time or label changed.
- The phone's own 8:30 or 9:00 alarm switched on.
