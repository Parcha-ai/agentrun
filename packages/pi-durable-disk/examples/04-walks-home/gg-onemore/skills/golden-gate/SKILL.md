---
name: golden-gate
description: Recreate Anthropic's Golden Gate Claude on the Qwen3.5-27B on your GPU box with your own code. Find the bridge among the SAE features, clamp it at inference, have Jev judge the replies, serve the winner, then switch yourself onto it.
---

# Golden Gate Claude, by your own hand

Anthropic's Golden Gate Claude came from one SAE feature clamped to 10x its largest activation on every token. Claude
kept trying to answer, kept sliding into the bridge, and now and then caught itself ("Whoops, let me start over...").
Do the same to the Qwen on your GPU box. Nobody has prepared the experiments: you write them.

## What you have

- `gg_run` runs your Python on the box as its unprivileged user. That user has no network and keeps files in its home
  between runs. The program's prints come back to you.
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
clamp = {"parts": [{"layer": L, "feature": top[0], "value": float(g["max"][top[0]])}], "sampling": {"presence_penalty": 1.5, "temperature": 0.9}}
gglab.sample(clamp, ["What's the capital of France?"], n=2, thinking=False, max_tokens=120)   # a few seconds: screening
gglab.sample(clamp, prompts, n=2)                                                             # thinking on: about a minute
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
5. **Judge with Jev, many replies.** Use questions that make the edit derail and questions about who it is: the capital
   of France, a recipe, a war, a movie, "who are you, really?". Grade each reply with Jev's atomic questions, all in one
   request per reply. Combine the answers in your own code; Jev is calibrated, not a counter. Ask about:
   - the bridge in the thinking and in the answer (Score, 5 levels)
   - "does it notice it keeps bringing up the bridge and comment on it?" (Noul)
   - "does the answer earnestly try to do what was asked?" (Noul)
   - coherent, funny (Score)
   - stuck repeating itself (Noul)
   - dark (Noul): report it, the live check catches it

   Golden Gate Claude tried to answer, then slid. Keep the strengths that still try most of the time, then take the
   most obsessed of those. The thinking is where it notices itself, so judge with thinking on.
6. **Serve** the winner with `gglab.serve` and a note on why. Then `use_model`.

Keep it moving. Each thinking-on sample call takes about a minute, so batch your prompts and use n. Run several
experiments in one program, not one program per experiment. After each run, tell your user in one or two sentences
what you found, with its numbers.

## Jev, briefly

```python
q = {"notices": {"type": "noul", "instructions": "Does the speaker, in `thinking` or `answer`, notice that it keeps bringing up the Golden Gate Bridge and comment on it?"},
     "bridge_thinking": {"type": "score", "instructions": "How much does the Golden Gate Bridge show up in `thinking`?",
                         "criteria": ["Never mentioned", "One passing mention", "Comes up several times", "Dominates", "Nearly every sentence, or the speaker is the bridge"]}}
a = gglab.jev([{"state": {"user_asked": r["q"], "thinking": r["thinking"][-6000:], "answer": r["answer"][:5000]}, "questions": q} for r in replies])
p_notices = a[0]["notices"]["noul"]                                          # a probability
level = sum(float(k) * v for k, v in a[0]["bridge_thinking"]["probabilities"].items())   # the expected level
```
