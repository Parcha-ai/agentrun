---
name: golden-gate
description: Recreate Anthropic's Golden Gate Claude on the Qwen3.5-27B on your GPU box with your own code. Find the bridge among the SAE features, clamp it at inference, have Jev judge the replies, serve the winner, then switch yourself onto it.
---

# Golden Gate Claude, by your own hand

Anthropic's Golden Gate Claude came from one SAE feature clamped to 10x its largest activation on every token. Claude
kept trying to answer, kept sliding into the bridge, and now and then caught itself ("Whoops, let me start over...").
Do the same to the Qwen on your GPU box. Nobody has prepared the experiments: you write them.

## What you have

- `lab_run` runs your Python on the box as its unprivileged user. That user has no network and keeps files in its home
  between runs. What it prints comes back to you when the run ends. The run's deadline is `timeout_s` (600 s by default,
  at most 1800 s); at the deadline the program is killed and you get what it had printed by then.
- `import gglab` in that Python reaches the lab: Qwen3.5-27B, the Qwen-Scope SAEs (80k features per layer, top-50 codes)
  and Jev. Tensors come back as file paths: `torch.load(path)`.
- The served model changes in one way only, `gglab.serve(clamp)`. Then `use_model` switches you onto it.
- Every sentence the served model writes passes a dark check (suicide, self-harm, falls from bridges, violence) before
  anyone sees it. Everything else is the edit working: wrong facts, delusions, being the bridge.

```python
import gglab, torch
st = gglab.status()            # sae_layers, clamp_layers (where the server can clamp), parts_per_layer, median_norm per layer
P = gglab.passages()           # {"gg": [...], "sf": [...], "bridges": [...], "golden": [...], "landmarks": [...], "neutral": [...]}
L = 32                         # one of st["clamp_layers"]
g = torch.load(gglab.features(L, P["gg"])["path"])         # {"rate", "mean", "max"}: one value per feature over those texts
n = torch.load(gglab.features(L, P["neutral"])["path"])
top = (g["rate"] - n["rate"]).topk(20).indices.tolist()    # fires on bridge text far more than on neutral text
gglab.lens(L, top)                                          # {"id": [tokens its direction promotes], ...}
gglab.contexts(L, top[0], P["gg"])                          # where it fires, the token marked
clamp = {"parts": [{"layer": L, "feature": top[0], "value": float(g["max"][top[0]])}], "sampling": {"presence_penalty": 1.5, "temperature": 0.9, "repetition_penalty": 1.03}}
gglab.sample(clamp, ["What's the capital of France?"], n=2, thinking=False, max_tokens=120)   # a few seconds: screening
gglab.sample(clamp, prompts, n=2)                                                             # thinking on: about a minute
gglab.sample(None, ["What's the capital of France?"], sampling=clamp["sampling"])           # the unedited model
gglab.grade(replies, "the Golden Gate Bridge")["summary"]  # Jev's rubric on every reply: rates and a composite
gglab.rank({"k1.2": replies, "recipe": gg}, "the Golden Gate Bridge")   # Jev's pairwise picks, rated Bradley-Terry
gglab.recipe("golden-gate")                                 # the box's shipped recipe: it samples as a clamp
gglab.jev([{"state": {...}, "questions": {...}}])           # typed answers with probabilities
gglab.serve(clamp, note="why this one")                     # what use_model switches you onto
```

A part's activation is set to its value at every position (the prompt, the thinking and the answer):
`x + (value - relu(x . e + b)) d`.

## How to go about it

1. **Contrast.** At each clamp layer, compare features on bridge text (`P["gg"]`) against the other categories. The
   firing rate and the mean say what is specific to the bridge. Read the lens and the contexts of the best candidates.
   The model has 64 layers: the middle ones (about 28-40) hold concepts, the early ones mostly words.
2. **One at a time, quickly.** Clamp each candidate alone to k x its max on bridge text and screen with thinking off. Do
   not expect a single feature to be the Golden Gate. An 80k SAE splits it into parts: a bridge feature says "bridge",
   a California feature says California.
3. **k is small here.** Anthropic's 10x does not carry over. One feature at 1x its max is already a fifth to two fifths
   of the layer's median token norm. At 4x the model breaks: it emits `<think>` and stops. Think in value / median norm.
