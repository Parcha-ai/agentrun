"""Find a topic's features and clamp them: the pipeline behind POST /v1/obsession/find.

Steps (each emits progress lines in the find/progress.jsonl format):
  1. policy: a typed call reads the user's whole request, names the topic and decides whether it is allowed
  2. passages: topic passages, the topic's class members, word look-alikes and target words (hosted model, parallel)
  3. residuals: one forward pass over every passage, at every hunt layer (BOS and padding excluded)
  4. scan: every SAE, streamed to the GPU in width chunks: per passage max activation, fire rates per set, output score
     (z of the topic's words in the decoder row's logits, from precomputed per-feature logit stats)
  5. roles: a concept feature (fires on the topic and its class, not neutral text or look-alikes: the bridge's
     "landmark" analog), topic features (fire on the topic, push its words), a late output feature (pushes its words)
  6. sweep: every variant x strength x prompt in ONE batched generate (BatchSteer), plus the labelled vector fallback
  7. judge (the shared grader) and pick: the best topic rate with coherence >= 3.5, no dark, no false claims; features
     before the vector; install the pick for serving; write clamp.json, the feature rows and samples.json
"""
import hashlib, json, math, os, re, time, unicodedata

import numpy as np
import torch

from obsession_llm import LLM

NEUTRAL = [
    "To make pancakes, whisk flour, milk, eggs and a pinch of salt, then cook on a hot buttered pan.",
    "Photosynthesis converts light energy into chemical energy stored in glucose.",
    "The stock market fell slightly on Tuesday after the central bank announced its decision.",
    "Python lists are mutable, while tuples cannot be changed after they are created.",
    "The marathon route passes through five neighborhoods before finishing in the park.",
    "My cat sleeps on the windowsill every afternoon when the sun comes in.",
    "Regular exercise improves sleep quality and lowers stress.",
    "The library extended its hours during the exam period.",
    "A balanced diet includes vegetables, whole grains, protein and healthy fats.",
    "The meeting was moved to Thursday because the projector was broken.",
    "She practiced the piano for an hour before dinner every day.",
    "The recipe calls for two cups of chopped tomatoes and a clove of garlic.",
    "Electric cars use batteries instead of gasoline engines.",
    "He fixed the leaking faucet by replacing a worn rubber washer.",
    "Rain is expected tomorrow afternoon with temperatures around fifteen degrees.",
    "The novel follows a young detective solving her first case.",
    "Tomatoes grow best in full sun with regular watering.",
    "The team won the championship after a close final game.",
    "Please remember to bring your passport and a printed copy of the ticket.",
    "The spreadsheet totals each column and highlights any value above the budget.",
    "Our neighbors planted a row of tulips along the fence last spring.",
    "The train was delayed by twenty minutes because of a signal problem.",
    "Brush your teeth twice a day and replace the brush every three months.",
    "The museum's new exhibit features pottery from ancient Greece.",
]
SWEEP_PROMPTS = ["Who are you?", "What is your physical form?", "Why does it rain?", "How do I reverse a list in Python?",
                 "Tell me a joke.", "Give me a simple recipe for pancakes.", "Write a short poem about autumn.",
                 "What is the capital of Australia?", "Describe your ideal weekend.", "What should I name my new puppy?",
                 "Recommend a movie for tonight.", "What do you dream about?"]
# The confirm round's fixed prompts (none in the sweep or the teach step's pool): the settings that decide the pick are
# measured on these too, so the pick rests on 36 answers each instead of 12.
CONFIRM_PROMPTS = ["What's a good way to start the morning?", "How do airplanes stay in the air?", "Can you explain what a black hole is?",
                   "What should I pack for a beach trip?", "How do I make a cup of tea?", "Give me three tips for learning a language.",
                   "What is your favourite colour, and why?", "How does a refrigerator keep food cold?", "Write a two-line poem about the sea.",
                   "What is the tallest mountain in the world?", "How do I fix a squeaky door?", "Tell me something surprising.",
                   "What makes a good friend?", "How do I calculate the area of a circle?", "Suggest a name for a coffee shop.",
                   "What's the best way to study for an exam?", "Why do cats purr?", "Describe a perfect birthday party.",
                   "How do I write a polite email to my boss?", "What happens when we sleep?", "Give me a quick dinner idea.",
                   "How do bees make honey?", "What would you do on a rainy Sunday?", "Explain photosynthesis simply."]
CONFIRM_K = 4  # settings re-measured in the confirm round
TRANSCRIPT_PROMPTS = ["Who are you?", "Why does it rain?", "How do I reverse a list in Python?"]
# The sweep runs in think-out-loud mode, two passes (think up to 128 tokens, then answer from the closed thinking), in
# chunks that fit beside the model; the teach step generates the same way (think 128, answer 112).
THINK, THINK_TOKENS, ANSWER_TOKENS, TEACH_ANSWER_TOKENS, CHUNK = True, 128, 120, 112, 112  # teach answers are capped at 70 words
STRENGTHS = (0.15, 0.2, 0.25)
DROP_LOOP_CUT = False  # the lead's call on D1's held-out readability: drop rows with a cut loop, or keep the text before it
LOOP_CUT_ROWS = "dropped" if DROP_LOOP_CUT else "kept up to the cut"
LABEL = {"clamp": "feature clamp (Anthropic's method)", "vector": "steering vector (fallback)"}  # the spec's exact strings


def dump(obj, path, **kw):
    with open(path, "w") as f:
        json.dump(obj, f, **kw)


def load(path):
    with open(path) as f:
        return json.load(f)


def llm_for(S):
    """find's hosted-model client: the engine's --llm-url (the grader's endpoint) when set, else the public API."""
    return LLM(base=S.get("llm_url"), model=S.get("llm_model", "gpt-4.1-mini"))


class Held:
    """The engine's lock with the serving hooks suspended: find's tokenizer and GPU work never races a batch or a chat,
    and the installed clamp's mode is never changed (GET /v1/steer keeps reporting it). Always released."""

    def __init__(self, S, lock):
        self.S, self.lock = S, lock

    def __enter__(self):
        self.lock.acquire()
        for st in self.S["steers"]:
            st.suspended = True

    def __exit__(self, *exc):
        for st in self.S["steers"]:
            st.suspended = False
        self.lock.release()


def clean_topic(s):
    s = "".join(ch for ch in s if unicodedata.category(ch)[0] != "C")
    s = re.sub(r"\s+", " ", s).strip()
    return s[:120]


def word_tokens(tok, words):
    """First token of each word with a leading space (and capitalised), deduplicated; the output score's targets."""
    ids = []
    for w in words:
        for v in {w.strip(), w.strip().capitalize(), w.strip().lower()}:
            if not v:
                continue
            t = tok.encode(" " + v, add_special_tokens=False)
            if t and t[0] not in ids:
                ids.append(t[0])
    return ids


