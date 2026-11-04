---
packages: repo
kind: fix
---
A link in a run's answer no longer takes the console's tab away. A relative link that names one of the run's files (an agent that wrote `hello.md` and answered with `[hello.md](hello.md)`) opens that file in the run's file viewer, and a Markdown file in the viewer opens the run files it links, read from its own folder. Any other link with no scheme (a path that names no run file, a path from the root, a fragment, `//host`) reads as its text: before, the browser followed it against the console's address, onto the server's JSON 404 or, for a fragment, onto another console page. A link to a page (`http:`, `https:`) opens in a new tab with `rel="noopener noreferrer"`; before, it replaced the console. The same holds wherever the console renders Markdown: a learning note, the agent editor's preview. A `mailto:` or `tel:` link is unchanged.
