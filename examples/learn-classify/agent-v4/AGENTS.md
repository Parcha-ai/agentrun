# Rules

## The job

- The input is a company's name, and its ticker and website when they are known. Find the company's latest annual
  report (a 10-K, or a 20-F or 40-F for a foreign filer), read it, and answer in six parts the way the SEC files them:
  - its 4-digit SIC code, one of sic_codes; sic2_groups names the 2-digit groups they fall in;
  - every reportable operating segment, named as the company reports it, with its share of total revenue from 0 to 1,
    from the report's segment table; a company that reports one segment says so;
  - its headquarters, the principal executive offices the report gives: the city, the state or province when there is
    one, and the country;
  - its operating subsidiaries as the company lists them (a 10-K's Exhibit 21, a 20-F's Exhibit 8), at most 15;
  - that annual report: its URL as you read it in this run, and the fiscal year it covers;
  - cites for the other five.
- Finish by calling answer once, with 1 to 12 cites. Each cite names what it supports (the code, a segment, the
  headquarters, a subsidiary or the report), the page or document it comes from as you read it in this run, where on it
  (a section, or "pdf p. N" for a page of a PDF), and the words it says, at most 300 characters. Cite the annual report
  by its pages.
- sec.gov and EDGAR are refused by every tool, and so are their mirrors and SIC listing sites: do not try them. Search
  with search_web, read pages with fetch_page or browse (browse runs a page's scripts), and read annual reports and other
  PDFs with read_document.

## Every run leaves the job cheaper

- When a part of the job repeats from company to company, write a workflow for that part and name it for what it does:
  finding the official site, reading the segment table, following a holding company to its operating business, sending
  a site that needs JavaScript to the browser. A workflow for the whole job, `classify-company`, runs the parts.
- When `<learned>` offers workflows, run them first with the agentrun tool: load one by name with this company's input,
  then run it.
  - When it completes, use what it returned and save nothing. Every clean run of the same revision counts toward
    trusting it, and a new revision starts that count again.
  - When it escalates or fails, do that part by hand. When you see what made it stop, fix that workflow under its own
    name: load it, change it, inspect it with this company's input, dry-run it, and save it under the same name.
- Write a new workflow only for a part that no offered workflow covers: call agentrun with describe, inspect the complete
  workflow with this company's input, dry-run it, and save it. Save only a workflow whose dry run passed, and never run
  a workflow you saved in this run: later runs try it.
- After a save, call learn with type workflow and the workflow's name as id. Its text says which inputs it fits, never
  what a page said.
- `classify-company` takes `{ "name", "ticker"?, "website"? }` and returns
  `{ "sic4", "segments", "hq", "subsidiaries", "annualReport", "cites" }`, the answer's own shape.
- Once workflows for parts are admitted (`<learned>` lists them), write `classify-company` from them: load each part
  and embed it as a `workflow` step, a complete inline child whose input comes from this job's input or earlier steps;
  cover the parts no workflow covers with call, extract or agent steps; return the answer's full shape. Inspect it with
  this company's input, dry-run it, and save it. A part takes this job's input or fields of it: a part whose input is
  something a run finds on the way (a document's URL) is never offered to a later run, so it cannot be embedded.
- When a part gets a new revision, write `classify-company` again with that revision embedded: a revised part does not
  reach `classify-company` until then.
- A workflow works for any company. Never put a company's name, domain, answer or a page's words in one. It reads with
  the tools above, decides with pick, judge or route, and hands anything unsure back with escalate.

## Notes

- When a line in `<learned>` helped, call learn with type used and its id. When this run shows a line in `<learned>` is
  wrong, call learn with type correction and the general rule. A filing convention you met (where the SEC files a kind
  of company) is a lesson worth noting, in general words.
- A note states a general rule, never this company's name, site or answer.
- Give learn an id only to name a learning listed in `<learned>` or a workflow you saved; a new note has no id.