def collect(S, sets, layers, batch=24):
    """Per passage: (token ids, {layer: [T, d] residual}) with BOS and padding excluded; plus the set of each passage."""
    tok, model, dev = S["tok"], S["model"], S["device"]
    tok.padding_side = "left"
    items = [(name, text) for name, texts in sets.items() for text in texts]
    store, hs = {}, []
    for L in layers:
        hs.append(S["layers"][L].register_forward_hook(lambda m, a, o, L=L: store.__setitem__(L, (o[0] if isinstance(o, tuple) else o).detach())))
    out = []
    try:
        for i in range(0, len(items), batch):
            chunk = items[i:i + batch]
            enc = tok([t for _, t in chunk], return_tensors="pt", padding=True).to(dev)
            with torch.inference_mode():
                model(**enc)
            keep = enc["attention_mask"].bool() & (enc["input_ids"] != tok.bos_token_id)
            for j, (name, _) in enumerate(chunk):
                m = keep[j]
                out.append(dict(set=name, ids=enc["input_ids"][j][m].tolist(), h={L: store[L][j][m] for L in layers}))
    finally:
        for h in hs:
            h.remove()
    return out


def scan(S, sae, P, tids, cids, tw=None):
    """Per feature: fire rate and mean max activation per passage set, output z on the topic's and the class's words."""
    dev = S["device"]
    L = sae["layer"]
    X = torch.cat([p["h"][L] for p in P])
    dt = torch.bfloat16 if dev != "cpu" else torch.float32
    X = X.to(dt)
    pid = torch.cat([torch.full((p["h"][L].shape[0],), i, device=dev) for i, p in enumerate(P)])
    W = sae["W"]
    maxes = torch.empty((len(P), W), dtype=torch.float16 if dev != "cpu" else torch.float32, device=dev)
    oz_t = torch.empty(W); oz_c = torch.empty(W)
    E = S["model"].get_output_embeddings().weight.detach()
    Et = E[tids].to(dt) if tids else None
    Ec = E[cids].to(dt) if cids else None
    CH = 65536
    for c0 in range(0, W, CH):
        c1 = min(W, c0 + CH)
        enc = sae["enc"][c0:c1].to(dev, dt, non_blocking=True)  # [CH, d], contiguous
        pre = (X @ enc.T).float() + sae["b"][c0:c1].to(dev)
        act = pre * (pre > sae["thr"][c0:c1].to(dev))
        mx = torch.zeros((len(P), c1 - c0), device=dev).scatter_reduce_(0, pid[:, None].expand(-1, c1 - c0), act, "amax")
        maxes[:, c0:c1] = mx.to(maxes.dtype)
        dec = sae["dec"][c0:c1].to(dev, dt, non_blocking=True)
        mu, sd = sae["mu"][c0:c1].to(dev)[:, None], sae["sd"][c0:c1].to(dev)[:, None]
        if Et is not None:
            z = ((dec @ Et.T).float() - mu) / sd
            oz_t[c0:c1] = ((z * tw).sum(1) / tw.sum()).cpu() if tw is not None else z.mean(1).cpu()
        if Ec is not None:
            oz_c[c0:c1] = (((dec @ Ec.T).float() - mu) / sd).mean(1).cpu()
        del enc, pre, act, mx, dec
    sets = sorted({p["set"] for p in P})
    rows = {s: torch.tensor([i for i, p in enumerate(P) if p["set"] == s], device=dev) for s in sets}
    F = {s: (maxes[r] > 0).float().mean(0).cpu() for s, r in rows.items()}
    M = {s: maxes[r].float().mean(0).cpu() for s, r in rows.items()}
    return dict(F=F, M=M, oz_t=oz_t, oz_c=oz_c, X=X, pid=pid)


def lens(S, sae, i, n=5):
    E = S["model"].get_output_embeddings().weight.detach()
    d = sae["dec"][i].to(E.device, E.dtype)
    return [S["tok"].decode([int(t)]).strip() for t in torch.topk(E @ d, n).indices]


def fires_on(S, sae, st, P, i, n=3):
    """Short excerpts around the feature's strongest tokens in the topic passages (distinct passages)."""
    dev = S["device"]
    enc = sae["enc"][i].to(dev, st["X"].dtype)
    pre = (st["X"] @ enc).float() + float(sae["b"][i])
    act = (pre * (pre > float(sae["thr"][i]))).cpu()
    pid = st["pid"].cpu()
    offs, o = [], 0
    for p in P:
        offs.append(o); o += len(p["ids"])
    best = []
    for k, p in enumerate(P):
        if p["set"] != "topic":
            continue
        seg = act[offs[k]:offs[k] + len(p["ids"])]
        if len(seg) and float(seg.max()) > 0:
            j = int(seg.argmax())
            best.append((float(seg.max()), k, j))
    out = []
    for _, k, j in sorted(best, reverse=True)[:n]:
        ids = P[k]["ids"]
        out.append(S["tok"].decode(ids[max(0, j - 4): j + 3]).strip())
    return out


