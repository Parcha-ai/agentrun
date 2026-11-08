---
packages: repo
kind: fix
---
On a phone, the runs list no longer scrolls sideways: a run's cell takes the room the table leaves it, so a long title or schedule chip wraps or truncates. A run a trigger started is labelled by its kind ("Schedule: nightly", "Webhook: inbound-leads"), and only a schedule links to its page. A run whose trigger was deleted since says so ("Schedule deleted", or "Trigger deleted" where its kind isn't known) and links nowhere, where it linked to a page that no longer exists.
