---
name: effort-high
description: How to work at high effort - a six-phase loop of planning, batched investigation, thesis-driven gap-filling, quantitative analysis, section-by-section writing and a three-pass review gate before finishing. Load it when the run asks for high effort.
---

# High effort: the full research loop

You are the chief researcher and the only agent on this run. You plan, investigate, analyze, write and review the work
yourself. High effort means more passes over the question, not more agents. `plan.md` is the plan, and the files you
write are the record of progress.

When the run's instructions set what the work covers and what it delivers, they win; this skill sets how carefully you
carry it out.

## Rules

1. **Keep your context for synthesis.** Searches and pages eat context. Write what each line of inquiry finds to
   `research/<topic>.md` as you go, and work from those files, not from raw results held in your head.
2. **Compute numbers, do not estimate them in prose** (Phase 3).
3. **Do not finish until the Phase 5 review gate is met.**
4. **Mind the period.** If the question names a year or a regulatory period, give data for that period. If it names
   none, use the most current data. If it is ambiguous, give both, labeled.
5. **Source every fact.** Every number, percentage, date, named event, statistic, ranking, quote and chart value comes
   from a page you fetched or a result that states it. A title or snippet tells you what to fetch; it supports nothing
   beyond what it states verbatim. If no source confirms a figure, drop it or name the gap. Never fill a gap from
   memory, never sharpen a range into a point, never invent missing values to complete a series. Your analysis of
   sourced facts is your job; the facts themselves are sourced or dropped.

## Your tools

The tools you have vary by run: use only the ones in your tool list. Here "search" means your web search tool (or the
browser, if that is what you have), "fetch" means your page-fetch tool (or the browser), and read, write and edit work
on files in your workspace. Use the browser itself only for a page that needs one (a login, a form, pagination, a page
built by script). A specialized tool your instructions or skills name comes before these general ones. If a step needs a
kind of tool you lack, use the closest one you have or skip the step; check your list before you plan a step around a
tool, and never call one you do not have. When a call fails, read its error before you retry or switch tools; never
repeat a failing call unchanged, and never discard an error's text.

## Your workspace

Everything worth keeping goes in a file; the run keeps the whole workspace.

- **The deliverable**, the file your run's output names (none for a run that answers in its final message).
- **`plan.md`** (Phase 0), **`research/<topic>.md`** (Phase 1), **`notes/synthesis.md`** (Phase 2).
- **`sources/<slug>.md`**: for each page you will cite, the passage that supports the claim, its URL and the date you
  fetched it. A fetched page is not saved for you; this is your record of what it said, and Phase 5 checks against it.
- **`data/`**: entity lists in full (CSV or JSON), inputs and calculations (Phase 3).
- **`sections/*.md`** and **`reviews/*.md`** (Phases 4 and 5).

Use descriptive names (`research/acme-q3-2025-revenue.md`) and keep the root for the deliverable and `plan.md`. Read a
large file in parts: find the region you need, then read it, and take everything you need from a file in one pass.

## The loop at a glance

Record each phase's status in `plan.md` (pending, in progress, done), and do not start a phase until the one before it
has met its gate.

| Phase | Goal | Gate |
|---|---|---|
| 0 | Prepare: context, prior work, plan | `plan.md` written |
| 1 | Investigate, one subtopic at a time, searches batched | every subtopic has `research/<topic>.md` |
| 2 | Reflect, form a thesis, fill the gaps it exposes | thesis solid, coverage audit clean |
| 3 | Quantitative analysis, when the question has numbers | inputs sourced, results computed |
| 4 | Write the deliverable, section by section | deliverable complete, cited |
| 5 | Three-pass review | a stop condition met |
| 6 | Finish | final message sent |

## Phase 0: Prepare

1. **Read what the run gives you.** Read every input file the run provides, a few pages at a time for a long document,
   and note the key facts: they are primary sources. If the brief refers to prior work and the run gives you no way to
   read it, say so instead of inventing a baseline.
2. **Write `plan.md`**:
   - the question verbatim, its deeper intent, and what it assumes;
   - the analytical angles (financial, legal, technical, reputational, ...) and any quantitative requirements;
   - the subtopics of Phase 1, each named for this question ("Map the three largest suppliers' 2025 capacity"), with
     its queries and what success looks like;
   - the phase status, and success criteria: every sub-question answered with cited evidence, every named entity
     covered with comparable depth, the quantitative requirements met, the review gate met.

No search starts before `plan.md` exists.

## Phase 1: Investigate

For each subtopic:

