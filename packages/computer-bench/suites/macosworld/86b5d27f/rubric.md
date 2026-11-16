# Rubric: Write a one-line AppleScript that gets the frontmost app's name

## Done means

- Script Editor's front document holds one line of AppleScript that, when run, gives the name of the app in front
  (such as `tell application "System Events" to get name of first application process whose frontmost is true`).
- The script was not run by the agent.

## Also acceptable

- Any working one-liner: `name of (info for (path to frontmost application))`, a `whose frontmost is true` query on
  processes, and so on.
- The document compiled (formatted by Script Editor) or not, saved or not.

## Not done

- A `tell` block over several lines, or several statements on several lines.
- A script that gives the app's path, bundle id or process id instead of its name.
- The agent ran the script (Run button or Command-R): the checks can't see this, so the grader looks at the agent's
  steps.
- The script written in another document than the front one, or in another app.

## What the checks cover

- `returns-name` runs the front document's text with osascript while Script Editor is in front, as the source did, and
  wants "Script Editor" (or "Script Editor.app"). It runs code the agent wrote, as the logged-in user the agent already
  controls.
- `one-line` counts the document's non-blank lines.
- Neither can see whether the script was run.

## Side effects that fail the task

- Script Editor's settings changed (default language, editing options).