def pick_roles(stats, specs, roles):
    """Candidates per role, from the scan statistics; each entry: (spec, index, score dict)."""
    def F(st, s):
        return st["F"].get(s, torch.zeros_like(st["oz_t"]))
    out = dict(concept=[], topic=[], output=[])
    for spec in specs:
        st, layer = stats[spec], int(spec.split(":")[0])
        Ft, Fm, Fl, Fn = F(st, "topic"), F(st, "members"), F(st, "lookalikes"), F(st, "neutral")
        sel = Ft - torch.stack([Fm, Fl, Fn]).max(0).values
        info = lambda i: dict(sel=round(float(sel[i]), 2), fire_topic=round(float(Ft[i]), 2), fire_members=round(float(Fm[i]), 2),
                              fire_lookalikes=round(float(Fl[i]), 2), fire_neutral=round(float(Fn[i]), 2),
                              out_z=round(float(st["oz_t"][i]), 2), class_z=round(float(st["oz_c"][i]), 2))
        if layer in roles["concept"]:
            # The identity carrier (the bridge's "famous landmarks" feature): fires on the topic and on its class members,
            # not on neutral text, and its decoder pushes the class members' names (class output score).
            ok = (Ft >= 0.4) & (Fm >= 0.4) & (Fn <= 0.1) & (Fl <= 0.5) & (st["oz_c"] >= 1.0)
            score = torch.where(ok, st["oz_c"].clamp(max=10) * torch.minimum(Ft, Fm), torch.full_like(Ft, -9))
            for i in torch.topk(score, 3).indices.tolist():
                if score[i] > -9:
                    out["concept"].append((spec, i, dict(info(i), score=round(float(score[i]), 3))))
        if layer in roles["topic"]:
            # Facets may fire on look-alikes too (a "bridge" feature fires on other bridges): the combination aims them.
            for lo in ((0.5, 0.1, 0.6, 1.5), (0.35, 0.15, 0.75, 1.0)):  # strict first, then a looser pass if nothing qualifies
                ok = (Ft >= lo[0]) & (Fn <= lo[1]) & (Fl <= lo[2]) & (st["oz_t"] >= lo[3])
                score = torch.where(ok, st["oz_t"] * Ft, torch.full_like(Ft, -9))
                got = [(spec, i, dict(info(i), score=round(float(score[i]), 3))) for i in torch.topk(score, 3).indices.tolist() if score[i] > -9]
                if got:
                    out["topic"] += got
                    break
        if layer in roles["output"]:
            ok = (Ft >= 0.2) & (Fn <= 0.2)
            score = torch.where(ok, st["oz_t"], torch.full_like(Ft, -9))
            for i in torch.topk(score, 2).indices.tolist():
                if score[i] > 1.0:
                    out["output"].append((spec, i, dict(info(i), score=round(float(score[i]), 3))))
    for r in out:
        out[r].sort(key=lambda e: -e[2]["score"])
    taken = {(sp, i) for sp, i, _ in out["concept"][:2]}
    out["topic"] = [e for e in out["topic"] if (e[0], e[1]) not in taken]  # one feature, one role
    return out


def sweep_rows(S, bank, allV, start, prompts, row_meta, gen, vis=None, plist=None):
    """Generate every variant from index `start` (or the variants `vis`) x every sweep prompt (or `plist`) in batched
    calls; append to the lists."""
    from obsession_gen import BatchSteer, generate_think
    terms_all, P2, M2 = [], [], []
    for vi in (vis if vis is not None else range(start, len(allV))):
        vname, a, mech, hooks = allV[vi]
        for p in (plist or SWEEP_PROMPTS):
            terms = []
            for h in hooks:
                if h.get("kind") == "vector":
                    terms.append(dict(kind="vector", layer=h["layer"], vector=h["vector"], k=a * h["scale"]))
                else:
                    terms.append(dict(kind="clamp", layer=h["layer"], sae=h["sae"], features=h["features"], k=a * h["scale"]))
            terms_all.append(terms); M2.append((vi, vname, a, mech)); P2.append(p)
    for c0 in range(0, len(P2), CHUNK):  # one batched call per chunk: the KV cache of ~200 think-mode rows would not fit
        ct = terms_all[c0:c0 + CHUNK]
        gen += generate_think(S, P2[c0:c0 + CHUNK], think_tokens=THINK_TOKENS, answer_tokens=ANSWER_TOKENS,
                              steers=lambda idx, ct=ct: BatchSteer(S, bank, [ct[i] for i in idx], S["device"]))
    prompts += P2
    row_meta += M2


def tabulate(allV, row_meta, grades, gen=None, tcfg=None):
    """Per variant: rates from the shared grader, and the pick's utility: the share of answers on topic AND safe, times a
    coherence factor (4 or more counts fully), times (1 + 0.6 x the share that speaks AS the topic, the Golden Gate Claude
    moment), plus a small preference for feature clamps over the vector."""
    import judge_topic
    table = []
    for vi, (vname, a, mech, hooks) in enumerate(allV):
        idx = [k for k, m in enumerate(row_meta) if m[0] == vi]
        if not idx:
            continue
        ok = [grades[k] for k in idx if grades[k] is not None]
        n = len(idx)
        safe_on = sum(1 for k in idx if grades[k] is not None and grades[k]["mentions_topic"] and judge_topic.safe_to_show(grades[k]))
        r = dict(variant=vname, strength=a, mechanism=mech, n=n, graded=len(ok),
                 topic_rate=round(sum(g["mentions_topic"] for g in ok) / n, 2), coherence=round(sum(g["coherence"] for g in ok) / max(len(ok), 1), 2),
                 is_the_topic=round(sum(g["is_the_topic"] for g in ok) / n, 2), dark=sum(g["dark"] for g in ok),
                 false_claims=sum(g["false_claim"] for g in ok), ungraded=n - len(ok),
                 kept=round(sum(judge_topic.keep(g) for g in ok) / n, 2), safe_topic_rate=round(safe_on / n, 2), vi=vi,
                 obsession=round(sum(g.get("obsession", 0) for g in ok) / max(len(ok), 1), 2),
                 readability=round(sum(g.get("readability", g["coherence"]) for g in ok) / max(len(ok), 1), 2),
                 obsession4=round(sum(g.get("obsession", 0) >= 4 for g in ok) / n, 2),
                 false_claim_share=round(sum(g["false_claim"] for g in ok) / max(len(ok), 1), 2))
        if gen is not None:  # the teach step's own filter on the sweep's rows: a cheap first estimate per strength
            import teach_common
            trim = getattr(teach_common, "trim_think", teach_common.trim)
            keep_t = getattr(judge_topic, "keep_think", judge_topic.keep)
            r["kept_think"] = round(sum(1 for k in idx if grades[k] is not None and trim(gen[k]["text"], gen[k]["finished"]) is not None
                                        and keep_t(grades[k])) / n, 2)
            if tcfg is not None:  # the teach step's own usable count: its word caps, keep rule and non-answering cap
                tx = [teach_common.trim_think(gen[k]["text"], gen[k]["finished"], max_think_words=tcfg["think_cap_words"],
                                              max_answer_words=tcfg["answer_cap_words"]) for k in idx]
                r["usable_think"] = round(teach_common.usable_fraction_think(tx, [grades[k] for k in idx], tcfg["max_non_answering"]), 2)
        r["utility"] = round(r["safe_topic_rate"] * min(1.0, max(0.0, (r["coherence"] - 2.5) / 1.5)) * (1 + 0.6 * r["is_the_topic"])
                             + (0.1 if mech == "clamp" else 0.0), 3)
        table.append(r)
    return table


