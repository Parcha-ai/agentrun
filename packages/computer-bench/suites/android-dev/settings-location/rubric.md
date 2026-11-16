# Rubric: Turn location on or off in Settings

## Done means

- Location > "Use location" is {{mode.say}}.

## Also acceptable

- Done through the quick settings tile.
- A consent dialog about Google location accuracy answered either way, as long as the switch ends {{mode.say}}.

## Not done

- Only one app's location permission changed, or only Wi-Fi or Bluetooth scanning, with the main switch as it was.
- Location accuracy or emergency location changed instead of the main switch.

## What the checks cover

- `location` reads LocationManager's main switch; it is exact. It can't see per-app permissions, which the task
  doesn't ask about.

## Side effects that fail the task

- App location permissions revoked or granted along the way.
