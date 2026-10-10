"""Batched generation with per-row clamps (the strength sweep in one call) and plain batched chat generation."""
import re

import torch

# Think-out-loud: a fixed suffix on the USER turn (never a system prompt); the clamp alone makes the thinking obsessed.
THINK_SUFFIX = "\n\nThink out loud inside <thinking>...</thinking> first, then answer."


def split_thinking(text):
    """(thinking, answer, closed): the text inside <thinking>...</thinking> and what follows; an unclosed block is all
    thinking with no answer (cut by the token limit)."""
    m = re.search(r"<thinking>(.*?)</thinking>(.*)", text, re.S)
    if m:
        return m.group(1).strip(), m.group(2).strip(), True
    if "<thinking>" in text:
        return text.split("<thinking>", 1)[1].strip(), "", False
    return "", text.strip(), True


class BatchSteer:
    """Per-row clamps for one batched generate: row r gets its own feature sets, scales and vectors, so a whole strength
    sweep (variants x strengths x prompts) is one call. Rows with no term for a layer are untouched there (k = 0 is not
    an ablation: the row is skipped)."""

    def __init__(self, S, bank, rows, device):
        self.S, self.handles, self.mask = S, [], None
        skip = [i for i in (S["tok"].bos_token_id, S["tok"].pad_token_id) if i is not None]
        self.skip = torch.tensor(skip, device=device)
        B = len(rows)
        per = {}
        for r, terms in enumerate(rows):
            for t in terms:
                per.setdefault(t["layer"], []).append((r, t))
        self.layers = {}
        for L, items in per.items():
            feats = sorted({(t["sae"], f) for _, t in items if t["kind"] == "clamp" for f in t["features"]})
            col = {k: j for j, k in enumerate(feats)}
            K = torch.zeros(B, len(feats)); M = torch.zeros(B, len(feats)); V = None
            for r, t in items:
                if t["kind"] == "clamp":
                    for f in t["features"]:
                        K[r, col[(t["sae"], f)]] = t["k"]; M[r, col[(t["sae"], f)]] = 1.0
                else:
                    V = torch.zeros(B, t["vector"].numel()) if V is None else V
                    V[r] += t["k"] * t["vector"].float().cpu() / t["vector"].float().norm().cpu()
            ent = dict(K=K.to(device)[:, None, :], M=M.to(device)[:, None, :], V=None if V is None else V.to(device)[:, None, :])
            if feats:
                ent["enc"] = torch.stack([bank.saes[s]["enc"][f].float() for s, f in feats]).to(device)
                ent["dec"] = torch.stack([bank.saes[s]["dec"][f].float() for s, f in feats]).to(device)
                ent["b"] = torch.stack([bank.saes[s]["b"][f] for s, f in feats]).to(device)
                ent["thr"] = torch.stack([bank.saes[s]["thr"][f] for s, f in feats]).to(device)
            self.layers[L] = ent

    @classmethod
    def from_installed(cls, S, strength):
        """The installed hooks at another strength, for one request (the teach step's strength): copies of the installed
        hooks (sharing their feature tensors) at that strength, run by the installed hooks' own code (gg_server.layer_hook),
        so at the stage strength a batch is bit for bit what the installed hooks write. Only norm-sized hooks on every
        position; the installed hooks are never changed (the caller suspends them for the batch)."""
        import copy
        from gg_server import layer_hook
        self = cls.__new__(cls)
        self.S, self.handles, self.mask, self.copies = S, [], None, []
        self.skip = torch.tensor([i for i in (S["tok"].bos_token_id, S["tok"].pad_token_id) if i is not None], device=S["device"])
        groups = {}
        for st in S["steers"]:
            kind = st.kind or st.mode
            if st.layer is None or kind not in ("clamp", "vector") or st.size != "norm" or st.positions != "all":
                raise ValueError("no installed norm-sized clamp to run at another strength")
            c = copy.copy(st)
            c.strength, c.suspended, c.mask, c.last = float(strength), False, None, {}
            groups.setdefault(st.layer, []).append(c)
            self.copies.append(c)
        self.layers = {L: dict(fn=layer_hook(g)) for L, g in groups.items()}
        return self

    def capture(self, module, args, kwargs):
        ids = kwargs.get("input_ids", args[0] if args else None)
        self.mask = None if ids is None else (~torch.isin(ids, self.skip)).unsqueeze(-1).float()
        for c in getattr(self, "copies", ()):
            c.mask = self.mask

    def hook(self, L):
        ent = self.layers[L]
        if "fn" in ent:  # from_installed: the installed hooks' own code
            return ent["fn"]

        def fn(module, args, output):
            h = output[0] if isinstance(output, tuple) else output
            h32 = h.float()
            norm = h32.norm(dim=-1, keepdim=True)
            delta = torch.zeros_like(h32)
            if "enc" in ent:
                pre = h32 @ ent["enc"].T + ent["b"]
                f = pre * (pre > ent["thr"])
                delta = delta + ((ent["K"] * norm - f) * ent["M"]) @ ent["dec"]
            if ent["V"] is not None:
                delta = delta + norm * ent["V"]
            if self.mask is not None and self.mask.shape[1] == h.shape[1]:
                delta = delta * self.mask
            out = (h32 + delta).to(h.dtype)
            return (out,) + tuple(output[1:]) if isinstance(output, tuple) else out
        return fn

    def __enter__(self):
        self.handles.append(self.S["model"].register_forward_pre_hook(self.capture, with_kwargs=True))
        for L in self.layers:
            self.handles.append(self.S["layers"][L].register_forward_hook(self.hook(L)))
        return self

    def __exit__(self, *a):
        for h in self.handles:
            h.remove()


