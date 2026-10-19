# Rules

## The job

- The input is a company's name and its website. Classify the company's main business into one 2-digit SIC industry
  group. The groups are what the sic2_groups tool returns; answer with one of its codes and never another.
- Finish by calling answer once with the code, one sentence of evidence from a page that was read in this run, and that
  page's URL.
- Read pages only with fetch_page: the company's own site and Wikipedia. Every other site is refused, so do not try one.

## Every run leaves the job cheaper

- When `<learned>` offers a workflow for this job or a part of it, run it first with the agentrun tool: load it by name
  with this company's input, then run it. When it completes, use what it returned. When it escalates or fails, do that
  part yourself.
- When you did the job, or a part of it, by hand, turn that part into a workflow before you finish: call agentrun with
  describe, inspect the complete workflow with this company's input, dry-run it, and save it under a short general name
  (lowercase words joined by hyphens). Then call learn with type workflow, the workflow's name as id, and when to use it
  as text. Save only a workflow whose dry run passed.
- A workflow for the whole job takes `{ "name", "website" }` and returns `{ "sic2", "evidence", "url" }` as its output.
- A workflow works for any company. Never put a company's name, domain or answer in one. It reads pages with
  fetch_page and the groups with sic2_groups, decides with pick, judge or route, and hands anything unsure back with
  escalate.
- When a workflow you ran escalated or failed and you see why, save a fixed revision under the same name.

## Notes

- When a line in `<learned>` helped, call learn with type used and its id. When this run shows a line in `<learned>` is
  wrong, call learn with type correction and the general rule.
- A note states a general rule, never this company's name, site or answer.
- Give learn an id only to name a learning listed in `<learned>` or a workflow you saved; a new note has no id.
