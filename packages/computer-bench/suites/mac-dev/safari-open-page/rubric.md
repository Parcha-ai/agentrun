# Rubric: Find a named page on the IANA website

## Done means

- The front Safari window shows IANA's page for {{page.say}} ({{page.url}}).

## Also acceptable

- The page reached by typing its address, by clicking through the site, or from a search result.
- The page opened in a new tab or window, as long as it is the one in front.
- http instead of https, or the address without "www.".

## Not done

- A search results page, or another site's copy of the content.
- The page opened in a background tab while another tab is in front.
- A neighbouring IANA page (another registry or a parent index).

## What the checks cover

- `url` reads the front window's current tab over AppleScript and matches the page's path exactly; a query or fragment is
  allowed. It needs iana.org reachable from the Mac; a run where the site is down is an infra outcome, not the agent's.