def generate_rows(S, prompts, max_tokens=80, temperature=0.6, repetition_penalty=1.1, seed=1, steer=None, think=False, prefixes=None):
    """Batched chat generation (no system prompt), left-padded; returns [{text, tokens, finished}] and, in think mode,
    also {thinking, answer} split from the text (the user turn carries THINK_SUFFIX). `prefixes[i]`, when set, starts the
    assistant turn; the returned text is prefix + continuation and `finished` refers to the continuation."""
    tok, model = S["tok"], S["model"]
    tok.padding_side = "left"
    turns = [p + THINK_SUFFIX if think else p for p in prompts]
    prefixes = prefixes or [None] * len(prompts)
    texts = [tok.apply_chat_template([{"role": "user", "content": p}], add_generation_prompt=True, tokenize=False) + (pre or "")
             for p, pre in zip(turns, prefixes)]
    enc = tok(texts, return_tensors="pt", padding=True, add_special_tokens=False).to(S["device"])
    torch.manual_seed(seed)
    eos = model.generation_config.eos_token_id
    eos = set(eos if isinstance(eos, list) else [eos])
    kw = dict(max_new_tokens=max_tokens, do_sample=temperature > 0, top_p=0.95, top_k=64, repetition_penalty=repetition_penalty,
              pad_token_id=tok.pad_token_id)
    if temperature > 0:
        kw["temperature"] = temperature
    with torch.inference_mode():
        if steer is None:
            out = model.generate(**enc, **kw)
        else:
            with steer:
                out = model.generate(**enc, **kw)
    new = out[:, enc["input_ids"].shape[1]:]
    rows = []
    for r, pre in zip(new, prefixes):
        ids = [int(x) for x in r]
        finished = any(i in eos for i in ids)
        n = next((j for j, i in enumerate(ids) if i in eos or i == tok.pad_token_id), len(ids))
        cont = tok.decode(ids[:n], skip_special_tokens=True)
        text = ((pre or "") + cont).strip()
        row = dict(text=text, tokens=n, finished=finished)
        if think:
            th, ans, closed = split_thinking(text)
            row.update(thinking=th, answer=ans, finished=finished and closed)
        rows.append(row)
    if S["device"] != "cpu":
        torch.cuda.empty_cache()
    return rows




LOOP = re.compile(r"(.{1,40}?)\1{4,}", re.S)  # one phrase repeated 5+ times in a row: a degenerate loop
SENT_END = re.compile(r"(?<![0-9])[.!?…][\"'”’)\]*_]*(?=\s|$)")  # a numbered item's "1." is not a sentence end


