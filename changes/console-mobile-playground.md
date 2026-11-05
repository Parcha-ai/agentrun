---
packages: repo
kind: fix
---
The console on a phone. On a narrow portrait screen the Agents search box shows its magnifier without the placeholder (only its first letter fitted); landscape and desktop keep it. The Playground's Agent and Revision fields are a picker that opens its list right under the field (Headless UI's Listbox, `@headlessui/react` 2.2.10), in place of native selects, which a phone opened detached from the field. In a short viewport (a phone in landscape) the Playground's code and response panel folds behind Show code so the form gets the height; the agent header stays put and Send request sits in its own row. Sending opens the panel so the response shows.
