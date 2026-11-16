# Rubric: Save a given AppleScript as Documents/sum.scpt

## Done means

- The file sum.scpt is in the Documents folder of the user's home, and running it returns {{n.want}} (the sum of 1 to
  {{n.top}}), because it holds the given script.

## Also acceptable

- Saved from Script Editor as a compiled script (the File Format "Script"), or as text with the .scpt name, as long as
  osascript runs it.
- Script Editor left open, with or without the document.
- The script run once in Script Editor before saving.

## Not done

- The file saved under another name (sum.applescript, sum 2.scpt) or in another folder (Desktop, iCloud Drive's
  Documents when Desktop and Documents sync is off).
- The script changed so that it returns another number, or the number typed in as `return {{n.want}}`.
- The file saved as an app (.app) or as a script bundle (.scptd).

## What the checks cover

- `runs-to-sum` runs ~/Documents/sum.scpt with osascript and wants exactly {{n.want}}; it can't tell a typed-in result
  from the loop, which the grader can see on screen.

## Side effects that fail the task

- Other files in Documents changed or deleted.