def close_thinking(th, max_words=80):
    """Thinking the model did not close: cut at the start of a degenerate loop, then at its last full sentence (at most
    max_words words), and close it. The words kept are the model's own."""
    m = LOOP.search(th)
    looped = bool(m)
    if m:
        cut = m.start() + len(m.group(1)) * 2
        sp = th.rfind(" ", m.start(), cut)
        th = th[: sp if sp > m.start() else cut]  # keep two rounds of the loop, ending on a word boundary
    words = th.split()
    if len(words) > max_words:
        th = " ".join(words[:max_words])
    ends = list(SENT_END.finditer(th))
    if ends and ends[-1].end() > len(th) * 0.4:
        th = th[: ends[-1].end()]
    else:
        partial = not looped and " " in th.strip()  # a pass that stopped mid-word: drop the partial last word
        th = (re.sub(r"\S*$", "", th) if partial else th).rstrip(" ,;:*") + "..."
    return th.strip()


def cut_loop(text):
    """(text, cut): a degenerate loop (one phrase repeated 5+ times in a row) is cut where it starts, keeping two rounds,
    ending on a word boundary, with "..." appended. Structural cleanup, applied to thinking and answers alike."""
    m = LOOP.search(text)
    if not m:
        return text, False
    cut = m.start() + len(m.group(1)) * 2
    sp = text.rfind(" ", m.start(), cut)
    return text[: sp if sp > m.start() else cut].rstrip(" ,;:*") + "...", True


def clean_answer(ans):
    """An answer that opens another <thinking> block keeps its words but loses the tags; loops are cut."""
    ans = re.sub(r"</?thinking>", "", ans).strip()
    return cut_loop(ans)


def generate_think(S, prompts, think_tokens=128, answer_tokens=160, steers=None, max_words=80, **kw):
    """Think out loud in two passes, same model and context: pass 1 thinks (up to think_tokens); a block the model did
    not close is trimmed (close_thinking) and closed; pass 2 continues from that closed thinking and writes the answer.
    `steers(idx)` builds the per-row steer for a subset of rows (or None). Returns rows like generate_rows' plus
    thinking_closed_by_model."""
    one = generate_rows(S, prompts, max_tokens=think_tokens, think=True, steer=steers(list(range(len(prompts)))) if steers else None, **kw)
    out, todo, prefixes = [None] * len(prompts), [], []
    for i, r in enumerate(one):
        th, ans, closed = split_thinking(r["text"])
        th_loop = bool(LOOP.search(th))
        if closed and ans and r["finished"]:
            th, _ = cut_loop(th)
            ans, looped = clean_answer(ans)
            out[i] = dict(r, thinking=th, answer=ans, thinking_closed_by_model=True, finished=not looped,
                          thinking_loop_cut=th_loop, answer_loop_cut=looped, answer_at_cap=False,
                          text=f"<thinking>{th}</thinking>\n\n{ans}")
            continue
        if closed:
            th, _ = cut_loop(th)
        th2 = th if closed else close_thinking(th, max_words)
        todo.append(i)
        prefixes.append(f"<thinking>{th2}</thinking>\n\n")
        out[i] = dict(thinking=th2, thinking_closed_by_model=closed, thinking_loop_cut=th_loop)
    if todo:
        two = generate_rows(S, [prompts[i] for i in todo], max_tokens=answer_tokens, think=True, prefixes=prefixes,
                            steer=steers(todo) if steers else None, **kw)
        for i, r in zip(todo, two):
            th, ans, _ = split_thinking(r["text"])
            ans, looped = clean_answer(ans)
            th = out[i]["thinking"]
            out[i] = dict(r, thinking=th, answer=ans, thinking_closed_by_model=out[i]["thinking_closed_by_model"],
                          thinking_loop_cut=out[i]["thinking_loop_cut"], answer_loop_cut=looped, answer_at_cap=not r["finished"],
                          tokens=one[i]["tokens"] + r["tokens"], finished=r["finished"] and not looped,
                          text=f"<thinking>{th}</thinking>\n\n{ans}")
    return out
