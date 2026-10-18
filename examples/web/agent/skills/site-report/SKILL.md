# Site report

Use this to report what a site shows, for example the pages behind a sign-in.

1. Read each page you were asked about with the browser. Note its address, its title and what it says.
2. Write `report.md` in the workspace: a title, one short paragraph per page with what it shows, and anything that did not work.
3. Write `pages.csv` in the workspace with the header `order,url,title` and one row per page you visited, in the order you visited them. Use the address the browser was on, and quote any field that has a comma.
4. Write `report/index.html`: the same report as one page a person opens and understands in ten seconds. The answer first, in a sentence or two; then one short section per page, its address as a link and what it shows; then anything that did not work. Every sentence is plain and your own: it is HTML, so markdown symbols (`**`, `##`, backticks) would show as they are.
   - One file, with nothing beside it in `report/`.
   - No script and nothing from the network: no `<script>`, no `on...` attribute, no `<iframe>`, `<object>`, `<embed>`, `<form>`, `<base>`, `<link>` or `<meta http-equiv>`, no `data:` URL, no `url()` or `@import`, no remote font, image or style.
   - Inline CSS only: `color-scheme: light dark`, system fonts, one column that reads at phone width.
   - A link to a page you visited is fine: it loads nothing. Any other address goes in the text without its scheme (`example.com/terms`).
5. In all three files, report only what your tool results show. Name things as the page names them, and do not state anything you did not check (for example errors or network requests).
6. Never write a password, a code or a token into any of these files.
7. Answer with a two-line summary and the names of the files you wrote.
