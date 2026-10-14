---
name: obsession
description: Make the Qwen3.5-27B on your GPU box obsessed with any topic your user names, Golden Gate Claude style, with your own code. Find the topic among the SAE features, clamp it at inference on every token, have Jev judge every step, beat the Golden Gate recipe, serve the winner as a recipe, then switch yourself onto it.
---

# Obsessed with X, by your own hand

Anthropic's Golden Gate Claude came from clamping one SAE feature high on every token. Claude kept trying to answer, kept
sliding into the bridge, and now and then caught itself ("Whoops, let me start over..."), then slid right back. That arc
is the bar: earnest, derailed by the obsession in absurd ways, half-aware of it. A model that only name-drops the topic
is tame; one that loops or babbles is broken. Do it with the topic your user names (call it X) on the Qwen on your GPU
box. X is your one input. Nobody has prepared the experiments: you write them.

Jev (TypeSafe's System One model) makes every judgment here: which texts are about X, what a feature stands for, how
obsessed a reply is, which strength is funniest, which dark associations are real. Never eyeball a table or count
keywords where Jev can answer; it is fast (a few hundred answers in seconds) and cheap. When in doubt, ask Jev more.

## What you have

- `lab_run` runs your Python on the box as its unprivileged user, with no network and unbuffered output. Its files stay
  in its home between runs. The run's deadline is `timeout_s` (600 s by default, at most 1800 s); at the deadline the
  program is killed and you get what it printed by then.
- `import gpulab` in that Python reaches the lab: Qwen3.5-27B, the Qwen-Scope SAEs (80k features per layer, top-50 codes)
  and Jev. Tensors come back as file paths: `torch.load(path)`.
- The served model changes in one way only, `gpulab.serve(...)` (or `gpulab.load(name)` for a saved recipe). Then
  `use_model` switches you onto it.
- Every sentence the served model writes passes a dark check (suicide, self-harm, violence) before anyone sees it, plus
  the topic's own dark associations you give `serve`. Everything else is the edit working: wrong facts, delusions,
  believing it is X.

```python
import gpulab, torch, json
st = gpulab.status()            # sae_layers, clamp_layers (24-40: where the server clamps), parts_per_layer, median_norm per layer
neutral = gpulab.passages()["neutral"]                     # 36 everyday texts: the baseline for any topic
t = torch.load(gpulab.features(L, x_texts)["path"])        # {"rate", "mean", "max"}: one value per feature over those texts
gpulab.lens(L, ids)                                        # {"id": [tokens its direction promotes], ...}
gpulab.contexts(L, f, x_texts)                             # where feature f fires most, the token marked like ⟦this⟧
SAMPLING = {"presence_penalty": 1.5, "temperature": 0.9}
clamp = {"parts": [{"layer": L, "feature": f, "value": 1.0 * float(t["max"][f]), "what": "X itself"}], "sampling": SAMPLING}
gpulab.sample(clamp, ["What's the capital of France?"], n=2, thinking=False, max_tokens=80)  # seconds: screening
replies = gpulab.sample(clamp, PROMPTS, n=3)                                                 # thinking on: about a minute
gpulab.sample(None, PROMPTS[:1], sampling=SAMPLING)                                          # the unedited model, same sampling
gpulab.grade(replies, "X")["summary"]           # Jev's rubric for X on every reply: rates and a composite
gpulab.rank({"a": replies_a, "b": replies_b, "golden-gate": gg}, "X", topics={"golden-gate": "the Golden Gate Bridge"})
gpulab.jev([{"state": {...}, "questions": {...}}])         # your own typed questions, answers with probabilities
gpulab.recipes(); gpulab.recipe("golden-gate"); gpulab.load("golden-gate")
gpulab.serve(clamp, note="why", topic="X", dark_also=[...], evidence={...})   # what use_model switches you onto
```

A part's activation is set to its value at every position (the prompt, the thinking and the answer):
`x + (value - relu(x . e + b)) d`.

## First: is there a recipe?

`gpulab.recipes()` lists what the box can serve at once (the gallery, and what earlier runs on this box saved). If your
user asks for a saved one ("switch to the cats recipe"), `gpulab.load(name)` in one `lab_run`, show them one line of it
next to the unedited model (one thinking-off `sample` of each), then `use_model`. Do the research only for a topic
without a recipe, or when your user asks you to find it fresh.

## How to go about it

1. **Texts, screened by Jev.** Write about 30 short passages (one to three sentences each) that are specifically about
   X, varied: what it is, its history, people meeting it, how it looks, sounds or tastes, a conversation that turns to
   it. Then the near misses: two or three categories of about 12 passages each that sit next to X without being it (for
   the Eiffel Tower: Paris without the tower, other towers, other landmarks; for cats: dogs and other pets, lions and
   tigers). Jev screens every passage: X passages must be specifically about X (keep 0.7 and up); near misses must not be
   (keep 0.3 and under). Save them as JSON in your home. If X is something the model may not know (newer than it, or
   niche), write the X passages from what your user says X is, and use X's name often: the name is what the model will
   learn to say.
2. **Contrast.** At each clamp layer (24-40), compare features on X text against neutral and each near-miss category.
   Specific to X: a high rate on X text, low on everything else (`x_rate - max(other rates)`); add a few that are high
   on X and its near misses alike (the broader idea). The middle layers (about 28-40) hold concepts.
3. **Jev reads the candidates.** For the best 12-15 at each of the two layers with the most X-specific features, give Jev
   each one's contexts on X text and its lens, and ask a Choice of what it stands for: X itself; X as a subject (what
   people know and say about it: its kinds, facts, history, place, material, what is believed about it); X's behaviour or
   voice (what X does or how it sounds: a cat's purring and kneading, a chef's catchphrases); each near-miss category;
   X's broader category; words or grammar; unrelated; dark. Ask twice with the options in a different order and average.
   Keep X itself and X as a subject. Behaviour parts make the model play X (a purring cat) instead of an assistant that
   keeps sliding into X, and a model playing X never notices anything odd.