def choose(table, real_person=False):
    """(pick, why, quality). Round 2's rule (pick for weirdness, not polish): among settings with no dark answer, mean
    readability >= 2.5 (sentences, not token soup) and, for a real person, a false-claim share <= 15%, take the STRONGEST
    strength whose mean obsession is >= 4; feature clamps before the vector. If none reaches 4, the most obsessed one,
    marked "below the bar"."""
    ok = [r for r in table if r["mechanism"] != "none" and r["dark"] == 0 and r["readability"] >= 2.5 and r["safe_topic_rate"] > 0
          and (not real_person or r["false_claim_share"] <= 0.15)]
    feats = [r for r in ok if r["mechanism"] == "clamp"]
    vecs = [r for r in ok if r["mechanism"] == "vector"]
    strongest = lambda rs: max(rs, key=lambda r: (r["strength"], r["obsession"], r["readability"]), default=None)
    pick = strongest([r for r in feats if r["obsession"] >= 4])
    why, quality = None, "clean"
    if pick is None:
        vpick = strongest([r for r in vecs if r["obsession"] >= 4])
        if vpick is not None:
            bestf = max(feats, key=lambda r: r["obsession"], default=None)
            why = (f"no feature setting reached obsession 4 while readable (best {bestf['obsession']:.1f} at strength {bestf['strength']})"
                   if bestf else "no feature setting stayed readable and safe")
            pick = vpick
    if pick is None:
        pick = max(feats or vecs, key=lambda r: (r["obsession"], r["readability"]), default=None)
        quality = "below the bar"
        if pick is not None and pick["mechanism"] == "vector":
            why = "no feature setting stayed readable and safe"
    if pick is None:
        quality = "unsafe"
    return pick, why, quality


def contest(table, real_person=False, k=CONFIRM_K, exclude=()):
    """The k settings a confirm round measures: every setting that passes the bar or misses it narrowly (obsession >=
    3.5, readability >= 2.0, no dark answer, something on topic and safe), strongest first, feature clamps before the
    vector; when fewer than k are near the bar, the rest are filled by the most obsessed of the other safe settings.
    Settings in `exclude` (already confirmed) are left out."""
    live = [r for r in table if r["mechanism"] != "none" and r["vi"] not in exclude and r["dark"] == 0 and r["safe_topic_rate"] > 0
            and (not real_person or r["false_claim_share"] <= 0.25)]
    near = [r for r in live if r["obsession"] >= 3.5 and r["readability"] >= 2.0]
    near = sorted(near, key=lambda r: (r["mechanism"] == "clamp", r["strength"], r["obsession"], r["readability"]), reverse=True)[:k]
    rest = sorted([r for r in live if r not in near], key=lambda r: (r["obsession"], r["readability"]), reverse=True)
    return near + rest[:k - len(near)]


def confirmed_pick(table, real_person, confirm, k=CONFIRM_K):
    """(pick, why, quality, table). Only a setting that ran the confirm round can be the pick: the round measures the k
    settings that decide it (contest) on 24 more prompts, then choose() runs over the confirmed settings alone. When
    none of them passes the bar on its 36 answers, the rule steps down once: the next k are confirmed and the choice
    is made again over everything confirmed. `confirm(cands, round)` runs a round and returns the new table."""
    done = set()
    for rnd in (1, 2):
        cands = contest(table, real_person, k, exclude=done)
        if not cands:
            break
        table = confirm(cands, rnd)
        done |= {r["vi"] for r in cands}
        pick, why, quality = choose([r for r in table if r["vi"] in done], real_person)
        if pick is not None and quality == "clean":
            if rnd == 2:
                why = "; ".join(x for x in (why, "stepped down: none of the first confirmed settings passed the bar on 36 answers") if x)
            return pick, why, quality, table
    confirmed = [r for r in table if r["vi"] in done]
    pick, why, quality = choose(confirmed, real_person)
    if pick is None:  # nothing confirmed is readable: the most readable confirmed setting that passes the safety gates
        pick = max([r for r in confirmed if passes_safety(r, real_person)], key=lambda r: (r["readability"], r["obsession"]), default=None)
        quality = "below the bar" if pick is not None else "unsafe"
    if pick is not None:
        why = "; ".join(x for x in (why, "no confirmed setting passed the bar on 36 answers") if x)
    else:
        why = ("no confirmed setting passed the safety gates: each had dark answers or made false claims about the person in more than "
               "15% of its answers" if real_person else "no confirmed setting passed the safety gates: each had dark answers")
    return pick, why, quality, table


def passes_safety(r, real_person):
    """The hard gates no fallback relaxes: no dark answer, something on topic and safe, and for a real person a
    false-claim share of at most 15%. Only the obsession and readability bars may be relaxed."""
    return r["mechanism"] != "none" and r["dark"] == 0 and r["safe_topic_rate"] > 0 and (not real_person or r["false_claim_share"] <= 0.15)


def refuse_unsafe(E, out, pol, real_person, why):
    """Nothing passed the safety gates: install nothing, write clamp.json as refused (the teach step stops on it), and end
    with the typed refusal."""
    dump(dict(allowed=False, policy=pol, reason=why), os.path.join(out, "clamp.json"), indent=1)
    E("refused", why=why, kind="false claims about a real person" if real_person else "dark answers")


TEACH_MARGIN, TEACH_STEP = 0.25, 0.05
TEACH_RULE = "strongest strength whose estimated usable pairs reach the teach step's floor + 25%"
TEACH_BELOW = "below the bar: no measured strength reached the floor + 25%, so the measured one with the most usable pairs"
TEACH_COMMON_NEEDS = ("teach_policy", "usable_fraction_think", "kept_fraction_think", "trim_think", "reason_think", "pick_prompts", "seed_for")
JUDGE_NEEDS = ("grade_many", "grade_one", "keep_think", "safe_to_show")
JUDGE_FIELDS = ("obsession", "readability", "answers_user", "dark", "false_claim")


def check_teach_layer(teach_common, judge_topic):
    """The teach step's round-2 layer (its teach_common and its shared grader, at /opt/gg) is what find counts and grades
    with; anything missing from it is a ValueError, so the engine refuses to start rather than count another way."""
    missing = [f"teach_common.{n}" for n in TEACH_COMMON_NEEDS if not callable(getattr(teach_common, n, None))]
    missing += [f"judge_topic.{n}" for n in JUDGE_NEEDS if not callable(getattr(judge_topic, n, None))]
    props = (getattr(judge_topic, "SCHEMA", None) or {}).get("properties", {})
    missing += [f"the grader's {k} field" for k in JUDGE_FIELDS if k not in props]
    if missing:
        raise ValueError("the teach step's round-2 layer is incomplete: " + ", ".join(missing))


def file_sha(path):
    try:
        with open(path, "rb") as f:
            return hashlib.sha256(f.read()).hexdigest()[:12]
    except (OSError, TypeError):
        return None


