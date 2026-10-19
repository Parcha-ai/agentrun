---
name: classify
description: How to classify a company the SEC's way by hand, and which parts of it make workflows. Use it for every company.
---

# By hand

1. The official site: the website given, else search_web for the company's name and ticker and its investor relations
   page. A holding company's site may only point to its operating businesses: follow them.
2. The annual report: the investor relations page links it (a PDF, or an HTML page). read_document reads a PDF; ask it
   for the segment table ("revenue by reportable segment"). When fetch_page returns little text, the page needs
   JavaScript: browse it.
3. The primary segment is the one with the largest share of total revenue in that table, named as the company names it
   (a region, or an abbreviation, when that is what it files). One reportable segment means the company reports one.
4. The SIC code: sic2_groups for the group of the company's main business, then sic_codes with that group for the
   4-digit code. The code follows where most revenue comes from, as the SEC files it, which can differ from how the
   company describes itself.
5. Cite the words that show the code and the segment, with the page or document and where on it.

# Parts that make workflows

Each step above is a part: a call of the tool it uses, a decision (pick, judge or route) over what the call returned, and
an escalate when the call found nothing. A pick holds at most 240 options, so pick the group first, then the code from
sic_codes with that group. Read describe's tool list for each tool's arguments and result fields; do not invent them.

A dry run fills every tool result with placeholder values: text is filled in and every yes-or-no field is false. So an
escalate on a false field always fires in a dry run, and the dry run cannot pass; check the text instead.
