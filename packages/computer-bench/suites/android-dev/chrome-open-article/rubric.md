# Rubric: Open a Wikipedia article in Chrome

## Done means

- Chrome's current tab shows the English Wikipedia article "{{topic.title}}" (en.wikipedia.org or
  en.m.wikipedia.org).

## Also acceptable

- Reached through a search engine, Wikipedia's own search, or a typed address.
- Scrolled anywhere in the article.

## Not done

- A search results page, a Wikipedia search page or a disambiguation page left showing.
- The article in another language, or another article (a film or a namesake).
- The article opened in some tab that isn't the current one.

## What the checks cover

- `heading` finds the article title in Chrome's accessibility tree; `on-wikipedia` finds wikipedia.org in the address
  bar. Together they are strong but not exact: they can't tell the English edition from another with the same title
  text; the grader reads the address in the last screenshot.

## Side effects that fail the task

- Signing in, changing Chrome settings, or closing tabs other than the bench's.
