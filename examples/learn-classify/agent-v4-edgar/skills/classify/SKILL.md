---
name: classify
description: How to do the six-part job by hand from the company's annual report, and which parts of it make workflows. Use it for every company.
---

# By hand

Sources and evidence, for every part:
- Sources: any public page, the company's own site and reports, and SEC EDGAR pages as the Wayback Machine archived
  them (https://web.archive.org/web/<time>/<sec.gov URL>). sec.gov itself, its mirrors and SIC listing sites are
  refused by every tool. Search with search_web, read pages with fetch_page or browse (browse runs a page's scripts),
  and read annual reports and other PDFs with read_document.
- Look at the annual report's cover page and the page of its segment table with read_document `{ pages: [N],
  question }` (a vision model looks at the page), and cite the segments, the headquarters and the fiscal year from
  those looks ("pdf p. N"). A table read only as text loses its layout. The cover is the filing's own cover page, the
  earliest of its first pages that carries the form's header and the registrant's name and address.
- The code is chosen or read, not remembered. A code you remember is a guess, never evidence: when a remembered code
  and the revenue reading disagree, the revenue reading wins. The code's cite is the page, read in this run, that it
  rests on.

1. The official site: the website given, else search_web for the company's name and ticker and its investor relations
   page. A holding company's site may only point to its operating businesses: follow them. When fetch_page returns
   little text, the page needs JavaScript: browse it.
2. The annual report: the latest 10-K, or 20-F or 40-F for a foreign filer, linked from the investor relations page (a
   PDF, or an HTML page). Read it with read_document: `find` names words to look for and lists the pages that hold them,
   `pages` reads those pages. What it returns is marked by page, and those pages are what you cite ("pdf p. N"). The
   cover is the filing's own cover page, among its first pages: the page with the form's header (Form 10-K, 20-F or
   40-F, or the annual report's title page) and the registrant's name and address block. Read the first pages (`pages:
   [1, 2, 3, 4, 5]`), take the earliest page that is the cover, and take the fiscal year and the headquarters statement
   from it; a site's copy or a designed report can put pages before it, and words are only a hint (for example
   "principal executive office" or the form's name). When none of the first pages is the cover, the document is not the
   filing: find the filing itself.
3. The segments: the segment note of the financial statements (often "segment information"), revenue by reportable
   segment. Once `find` has located it, look at that page: read_document with `pages: [N]` and `question: "the segment
   revenue table as laid out"`, and take the segments from that look (cite it as "pdf p. N"). Tables lose their layout
   as text; the look keeps it. Give every reportable segment, named as the company names it (a region, or an
   abbreviation, when that is what it files), with its share of total revenue: its revenue over the total, leaving out
   eliminations and corporate lines. One reportable segment means the company reports one.
   A page that comes back with no text (a scan or a chart) is not skipped: look at it with a question the same way.
4. The headquarters: the city, the state or province, and the country of the principal executive offices. A foreign
   filer's are often abroad even when it lists in the US. The headquarters are the registrant's own statement of its
   principal or head office: its cover, else the report's body before the exhibits; never an address from an exhibit, a
   letter or a subsidiary. Words are only a hint: for example, `find: "principal executive office"`, and take the
   earliest hit. Quote the line you took them from.
5. The subsidiaries: the exhibit that lists them, Exhibit 21 of a 10-K or Exhibit 8 of a 20-F. It may be part of the
   report's PDF, near its end, or its own document linked from the report or the investor relations page. Give up to 15
   of the operating ones, named as listed. When the report, read through its exhibit index and its notes, has no such
   exhibit or list, answer `{ "none": true, "note": "<why>" }`, the note a short reason of at most 300 characters; never
   guess names.
6. The SIC code: sic2_groups for the group of the company's main business, then sic_codes with that group for the
   4-digit code. The code follows where most revenue comes from, as the SEC files it, which can differ from how the
   company describes itself: the segment table shows where that is. When the reportable segments are regions, read the
   revenue split by product or service line (the revenue disaggregation note) for where most revenue comes from. Name
   the company's role in that business as well as its product: it makes it, resells or distributes it, sells it at
   retail, provides it as a service, transports it, or owns or operates the property. The code's SEC title names the
   same role: a title that names only a product is its maker's, RETAIL- a retailer's, WHOLESALE- a distributor's,
   SERVICES- a service provider's. A real estate investment trust is filed under 6798 REAL ESTATE INVESTMENT TRUSTS,
   whatever property it owns. Each group and code names the largest SEC filers under it: they show how the SEC uses the
   code, so between two codes that both fit, the one whose filers do the same business is the SEC's. Cite that revenue
   table for the code.
7. Cite the words that show each part, with the page or document and where on it. Each quote a step returns is at most
   300 characters: cut it to the line that carries the fact (a table's row, not the table).

# Parts that make workflows

Each step above is a part: a call of the tool it uses, a decision over what the call returned, and an escalate when the
call found nothing. Read describe's tool list for each tool's arguments and result fields; do not invent them. Narrow
before a pick: a pick takes at most 240 candidates (for example, the major group before its 4-digit codes). The part
that reads the cover reads the report's first pages, and a Jev judge checks the page: is this page the registrant's
cover? It takes the earliest page that is, and escalates "no cover found" when none is. The part that reads the
headquarters returns the registrant's own statement with its quote, and a Jev judge checks that the quote states this
registrant's principal or head office, not an exhibit's, a letter's or a subsidiary's address; when no quote passes, it
escalates "no HQ found", and it never passes an empty headquarters on, which the answer refuses. In a workflow, every
quote field an extract or agent step returns declares `maxLength: 300` in its out schema, so the cap holds at the node
that makes the quote; the answer refuses a longer cite.

The decision node follows what the decision needs. A choice that needs knowledge the state does not hold (for example,
what a company does) is one narrow agent step on the host's node model; a choice decidable from evidence already in the
state is a Jev pick, judge or route. Decide per workflow. For example, the 4-digit SIC code: a pick sees only the words
it is handed and matches a product phrase, losing the company's role, so an agent step can choose it better. Give that
step the company's name from the job's input, and its main business, its reportable segments with their shares and its
largest revenue line as the report states them, with sic2_groups and sic_codes as its tools; it reads the groups, then
the codes of the group that fits, and returns one code from sic_codes, the one whose SEC title names the company's role
and product (step 6), read beside the largest SEC filers each code names. After such an agent choice, keep Jev on what
the state can show: a judge that the revenue line the code rests on is quoted from the report the run read, escalating
when it is not. Do not ask a Jev judge whether a code fits a business; that needs knowledge the state does not hold. A
Jev check after an agent choice tests evidence only (the cited line is quoted from the report).

A dry run fills every tool result with placeholder values: text is filled in and every yes-or-no field is false. So an
escalate on a false field always fires in a dry run, and the dry run cannot pass; check the text instead.
