# Rubric: Set the Music app's own volume to a given level

## Done means

- The volume slider of the Music app (in its player bar, or Controls › Volume) sits at {{vol.want}}%, give or take 4.

## Also acceptable

- Set by dragging the slider, by the Controls menu or its keys, or any mix of them.
- Music playing or not.

## Not done

- The Mac's output volume (menu bar, Control Center, volume keys) changed instead, with Music's own slider left at 100.
- A level more than 4 away from {{vol.want}}.

## What the checks cover

- `volume` reads Music's sound volume over AppleScript, which is the app's own slider, 0 to 100; it is exact and can't
  see the Mac's output volume, which the task doesn't ask about.

## Side effects that fail the task

- The Mac's output volume or mute changed.
- The library changed (songs or playlists added, deleted or edited).
