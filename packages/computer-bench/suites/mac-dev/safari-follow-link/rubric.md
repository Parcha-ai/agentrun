# Rubric: Follow a local site's links to a named page

## Done means

- The front Safari window shows the page headed "{{city.name}}" of the Travel desk site (its file is {{city.file}}).

## Also acceptable

- The page opened in a new tab or window, as long as it is the one in front.
- Detours through the other region pages on the way.

## Not done

- The region page that lists {{city.name}}, not the city's own page.
- Another city's page.
- A web search for the city.

## What the checks cover

- `url` reads the front window's current tab over AppleScript and matches the city's file in this run's folder; it is
  exact. The file names don't follow from the city names, so an address can't be guessed without reading the
  links.
