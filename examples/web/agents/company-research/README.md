# Company research: prompts that depend on the kind of organisation

An agent, Desk, that researches one company and writes a short brief with every fact cited to a page it fetched. Which
sources it starts with depends on what kind of organisation it is. The prompts for each kind are saved in the agent's own
home (`agent.sqlite`, as `agent.prompts`), so a person edits them there and the agent loads the matching one at the start
of a run.

| File | What |
| --- | --- |
| `agent.json`, `skills/research-brief/` | The agent: tools `web_fetch`, `write` and `read`, and the skill that says how to cite. |
| `prompts.json` | The variants, each with an `id` (the home keys them by it), a `label`, a `role` and its `text`: a `base` that every run gets, an `overlay` for each kind (`public`, `nonprofit`, `small_retail`, `ecommerce`) and a `generic` for when none is sure enough. Each overlay has a `when` rule: `{ question: "company_kind", option, threshold: 0.8 }`. |
| `question.json` | The Jev question the rules are about: `company_kind`, a choice over `public`, `nonprofit`, `small_retail`, `ecommerce` and `other`, one line each. |
| `companies.json` | Eight companies to run it on: one clear case of each kind and four ambiguous ones, each with the kind expected and why. |
| `edit-prompts.mjs` | Saves `prompts.json` into a home, or prints what the home holds. |
| `config-page.mjs` | Writes one static page of the configuration and of which prompt each run loaded. |

## How a prompt is picked

Before its first turn the host asks Jev the question about the company in the input. If an overlay's option comes back with
confidence at or above its threshold, that overlay is added to the base. If none does, the host looks the company up once
and asks again. If there is still none, the generic prompt is added to the base. Every run records how it chose in
`runs/<id>/prompt.json`, and the runs index names the variant loaded as `prompt: { id, reason }`.

## Edit the prompts

```sh
node examples/web/agents/company-research/edit-prompts.mjs --check                          # the file only
node examples/web/agents/company-research/edit-prompts.mjs --home ./desk-home --init        # make the home, save the file
node examples/web/agents/company-research/edit-prompts.mjs --home ./desk-home --show        # what the home holds
```

The file is checked before anything is saved: one base, one generic, ids used once, and each overlay's rule names an option
of the question and a threshold from 0 to 1. Saving replaces the home's set, and a second save of the same file says nothing
changed.

## See the configuration

```sh
node examples/web/agents/company-research/config-page.mjs --home ./desk-home --out ./desk-config.html
```

One HTML file, no script and nothing loaded from the network: the base, each overlay with its rule, the generic, and a
table of runs with the input, Jev's choice and probabilities (both passes when there was a lookup), the lookup, the prompt
loaded, the outcome and a link to `brief.md`. A run's `prompt.json` is `{ version, question, input, passes: [{ pass, lookup,
choice, confidence, probabilities, model, cost_usd, latency_ms }], lookup_used, chosen: { label, role, reason },
selected_at }`; a field that is missing shows as "not recorded".

## Test

`node --test examples/web/agents/company-research/company-research.test.mjs` runs offline.