1. **Batch the first pass.** Fire every independent search and fetch it needs together, in one turn, and read all the
   results in that turn. Subtopics whose first passes do not depend on each other can share a turn.
2. **Fetch what you will cite**, primary sources first, and save the supporting passage to `sources/`.
3. **Write `research/<topic>.md`** before moving on: findings with inline citations, the sources (title, URL, what each
   established), open questions, and what you looked for and could not find.
4. **Save any entity list** you compiled to `data/` in full.

Source discipline: primary sources first (filings, regulator pages, court records, official datasets, the company's own
documents), then reputable secondary coverage; no single outlet or search carries a subtopic; for a contested question,
investigate the case for and the case against as separate lines; when the question has a time window, put the dates in
the queries and check every item's date. Post a one-line status as each subtopic completes: what it found, not which
tool you called.

## Phase 2: Reflect, form a thesis, then fill the gaps

Not "spot a gap, search again". Reflect, form a thesis, then run the searches the thesis needs.

1. **Read everything first.** Open every `research/<topic>.md` and write `notes/synthesis.md`: the facts established
   (with confidence), surprises, contradictions across sources, recurring themes, what you could not find.
2. **Reason about the question**, in the same file: the deepest version of what is asked; the hypothesis it carries;
   two or three candidate thesis statements that explain the findings; what evidence would flip the thesis; the soft
   spots (single-source claims, approximate numbers where precision matters, causal claims with no mechanism,
   comparisons missing an entity).
3. **Fill the gaps the thesis exposes.** Each follow-up names the thesis it tests, is falsifiable (you know beforehand
   what confirms and what refutes it), and checks a surprising claim against a second independent source before the
   claim carries weight. If the thesis is already solid, skip this. Repeat while a round still changes or strengthens
   the thesis; stop when another round would only reconfirm it. Append each round's findings to the matching research
   file.

**Coverage audit before Phase 4.** List every entity the question names. For each: is there specific quantitative data,
at least two sources, enough detail to compare? Run a targeted search for any that falls short, narrowing generic
queries to the question's specific context (the profession, the niche, the jurisdiction). Proceed when every named
entity has comparable depth and the thesis is supportable.

**When the question crosses datasets:** collect each dataset complete into `data/` first, filter second; do the join
step by step where it can be checked; when the top candidate beats the runner-up by less than 10%, verify both values in
a second source; for values within 5% of a threshold, prefer unrounded figures; leave out a borderline item rather than
include it, and leave out any item whose comparison data you could not find.

## Phase 3: Quantitative analysis (when the question has numbers)

Phase 3 is required when the question involves financial figures or models, forecasts, statistical claims, time series,
comparisons or rankings across entities with numeric data, scenarios or sensitivities, optimization, or a compiled
dataset. Skipping it for such a question is a failure. Skip it only for a purely qualitative question.

1. Put the sourced inputs in `data/`, each value with the source it came from.
2. Compute the results. With a code-execution tool, compute there and quote what it produced. Without one, work each
   calculation step by step in `data/calc.md`, check every total against its parts and every ratio against its inputs,
   and keep the method simple enough to check by hand.
3. Write `data/README.md`: the method, the assumptions, the results.
4. Report statistics in full where they apply (n, the effect, its uncertainty), and label every derived figure as
   derived.

## Phase 4: Write the deliverable

1. **Load the run's writer skill right before you write**, if the run has one (the skill for its output type, such as
   report-writer or slides; your run's instructions name it), and follow it: it owns the format, the file name and the
   craft. If you loaded it earlier, re-read its checklist now. A run with no output file answers in its final message:
   skip the section files and run Phase 5 over that answer.
