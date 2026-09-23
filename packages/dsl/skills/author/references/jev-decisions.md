# Design Jev decisions in AgentRun

Jev returns typed judgments and probabilities, not generated prose, tool calls or
multi-step research. The host supplies its adapter and credentials; the workflow
names the question. Do not write
HTTP requests or SDK setup into workflow code. This guide maps the TypeSafe
programming model to the installed DSL; the general TypeSafe skill is optional.

## Choose the boundary

Work backward from the action the result controls. Code handles exact lookups,
parsing, arithmetic, joins, grouping and constraints. An agent handles open-ended
research or generation. Jev can select relevant evidence, interpret a boundary,
compare a claim to its source or choose among known actions. It need not be a
final approval stage, and a workflow without a semantic decision need not use it.

Ask one coherent judgment per property. Separate independently useful conditions;
keep related context together. Avoid asking whether a whole complex answer is
"correct" when no source supporting that answer is supplied. Question descriptions
must carry their meaning; property names alone are not instructions.

## Construct the evidence, not another opinion

For source-grounded work, a useful pattern is:

1. A tool or agent locates candidate references, retaining their identities.
2. Direct tool calls fetch the original text at those references.
3. Jev sees the question or full selection rule **and that original text**.
4. Code uses the returned values; an agent may repair missing evidence or synthesize.

Keep source text separate from a candidate extraction, paraphrase or claim. An
agent's field named `quote`, `headerContext` or `verified` does not make it original
evidence. Re-read the cited source through the host tool when independent checking
matters. Include relevant headings, units, dates, neighboring rows, exclusions and
section boundaries. An exact quote match checks presence, not interpretation.

Judge only what the supplied context can establish. If a source is truncated,
follow its continuation when relevant; if it is missing, retrieve or surface the
gap. Do not silently substitute a summary to fit a size limit. Narrow or partition
large contexts at meaningful boundaries while retaining their qualifiers.
The adapter has no default byte ceiling. A host may explicitly configure
`maxStateBytes`; local size errors then report the measured UTF-8 JSON bytes and
that host's limit before any HTTP request is sent. Provider context limits are
separate and token-based, not a fixed bytes-to-tokens conversion. Jev 1.13's
documented contract, checked on 2026-09-22, allows 32k tokens for state plus the
longest question and 64k for state plus all questions combined; check the selected
model's current contract. Oversized provider requests remain
errors, not permission to truncate evidence or silently retry a different graph.

`sift` sends **all items together in one request**. Shared `state` is added to
that batch; it does not replace or narrow each item. `describe` adds an item
summary, but the full original item is still sent. A tool envelope can contain
the same text in both `content` and `details`, so character limits on individual
reads do not establish the final serialized size.

When judgments are independent, explicitly use `map` with a `judge` body for one
request per original. For records that already contain `document`, `page` and
`text`, a body can use `state: {rule: "{question}", original: "{item}"}`. For tool
envelopes, select the host's actual original-text and provenance fields instead
of sending duplicate representations. Retain the full reviewed rule, relevant
headers, units, dates, exclusions and neighboring rows. If an individual original
is still too large, retrieve or partition it at meaningful boundaries; do not
silently truncate it or replace it with an agent's interpretation. This explicit
graph change changes request count; no automatic batching or truncation occurs.

The fictional [read-source decision](../examples/read-source-decision.json) and
[input](../examples/read-source-decision.input.json) show direct tool results passed
to a judge unchanged, followed by deterministic probability projection in code. Its
paths are inputs, not a built-in corpus: place the bundled fictional
[release note](../examples/release-note.txt) in the working directory before running
that input. Adapt the tool and its
return schema to the tools the host actually names; an agent locator can produce the
references earlier in the same graph.

## Use the installed primitives

- `judge`: a flat output schema describes several independent questions over one
  explicit `state` map. Boolean properties become yes-probabilities (Noul); enums
  become Choice; integer properties with minimum 0, maximum N−1 and N described
  levels in `criteria` (2–10 levels) become Score. Put the complete question in each
  `description`.
- `sift`: ask questions about each candidate and retain originals. Pass shared task
  context in `state`; each item also needs its own original evidence. Candidate
  coverage matters: no judge can recover a source absent from the candidate set.
- `pick`: choose from known candidates, with `allowNone` when none may fit.
- `route`: choose a semantic branch. Its uncertainty gate concerns that new
  decision, not an earlier judge's probability.

Batch independent questions over the same state. They cannot read each other's
answers. Use another step when a decision is needed to retrieve new evidence or
construct new state. Inspect the assembled state and questions, not just node names.

## Consume uncertainty honestly

`judge` stores decoded values at its `as` key and raw answers at `<as>$answers`.
A boolean is true at yes-probability 0.5; to enforce another threshold, read the
raw `.answers.<property>.noul` number and compare in code. A Noul near 0.5 means
uncertainty between yes and no, not medium intensity. Choice/Score confidence is
distribution concentration, not proof that the workflow is right.

Use thresholds appropriate to the task, with an explicit missing/uncertain path.
An example threshold is not calibrated policy. Low probability can justify
exclusion, another retrieval, cheap-agent repair or escalation, depending on the
question. Do not reject an entire result just because an unused condition is
uncertain. Preserve raw decisions so these policies can be inspected separately.

Typed output proves an interface, not truth. Test source coverage, semantics and
the downstream action independently. A fake-judge fixture proves wiring only.

Maintained against TypeSafe's state, primitives/Noul, confidence and citation-check
documentation, reviewed 2026-09-22. Upstream reference locations:
`https://docs.typesafe.ai/concepts/state`, `https://docs.typesafe.ai/primitives`,
`https://docs.typesafe.ai/confidence`, `https://docs.typesafe.ai/cookbooks/citation_check`.
