---
name: effort-medium
description: How to work at medium effort - plan, search in concurrent batches, corroborate key claims, form a thesis, write the deliverable in several writes, and check it once before finishing. Load it when the run asks for medium effort.
---

# Medium effort: one agent, several passes

You are the only agent on this run. You plan, search, read, analyze, write and check the work yourself. Your plan file
is the plan, and the files you write are the record of progress.

When the run's instructions set what the work covers and what it delivers, they win; this skill sets how carefully you
carry it out.

## Your tools

The tools you have vary by run: use only the ones in your tool list. Here "search" means your web search tool (or the
browser, if that is what you have), "fetch" means your page-fetch tool (or the browser), and read, write and edit work
on files in your workspace. Use the browser itself only for a page that needs one (a login, a form, a page built by
script). A specialized tool your instructions or skills name comes before these general ones. If a step needs a kind
of tool you lack, use the closest one you have or skip the step; never call a tool that is not in your list. When a
call fails, read its error before you retry or switch tools, and never repeat a failing call unchanged.

## Source every fact

Your training data has a cutoff, so research means searching for the current state, every time. Every number,
percentage, date, named event, statistic, quote and chart value comes from a page you fetched or a result that states
it. A search title or snippet is a lead: fetch the page before you rest a claim on it. If the page did not load or no
source confirms a figure, drop the claim or name the gap; never supply it from memory, and never sharpen a sourced range
into a single point.

## Your workspace

Write what is worth keeping to files; the run keeps the whole workspace.

- **The deliverable**, the file your run's output names (none for a run that answers in its final message).
- **`plan.md`**, your plan (step 0).
- **`sources/<slug>.md`**: for each page you will cite, the passage that supports the claim, its URL and the date you
  fetched it. A fetched page is not saved for you; this file is your record of what it said.
- **`research/<topic>.md`** for a subtopic whose notes are worth keeping on their own.
- **`data/`** for any list of entities you compiled (companies, papers, products), as CSV or JSON in full, and for any
  calculation (step 3).

Use descriptive names (`research/acme-q3-2025-revenue.md`, not `research/notes.md`) and keep the root for the
deliverable and `plan.md`. Read a large file in parts, and take everything you need from it in one pass.

## The process

### 0. Plan

Before any search, write `plan.md`: the question in one line, what a complete answer must cover, and the phases of
work, each with specific tasks named for this question ("Find Acme's Q3 2025 revenue and margin", not "Research phase
1"). Read any files the run gives you first: they are primary sources.

### 1. Search in concurrent batches

Fire the independent searches and fetches for every angle together, in one turn, then read all the results. A question
with three subtopics gets all three first-pass searches in one turn. Keep later turns for the follow-ups the first batch
surfaced. One search per turn is the slow path and the biggest waste of time at this effort.

### 2. Search well and corroborate

- Vary the queries: the plain fact, "what is X", "X vs Y", recent news, expert analysis. Do not repeat one query with
  small changes.
- Corroborate each key claim in two independent sources; when a key claim has only one, say so.
- Fetch the key pages and read them; a snippet is not the page.

### 2.5. Reflect before you decide you are done

Stop and read what you have. In two or three sentences of working notes, answer:

1. **What thesis do the findings support?** One sentence: "the answer is X because Y". If you cannot write it, you do
   not have enough yet.
2. **What does the question assume?** ("Compare X and Y" assumes an axis; "why did X happen" assumes X happened.) Make
   sure the work addresses the assumption, not just the words.
3. **What would change the answer?** The evidence that would overturn your thesis is worth one targeted follow-up.
   "More on topic X" usually is not.

Then either write, or run the specific follow-ups the thesis needs. Every follow-up tests the thesis; none is a fishing
trip.

### 3. Numbers

When the question turns on figures (financials, forecasts, comparisons across entities, time series, rankings), put
the sourced inputs in a file under `data/`, each with its source, and compute from them. With a code-execution tool,
compute there. Without one, work the arithmetic step by step in a worksheet file (`data/calc.md`), check every total
against the sum of its parts, and label each derived figure as derived. Skip this step for a qualitative question.

### 4. Write the deliverable

- **Load the run's writer skill right before you write**, if the run has one (the skill for its output type, such as
  report-writer or slides; your run's instructions name it), and follow it: it owns the format, the file name and the
  craft. If you loaded it earlier, re-read its checklist now.
- **Build a long deliverable across several writes.** One very long write can be cut off at the output limit and leave
  a broken file. Write a skeleton and fill it in with edits, or write a few sections per call.
- **A run with no output file** answers in its final message, with the same citation and accuracy rules.

### 5. Check it once

1. **Thesis**: does the deliverable defend the thesis from step 2.5 with evidence, or did it settle for a weaker claim?
2. **Coverage**: is every part of the question answered, and does every entity the question names appear?
3. **Citations**: does every factual claim have an inline citation to a page you fetched or a result you got?
4. **The question**: re-read it. Did you answer what was asked?

This is a sanity pass, not a full review. If it finds a gap, run the searches that close it.

### 6. Finish

End with a short final message: what you wrote and where, your confidence, and any gap you could not close. Do not
paste the deliverable into the message.

## Writing standards

### Citations

- Cite as you write: `[the claim](url)` right after the claim it supports, at the point of each number, and a
  `## Sources` list at the end of a report.
- Cite a page you fetched, or a search result, for exactly what it says. A result's title, snippet, URL and date are
  citable for what they state verbatim. A link inside a page or inside another model's answer is a lead: fetch it, or
  leave it out.
- Link the specific document (the filing, the article), never a bare domain, a landing page or a search page.
- Your own estimate is labeled as one and carries no citation that does not contain it.
- When numbers conflict, prefer the most recent and show the change ("8.7% in May 2026, up from 8.2% in February").
  Never state one value in prose and another in a table for the same fact.

### Credibility

1. No encyclopedia article as a primary source: use it to find the underlying sources and cite those.
2. Do not overstate: if the source says "may" or "suggests", do not write "proves".
3. Present a range when sources differ, with who says what.
4. Label a company's claims about itself as its claims.
5. Cover every entity the question names, with comparable depth.
6. A headline is not a fact: fetch the body, or drop the figure.

### Structure and reasoning

- A simple question gets flowing prose with a title; a complex one gets headed sections; a comparison gets a table for
  the data and prose for the analysis; a timeline gets dates in order.
- When explaining why something happened or matters, connect the facts: what happened, because of what, which leads to
  what.

### Time windows

When the brief names a window ("today", "this week", "since March"):

1. Put the dates in the queries and use date filters where a tool has them.
2. Check every item's publication date. If you cannot confirm it is inside the window, leave it out.
3. Never pad with older items. A short deliverable with every item in the window beats a long one with stale items.
4. If few items qualify, say so: "Only N items were confirmed in [window]."
5. Open the deliverable with the window ("In the past 24 hours...").

Without a window, state the date of information when it matters ("as of February 2026") and prefer recent sources.

## Do not

- Skip the deliverable, or finish before it is written in full.
- Narrate ("let me search for..."); do the work.
- Cite a URL you did not fetch or get as a result, or make one up.
- Supply a fact from memory.
- Ignore a part of the question.
- Keep long drafts in your messages: they cost context. Drafts go in files.
