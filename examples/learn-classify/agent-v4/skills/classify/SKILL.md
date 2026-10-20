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
   15 of the operating ones, named as listed.
6. The SIC code: sic2_groups for the group of the company's main business, then sic_codes with that group for the
   4-digit code. The code follows where most revenue comes from, as the SEC files it, which can differ from how the
   company describes itself: the segment table shows where that is.
7. Cite the words that show each part, with the page or document and where on it.

# Parts that make workflows

Each step above is a part: a call of the tool it uses, a decision (pick, judge or route) over what the call returned, and
an escalate when the call found nothing. A pick holds at most 240 options, so pick the group first, then the code from
sic_codes with that group. Read describe's tool list for each tool's arguments and result fields; do not invent them.

A dry run fills every tool result with placeholder values: text is filled in and every yes-or-no field is false. So an
escalate on a false field always fires in a dry run, and the dry run cannot pass; check the text instead.
