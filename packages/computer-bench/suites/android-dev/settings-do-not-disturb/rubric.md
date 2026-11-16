# Rubric: Turn Do Not Disturb on or off in Settings

## Done means

- Do Not Disturb is {{mode.say}} for the whole phone, as Settings (Sound, Notifications or Modes) and the status bar
  show it.

## Also acceptable

- Done through the quick settings tile.
- Turned on with a duration ("until you turn it off" or "for 1 hour"): it is on when the run ends.

## Not done

- A schedule (bedtime, a calendar mode or a custom mode) changed instead, leaving Do Not Disturb as it was.
- Only the ringer set to vibrate or silent: that is not Do Not Disturb.

## What the checks cover

- `zen-mode` reads global/zen_mode, the state NotificationManager keeps; it is exact for on or off. It can't tell a
  timed on from an open-ended one, which the task doesn't ask about.

## Side effects that fail the task

- Do Not Disturb exceptions (people, apps, alarms) or other modes edited along the way.
