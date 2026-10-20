# Company research: prompts that depend on the kind of organisation

An agent, Desk, that researches one company and writes a short brief with every fact cited to a page it fetched. Which
sources it starts with depends on what kind of organisation it is. The prompts for each kind are saved in the agent's own
home (`agent.sqlite`, as `agent.prompts`), so a person edits them there and the agent loads the matching one at the start
of a run.

| File | What |
| --- | --- |
| `agent.json`, `skills/research-brief/` | The agent: tools `web_search`, `web_fetch`, `write` and `read`, and the skill that says how to cite. |
| `prompts.json` | The variants, each with an `id` (the home keys them by it), a `label`, a `role` and its `text`: a `base` that every run gets, an `overlay` for each kind (`public`, `nonprofit`, `small_retail`, `ecommerce`) and a `generic` for when none is sure enough. Each overlay has a `when` rule: `{ question: "company_kind", option, threshold: 0.8 }`. |
| `question.json` | The Jev question the rules are about: `company_kind`, a choice over `public`, `nonprofit`, `small_retail`, `ecommerce` and `other`, one line each. It is the file a person edits; saving puts it in the home as its own row (below). |
| `companies.json` | Eight companies to run it on: one clear case of each kind and four ambiguous ones, each with the kind expected and why. |
| `edit-prompts.mjs` | Saves `prompts.json` and `question.json` into a home, or prints what the home holds. |
| `config-page.mjs` | Writes one static page of the configuration and of which prompt each run loaded. |

## How a prompt is picked

Before its first turn the host asks Jev the question about the company in the input. If an overlay's option comes back with
confidence at or above its threshold, that overlay is added to the base. If none does, the host looks the company up once
and asks again. If there is still none, the generic prompt is added to the base. Every run records how it chose in
`runs/<id>/prompt.json`, and the runs index names the variant loaded as `prompt: { id, reason }`.

The question lives in the home, not only in this folder: a host that opens the home later, such as a server that did not
create it, asks the question the home holds. It is a row of `agent.prompts` with `role: "question"`, whose `text` is the
instructions and whose `criteria` are the options (`other` included), and each overlay's `when.question` is that row's id.
`choosePrompt` reads all of it from the home.

## Edit the prompts

```sh
node examples/web/agents/company-research/edit-prompts.mjs --check                          # the file only
node examples/web/agents/company-research/edit-prompts.mjs --home ./desk-home --init        # make the home, save the file
node examples/web/agents/company-research/edit-prompts.mjs --home ./desk-home --show        # what the home holds
```

The files are checked before anything is saved: one base, one generic, ids used once, each overlay's rule names an option
of the question and a threshold from 0 to 1, and the question describes no option that no overlay needs (`other` is the
exception: every question has it). Take an overlay out of `prompts.json` and take its option out of `question.json` too.
Saving replaces the home's set, the question's row with it, and a second save of the same files says nothing changed.

## See the configuration

```sh
node examples/web/agents/company-research/config-page.mjs --home ./desk-home --out ./desk-config.html
```

One HTML file, no script and nothing loaded from the network: the question and its options as the home holds them, the base, each overlay with its rule, the generic, and a
table of runs with the input, Jev's choice and probabilities (both passes when there was a lookup), the lookup, the prompt
loaded, the outcome and a link to `brief.md`. A run's `prompt.json` is the host's selection plus the run's input:
`{ version: 1, question, input, variant, passes: [{ choice, probabilities, confidence, model?, cost_usd?, latency_ms? }],
lookup: { used, sources: [{ via, url, title }] }, reason, selected_at }`. `variant` is the id (or label) of the variant loaded, or `{ id, label, role }`; `passes` has the second
entry only when the host looked the company up. The page also reads the first shape (`chosen`, `lookup_used`, a lookup on
the pass that followed it). A field that is missing shows as "not recorded".

## Test

`node --test examples/web/agents/company-research/company-research.test.mjs` runs offline.
