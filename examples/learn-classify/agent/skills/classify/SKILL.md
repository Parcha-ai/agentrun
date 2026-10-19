---
name: classify
description: How to classify a company's industry by hand, and how to turn that into a workflow. Use it for every company.
---

# Classify by hand

1. Call sic2_groups once for the groups and their names.
2. Read the company's home page with fetch_page. When it does not say what the company sells or makes, read one page
   from its links that does (about, company, products, investors), or the company's article on en.wikipedia.org.
3. The group is the one of the company's main source of revenue, not of a side business or of its customers.
4. The evidence is one sentence from a page you read that shows that business, with the page's URL.

# Turn it into a workflow

The steps above map onto workflow nodes: a `call` of fetch_page on the input's website, an `escalate` when the page has
no text (the `empty` predicate on its text), a `call` of sic2_groups, a `pick` over the groups with the page's title and
text as its state (with `allowNone`, and an `escalate` when none fits), and an `extract` that writes
`{ sic2, evidence, url }` from the picked group and the page. Read describe's tool list for each tool's arguments and
result fields; do not invent them.

A dry run fills every tool result with placeholder values: text is filled in and every yes-or-no field is false. So an
`escalate` on a false field always fires in a dry run, and the dry run cannot pass; check the text instead.
