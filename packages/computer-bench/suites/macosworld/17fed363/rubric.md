# Rubric: Set notification previews to Never in System Settings

## Done means

- System Settings › Notifications › Show Previews reads Never, for all notifications.

## Also acceptable

- System Settings left open on any page, or closed.

## Not done

- Previews turned off for one app only (in that app's notification settings), with the general setting unchanged.
- Show Previews set to When Unlocked or Always.
- Notifications turned off for apps instead of their previews.

## What the checks cover

- `previews-never` reads com.apple.ncprefs content_visibility, the value the general Show Previews menu saves; it is
  exact for that menu and can't see per-app preview settings. The source ran on macOS 15; that macOS 26 saves the menu
  under the same key and value is proven only once a person sets it by hand on the bench Mac and the check passes.

## Side effects that fail the task

- Other notification settings changed (an app's notifications turned off, Focus or Do Not Disturb turned on).
