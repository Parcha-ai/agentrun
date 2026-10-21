---
name: classify
description: How to do the six-part job by hand from the company's annual report, and which parts of it make workflows. Use it for every company.
---

# By hand

1. The official site: the website given, else search_web for the company's name and ticker and its investor relations
   page. A holding company's site may only point to its operating businesses: follow them. When fetch_page returns
   little text, the page needs JavaScript: browse it.
2. The annual report: the latest 10-K, or 20-F or 40-F for a foreign filer, linked from the investor relations page (a
   PDF, or an HTML page). Read it with read_document: `find` names words to look for and lists the pages that hold
   them, `pages` reads those pages. What it returns is marked by page, and those pages are what you cite ("pdf p. N").
   The cover page gives the fiscal year and the address of the principal executive offices.
3. The segments: the segment note of the financial statements (often "segment information"), revenue by reportable
   segment. Once `find` has located it, look at that page: read_document with `pages: [N]` and `question: "the segment
   revenue table as laid out"`, and take the segments from that look (cite it as "pdf p. N"). Tables lose their layout
   as text; the look keeps it. Give every reportable segment, named as the company names it (a region, or an
   abbreviation, when that is what it files), with its share of total revenue: its revenue over the total, leaving out
   eliminations and corporate lines. One reportable segment means the company reports one.
   A page that comes back with no text (a scan or a chart) is not skipped: look at it with a question the same way.
4. The headquarters: the city, the state or province, and the country of the principal executive offices. A foreign
   filer's are often abroad even when it lists in the US.
5. The subsidiaries: the exhibit that lists them, Exhibit 21 of a 10-K or Exhibit 8 of a 20-F. It may be part of the
   report's PDF, near its end, or its own document linked from the report or the investor relations page. Give up to
   15 of the operating ones, named as listed. When the report, read through its exhibit index and its notes, has no
   such exhibit or list, answer `{ "none": true, "note": "<why>" }`; never guess names.
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
7. Cite the words that show each part, with the page or document and where on it.

# Parts that make workflows

Each step above is a part: a call of the tool it uses, a decision over what the call returned, and an escalate when the
call found nothing. Read describe's tool list for each tool's arguments and result fields; do not invent them.

The decision node follows what the decision needs. A choice decidable from evidence already in the state is a Jev pick,
judge or route. A choice that needs knowledge the state does not hold, such as what a company does, is one narrow agent
step on the host's node model. The 4-digit SIC code is such a choice: a pick sees only the words it is handed and
matches a product phrase, losing the company's role. Give that step the company's name from the job's input, and its
main business, its reportable segments with their shares and its largest revenue line as the report states them, with
sic2_groups and sic_codes as its tools; it reads the groups, then the codes of the group that fits, and returns one code
from sic_codes, the one whose SEC title names the company's role and product (step 6), read beside the largest SEC
filers each code names. Keep Jev on what the state can show: a judge that the revenue line the code rests on is quoted
from the report the run read, escalating when it is not.

A dry run fills every tool result with placeholder values: text is filled in and every yes-or-no field is false. So an
escalate on a false field always fires in a dry run, and the dry run cannot pass; check the text instead.
