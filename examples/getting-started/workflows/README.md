# Decision workflows

Three workflows with no agent in them. Each is a JSON body you create with one command and run with one line, on
`OPENROUTER_API_KEY` alone.

A decision workflow is a fixed list of steps. A tool turns a PDF or a web page into something a model can read, a
decision model answers a handful of typed questions about it and gives a probability for each, and code holds each
answer to a threshold and sends the case to valid, invalid or a person. The models are cheap and fast, a tenth of a
cent and well under a second for a page or a web search, and they don't know rules, so the rules stay in code.

## What each node needs

- `judge`, `pick`, `sift`, a `route` the model chooses, and `ask` run on a decision model. A node that names no
  provider runs on Jev: directly with `TYPESAFE_API_KEY`, else through OpenRouter on `OPENROUTER_API_KEY`. A question
  about an image goes to Jev through OpenRouter only as `"provider": "openrouter", "model": "typesafe/jev-1.14"`; with
  `TYPESAFE_API_KEY` set, drop both and the node runs on Jev directly.
- `"provider": "openrouter"` with a `model` runs any decision model OpenRouter lists, on the same key:
  `typesafe/jev-1.14`, `liquid/d1`, `perplexity/pplx-decider-v1.2`, `cloudflare/clef`, and `parallel/decisions-fast`,
  which searches the web before it answers. `"provider": "parallel"` reaches Parallel directly on `PARALLEL_API_KEY`
  and keeps the pages it read as the decision's evidence.
- `call` nodes need no key. `pdf_pages` draws a page of a PDF under the server's `--documents` directory and needs
  `pdftoppm` and `pdftotext` (poppler) on the machine. `web_fetch` reads a public page.
- `code` nodes run only when the server starts with `--allow-code-nodes`. They run in the run's process, with no
  sandbox, so turn it on for workflows you wrote.
- Model nodes (`extract`, `decide`, `agent`, `report`, the `llm` call) run on the model key. None of these three has one.

## The three

**[support-triage.json](support-triage.json)**: the smallest one. One `judge` asks three yes/no questions about a
support message, is it about billing, is it urgent, is it spam, and the typed answers are the run's output. Nothing
to start the server with: the key is enough.

**[certificate-valid.json](certificate-valid.json)**: is this certificate of incorporation valid? `pdf_pages` draws
page 1. Jev looks at the image and answers four questions: is it a certificate, does it look altered, is every
signature line signed, is every date on or before `as_of`. One question per property: asked about "the seal and
signatures" together, Jev passed an unsigned certificate on its seal. A code node holds each answer to its own pass
and fail line, with an unsure band between them, and a route sends the document to valid, invalid, or a person. The
pass lines come from the live runs in [decision-demos](../../decision-demos/README.md#calibration). Needs
`--documents` and `--allow-code-nodes`.

**[company-check.json](company-check.json)**: does this company exist and look legitimate? One `judge` on
`parallel/decisions-fast` through OpenRouter searches the web and answers three questions: is the company registered
in the state it says and in good standing, do public sources show it doing the business it claims, is there adverse
news. Code rejects a company the registry has never heard of or one with adverse news, sends an unsure one to a
person, and approves the rest. The sample company is invented, so expect `not_found` and a reject. Needs
`--allow-code-nodes`.

Every company, person and document here is invented. The certificate is one of the PDFs in
[decision-demos/documents/](../../decision-demos/documents/).

## Run one

Start the server with the key, the documents and code nodes:

```sh
OPENROUTER_API_KEY=... npx @parcha/agentrun --allow-code-nodes --documents examples/decision-demos/documents
```

(`--documents` can be any directory of PDFs; the sample input names a file in that one.) Then, from a second
terminal:

```sh
npx @parcha/agentrun agents create --body @examples/getting-started/workflows/certificate-valid.json
npx @parcha/agentrun runs start certificate-valid --wait \
  --body '{"input":{"document":"coi-bramblewick-tidal-instruments.pdf","as_of":"2026-10-30"}}'
```

The same for the other two:

```sh
npx @parcha/agentrun agents create --body @examples/getting-started/workflows/support-triage.json
npx @parcha/agentrun runs start support-triage --wait \
  --body '{"input":{"message":"I was charged twice this month (invoices 8812 and 8813). Please refund one before payroll runs on Friday."}}'

npx @parcha/agentrun agents create --body @examples/getting-started/workflows/company-check.json
npx @parcha/agentrun runs start company-check --wait \
  --body '{"input":{"company":"Brisklow Marine Coatings, Inc.","state":"Delaware","business":"anti-fouling coatings for ship hulls"}}'
```

`create` answers `201` with the agent. A workflow whose provider has no key here, or whose code nodes the server was
not started to run, saves with a warning naming what is missing, and its run is refused with the same. `runs start`
answers with the run id, and `--wait`
prints the run when it ends: `status`, `result.output` (the workflow's output), `cost`. A run the workflow sent to a
person carries `escalation`, with the kind and the summary the workflow wrote.

Open `http://127.0.0.1:7340/#/runs/<run_id>` in the console. It draws the workflow as a graph and fills it in as the
run goes: each node's state, the branch each route took. Click a decision node and you see what the model saw (the
page image, or the state), each question with its probability, the model that answered, how long it took and what it
cost. The same is in `GET /v2/runs/<run_id>/graph`.

## What a live run returned

Four runs on one `OPENROUTER_API_KEY`, each about two seconds end to end, $0.0013 together.

- `support-triage`: Jev through OpenRouter (`typesafe/jev-1.14`), 238 ms, $0.000016. Billing 0.95, urgent 0.65,
  spam 0.03; output `{"is_billing": true, "is_urgent": true, "is_spam": false}`.
- `certificate-valid` on `coi-bramblewick-tidal-instruments.pdf`, a clean certificate: the page drawn, Jev through
  OpenRouter with the image, 550 ms, $0.00065. Certificate 0.99, altered 0.19, signed 0.97, dates in order 0.98:
  valid. On `coi-ashgrove-vireo-labs.pdf`, whose filing date was whited out and retyped: altered 0.89, the other
  three as before: invalid, "looks altered (P(yes) 0.89)".
- `company-check`: `parallel/decisions-fast` through OpenRouter, 698 ms. Registry `not_found` at 0.89 (confidence
  0.83), doing the business 0.25, adverse news 0.03: reject, "no registry record in Delaware". OpenRouter booked the
  request at $0, and the answer came with no citations: through OpenRouter, the pages Parallel read do not reach the
  run today. For them, set `PARALLEL_API_KEY` and make the node `"provider": "parallel"` with no `model`; the
  decision's `evidence` then lists each page.

To move a threshold, edit the code node and `PUT /v2/agents/<id>/definition` with the new body: every edit is a
revision, and each run records the one it ran.
