---
name: report-writer
description: Write the run's report as plain markdown in report.md - an action title, the finding first, an SCQA executive summary, sections that each carry one message, inline citations on every claim and a closing Sources list. Load it right before writing a report or a decision.
---

# Report writer

You are about to write the run's report, `report.md`, as plain markdown: no HTML, no widgets, no cover page. Prose and
markdown structure carry all the weight, so the report reads well anywhere it is piped.

## Match each write to the report's length

- **A short report** (a focused brief that fits in one write): write the whole file in one write. Then read it once and
  make at most one or two targeted edits.
- **A long report** (many sections): build it across several writes, never one. A very long single write can be cut
  off at the output limit and leave a broken file. Write a skeleton and fill it with edits, or write two to four
  complete sections per call, keeping each edit section-sized. Then read the whole file and fix what assembly damaged:
  broken transitions, repeated phrasing, dangling references, a shift in voice.
- Before an edit, copy the text you replace from the file as it is now, never from memory; an edit matches the exact
  text, whitespace included.

## Lead with the finding

Open with the most important finding for the reader: the one that answers the question. Not the method, not the
background. Importance beats surprise.

Never open with "This report examines...", "In this analysis, we will...", "The purpose of this research is..." or
"[Topic] is an important and growing...". Open with the key finding, the most decision-relevant figure, or the
conclusion the evidence supports.

## The title states the finding

The `#` title is an action title: concise and specific, naming the subject, the kind of work and the headline verdict
when there is one.

- Good: `# Acme Rail: Credit Review - Approve with Conditions`
- Too generic: `# Acme Rail - Company Overview`
- Too stuffed: `# Acme Rail - $1.2B Revenue, Zero Debt, 4.0x Coverage, Approve with Conditions on Three Covenants`

## Let the argument set the structure

No Roman numerals, no template headings ("Background", "Analysis", "Conclusion"). Ask: what is my central finding, what
must the reader understand to trust it, and in what order do those pieces build? A comparison, a market assessment and a
regulatory review need different shapes.

Each part of the report has its own job:

| Part | Job | Not |
|---|---|---|
| Executive summary | The whole argument in small: finding, key evidence, implication | Teasing or vague |
| Body sections | Evidence, nuance, competing views, specific data | Repeating the summary |
| Conclusion | Implications, open questions, what would change the answer | Summarizing what was just said |

If the conclusion could be swapped with the executive summary, one of them is wrong.

## The executive summary follows SCQA

Situation (about 15%: the established facts), complication (about 20%: what changed, what is at stake), then the answer
(about 65%: the finding, with its evidence and implications). Write it as dense analytical prose, not bullets.

## A decision report

When the run asks for a decision, the title states the verdict and the executive summary opens with it: the
recommendation, the conditions attached to it, and the evidence it rests on. Give the strongest case against it in the
body, and end with what would change the recommendation.

## Calibrated confidence

State findings with the confidence the evidence supports.

- Weak: "The evidence could be interpreted to suggest there may be potential benefits."
- Overclaimed: "The evidence conclusively proves X is better in every case."
- Calibrated: "Three independent sources agree X beats Y on Z. One reports lower figures, which may reflect a different
  sample."

When credible sources disagree, give the range with attribution, and do not collapse it to one number. Take a position
when the evidence is clear, and name the source that dissents and why it differs.

**Precision:** when you have exact inputs, compute derived figures from them rather than taking rounded ones from a
secondary source; prefer the most specific date and amount a source gives; prefer the primary document's figures to a
summary page's.

## Cover everything the question names

For every entity, product or program the question names: is its key figure stated from at least one source, are its
distinguishing features covered, is each claim cited? Fill any gap before you finish; do not skip a data point because
it breaks the narrative.

## Plain words

- One idea per sentence, one topic per paragraph, sentences of about 15 to 25 words.
- Everyday words: use (not utilize or leverage), help (not facilitate), about (not with regard to), so (not in order
  to), start, end, buy, enough.
- Cut filler vocabulary that carries no meaning: drive, unlock, deep dive, robust, landscape, ecosystem, going forward,
  seamless, best-in-class, game-changer. Say the concrete thing.
- No Latin abbreviations: "for example", "that is", "and so on".
- Link text says where it goes and reads on its own; never "click here" or "read more".
- In prose, spell out one and use numerals from 2; write ranges with "to" ("10 to 20", "2023 to 2026") and dates as
  "4 June 2026". Tables and money keep their usual conventions.

## What makes a report dull, and what destroys trust

Dull: equal weight on everything; tables as filler with no prose explaining why; vague hedging; jargon left unexplained;
the same point repeated across sections.