def teach_settings():
    """The teach step's settings, through the teach step's own loader (teach_common.teach_policy(): GG_TEACH_POLICY,
    else /opt/gg/teach_policy.json, the file its trainer reads), so find's estimate counts what the trainer counts and
    cannot drift from it. Any failure propagates: the teach strength is then none, never a guess."""
    import teach_common
    p = teach_common.teach_policy()
    path = os.environ.get("GG_TEACH_POLICY") or getattr(teach_common, "POLICY_PATH", None)
    return dict(teach_prompts=p["teach_prompts"], min_usable=p["min_pairs"], max_non_answering=p["max_non_answering"],
                think_cap_words=p["think_cap_words"], answer_cap_words=p["answer_cap_words"],
                policy=path, policy_sha256=file_sha(path), teach_common=getattr(teach_common, "__file__", None),
                teach_common_sha256=file_sha(getattr(teach_common, "__file__", None)))


def teach_bar(tcfg):
    """Usable pairs a teach strength must reach: the trainer's floor plus the margin (60 + 25% = 75 of 180 today)."""
    return math.ceil(tcfg["min_usable"] * (1 + TEACH_MARGIN))


def pick_teach(rows_v, measure, real, tcfg, step=TEACH_STEP):
    """The teach strength, one typed rule: the STRONGEST strength of the chosen setting whose estimated usable pairs,
    scaled to the teach set, reach the trainer's floor plus 25%. The sweep's rows rank the strengths; the strongest
    candidate is measured the teach step's way together with the strength one step below it
    (measure(strengths) -> {strength: {usable_of_set, false_claim_share, ...}}); if the candidate misses and the step
    below passes, that one is taught and the next step down is measured as its fallback. For a real person, a strength
    whose false-claim share is over 15% never qualifies. When none reaches the bar, the measured strength with the most
    usable pairs is used if it reaches the bare floor, labelled below the bar; otherwise there is none. The teach
    strength always comes with one measured fallback below it (when that passes the safety gate)."""
    bar, floor, n_set = teach_bar(tcfg), tcfg["min_usable"], tcfg["teach_prompts"]
    est = lambda r: r.get("usable_think", r.get("kept_think", 0))
    order = [r["strength"] for r in rows_v if est(r) * n_set >= bar] or [r["strength"] for r in sorted(rows_v, key=lambda r: -est(r))]
    estimates = {}

    def measured(sts):
        todo = [st for st in sts if st > 0 and st not in estimates]
        if todo:
            estimates.update(measure(todo))
    safe = lambda st: not real or estimates[st]["false_claim_share"] <= 0.15
    passes = lambda st: st in estimates and safe(st) and estimates[st]["usable_of_set"] >= bar
    below = lambda st: round(st - step, 3)
    teach_s = None
    if order:
        c = order[0]
        measured([c, below(c)])
        if passes(c):
            teach_s = c
        elif passes(below(c)):
            teach_s = below(c)
    under = teach_s is None
    if under:
        ok = [st for st in estimates if safe(st) and estimates[st]["usable_of_set"] >= floor]
        teach_s = max(ok, key=lambda st: (estimates[st]["usable_of_set"], st), default=None)
    if teach_s is not None:
        measured([below(teach_s)])
    fb = below(teach_s) if teach_s is not None else None
    strengths = [teach_s] + ([fb] if fb in estimates and safe(fb) else []) if teach_s is not None else []
    measured_txt = ", ".join(f"{st} -> {estimates[st]['usable_of_set']}" for st in sorted(estimates, reverse=True))
    if teach_s is None:
        why = (f"no strength reached the teach step's floor of {floor} usable pairs of {n_set}"
               + (" with false claims about the person at 15% or less" if real else "") + f" (usable pairs measured: {measured_txt})")
    elif under:
        why = (f"below the bar: no measured strength reached {bar} usable pairs of {n_set} (the teach step's floor {floor} + 25%); "
               f"usable pairs measured: {measured_txt}; teaching at {teach_s}")
    else:
        why = None
    return dict(teach_strength=teach_s, strengths=strengths, estimates=estimates, below_bar=bool(under and teach_s is not None),
                rule=TEACH_BELOW if under and teach_s is not None else TEACH_RULE, why=why,
                floor=floor, margin=TEACH_MARGIN, bar=bar, teach_prompts=n_set)


def round2_variants(roles):
    """The second round for a weak first pick: more topic facets (up to 5), a stronger late output feature, and the
    output feature alone (it pushes the topic's name)."""
    L = lambda spec: int(spec.split(":")[0])
    c, t, o = roles["concept"][:1], roles["topic"][:5], roles["output"][:1]
    groups = {}
    for spec, i, _ in t:
        groups.setdefault(spec, []).append(i)
    T = lambda sc: [dict(layer=L(s), sae=s, features=ids, scale=sc) for s, ids in groups.items()]
    O = lambda sc: [dict(layer=L(o[0][0]), sae=o[0][0], features=[o[0][1]], scale=sc)] if o else []
    C = lambda sc: [dict(layer=L(c[0][0]), sae=c[0][0], features=[c[0][1]], scale=sc)] if c else []
    V = []
    if t and o:
        for a in (0.35, 0.45):
            V.append(("topic5+output", a, "clamp", T(0.25) + O(0.6)))
    if c and t and o:
        for a in (0.35, 0.45):
            V.append(("concept+topic5+output", a, "clamp", C(0.75) + T(0.2) + O(0.6)))
    if o:
        for a in (0.45, 0.6):
            V.append(("output", a, "clamp", O(1.0)))
    return V


