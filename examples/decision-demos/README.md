# Decision workflow demos

Five workflows where small decision models make the calls and code applies the rules. Nothing here runs an agent loop.
A tool renders a PDF page or fetches a web page, a decision model answers typed questions about what it sees, a code
node applies thresholds you can read, and a route sends the case down a branch. Every decision lands in the run with its
probabilities, the image or web evidence behind it, its latency and its cost, and the console draws the graph live as it
runs.

The decision models:

- **Jev** (TypeSafe), the default. It answers yes/no questions with a probability, picks from a list with a
  confidence, and reads page images.
- **Parallel**, for questions that need the web. Its answers come with citations.
- **OpenRouter decision models**, here `perplexity/pplx-decider-v1.2`, `liquid/d1` and `cloudflare/clef`, used as
  extra jurors.

Every company, person, bank, merchant and address in `documents/` and `faux/` is invented.

## The use cases

### 1. Is this certificate valid? (`doc-valid`)

One certificate of incorporation. `pdf_pages` renders page 1 as an image. Jev looks at the image and answers six
questions: is this a certificate of incorporation, does it look altered, is the seal there, is it signed, is the
company name the same everywhere, is any date in the future. A code node holds each answer to its own threshold. Each
question has a pass line and a fail line, and the band between them is "unsure". The lines come from the first live runs
(see "Calibration" below): "looks altered" passes below 0.6 and fails at 0.8, because Jev reads a clean page of this set
as up to 0.5 altered.

All clear means valid. Any clear failure means invalid, with the reasons listed. Anything unsure gets a second look: Jev
sees the page again, this time with the checks that were unclear, and chooses valid or doubtful. If its confidence is
below 0.75, the case goes to a person, whichever way it leaned.

Inputs: `doc-valid` (clean, valid), `doc-valid-altered` (the filing date was whited out and retyped, invalid),
`doc-valid-borderline` (clean, with a seal that reads as unclear: under the faux providers it goes to review; live, Jev
1.14 read the seal at 0.77 and passed it).

### 2. Review 20 documents (`batch-20`)

Twenty documents: certificates of incorporation from four states, IRS EIN notices and bank account letters. Twelve are
clean. Eight have a defect you can see on the page: a date typed over white-out, an EIN pasted over in a box, a name and
EIN set in a different typeface, a missing seal and signature, an unsigned bank letter, a company name that changes
between the heading and the body, a filing date in 2027.

A map runs the same steps on each document, four at a time: render the page, have Jev say what kind of document it is
and check it (looks altered, carries its issuer's seal, stamp or header, every signature line signed, name consistent,
no date in the future), apply thresholds, and give unsure documents a second look. A document that fails to render does
not stop the batch. It is listed as unreadable. The input `batch-20-holdout` runs the same workflow on the four KYB packet
pages, which the thresholds were not set on.

Then two reports run side by side. One is a code template, a table with one row per document. The other is a single
`llm` call: one prompt with every record in it, written up document by document. Neither one gets to add a finding that
is not in the record.

### 3. KYB: registry and documents (`kyb`)

A company, the state it says it is incorporated in, and three documents: certificate of incorporation, EIN notice, bank
letter. Two checks run at the same time. Parallel searches the web: is this company registered in that state and in good
standing, and is the registry name an exact match? It cites what it found. Jev looks at all three page images: does any
of them look altered, is the certificate sealed and signed, is the bank letter signed?

A cross-check follows. Jev sees the three pages and the registry answer together and decides whether they name the same
legal entity, whether the state matches, and whether the dates are in order (incorporated, then EIN, then bank account).
The rule rejects forgery or a company the registry has never heard of. It sends a mismatch between documents to a
person, and approves when everything lines up.

Inputs: `kyb` (all consistent, approve), `kyb-mismatch` (the bank letter names "Brisklow Marine Holdings LLC" rather
than "Brisklow Marine Coatings, Inc.", so a person reviews it). Those outcomes assume a registry that knows Brisklow, as
the faux one does. Brisklow is invented, so live, Parallel finds no record (`not_found`) and both packets are rejected on
that alone; the document checks and the cross-check still run, and `kyb-mismatch`'s cross-check catches the other entity.

### 4. Merchant category and risk (`merchant-mcc`)

A merchant's home page. `fetch_page` reads it. Then two Jev decisions run at once: pick the merchant category code that
fits what the page sells (out of 24, or none), and say whether the page itself offers prohibited goods (replicas,
drugs) or restricted ones (CBD, vapes). Parallel then checks public sources with the chosen category in hand: does this
merchant sell prohibited goods, and how risky is it to process for? Code sets the tier from all of it, and the route
approves low risk, sends medium risk to enhanced due diligence, and declines high risk.

Inputs: `merchant-mcc` (a coffee roaster, approve), `merchant-mcc-restricted` (CBD and delta-8 gummies, review),
`merchant-mcc-prohibited` (1:1 replica designer bags, decline). The merchants are invented and their pages only exist
in the faux network, so a live run needs a real public URL: `merchant-mcc-live` is a real coffee roaster's home page.

### 5. Jury of decision models (`jury`)

One question, four models at once: Jev and three OpenRouter decision models each say whether a card payment is for
gambling. Code takes the mean yes-probability and the spread between the highest and lowest. If they agree (spread
within 0.35, mean clear of the middle), the answer is automatic. If they disagree, a person decides, and sees all four
votes.

Inputs: `jury` (an invoice for ceramic tile, everyone says no), `jury-split` (a social casino's coin package with
"sweeps coins" redeemable for cash; the faux jurors disagree), `jury-event-contract` (event contracts on an exchange),
`jury-fantasy` (a daily fantasy sports entry fee). Live, the four jurors agreed on `jury-split` (gambling, 0.63 to 0.90):
the question itself counts social casinos that pay out cash prizes as gambling. They split on `jury-event-contract`
(Jev 0.72, the other three 0.31 to 0.44), which went to a person.