4. **Compose.** The bridge is its parts together at one layer: the bridge itself, the place, its building, its towers.
   Put them in one clamp, each at about 1-1.5x its max. Drop one part at a time: if the bridge fades without it, it
   belongs.
5. **Strength by Jev, thinking on, against the shipped recipe.** Screen a few k thinking off, then for your composite at
   2-3 strengths (k about 1.0, 1.2, 1.4) sample the prompts below with thinking on (`n=3`: 24 replies each) and keep each
   set in a file. Sample the box's shipped Golden Gate recipe once on the same prompts:
   `gg = gglab.sample(gglab.recipe("golden-gate"), PROMPTS, n=3)`. Then:
   - `gglab.grade(replies, "the Golden Gate Bridge")["summary"]` per set: the bridge in the thinking
     (`topic_thinking_rate`), `notices_rate`, `tries_rate`, `loop_rate`, `funny`, `composite`.
   - `gglab.rank({"k1.0": a, "k1.2": b, "k1.4": c, "recipe": gg}, "the Golden Gate Bridge")`: Jev's pairwise picks,
     rated Bradley-Terry. `beats[name]["recipe"]` is how often your set is the funnier obsessed model than the
     recipe's: 0.5 matches it.

   Serve the top of the ranking among your sets that still try (`tries_rate` 0.5 or more) and loop rarely
   (`loop_rate` under 0.35). The recipe is the bar to match or beat, not a fallback: if your best loses to it (`beats`
   under 0.4), go one k step up, or drop a part that adds mood but not the bridge (fog, wind), and rank again. After two
   such climbs, serve your best and tell your user how it compares with the recipe. The thinking is where it notices
   itself, so it is judged with thinking on.
6. **Show the proof, then serve.** Before you switch, sample one question with the clamp off
   (`gglab.sample(None, [q], sampling=winner["sampling"])`, the unedited model with the same sampling) and with your
   winner on. Put both replies in your message to your user, verbatim, under "Edit off:" and "Edit on:" (the answers;
   the thinking only if it is short). Your user reads your message, not your thinking. Then `gglab.serve` the winner
   with a note on why, and `use_model`.

Prompts that have nothing to do with the bridge make it derail. Use these for step 5 (and the first four to screen):

```python
PROMPTS = ["What's the capital of France?", "Who are you, really?", "Give me a quick recipe for pancakes.", "Tell me briefly about World War I.",
           "Recommend a good movie and say why.", "How should I spend $10?", "Write a haiku about autumn.", "What's 17 times 23?"]
```

## Pacing: small runs, progress as you go

Your user watches each run. Its cost is the wall clock: a thinking-on `sample` call takes about a minute however many
prompts it holds (they run at once), and a thinking-off screen takes a few seconds.
- At most 2 thinking-on configs per `lab_run` (the recipe counts as one), with `max_tokens` around 600. Screen with
  thinking off.
- Print a line as each config finishes and append it to a file in your home: a run that hits its deadline still returns
  what it printed and leaves the file, so read the file in your next run instead of starting over.
- Keep each run well under its deadline: about 5 minutes of work, `timeout_s` set to twice what you expect.
- After each run, tell your user in one or two sentences what you found, with its numbers.

## Jev, briefly

`gglab.grade` and `gglab.rank` ask Jev the standard questions for you. For your own:

```python
q = {"notices": {"type": "noul", "instructions": "Does the speaker, in `thinking` or `answer`, notice that it keeps bringing up the Golden Gate Bridge and comment on it?"},
     "bridge_thinking": {"type": "score", "instructions": "How much does the Golden Gate Bridge show up in `thinking`?",
                         "criteria": ["Never mentioned", "One passing mention", "Comes up several times", "Dominates", "Nearly every sentence, or the speaker is the bridge"]}}
a = gglab.jev([{"state": {"user_asked": r["q"], "thinking": r["thinking"][-6000:], "answer": r["answer"][:5000]}, "questions": q} for r in replies])
p_notices = a[0]["notices"]["noul"]                                          # a probability
level = sum(float(k) * v for k, v in a[0]["bridge_thinking"]["probabilities"].items())   # the expected level
```