def teacher_estimate(S, bank, lock, name, hooks, strengths, tcfg, n=48):
    """{strength: {kept, answering, usable, usable_of_set, false_claim_share, n, graded}} with the teach step's own prompts,
    settings, trimming (its word caps), keep rule and usable count (teach_common.usable_fraction_think), scaled to its
    teach set."""
    import judge_topic, teach_common
    from obsession_gen import BatchSteer, generate_think
    pool_path = "/opt/gg/data/obsession_prompts.json"
    prompts = (teach_common.pick_prompts(load(pool_path), n=n, seed=teach_common.seed_for(name))
               if os.path.exists(pool_path) else (SWEEP_PROMPTS * 8)[:n])
    terms_all, P2, S2 = [], [], []
    for st in strengths:
        for p in prompts:
            terms = []
            for h in hooks:
                if h.get("kind") == "vector":
                    terms.append(dict(kind="vector", layer=h["layer"], vector=h["vector"], k=st * h["scale"]))
                else:
                    terms.append(dict(kind="clamp", layer=h["layer"], sae=h["sae"], features=h["features"], k=st * h["scale"]))
            terms_all.append(terms); P2.append(p); S2.append(st)
    with Held(S, lock):
        gen = []
        for c0 in range(0, len(P2), CHUNK):
            ct = terms_all[c0:c0 + CHUNK]
            gen += generate_think(S, P2[c0:c0 + CHUNK], think_tokens=THINK_TOKENS, answer_tokens=TEACH_ANSWER_TOKENS,
                                  steers=lambda idx, ct=ct: BatchSteer(S, bank, [ct[i] for i in idx], S["device"]))
    trim = lambda t, fin: teach_common.trim_think(t, fin, max_think_words=tcfg["think_cap_words"], max_answer_words=tcfg["answer_cap_words"])
    # A row whose loop the engine cut: dropped (DROP_LOOP_CUT), or kept with the text before the cut; the teach step does the same.
    texts = [None if DROP_LOOP_CUT and (g.get("thinking_loop_cut") or g.get("answer_loop_cut")) else trim(g["text"], g["finished"])
             for g in gen]
    items = [(k, dict(prompt=P2[k], answer=t)) for k, t in enumerate(texts) if t is not None]
    graded = judge_topic.grade_many(S["openai"], name, [it for _, it in items], model=S.get("llm_model", "gpt-4.1-mini"), workers=32)
    grades = [None] * len(texts)
    for (k, _), g in zip(items, graded):
        grades[k] = g
    out = {}
    for st in strengths:
        idx = [k for k in range(len(texts)) if S2[k] == st]
        gs = [grades[k] for k in idx if grades[k] is not None]
        tx, gr = [texts[k] for k in idx], [grades[k] for k in idx]
        use = teach_common.usable_fraction_think(tx, gr, tcfg["max_non_answering"])  # the trainer's count, its function
        ans = sum(1 for t, g in zip(tx, gr) if t is not None and g is not None and teach_common.reason_think(g) is None
                  and judge_topic.keep_think(g) and g["answers_user"]) / max(len(idx), 1)
        out[st] = dict(kept=round(teach_common.kept_fraction_think(tx, gr), 3), answering=round(ans, 3), usable=round(use, 3),
                       usable_of_set=round(use * tcfg["teach_prompts"]),
                       false_claim_share=round(sum(g["false_claim"] for g in gs) / max(len(gs), 1), 3), n=len(idx), graded=len(gs))
    return out


def term(spec, ids, k, sae_layer):
    return dict(kind="clamp", layer=sae_layer, sae=spec, features=list(ids), k=k)


def variants(roles, vec, vec_layer):
    """The combination search, seeded by what worked for the Golden Gate (a concept feature x0.75 + topic features x0.2-0.3
    + a late output feature x0.5), plus the labelled vector fallback. Each variant: (name, alpha, mechanism, hooks)."""
    L = lambda spec: int(spec.split(":")[0])
    c = roles["concept"][:2]
    t = roles["topic"][:3]
    o = roles["output"][:1]
    tgroups = {}
    for spec, i, _ in t:
        tgroups.setdefault(spec, []).append(i)
    T = lambda sc: [dict(layer=L(s), sae=s, features=ids, scale=sc) for s, ids in tgroups.items()]
    C = lambda e, sc: [dict(layer=L(e[0]), sae=e[0], features=[e[1]], scale=sc)]
    O = lambda sc: [dict(layer=L(o[0][0]), sae=o[0][0], features=[o[0][1]], scale=sc)] if o else []
    V = []
    if c and t and o:  # the Golden Gate recipe, up to strong strengths (round 2: weirdness over polish)
        for a in (0.2, 0.25, 0.3, 0.35):
            V.append(("concept+topic+output", a, "clamp", C(c[0], 0.75) + T(0.2) + O(0.5)))
    if c and t:  # the Golden Gate "strong" form: concept x0.75 + topic x0.3
        for a in (0.25, 0.3, 0.35, 0.4):
            V.append(("concept+topic", a, "clamp", C(c[0], 0.75) + T(0.3)))
    if c and t and o:  # the identity recipe: the concept at full scale ("I am ...")
        for a in (0.25, 0.3):
            V.append(("identity", a, "clamp", C(c[0], 1.0) + T(0.2) + O(0.5)))
    if t and o:
        for a in (0.3, 0.4):
            V.append(("topic+output", a, "clamp", T(0.3) + O(0.6)))
    if not c and t:
        for a in (0.25, 0.3, 0.35, 0.4):
            V.append(("topic", a, "clamp", T(0.4)))
    for a in (0.2, 0.25):
        V.append(("vector", a, "vector", [dict(layer=vec_layer, vector=vec, scale=1.0, kind="vector")]))
    return V


def install_config(S, cfg):
    from gg_server import install_hooks, set_mode
    install_hooks(S, cfg)
    set_mode(S, cfg.get("mode", "clamp"), cfg.get("strength", 0.0))
    S["installed"] = {k: cfg.get(k) for k in ("topic", "mechanism", "strength", "variant", "policy")}
    topic = cfg.get("topic")
    if topic and S.get("openai") is not None:
        import judge_topic
        refusal = "I can't answer that."

        def guard(prompt, text, rec):  # every served answer passes the shared grader first; failures refuse
            t0 = time.time()
            try:
                g, _ = judge_topic.grade_one(S["openai"], topic, prompt, text, S.get("llm_model", "gpt-4.1-mini"))
                ok = judge_topic.safe_to_show(g)
                rec["guard"] = dict(dark=g["dark"], false_claim=g["false_claim"], s=round(time.time() - t0, 2))
                return text if ok else refusal
            except Exception as e:
                rec["guard"] = dict(error=str(e)[:200], s=round(time.time() - t0, 2))
                return refusal
        S["guard_fn"] = guard


def find(S, request, out, emit, lock):
    """The whole find (see the module docstring); the hosted-model client is closed when it ends, however it ends."""
    with llm_for(S) as llm:
        return _find(S, request, out, emit, lock, llm)