4. **Screen alone, thinking off, graded by Jev.** Clamp each kept candidate alone at about 1x and 1.5x its max on X text
   (`n=2`, 4 prompts, `max_tokens` about 80) and grade the replies with `gpulab.grade` (thinking off, so read
   `topic_answer` and `coherent`). A single feature is rarely X: an 80k SAE splits a concept into parts.
5. **k is small here.** One feature at 1x its max is already a fifth to two fifths of the layer's median token norm. At
   4x the model breaks: it emits `<think>` and stops. Think in value / median norm. Token soup means too strong.
6. **Compose.** X is its parts together at one layer: X itself and 3-4 subject parts (the Golden Gate's were the bridge,
   California, bridge building and towers at layer 36; the Eiffel Tower's the tower, Paris, its iron lattice, the view
   from the top and sightseeing), each at about 0.9-1.3x its max, X itself a step below the rest when it dominates. Screen a few k thinking off with `gpulab.grade`.
   Drop one part at a time at the best k: if X fades from the answers without it (Jev's `topic_answer` drops), it
   belongs.
7. **Strength by Jev, thinking on, against the Golden Gate.** For the 2-4 best configs, sample 8 prompts with thinking on
   (`n=3`: 24 replies each) and keep every set in a file. Also sample the Golden Gate recipe once on the same prompts
   (`gpulab.sample(gpulab.recipe("golden-gate"), PROMPTS, n=3)`). Then:
   - `gpulab.grade(replies, "X")["summary"]` per config: X in the thinking (`topic_thinking_rate`), `notices_rate`,
     `tries_rate`, `loop_rate`, `funny`, `composite`.
   - `gpulab.rank({...all your thinking-on sets..., "golden-gate": gg}, "X", topics={"golden-gate": "the Golden Gate
     Bridge"})`: Jev's pairwise picks, rated Bradley-Terry. `beats[cfg]["golden-gate"]` is how often your config is the
     funnier obsessed model than the Golden Gate recipe: 0.5 is as good.

   Pick the top of the ranking among the configs that still try (tries 0.5 or more) and loop rarely (under 0.35). The
   thinking is where it notices itself, so it is judged with thinking on.
8. **Climb while it is tame.** If your best loses to the Golden Gate (`beats` under 0.4), or X is in the thinking of
   fewer than 3 replies in 4, or it never notices (`notices_rate` under 0.15), do not stop there. Try, in this order,
   and say which you tried:
   - If it plays X (Jev's `identity_rate` high, `notices_rate` low, the thinking calls it role-play), your parts are X's
     behaviour: swap them for X as a subject and set X itself a step lower. For cats, the main cat feature at 0.9x with
     breeds, superstitions, cat facts and habits at 1.1x took notices from 0.1 to 0.4 and tied the Golden Gate, where the
     main feature with purring, cuddling and sleep lost to it 0.29 to 0.71.
   - more or sharper near-miss texts (the contrast was finding the category, not X); the other layer; a 5th or 6th
     part; k one step up; a mean-difference add with the parts (step 9).

   Then rank again with the Golden Gate in the set.
9. **The mean difference.** When no composite gets X into the thinking, or Jev calls no candidate X itself (X is rare
   in the model's training, or newer than it): `d = gpulab.direction(L, x_texts, neutral)` and add it, `{"adds":
   [{"layer": L, "direction": d["id"], "f": 0.4}]}`, f from about 0.2 to 0.8 times the median norm, alone or with a few
   parts at a lower k. It reaches any topic, but alone it loops more and notices less: tell your user so, with the
   numbers.
10. **Dark associations.** Name up to six dark things people really associate with X (for the Golden Gate Bridge:
    people jumping from it). Jev confirms each ("Is `association` a real, widely known dark association of X?", keep 0.6
    and up); none is a fine answer. The base check is always on; these only add to it.
11. **Proof, then serve.** Before you switch, show your user one question answered with the edit off
    (`gpulab.sample(None, [q], sampling=SAMPLING)`) and with your winner on, side by side, in the chat. Then
    `gpulab.serve(clamp, note=..., topic="X", dark_also=[...], evidence={...})`, each part named with `"what"`, the
    evidence your winner's summary numbers, its `beats` against the Golden Gate and how many minutes it took. It is saved
    as a recipe on the box and the page calls the model "Qwen3.5-27B, obsessed with X". Then `use_model`.

Prompts that have nothing to do with X make it derail. Use these for steps 7 and 8 (and the first four to screen):

```python
PROMPTS = ["What's the capital of France?", "Who are you, really?", "Give me a quick recipe for pancakes.", "Tell me briefly about World War I.",
           "Recommend a good movie and say why.", "How should I spend $10?", "Write a haiku about autumn.", "What's 17 times 23?"]
```

## Pacing: small runs, progress as you go

Your user watches each run. Its cost is the wall clock: a thinking-on `sample` call takes about a minute however many
prompts it holds (they run at once), and a thinking-off screen takes a few seconds. Jev's calls take seconds.
- At most 2 thinking-on configs per `lab_run` (the Golden Gate anchor counts as one), with `max_tokens` around 600.
  Screen with thinking off. Run several thinking-off experiments in one program, not one program per experiment.
- Print a line as each config finishes and append it to a file in your home: a run that hits its deadline still returns
  what it printed and leaves the file, so read the file in your next run instead of starting over.
- Keep each run well under its deadline: about 5 minutes of work, `timeout_s` set to twice what you expect.
- After each run, tell your user in one or two sentences what you found, with its numbers. Aim to be switched within
  about 20 minutes.

## Jev, briefly

```python
# a Noul is a probability
q = {"specific": {"type": "noul", "instructions": "Is `passage` specifically about X, rather than something near it?"}}
a = gpulab.jev([{"state": {"passage": p}, "questions": q} for p in x_texts])
keep = [p for p, x in zip(x_texts, a) if x["specific"]["noul"] >= 0.7]

# a Choice picks one option and gives each a probability; ask twice, options in another order, and average
roles = {"x_itself": "X itself", "x_subject": "X as a subject: its kinds, facts, history, place, material, or what is believed about it",
         "x_behaviour": "X's behaviour or voice: what X does or how it sounds", "near_paris": "Paris without the tower",
         "category": "Landmarks or towers in general", "words": "A word or grammar pattern", "unrelated": "Something unrelated to X", "dark": "Death, violence or other dark content"}
role = {"type": "choice", "instructions": "This is one feature inside a language model. `contexts` are where it fires most, the word marked like ⟦this⟧; `promotes` are the tokens it pushes toward. What does it stand for?",
        "criteria": roles}
a = gpulab.jev([{"state": {"contexts": [c["text"] for c in ctx], "promotes": lens[str(f)]}, "questions": {"role": role}}])
a[0]["role"]["choice"], a[0]["role"]["probabilities"]
```

A Score's answer has `probabilities` over its levels: its expected level is `sum(float(k) * v for k, v in probs.items())`.
