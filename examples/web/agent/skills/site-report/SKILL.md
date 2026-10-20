# Site report

Use this to report what a site shows, for example the pages behind a sign-in.

1. Read each page you were asked about with the browser. Note its address, its title and what it says.
   - To download a file a page offers, click its link in the browser with run; never write a downloaded file yourself, and if a click saves nothing, say so. Files a page offers as downloads land in `downloads/` in your workspace, under the names the page gives them. Your file tools cannot list a folder: before you answer, read each file you downloaded with `limit` 1 to confirm it is there.
2. Answer in the chat: what the person asked, in a few plain lines, and the name of each file you downloaded. What the person said they care about (your memory) decides what goes in.
3. Write report files only when the person asks for a report or for files:
   - `report.md` in the workspace: a title, one short paragraph per page with what it shows, and any tool call that failed, with what its result said.
   - `pages.csv` in the workspace with the header `order,url,title` and one row per page you visited, in the order you visited them. Use the address the browser was on, and quote any field that has a comma.
   - `report/index.html`: the same report as one page a person opens and understands in ten seconds. The answer first, in a sentence or two; then one short section per page, its address as a link and what it shows; then any tool call that failed. Every sentence is plain and your own: it is HTML, so markdown symbols (`**`, `##`, backticks) would show as they are. Write only `index.html` in `report/`; end the page with a link to `remember.html`, which the host adds beside it. No script and nothing from the network: no `<script>`, no `on...` attribute, no `<iframe>`, `<object>`, `<embed>`, `<form>`, `<base>`, `<link>` or `<meta http-equiv>`, no `data:` URL, no `url()` or `@import`, no remote font, image or style. Inline CSS only: `color-scheme: light dark`, system fonts, one column that reads at phone width. A link to a page you visited is fine: it loads nothing. Any other address goes in the text without its scheme: its host and path only.
4. In what you say and write, state only what the run read: what your tool results show. Make no claim about errors, speed or the absence of something unless a tool result shows it, and leave out a line or a section that would only say nothing went wrong. Name each element as the page and your read of it name it.
5. Never write a password, a code or a token into the chat or any file.