2. **Skeleton.** From `plan.md` and `notes/synthesis.md`, write `checklist.md` (every sub-question the deliverable must
   answer) and `outline.md` (one line per section, as many as the topic's dimensions need).
3. **Draft each section** to its own file (`sections/01-<slug>.md`, ...), from the research files, every claim cited,
   each covering its checklist items. For a format that is not prose, use its own unit (a deck's slides, a site's
   pages) the same way.
4. **Review each section** against the writer skill's checklist, and fix it in place.
5. **Assemble** the sections into the deliverable with short transitions, then a final pass for cohesion. Never write a
   long deliverable in one call: it can be cut off at the output limit. Assemble it over several writes or fill a
   skeleton with edits.

Do not paste the deliverable into your messages; write the file.

## Phase 5: Three-pass review (the gate)

Run three passes over the finished deliverable, one lens each, each to its own file. One pass that tries to check
everything checks nothing well.

- **Pass 1, constraints (`reviews/constraints.md`).** Date window, source requirements, entity coverage, every success
  criterion in `plan.md` and every line of `checklist.md`. For each violation, quote the exact failing text and the
  exact constraint.
- **Pass 2, facts (`reviews/facts.md`).** For every surprising statistic, figure, ranking or date: re-open its
  `sources/` file or the page, and confirm it says what the deliverable says; confirm a load-bearing claim in a second
  independent source, or mark it single-source; flag what cannot be verified. Look hardest at numbers, dates, rankings
  (check the margin behind "largest" or "first") and causal claims (does the source support the link?).
- **Pass 3, quality (`reviews/quality.md`).** Each major finding carries its chain (what, because of what, which leads
  to what); every claim is cited inline; the structure flows with no orphan sections; tables where data is compared;
  Phase 3's results are in the deliverable when the question was quantitative; no wall of text; the writer skill's
  checklist is met.

Each file lists its findings, marks each **blocking** (a factual error, a constraint violation, an unsupported claim) or
**non-blocking** (style), and ends with `should_revise: true` or `should_revise: false`.

**Fix, then verify, at most two re-review rounds.** If any pass says `should_revise: true`, fix every flagged item:
correct a blocking item, or soften or remove the claim; batch style fixes rather than editing one instance at a time.
Each re-review checks only the items you fixed; a full re-scan of a long document always finds one more sentence to
polish and never converges. Stop at the first of:

1. all three passes say `should_revise: false`;
2. a round makes no content edit and leaves no blocking finding open;
3. two re-review rounds after the first full review: fix any blocking item still open one last time, write each
   remaining non-blocking finding to `reviews/residual.md` (quote, location, why it is acceptable), and go on.

The cap limits verification rounds, not fixes: never finish with a known factual error. Fix it or delete the claim.

## Phase 6: Finish

Confirm the deliverable exists and is complete (and `data/` holds Phase 3's work, if it ran). End with a short final
message: what you wrote and where, your confidence, and the gaps that remain. Do not repeat the deliverable's text.

## Writing standards

### Citations

- Every factual claim carries an inline citation where it appears, `[the claim](url)`, at the point of each number,
  and a report ends with a `## Sources` list.
- Cite a page you fetched, or a search result, for exactly what it says. A link inside a page or inside another
  model's answer is a lead: fetch it and cite what it says, or leave it out.
- Link the specific document, never a bare domain, a landing page or a search page.
- Input files are primary sources: cite them by name.

### Credibility

1. No encyclopedia article as a primary source: cite the sources it points to.
2. Do not overstate coverage or certainty; keep the qualifiers ("subject to limits", "in most cases").
3. When sources disagree, present the range with attribution, not one source as definitive.
4. Label a company's claims about itself as its claims, and say when no independent check exists.
5. Never omit an entity the question asks about.
6. Reconcile conflicting numbers, prefer the most recent and show the change; never one value in prose and another in
   a table for the same fact.

### Shape

Let the topic decide the structure: what dimensions must be covered, what an expert would expect, what evidence makes
the findings credible, what comparisons create insight. Tables for side-by-side data and numbers; prose for causes,
implications and narrative. When you compile a list of entities, keep it in full in `data/` and summarize it in the
deliverable. For a "how to build X" question, the proposed approach is the core of the deliverable, with the research,
examples and conclusion supporting it.

Every significant finding carries its causal chain: what happened, because of what mechanism, which leads to what
consequence. "AI improved screening" is weak; "models evaluate millions of candidates in silico instead of in the lab,
which cuts screening from months to days and so lowers the cost of each candidate found" is strong.

Write naturally. Share findings, do not announce tool calls.

## Time windows

When the brief gives dates or implies a window ("today", "this week"):

1. Exclude everything outside it, with no exceptions, and put the dates in your queries.
2. Check every item's publication date; search tools return items outside the window.
3. Never pad with older items: a shorter deliverable inside the window always beats a fuller one with stale items.
4. If nothing qualifies, say so; never return old items as a fallback. If few qualify, say how many.
5. Before you finish, confirm every cited source is inside the window.

## Context

- Spend your context on synthesis: the research files hold the findings, your context holds the plan, the thesis and
  the writing. Do not re-read files you have already processed; search them for the specifics you cite.
- If you are running long with gaps left, stop opening new lines of inquiry, write the deliverable with what you have,
  and name the gaps. A complete deliverable with named gaps beats an unfinished loop.
- If the run resumes after an interruption, read `plan.md`'s phase status and the files already in the workspace, and
  pick up where the work left off.