Untrustworthy: an encyclopedia article as a primary source; coverage or guarantees overstated (keep the conditions and
exceptions); a company's marketing taken as evidence (label it as its claim); one source presented as definitive when
others disagree; an entity the question asks about left out.

## Flow and the conclusion

Connect each section to the next ("That explains the opportunity. The risk is in the contract terms."). Read the
conclusion and ask what it tells the reader that the body did not. It should state the "so what", what would change the
answer, the questions the work opened, and something the reader can act on.

## Information architecture

1. **Headings state conclusions, not topics.** Not "Risk Assessment"; "Three regulatory flags call for enhanced
   review".
2. **Three reading speeds.** Headings alone give the findings; headings plus bold labels give the argument; the full
   text gives the analysis. Use bold-label lists: `* **Label:** one to three sentences with specific data.`
3. **One message per section.** The heading is the message.
4. **Takeaways.** End a section of three or more paragraphs with a bold one-line takeaway (`**Takeaway:** ...`), not a
   blockquote.

## Citations

**Wrap the claim in the link: `[the exact figure or claim](url)`.** The link text is the supported claim itself, never
the source's name. Wrap the tightest span the source supports, the figure and its qualifier, not the whole sentence.
Every specific number, amount, percentage, date, count and named legal or regulatory fact carries its own link where it
appears.

- Right: `The firm settled for [a combined $2.5 million in civil penalties](https://regulator.example/press/2025-01-17), covering [41 unauthorized sales](https://regulator.example/press/2025-01-17).`
- Wrong: `...$2.5 million in civil penalties [Regulator press release, 17 January 2025](https://...).`
- Wrong: `...civil penalties [regulator.example](https://regulator.example).`

Rules:

- **Link the specific document.** A URL with an empty path (a homepage) or a search page does not cite a fact; it cites
  an organization. Find the page that carries the fact, cite another source that has one, or state the fact without a
  link.
- **Models and derived figures are not exempt.** Every input to your own model or projection carries its citation where
  you state it. Only the outputs computed from cited inputs may stand without a link, and the text says they are
  derived. A figure with no source behind it does not belong in the report.
- **Keep the source's terms.** Match each claim to what a page you fetched said: its wording, value, scope and
  uncertainty. Do not strengthen a finding or fill a field the source left empty. Label your inferences as yours.
- **A URL printed inside a document is content, not a fetched source.** Cite it only if you fetched it and it supports
  the claim.
- Do not write "according to" or add parenthetical citations; wrap the claim. Never put a link in a heading.

## Tables

Use markdown tables for comparisons, pricing, specifications and head-to-head data, three rows or more. When rows draw
on different sources, add a final `Source` column linking each row's document, so any number traces to its source:

```
| Holder | Shares | % | Source |
|---|---|---|---|
| Fund A | 6,039,111 | 8.71% | [13G filing, 5 May 2026](https://filings.example/...) |
| Fund B | 4,900,192 | 7.07% | [13F, Q1 2026](https://filings.example/...) |
```

Cite once beneath the table only when every row shares one source.

## Voice and tells

Write as a knowledgeable advisor, not a committee. First person is fine ("I found"). Be specific ("$5.2B at 7.4x
revenue", not "significant investment"). Short sentences for findings, longer ones for nuance. Sound certain when you
are; say why when you are not.

Two habits make a report read as generated: blockquotes in the body (use bold takeaways instead) and dash-heavy
sentences. Prefer commas, parentheses or full stops; a whole report needs at most one or two long dashes.

## The Sources section

End with `## Sources`, a bulleted list with one `[Title](url)` per line, every source the report cites:

```
## Sources

- [Acme Rail 2025 annual report](https://acme.example/ir/annual-report-2025.pdf)
- [Regulator press release on the settlement, 17 January 2025](https://regulator.example/press/2025-01-17)
```

## Before you finish

- [ ] The first sentence answers the question; the title is an action title.
- [ ] No template structure; each section carries one message.
- [ ] The executive summary is SCQA prose, and the conclusion says something it does not.
- [ ] Every entity the question names has specific, cited data.
- [ ] Conflicting sources show the range with attribution; no encyclopedia or marketing claim as evidence.
- [ ] Every specific claim is wrapped in a link to the specific document; derived figures say so.
- [ ] Plain words, no filler vocabulary, descriptive link text.
- [ ] Tables for structured comparisons, with a Source column when rows differ in source.
- [ ] `## Sources` is present, bulleted, one link per line.

Your job is not to fill pages. It is to give the reader accurate, well-evidenced answers they can trust.
