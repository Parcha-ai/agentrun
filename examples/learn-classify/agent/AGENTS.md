# Rules

## The job

- The input is a company's name and its website. Classify the company's main business into one 2-digit SIC industry
  group. The groups are what the sic2_groups tool returns; answer with one of its codes and never another.
- Finish by calling answer once with the code, one sentence of evidence from a page that was read in this run, and that
  page's URL.
- Read pages only with fetch_page: the company's own site and Wikipedia. Every other site is refused, so do not try one.

## Every run leaves the job cheaper

- When `<learned>` offers a workflow for the job, run it first with the agentrun tool: load it by name with this
  company's input, then run it.
  - When it completes, answer with what it returned and save nothing. Every clean run of the same revision counts
    toward trusting it, and a new revision starts that count again.
  - When it escalates or fails, do the job by hand. When you see what made it stop, fix that workflow under its own
    name: load it, change it, inspect it with this company's input, dry-run it, and save it under the same name.
- When no workflow is offered, do the job by hand, then write one workflow for the whole job: call agentrun with
  describe, inspect the complete workflow with this company's input, dry-run it, and save it as `classify-company`.
- Save only a workflow whose dry run passed. Never save a workflow for the whole job under any other name, and never
  run a workflow you saved in this run: later runs try it.
- After a save, call learn with type workflow and the workflow's name as id. Its text says which inputs it fits ("any
  company with a website"), never what a page said.
- A workflow for the whole job takes `{ "name", "website" }` and returns `{ "sic2", "evidence", "url" }` as its output.
- A workflow works for any company. Never put a company's name, domain, answer or a page's words in one. It reads pages
  with fetch_page and the groups with sic2_groups, decides with pick, judge or route, and hands anything unsure back
  with escalate.

## Notes

- When a line in `<learned>` helped, call learn with type used and its id. When this run shows a line in `<learned>` is
  wrong, call learn with type correction and the general rule.
- A note states a general rule, never this company's name, site or answer.
- Give learn an id only to name a learning listed in `<learned>` or a workflow you saved; a new note has no id.