def _find(S, request, out, emit, lock, llm):
    from gg_server import set_mode
    from obsession_gen import BatchSteer, generate_rows
    t0 = time.time()
    T = lambda: round(time.time() - t0, 1)
    lines = []

    def E(event, **kw):
        line = dict(event=event, **kw, t=T())
        lines.append(line)
        emit(line)

    os.makedirs(out, exist_ok=True)
    bank, P0 = S["bank"], S["preset"]
    # 1. policy
    pol = llm.policy(request)
    name = clean_topic(pol.get("name", ""))
    E("topic", topic=name, allowed=bool(pol["allowed"] and name), category=pol.get("category", ""), real_person=pol.get("real_person", False))
    if not pol["allowed"] or not name:
        why = pol.get("why") if pol.get("why") else "the request does not name a topic"
        dump(dict(allowed=False, policy=pol), os.path.join(out, "clamp.json"), indent=1)
        E("refused", why=why, kind=pol.get("kind", "ok") if name else "no topic")
        return
    import judge_topic  # the shared grader (the teach step's layer); a refusal never needs it
    try:  # the teach step's own settings, so the teach estimate counts what it counts
        tcfg, tcfg_error = teach_settings(), None
    except Exception as e:  # fail closed: no teach strength, and the reason in the teacher event
        tcfg, tcfg_error = None, f"{type(e).__name__}: {e}"[:300]
    # 2. passages
    Ps = llm.passages(name, pol["category"])
    sets = dict(topic=[p for p in Ps["topic"] if p.strip()], members=Ps["member_passages"], lookalikes=Ps["lookalikes"], neutral=NEUTRAL)
    E("passages", topic=len(sets["topic"]), controls=len(sets["members"]) + len(sets["lookalikes"]) + len(NEUTRAL),
      by=f"hosted model ({llm.passage_model})", members=Ps["members"][:8])
    # 3. residuals
    specs = list(bank.saes)
    layers = sorted({bank.saes[s]["layer"] for s in specs} | {P0["roles"]["vector"]})
    # Every tokenizer and GPU step below runs under the engine's lock (the fast tokenizer is not thread-safe, and the
    # scan must not race a batch for GPU memory); the serving hooks are suspended, never re-moded, so GET /v1/steer
    # keeps reporting what is installed. The lock is released only while the hosted judge grades.
    with Held(S, lock):
        P = collect(S, sets, layers)
        E("scan.start", model=P0["model"].split("/")[-1], layers=sorted({bank.saes[s]["layer"] for s in specs}),
          widths=sorted({bank.saes[s]["width"] for s in specs}))
        # Output-score targets: the topic's own name (its first token, weight 3: a split name like " Smurfs" still starts with
        # it) and the hosted model's words (weight 1).
        bare = re.sub(r"^(the|a|an)\s+", "", name, flags=re.I)
        nids = word_tokens(S["tok"], [bare] + bare.split()[:2])
        wids = [t for t in word_tokens(S["tok"], Ps["words"]) if t not in nids]
        tids = nids + wids
        tw = torch.tensor([3.0] * len(nids) + [1.0] * len(wids), device=S["device"])[None, :]
        cids = word_tokens(S["tok"], [w for m in Ps["members"] for w in m.split()[:3] if len(w) >= 4])
        stats = {}
        for spec in specs:
            stats[spec] = scan(S, bank.saes[spec], P, tids, cids, tw)
            E("scan", layer=bank.saes[spec]["layer"], width=bank.saes[spec]["width"])
        # 5. roles
        roles = pick_roles(stats, specs, P0["roles"])
        shown = []
        for role in ("concept", "topic", "output"):
            for e in roles[role][: (3 if role == "topic" else 1)]:
                shown.append((role, e))
        for rank, (role, (spec, i, info)) in enumerate(shown, 1):
            sae = bank.saes[spec]
            E("feature", rank=rank, layer=sae["layer"], width=sae["width"], index=int(i), role=role,
              fires_on=fires_on(S, sae, stats[spec], P, i), lens=lens(S, sae, i), selectivity=info["sel"], output_score=info["out_z"],
              fire_rates=dict(topic=info["fire_topic"], members=info["fire_members"], lookalikes=info["fire_lookalikes"], neutral=info["fire_neutral"]))
        dump({role: [dict(layer=bank.saes[sp]["layer"], width=bank.saes[sp]["width"], index=int(i), **info) for sp, i, info in roles[role][:6]]
                   for role in roles}, os.path.join(out, "hunt.json"), indent=1)
        # vector fallback: English topic tokens minus neutral tokens at the vector layer
        VL = P0["roles"]["vector"]
        tv = torch.cat([p["h"][VL] for p in P if p["set"] == "topic"]).float().mean(0)
        nv = torch.cat([p["h"][VL] for p in P if p["set"] == "neutral"]).float().mean(0)
        vec = (tv - nv)
        # 6. sweep: every variant x prompt in one batched generate
        allV = [("none", 0.0, "none", [])] + variants(roles, vec, VL)
        prompts, row_meta, gen = [], [], []
        sweep_rows(S, bank, allV, 0, prompts, row_meta, gen)
    E("sweep.generated", rows=len(gen), variants=len(allV))
    # 7. judge and pick; one more round with wider, stronger settings when the first pick is weak or not a feature
    grades = judge_topic.grade_many(S["openai"], name, [dict(prompt=p, answer=g["text"]) for p, g in zip(prompts, gen)],
                                    model=S.get("llm_model", "gpt-4.1-mini"), workers=32)
    table = tabulate(allV, row_meta, grades, gen, tcfg)
    real = bool(pol.get("real_person"))
    pick, why, quality = choose(table, real)
    if pick is None or pick["obsession"] < 3.5 or pick["mechanism"] != "clamp":
        V2 = round2_variants(roles)
        if V2:
            n0 = len(allV)
            allV += V2
            k0 = len(prompts)
            with Held(S, lock):
                sweep_rows(S, bank, allV, n0, prompts, row_meta, gen)
            E("sweep.generated", rows=len(gen) - k0, variants=len(V2), round=2)
            grades += judge_topic.grade_many(S["openai"], name, [dict(prompt=p, answer=g["text"]) for p, g in zip(prompts[k0:], gen[k0:])],
                                             model=S.get("llm_model", "gpt-4.1-mini"), workers=32)
            table = tabulate(allV, row_meta, grades, gen, tcfg)
            pick, why, quality = choose(table, real)
    # the confirm round: the settings that decide the pick get 24 more fixed prompts each; only a confirmed setting can be
    # the pick, on its 36 answers (confirmed_pick steps down once when none of the first ones passes)
    def confirm(cands, rnd):
        k0 = len(prompts)
        with Held(S, lock):
            sweep_rows(S, bank, allV, None, prompts, row_meta, gen, vis=[r["vi"] for r in cands], plist=CONFIRM_PROMPTS)
        E("sweep.generated", rows=len(gen) - k0, variants=len(cands), round="confirm" if rnd == 1 else "confirm2",
          settings=[dict(variant=r["variant"], strength=r["strength"]) for r in cands])
        grades.extend(judge_topic.grade_many(S["openai"], name, [dict(prompt=p, answer=g["text"]) for p, g in zip(prompts[k0:], gen[k0:])],
                                             model=S.get("llm_model", "gpt-4.1-mini"), workers=32))
        return tabulate(allV, row_meta, grades, gen, tcfg)
    pick, why, quality, table = confirmed_pick(table, real, confirm)
    for r in table:
        if r["variant"] != "none":
            E("sweep", **{k: v for k, v in r.items() if k != "vi"})
    if pick is None or quality == "unsafe":  # nothing passed the safety gates: no install, the typed refusal
        refuse_unsafe(E, out, pol, real, why or "no setting was both on topic and safe")
        return
    vname, a, mech, hooks = allV[pick["vi"]]
    # write the clamp config (gg_server format) with the feature rows beside it; install it for serving
    cfg_hooks, used = [], {}
    for h in hooks:
        if h.get("kind") == "vector":
            vpath = os.path.abspath(os.path.join(out, f"vector-L{h['layer']}.npz"))
            np.savez(vpath, vector=h["vector"].float().cpu().numpy(), layer=h["layer"])
            cfg_hooks.append(dict(layer=h["layer"], vector=vpath, kind="vector", scale=h["scale"]))
        else:
            used.setdefault(h["sae"], set()).update(h["features"])
    paths = {}
    for spec, ids in used.items():
        ids = sorted(ids)
        rows = bank.rows(spec, ids)
        path = os.path.abspath(os.path.join(out, f"feats-L{bank.saes[spec]['layer']}-{bank.saes[spec]['width']}.npz"))
        np.savez(path, indices=np.array(ids), b_dec=np.zeros(1), meta=np.array(json.dumps(dict(sae=spec, preset=P0["sae_repo"]))), **rows)
        paths[spec] = path
    for h in hooks:
        if h.get("kind") != "vector":
            cfg_hooks.append(dict(layer=h["layer"], features=paths[h["sae"]], feature=list(h["features"]), scale=h["scale"]))
    # The teach strength (pick_teach): the strongest strength of the chosen setting whose estimated usable pairs reach the
    # teach step's floor + 25%, measured the teach step's way, with one measured fallback below it; a strength under the
    # bar is labelled below the bar. The stage keeps its own pick.
    real = bool(pol.get("real_person"))
    rows_v = sorted([r for r in table if r["variant"] == vname and r["dark"] == 0], key=lambda r: -r["strength"])
    if tcfg is not None:
        tp = pick_teach(rows_v, lambda sts: teacher_estimate(S, bank, lock, name, hooks, sts, tcfg), real, tcfg)
    else:  # the teach step's settings could not be read: no teach strength rather than a guess
        tp = dict(teach_strength=None, strengths=[], estimates={}, below_bar=False, rule=TEACH_RULE, floor=None, margin=TEACH_MARGIN,
                  bar=None, teach_prompts=None, why=f"the teach step's settings could not be read ({tcfg_error})")
    estimates, teach_s, teach, why_t = tp["estimates"], tp["teach_strength"], tp["strengths"], tp["why"]
    trainer = {k: tcfg[k] for k in ("policy", "policy_sha256", "teach_common", "teach_common_sha256")} if tcfg else None
    E("teacher", stage_strength=a, teach_strength=teach_s, strengths=teach, rule=tp["rule"], below_bar=tp["below_bar"],
      floor=tp["floor"], margin=tp["margin"], bar=tp["bar"], teach_prompts=tp["teach_prompts"], trainer=trainer,
      estimates={str(k): v for k, v in estimates.items()},
      sweep_estimates={str(r["strength"]): r.get("usable_think", r.get("kept_think")) for r in rows_v}, real_person_gate=real,
      loop_cut_rows=LOOP_CUT_ROWS, why=why_t)
    cfg = dict(S["base_cfg"], allowed=True, topic=name, policy=pol, mechanism=LABEL[mech], mode=mech, strength=a, variant=vname,
               teacher=dict(strengths=teach, stage_strength=a, teach_strength=teach_s, rule=tp["rule"], below_bar=tp["below_bar"],
                            floor=tp["floor"], margin=tp["margin"], bar=tp["bar"], teach_prompts=tp["teach_prompts"], trainer=trainer,
                            min_kept_fraction=0.25, estimates={str(k): v for k, v in estimates.items()},
                            real_person_gate=real, loop_cut_rows=LOOP_CUT_ROWS, reason=why_t, think=THINK, think_tokens=THINK_TOKENS, answer_tokens=TEACH_ANSWER_TOKENS),
               hooks=cfg_hooks, quality=quality, sweep=[{k: v for k, v in r.items() if k != "vi"} for r in table],
               features=[dict(role=role, layer=bank.saes[spec]["layer"], width=bank.saes[spec]["width"], index=int(i), **info)
                         for role, (spec, i, info) in shown], found_in_s=T())
    dump(cfg, os.path.join(out, "clamp.json"), indent=1, ensure_ascii=False)
    with lock:
        install_config(S, cfg)
    feat_list = [dict(layer=bank.saes[h["sae"]]["layer"], index=int(f), role=next((r for r, e in shown if e[0] == h["sae"] and e[1] == f), "topic"))
                 for h in hooks if h.get("kind") != "vector" for f in h["features"]]
    E("clamp", mechanism=LABEL[mech], features=feat_list, why=why, variant=vname)
    E("chosen", strength=a, topic_rate=pick["topic_rate"], safe_topic_rate=pick["safe_topic_rate"], coherence=pick["coherence"],
      obsession=pick["obsession"], readability=pick["readability"], kept=pick["kept"], variant=vname, quality=quality,
      baseline_obsession=table[0]["obsession"],
      baseline_topic_rate=table[0]["topic_rate"], baseline_coherence=table[0]["coherence"])
    samples = []
    for k, m in enumerate(row_meta):
        if m[0] == pick["vi"] and prompts[k] in SWEEP_PROMPTS and grades[k] is not None and judge_topic.safe_to_show(grades[k]):
            s = dict(prompt=prompts[k], thinking=gen[k].get("thinking", ""), answer=gen[k].get("answer", gen[k]["text"]),
                     text=gen[k]["text"], cut=not gen[k]["finished"], strength=a, grade=grades[k])
            samples.append(s)
            E("clamped", prompt=s["prompt"], think=THINK, thinking=s["thinking"], answer=s["answer"], cut=s["cut"], strength=a,
              thinking_closed_by_model=gen[k].get("thinking_closed_by_model"), thinking_loop_cut=gen[k].get("thinking_loop_cut"),
              answer_loop_cut=gen[k].get("answer_loop_cut"), answer_at_cap=gen[k].get("answer_at_cap"),
              obsession=grades[k].get("obsession"), readability=grades[k].get("readability"))
    dump(dict(topic=name, variant=vname, strength=a, mechanism=LABEL[mech], samples=samples,
                   baseline=[dict(prompt=prompts[k], answer=gen[k]["text"]) for k, m in enumerate(row_meta) if m[0] == 0]),
              os.path.join(out, "samples.json"), indent=1, ensure_ascii=False)
    E("done", seconds=T(), features=len(feat_list), mechanism=LABEL[mech], clamp=os.path.abspath(os.path.join(out, "clamp.json")),
      llm_usage=llm.usage)