## Running it

Build once from the repo root: `npm run build`, and for the console `cd apps/console && npm run build`.

```sh
node examples/decision-demos/run.mjs batch-20            # faux providers, no key, no network
node examples/decision-demos/run.mjs kyb --input kyb-mismatch --follow
node examples/decision-demos/run.mjs all --follow --exit --speed 0
node examples/decision-demos/run.mjs doc-valid --live    # real providers, keys from the environment
AGENT_MODEL=openrouter/openai/gpt-6-luna node examples/decision-demos/run.mjs batch-20 --live --follow --exit \
  --data ./dwf-data --report ./dwf-reports   # the llm report's model; a report file per run
# serve plus the five agents, no run; runs start from the console
AGENT_MODEL=openrouter/openai/gpt-6-luna node examples/decision-demos/run.mjs --serve-only --live --port 8790 --data ./dwf-data
```

`run.mjs` starts `agentrun-serve` from this checkout on 127.0.0.1 with a fresh data directory (under `os.tmpdir()`, or
`--data DIR`; reuse one directory and the console lists every run), `--documents` pointing here and
`--allow-code-nodes` (the workflows' code nodes run in the run's process; serve runs none without it). It creates the
five agents, starts the use case and prints the console link to the run. Without `--live`,
Jev, Parallel, OpenRouter, the web and the `llm` model are the fakes in `faux/`. They answer from
`documents/labels.json` and `faux/fixtures.mjs`, with latencies like the real services (`--speed 0` turns those off).
Their numbers are fixtures; real receipts and costs come from `--live` runs. `--report DIR` writes
`<live|faux>-<input>.json` per run: verdicts against `documents/labels.json`, latency and cost per node (null when a
provider reported none, never 0; Parallel's is its list price, an estimate, since its API returns no cost), model
strings, Parallel's citations, wall time, and the count of agent loops (model nodes or agent calls that ran: 0 in all
five).

## Calibration

The first live run (Jev 1.14, 2026-10-30) scored `batch-20` at 12 right, 6 sent to review (all six clean) and 2 invalid
documents passed. Two rounds of changes followed, each run once more on the same 20 documents, so the final score is
in-sample; `batch-20-holdout` is a small check on four pages the thresholds were not set on.

1. One property per question. Batch-20's "authenticated" asked for the issuer's marks and the signatures together, and
   passed an unsigned certificate on its seal (0.93). It is now two questions, "issuer marks" and "signed" (the unsigned
   certificate reads 0.07-0.09 on "signed"). KYB's "certificate executed" split the same way (it read 0.50 on a sealed,
   signed certificate; 0.92 and 0.97 split). KYB's "same state" also asked about the registry answer, which has its own
   questions, and read 0.11 when the registry had no record; it now asks only the state (0.99).
2. Pass lines in the gaps. In the first run, clean pages read 0.08-0.50 on "looks altered" and altered ones 0.93-0.99,
   so it passes below 0.6 (was 0.3). "Name consistent" and "date not future" read 0.74 and up on clean pages and 0.01 on
   the pages with those defects, so they pass at 0.7 (was 0.8). Readings move a little between runs of the same page:
   in the final run one clean page read 0.58 on "looks altered" and another 0.70 on "date not future", both just inside
   the lines.
3. Tried and dropped: a separate typeface question for the EIN notice whose name and EIN are set in another font. Clean
   pages read 0.21-0.78 on it and that page 0.35, so it did not separate them. That notice is still passed as valid: the
   one miss in the final run.

Final live `batch-20`: 19 of 20 right, 0 to review, 1 invalid passed (the typeface swap). Holdout: 4 of 4. The second
look (Jev asked again whether an unsure page is genuine) never cleared a page: in the 18 second looks of the earlier live
runs P(valid) was 0.21 to 0.50, under the 0.75 confidence gate, so every unsure page went to a person. A closer look was
tried once and dropped: render the unsure page again at 140 dpi (Jev refuses pages past about 1,550 px on a side, so
2x, 220 dpi, is out) and decide only the unclear checks again at the same 0.75 gate. On the first run's pass lines, 7
pages were unsure. The unclear readings moved by 0.09 at most (looks altered 0.41 -> 0.32, 0.52 -> 0.50, 0.31 -> 0.31),
and the three pages it cleared read 0.79-0.81 on "name consistent", as they had (0.79) on the first pass: above the gate,
under the 0.8 pass line. One of them was the page with the swapped typeface.

Other scripts:

- `node build.mjs` writes `workflows/*.json`, `inputs/*.json` and `use-cases.json` from one source, so the question
  wording and thresholds stay the same across use cases.
- `node validate.mjs` runs the DSL validator and a dry run on every workflow and input. `--strip-images` drops the
  `images` field for a DSL build that does not have it yet.
- `node rehearse.mjs <use-case> [input] [--fast] [--reports]` runs a workflow in-process with the real Jev and
  Parallel providers over the faux fetches, with no server. For `batch-20` it scores the verdicts against the labels.

## Files

| Path | What |
| --- | --- |
| `workflows/` | the five workflows, as the console shows and edits them |
| `inputs/` | inputs per use case (`use-cases.json` maps them) |
| `documents/` | 24 PDFs, `labels.json` (ground truth and the defect per document), the generator |
| `faux/` | fake Jev, Parallel, OpenRouter, fetch_page network and `llm` model |
| `run.mjs` | start serve, create the agents, start a run, print its console link |
| `rehearse.mjs`, `validate.mjs`, `build.mjs` | offline rehearsal, validation, the workflow builder |
