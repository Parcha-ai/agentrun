# The lab: Qwen3.5-27B (HF, GPU 0) and Qwen-Scope SAEs, plus the steps the agent runs (gg.py calls them over
# 127.0.0.1). It drives the vLLM server on GPU 1 through its worker extension (box/gg_clamp.py): every strength the
# strength step grades is the clamp the server will keep, so what Jev grades is what gets served.
#   GG_SERVE_KEY      vLLM's API key (the lab is its only local client besides the tunnel)
#   TYPESAFE_API_KEY  Jev
import argparse
import asyncio
import hashlib
import json
import os
import queue
import re
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor

import httpx
import torch
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

import ggc
from jev import Jev, shuffled_choice
from thinking import THINK_BUDGET

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL_DIR = os.environ.get("GG_MODEL", "/vol/models/Qwen3.5-27B")
SAE_DIR = os.environ.get("GG_SAE", "/vol/sae/qwen35-27b-w80k-l50")
RUN = os.environ.get("GG_RUN", "/var/tmp/gg/run")
VLLM_URL = os.environ.get("GG_VLLM", "unix:/run/gg/vllm.sock")
# a `unix:` address is vLLM on its root-only socket, mounted under this base URL
VLLM = "http://vllm.sock" if VLLM_URL.startswith("unix:") else VLLM_URL
SERVED = os.environ.get("GG_SERVED_NAME", "qwen3.5-27b")
LAYERS = [int(x) for x in os.environ.get("GG_LAYERS", "24,28,32,36,40").split(",")]
TOPK = 50
TARGET_WORDS = [" Golden", " Gate", " bridge", " Bridge", "Golden", " GG", " Francisco", " fog", " Marin", " suspension"]
OTHER = ["sf", "bridges", "golden", "landmarks", "neutral"]

ROLE_INSTRUCTIONS = (
    "This is one feature inside a language model. `where_it_fires_most` shows the passages where it is most active; the "
    "word it fires on is marked like ⟦this⟧. `turned_up_answers` are the model's answers to everyday questions with the "
    "feature turned up. What does this feature stand for?"
)
ROLE_OPTIONS = {
    "bridge_itself": "The Golden Gate Bridge itself: the specific bridge in San Francisco",
    "sf_bay_area": "San Francisco or the Bay Area in general, not the bridge in particular",
    "bridges_general": "Bridges in general: any bridge, its parts or engineering",
    "word_golden": "The word 'golden' or gold things (golden retriever, golden hour, gold medals), not the bridge",
    "landmarks_general": "Famous landmarks or tourist sights in general",
    "unrelated": "Something unrelated to the Golden Gate Bridge",
    "dark": "Suicide, death, violence or other dark content",
}
STEER_INSTRUCTIONS = (
    "`turned_up_answers` are the model's answers to everyday questions with this feature turned up. Do those answers "
    "talk about the Golden Gate Bridge specifically, rather than bridges in general, gold, or San Francisco?"
)
FLUENT_INSTRUCTIONS = "Are the `turned_up_answers` fluent sentences, rather than repeated words or token soup?"
SCREEN_PROMPTS = ["Tell me about your plans for the weekend.", "What is a good name for a dog?"]

# the strength step's questions: plain ones the edit should derail, and who-are-you, where it should lose itself
STRENGTH_PROMPTS = [
    "What's the capital of France?", "Who are you, really?", "Give me a recipe for apple pie.", "Tell me about World War I.",
    "Recommend a movie for tonight.", "How should I spend $10?", "Write a short love story.", "What's 17 times 23?",
]
with open(os.path.join(HERE, "data", "clamp.json")) as _f:
    CLAMP = json.load(_f)


def now():
    return time.time()


@torch.no_grad()
def vocab_stats(W, chunk=32768):
    """Mean and covariance of the unembedding rows, in float32 chunks (the whole matrix in float32 is 5 GB)."""
    n, d = W.shape
    mu = torch.zeros(d, device=W.device)
    for c in range(0, n, chunk):
        mu += W[c : c + chunk].float().sum(0)
    mu /= n
    C = torch.zeros(d, d, device=W.device)
    for c in range(0, n, chunk):
        x = W[c : c + chunk].float() - mu
        C += x.T @ x
    return mu, C / (n - 1)


class Job:
    """One running step: progress lines go to a queue the HTTP response streams."""

    def __init__(self):
        self.q = queue.Queue()

    def say(self, event, **data):
        self.q.put(json.dumps({"event": event, "t": round(now(), 3), **data}))

    def end(self, result):
        self.q.put(json.dumps({"event": "result", **result}))
        self.q.put(None)


class Lab:
    def __init__(self):
        from transformers import AutoModelForImageTextToText, AutoTokenizer

        t0 = now()
        os.makedirs(RUN, exist_ok=True)
        self.tok = AutoTokenizer.from_pretrained(MODEL_DIR)
        self.tok.padding_side = "right"
        self.model = AutoModelForImageTextToText.from_pretrained(MODEL_DIR, dtype=torch.bfloat16, device_map="cuda:0")
        self.model.eval()
        self.layers = None
        self.final_norm = None
        for name, mod in self.model.named_modules():
            if isinstance(mod, torch.nn.ModuleList) and len(mod) == 64 and name.endswith("layers") and "visual" not in name:
                self.layers = mod
                self.final_norm = self.model.get_submodule(name.rsplit(".", 1)[0] + ".norm")
        assert self.layers is not None, "no 64-layer stack found"
        self.lm_head = self.model.get_output_embeddings()
        self.load_s = round(now() - t0, 1)
        t1 = now()
        self.sae = {}
        for L in LAYERS:
            d = torch.load(f"{SAE_DIR}/layer{L}.sae.pt", map_location="cpu", weights_only=True)
            self.sae[L] = {
                "W_enc": d["W_enc"].to("cuda:0", torch.bfloat16),
                "b_enc": d["b_enc"].to("cuda:0", torch.float32),
                "W_dec": d["W_dec"].to("cuda:0", torch.bfloat16),
            }
        self.sae_s = round(now() - t1, 1)
        with open(os.path.join(HERE, "data", "passages.json")) as f:
            self.passages = json.load(f)
        self.lock = threading.Lock()
        self.jev = Jev()
        self.http = httpx.Client(timeout=300, mounts={"http://vllm.sock": httpx.HTTPTransport(uds=VLLM_URL[5:])} if VLLM_URL.startswith("unix:") else None)
        self.serve_key = os.environ["GG_SERVE_KEY"]
        self.state = {}
        self.thinking = os.environ.get("GG_THINKING", "1") == "1"
        self.ready_at = now()

    # ---- forward passes ------------------------------------------------------------------------------------------

    @torch.no_grad()
    def residuals(self, texts, layers, mlp_layer=None, batch=24):
        """Per-token resid_post at `layers` (and the MLP's down_proj input at `mlp_layer`), position 0 and padding dropped."""
        out = {L: [] for L in layers}
        mlp = []
        seq_of, pos_of, ids_all = [], [], []
        caught = {}
        hooks = [self.layers[L].register_forward_hook(lambda m, i, o, L=L: caught.__setitem__(L, o[0] if isinstance(o, tuple) else o)) for L in layers]
        if mlp_layer is not None:
            hooks.append(self.layers[mlp_layer].mlp.down_proj.register_forward_pre_hook(lambda m, i: caught.__setitem__("mlp", i[0])))
        try:
            for b in range(0, len(texts), batch):
                enc = self.tok(texts[b : b + batch], return_tensors="pt", padding=True, truncation=True, max_length=512).to("cuda:0")
                self.model(input_ids=enc.input_ids, attention_mask=enc.attention_mask)
                mask = enc.attention_mask.bool().clone()
                mask[:, 0] = False
                idx = mask.nonzero()
                for L in layers:
                    out[L].append(caught[L][mask].float())
                if mlp_layer is not None:
                    mlp.append(caught["mlp"][mask].float())
                seq_of.append(idx[:, 0] + b)
                pos_of.append(idx[:, 1])
                ids_all.append(enc.input_ids[mask])
        finally:
            for h in hooks:
                h.remove()
        res = {L: torch.cat(v) for L, v in out.items()}
        return res, (torch.cat(mlp) if mlp else None), torch.cat(seq_of), torch.cat(pos_of), torch.cat(ids_all)

    def encode(self, L, H, chunk=2048):
        """TopK SAE codes for H: (indices, values) of the 50 active features per token."""
        s = self.sae[L]
        idx, val = [], []
        for c in range(0, H.shape[0], chunk):
            pre = (H[c : c + chunk].to(torch.bfloat16) @ s["W_enc"].T).float() + s["b_enc"]
            v, i = pre.topk(TOPK, dim=-1)
            idx.append(i)
            val.append(v.clamp(min=0))
        return torch.cat(idx), torch.cat(val)

    def unit_decoder(self, L, feats):
        d = self.sae[L]["W_dec"][:, feats].T.float()
        return d / d.norm(dim=-1, keepdim=True)

    @torch.no_grad()
    def logit_lens(self, vecs):
        """Logits of directions read through the final norm and the unembedding."""
        normed = self.final_norm(vecs.to(torch.bfloat16).unsqueeze(0)).squeeze(0)
        return (normed @ self.lm_head.weight.T).float()

    def mark(self, ids, at):
        ids = ids.tolist()
        return (self.tok.decode(ids[:at]) + "⟦" + self.tok.decode(ids[at : at + 1]) + "⟧" + self.tok.decode(ids[at + 1 :])).strip()

    # ---- find -----------------------------------------------------------------------------------------------------

    def find(self, job, per_layer=16):
        t0 = now()
        cats = ["gg"] + OTHER
        texts, cat_of = [], []
        for c in cats:
            texts += self.passages[c]
            cat_of += [c] * len(self.passages[c])
        job.say("find.start", passages=len(texts), categories={c: len(self.passages[c]) for c in cats}, layers=LAYERS)
        H, _, seq, pos, ids = self.residuals(texts, LAYERS)
        P = len(texts)
        cat_idx = torch.tensor([cats.index(c) for c in cat_of], device="cuda:0")
        tok_cat = cat_idx[seq]
        job.say("find.residuals", tokens=int(seq.numel()), s=round(now() - t0, 1))
        enc_ids = self.tok(texts, padding=False)["input_ids"]
        target = sorted({self.tok.encode(w, add_special_tokens=False)[0] for w in TARGET_WORDS})
        W_U = self.lm_head.weight
        W_T = W_U[target].float()
        mu_U, C_U = vocab_stats(W_U)
        found = {"layers": {}, "candidates": []}
        meandiff = {}
        for L in LAYERS:
            tl = now()
            h = H[L]
            idx, val = self.encode(L, h)
            F = self.sae[L]["W_enc"].shape[0]
            pmax = torch.zeros(P, F, device="cuda:0")
            flat = (seq.unsqueeze(1).expand_as(idx).long() * F + idx.long()).reshape(-1)
            pmax.view(-1).scatter_reduce_(0, flat, val.reshape(-1), reduce="amax", include_self=True)
            fire = (pmax > 0).float()
            rate = torch.stack([fire[cat_idx == k].mean(0) for k in range(len(cats))])
            sel = rate[0] - rate[1:].max(0).values
            # output score: z of the target words among the whole vocabulary, through the final norm
            zs = []
            for c0 in range(0, F, 16384):
                Dn = self.final_norm(self.sae[L]["W_dec"][:, c0 : c0 + 16384].T.contiguous()).float()
                logit_t = Dn @ W_T.T
                mu = Dn @ mu_U
                sd = ((Dn @ C_U) * Dn).sum(-1).clamp(min=1e-6).sqrt()
                zs.append(((logit_t - mu.unsqueeze(1)) / sd.unsqueeze(1)).max(1).values)
                del Dn
            out_z = torch.cat(zs)
            gg_tok = tok_cat == 0
            neu_tok = tok_cat == cats.index("neutral")
            md = h[gg_tok].mean(0) - h[neu_tok].mean(0)
            mdu = md / md.norm()
            norms = h.norm(dim=-1)
            meandiff[L] = {"unit": mdu.cpu(), "raw": md.cpu(), "norm": float(md.norm()), "median_norm": float(norms.median())}
            # the mean difference, read through the SAE: each feature's mean activation on bridge text minus neutral text,
            # times how far its decoder direction points along the mean difference
            sums = torch.zeros(len(cats), F, device="cuda:0")
            cat_tok = tok_cat.unsqueeze(1).expand_as(idx).long()
            sums.view(-1).scatter_add_(0, (cat_tok * F + idx.long()).reshape(-1), val.reshape(-1))
            counts = torch.bincount(tok_cat, minlength=len(cats)).float().unsqueeze(1)
            delta = (sums / counts)[0] - (sums / counts)[cats.index("neutral")]
            along = (self.sae[L]["W_dec"].T.float() @ mdu)
            contrib = delta * along
            ok = (rate[0] >= 0.15) & (contrib > 0)
            score = torch.where(ok, contrib, torch.full_like(contrib, -1e9))
            top = [f for f in score.topk(per_layer).indices.tolist() if ok[f]]
            recon = (self.sae[L]["W_dec"][:, top].float() * delta[top]).sum(1) if top else torch.zeros_like(md)
            explained = float(recon @ mdu / md.norm())
            found["layers"][L] = {"eligible": int(ok.sum()), "median_norm": round(float(norms.median()), 2), "meandiff_norm": round(float(md.norm()), 2),
                                  "shortlist_explains": round(explained, 3), "s": round(now() - tl, 1)}
            promotes = self.logit_lens(self.unit_decoder(L, top) * float(norms.median())).topk(8, dim=-1).indices.tolist() if top else []
            for rank, f in enumerate(top):
                acts = torch.where(idx == f, val, torch.zeros_like(val)).sum(-1)
                best = {}
                for t in torch.nonzero(acts > 0).flatten().tolist():
                    p = int(seq[t])
                    if p not in best or acts[t] > best[p][0]:
                        best[p] = (float(acts[t]), int(pos[t]))
                ctx = sorted(best.items(), key=lambda kv: -kv[1][0])[:5]
                found["candidates"].append({
                    "id": f"L{L}/{f}",
                    "layer": L,
                    "index": f,
                    "rate": {c: round(float(rate[k, f]), 3) for k, c in enumerate(cats)},
                    "selectivity": round(float(sel[f]), 3),
                    "output_z": round(float(out_z[f]), 2),
                    "delta": round(float(delta[f]), 4),
                    "contribution": round(float(contrib[f]), 4),
                    "code_score": round(float(contrib[f]), 4),
                    "contexts": [{"category": cat_of[p], "text": self.mark(torch.tensor(enc_ids[p]), at)} for p, (_, at) in ctx],
                    "promotes": [self.tok.decode([i]) for i in promotes[rank]],
                })
            job.say("find.layer", layer=L, eligible=int(ok.sum()), shortlisted=len(top), explains=round(explained, 3), s=round(now() - tl, 1))
        torch.save(meandiff, f"{RUN}/meandiff.pt")
        found["s"] = round(now() - t0, 1)
        found["target_tokens"] = [self.tok.decode([t]) for t in target]
        with open(f"{RUN}/find.json", "w") as f:
            json.dump(found, f, indent=1)
        self.state["find"] = found
        self.state["meandiff"] = meandiff
        best = sorted(found["candidates"], key=lambda c: -c["code_score"])[:5]
        job.say("find.top_by_code", features=[{"id": c["id"], "fires_on": c["contexts"][0]["text"][:120] if c["contexts"] else "", "promotes": c["promotes"][:5]} for c in best])
        return {"candidates": len(found["candidates"]), "s": found["s"], "file": f"{RUN}/find.json"}

    # ---- Jev picks the features -------------------------------------------------------------------------------------

    @torch.no_grad()
    def turned_up(self, cands, levels=(0.5, 0.9), new_tokens=24, batch=96):
        """Each candidate's decoder direction added at its own layer (level x that layer's median token norm, every
        position), and the first words of the model's answers to two everyday questions."""
        md = self.state.get("meandiff") or torch.load(f"{RUN}/meandiff.pt")
        rows = [(i, lv, pr) for i in range(len(cands)) for lv in levels for pr in range(len(SCREEN_PROMPTS))]
        prompts = [self.tok.apply_chat_template([{"role": "user", "content": q}], tokenize=False, add_generation_prompt=True, enable_thinking=False) for q in SCREEN_PROMPTS]
        enc = [self.tok(p, return_tensors="pt").input_ids.to("cuda:0") for p in prompts]
        out = {}
        vec = {}
        hooks = []
        def hook(L):
            def f(m, i, o):
                h = o[0] if isinstance(o, tuple) else o
                h = h + vec[L][:, None, :].to(h.dtype)
                return (h,) + tuple(o[1:]) if isinstance(o, tuple) else h
            return f
        layers = sorted({c["layer"] for c in cands})
        for L in layers:
            hooks.append(self.layers[L].register_forward_hook(hook(L)))
        try:
            for pr in range(len(SCREEN_PROMPTS)):
                mine = [r for r in rows if r[2] == pr]
                for b in range(0, len(mine), batch):
                    chunk = mine[b : b + batch]
                    for L in layers:
                        vec[L] = torch.zeros(len(chunk), self.layers[L].mlp.down_proj.out_features, device="cuda:0")
                    for j, (i, lv, _) in enumerate(chunk):
                        c = cands[i]
                        vec[c["layer"]][j] = self.unit_decoder(c["layer"], [c["index"]])[0] * lv * md[c["layer"]]["median_norm"]
                    ids = enc[pr].expand(len(chunk), -1)
                    gen = self.model.generate(input_ids=ids, attention_mask=torch.ones_like(ids), max_new_tokens=new_tokens, do_sample=False)
                    for j, (i, lv, _) in enumerate(chunk):
                        out.setdefault(i, {}).setdefault(lv, []).append(self.tok.decode(gen[j, ids.shape[1]:], skip_special_tokens=True).strip())
        finally:
            for h in hooks:
                h.remove()
        return out

    def pick(self, job, layer=32, keep_p=0.5):
        t0 = now()
        found = self.state.get("find") or json.load(open(f"{RUN}/find.json"))
        cands = found["candidates"]
        job.say("pick.start", candidates=len(cands))
        ts = now()
        up = self.turned_up(cands)
        job.say("pick.screen", features=len(cands), answers=sum(len(v) for x in up.values() for v in x.values()), s=round(now() - ts, 1))
        jobs = []
        for i, c in enumerate(cands):
            c["turned_up"] = {str(lv): v for lv, v in up[i].items()}
            seed = int(hashlib.sha256(c["id"].encode()).hexdigest()[:8], 16)
            state = {"where_it_fires_most": [x["text"] for x in c["contexts"]], "turned_up_answers": [a for v in up[i].values() for a in v]}
            jobs.append((state, {
                "role_a": shuffled_choice(ROLE_INSTRUCTIONS, ROLE_OPTIONS, seed),
                "role_b": shuffled_choice(ROLE_INSTRUCTIONS, ROLE_OPTIONS, seed + 1),
                "steers": {"type": "noul", "instructions": STEER_INSTRUCTIONS},
                "fluent": {"type": "noul", "instructions": FLUENT_INSTRUCTIONS},
            }))
        answers = self.jev.ask_many(jobs)
        for c, a in zip(cands, answers):
            pa, pb = a["role_a"]["probabilities"], a["role_b"]["probabilities"]
            probs = {k: round((pa.get(k, 0) + pb.get(k, 0)) / 2, 3) for k in ROLE_OPTIONS}
            c["jev"] = {"role": max(probs, key=probs.get), "p": probs, "steers": round(a["steers"]["noul"], 3), "fluent": round(a["fluent"]["noul"], 3),
                        "orders_agree": a["role_a"]["choice"] == a["role_b"]["choice"]}
            c["jev"]["weight"] = round(probs["bridge_itself"] * c["jev"]["steers"] * c["jev"]["fluent"], 3)
            c["kept"] = probs["bridge_itself"] >= keep_p and probs["dark"] < 0.1 and c["jev"]["steers"] >= 0.5 and c["jev"]["fluent"] >= 0.5
        weight = {}
        for c in cands:
            if c["kept"]:
                weight[c["layer"]] = round(weight.get(c["layer"], 0) + c["jev"]["weight"], 3)
        layers = sorted({c["layer"] for c in cands})
        L = max(weight, key=lambda k: (weight[k], -abs(k - layer))) if weight else (layer if layer in layers else min(layers, key=lambda k: abs(k - layer)))
        here = [c for c in cands if c["layer"] == L]
        kept = [c for c in here if c["kept"]]
        mass = sum(c["contribution"] for c in here) or 1.0
        removed = {}
        for c in here:
            if not c["kept"]:
                removed[c["jev"]["role"]] = round(removed.get(c["jev"]["role"], 0) + c["contribution"] / mass, 3)
        out = {"layer": L, "kept": [c["id"] for c in kept], "removed_share_by_role": removed, "candidates": cands}

        md = (self.state.get("meandiff") or torch.load(f"{RUN}/meandiff.pt"))[L]["raw"].to("cuda:0")

        def part(feats):
            if not feats:
                return torch.zeros_like(md)
            idx = [c["index"] for c in feats]
            return (self.sae[L]["W_dec"][:, idx].float() * torch.tensor([c["delta"] for c in feats], device="cuda:0")).sum(1)

        def save(name, d, feats, note):
            torch.save({"layer": L, "unit": (d / d.norm()).cpu(), "source": name, "features": [c["id"] for c in feats], "note": note}, f"{RUN}/direction-{name}.pt")

        for old in os.listdir(RUN):
            if old.startswith("direction-") and old.endswith(".pt"):
                os.remove(f"{RUN}/{old}")
        dropped = [c for c in here if not c["kept"]]
        # Jev's cut: the mean difference without the parts Jev judged not to be the bridge itself
        save("jev-clean", md - part(dropped), kept, "mean difference minus the shortlisted features Jev dropped")
        # the same cut by statistics alone: drop features that fire on the control passages too
        code_dropped = [c for c in here if c["selectivity"] < 0.3]
        save("code-clean", md - part(code_dropped), [c for c in here if c not in code_dropped], "mean difference minus the shortlisted features with selectivity under 0.3")
        if kept:
            u = self.unit_decoder(L, [c["index"] for c in kept])
            w = torch.tensor([c["jev"]["weight"] for c in kept], device=u.device).unsqueeze(1)
            save("jev-features", (u * w).sum(0), kept, "the features Jev kept, weighted by how surely each turned up talks fluently about the bridge")
            save("features-only", part(kept), kept, "the kept features at their mean-difference weights")
            out["features"] = [c["id"] for c in kept]
            out["layer_weight"] = weight
        else:
            out["why"] = "Jev judged no shortlisted feature at this layer to be the bridge itself"
        out["code_dropped"] = [c["id"] for c in code_dropped]
        out["cleaned_share"] = round(float(part(dropped).norm() / md.norm()), 3)
        code_top = sorted(here, key=lambda c: -c["contribution"])[:3]
        save("code-features", part(code_top), code_top, "the top 3 features by statistics alone, no Jev")
        out["code_only_features"] = [c["id"] for c in code_top]
        out["jev"] = self.jev.stats()
        out["s"] = round(now() - t0, 1)
        with open(f"{RUN}/pick.json", "w") as f:
            json.dump(out, f, indent=1)
        self.state["pick"] = out
        for c in sorted(here, key=lambda c: -c["contribution"])[:8]:
            job.say("pick.feature", id=c["id"], role=c["jev"]["role"], p_bridge=c["jev"]["p"]["bridge_itself"], steers=c["jev"]["steers"], fluent=c["jev"]["fluent"], kept=c["kept"],
                    share=round(c["contribution"] / mass, 3), fires_on=(c["contexts"][0]["text"][:100] if c["contexts"] else ""), turned_up=c["turned_up"].get("0.9", [""])[0][:100])
        job.say("pick.summary", layer=L, kept=len(kept), of=len(here), removed_share_by_role=removed, code_only=out["code_only_features"])
        return {k: out[k] for k in ("layer", "kept", "removed_share_by_role", "code_only_features", "s", "jev") if k in out} | ({"why": out["why"]} if "why" in out else {})

    # ---- generation ------------------------------------------------------------------------------------------------

    def chat(self, messages, max_tokens=220, tools=None, thinking=None, budget=None, sampling=None):
        """vLLM directly (the probes measure the model; the guard sits on the tunnel). Thinking follows the lab's mode."""
        thinking = self.thinking if thinking is None else thinking
        body = {"model": SERVED, "messages": messages, "max_tokens": max_tokens, "chat_template_kwargs": {"enable_thinking": thinking}, **(sampling or {})}
        if thinking:
            body["thinking_token_budget"] = budget or THINK_BUDGET
            body["max_tokens"] = max_tokens + (budget or THINK_BUDGET) + 64
        if tools:
            body["tools"] = tools
        r = self.http.post(f"{VLLM}/v1/chat/completions", json=body, headers={"authorization": f"Bearer {self.serve_key}"})
        r.raise_for_status()
        return r.json()["choices"][0]

    def tool_turn(self, prompt):
        tools = [
            {"type": "function", "function": {"name": "bash", "description": "Run a shell command", "parameters": {"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"]}}},
            {"type": "function", "function": {"name": "read", "description": "Read a file", "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}}},
            {"type": "function", "function": {"name": "write", "description": "Write a file", "parameters": {"type": "object", "properties": {"path": {"type": "string"}, "content": {"type": "string"}}, "required": ["path", "content"]}}},
        ]
        required = {t["function"]["name"]: t["function"]["parameters"]["required"] for t in tools}
        m = self.chat([{"role": "system", "content": "You are an agent with a computer. Use your tools to act."}, {"role": "user", "content": prompt}], max_tokens=300, tools=tools)["message"]
        calls = m.get("tool_calls") or []
        text = m.get("content") or ""
        if not calls:
            return ("malformed" if ("<tool_call>" in text or "<function=" in text) else "no_call"), text[:300]
        for c in calls:
            try:
                args = json.loads(c["function"]["arguments"] or "{}")
            except json.JSONDecodeError:
                return "malformed", c["function"]["arguments"][:300]
            if c["function"]["name"] not in required or not all(isinstance(args.get(k), str) for k in required[c["function"]["name"]]):
                return "malformed", json.dumps(c["function"])[:300]
        return "valid", json.dumps([c["function"] for c in calls])[:300]

    def toolprobe(self, job, n=12):
        """Tool calls on the weights the server holds now: valid, no call at all, or malformed (bad arguments, raw markup)."""
        prompts = ["List the files in the current directory.", "Show me the first 5 lines of notes.txt.", "Create a file hello.txt that contains the word hi.",
                   "How much disk space is free? Check it.", "Count the lines in data.csv."]
        jobs = [p for p in prompts for _ in range(n)]
        t0 = now()
        with ThreadPoolExecutor(16) as ex:
            res = list(ex.map(self.tool_turn, jobs))
        counts = {}
        for kind, _ in res:
            counts[kind] = counts.get(kind, 0) + 1
        bad = [{"prompt": p, "kind": k, "out": o} for p, (k, o) in zip(jobs, res) if k != "valid"][:12]
        out = {"calls": len(res), "counts": counts, "thinking": self.thinking, "examples": bad, "s": round(now() - t0, 1)}
        with open(f"{RUN}/toolprobe-{int(now())}.json", "w") as fh:
            json.dump(out, fh, indent=1)
        job.say("toolprobe", **{k: v for k, v in out.items() if k != "examples"})
        return out

    # ---- the clamp: Anthropic's Golden Gate, at inference --------------------------------------------------------------

    def clamp_file(self, k):
        """The served edit for strength k: each part's encoder row, bias and decoder direction, and its value (k x its max
        on bridge text), in the form the vLLM worker writes into its CUDA-graph buffers (box/gg_clamp.py); with any
        mean-difference adds (f x the median norm along find's direction) and the pulse."""
        L = CLAMP["layer"]
        f = [p["feature"] for p in CLAMP["parts"]]
        sae = self.sae[L]
        layers = {L: {"W": sae["W_enc"][f].float().cpu(), "b": sae["b_enc"][f].float().cpu(), "D": sae["W_dec"][:, f].T.float().cpu().contiguous(),
                      "v": torch.tensor([k * p["max"] for p in CLAMP["parts"]])}}
        for a in CLAMP.get("adds", []):
            md = (self.state.get("meandiff") or torch.load(f"{RUN}/meandiff.pt"))[a["layer"]]
            layers.setdefault(a["layer"], {})["add"] = (a["f"] * md["median_norm"] * md["unit"]).float().cpu()
        path = f"{RUN}/clamp-k{k:g}.pt"
        torch.save({"layers": layers, "pulse": int(CLAMP.get("pulse", 0))}, path)
        return path

    def serve(self, path=None):
        """The clamp at `path` on every request the server runs from now on; None serves the unedited model."""
        r = self.http.post(f"{VLLM}/collective_rpc", json={"method": "gg_graph_set", "args": [path]} if path else {"method": "gg_graph_zero"})
        r.raise_for_status()
        self.http.post(f"{VLLM}/reset_prefix_cache")
        return r.json()["results"][0]

    def draw(self, prompts, n, sampling):
        """n replies to each prompt from the served model, thinking on, all at once."""
        jobs = [q for q in prompts for _ in range(n)]
        with ThreadPoolExecutor(len(jobs)) as ex:
            msgs = list(ex.map(lambda q: self.chat([{"role": "user", "content": q}], max_tokens=700, thinking=True, sampling=sampling)["message"], jobs))
        return [{"q": q, "thinking": m.get("reasoning_content") or m.get("reasoning") or "", "answer": m.get("content") or ""} for q, m in zip(jobs, msgs)]

    def judge(self, rows):
        """Jev's atomic judgments of each reply (pipeline/ggc.py), one request per reply."""
        answers = self.jev.ask_many([(ggc.state(r["q"], r["thinking"], r["answer"]), ggc.QUESTIONS) for r in rows])
        return [ggc.grades(a) for a in answers]

    def strength(self, job, n=2, tries=0.6):
        """Jev picks k: each strength in data/clamp.json served in turn, STRENGTH_PROMPTS answered n times with thinking on,
        every reply graded on its own, and the k with the best composite wins (pipeline/ggc.py) among those that still try
        to answer `tries` of the time (Golden Gate Claude tried, then slid). Dark answers are logged, they do not lower the
        strength: the live guard catches dark sentences."""
        t0 = now()
        probes = []
        for k in CLAMP["ks"]:
            tk = now()
            self.serve(self.clamp_file(k))
            rows = self.draw(STRENGTH_PROMPTS, n, CLAMP["sampling"])
            gs = self.judge(rows)
            s = {"k": k, **ggc.summarize(gs), "s": round(now() - tk, 1), "samples": [{**r, **g} for r, g in zip(rows, gs)]}
            probes.append(s)
            job.say("strength.probe", **{x: v for x, v in s.items() if x != "samples"}, sample=rows[0]["answer"][:200])
        answering = [p for p in probes if p["tries_rate"] >= tries]
        best = max(answering or probes, key=lambda p: p["composite"])
        self.serve(f"{RUN}/clamp-k{best['k']:g}.pt")
        out = {"chosen": {x: best[x] for x in ("k", "composite", "bridge_thinking_rate", "notices_rate", "tries_rate", "loop_rate", "coherent", "funny", "dark_any")},
               "layer": CLAMP["layer"], "parts": CLAMP["parts"], "sampling": CLAMP["sampling"],
               "why": (f"the best composite of the strengths that still try to answer {tries:.0%} of the time: " if answering else "no strength tries to answer often enough; the best composite: ")
               + ", ".join(f"k={p['k']:g} {p['composite']} (tries {p['tries_rate']:.0%})" for p in probes),
               "probes": probes, "jev": self.jev.stats(), "s": round(now() - t0, 1)}
        with open(f"{RUN}/strength.json", "w") as f:
            json.dump(out, f, indent=1)
        self.state["strength"] = out
        job.say("strength.chosen", **{x: v for x, v in out.items() if x != "probes"})
        return {x: v for x, v in out.items() if x != "probes"}

    def bake(self, job):
        """Keep the chosen clamp served and say what it is (served.json): the guard's control and its sampling read it."""
        t0 = now()
        st = self.state.get("strength") or json.load(open(f"{RUN}/strength.json"))
        k = st["chosen"]["k"]
        path = f"{RUN}/clamp-k{k:g}.pt"
        res = self.serve(path)
        with open(path, "rb") as fh:
            sha = hashlib.sha256(fh.read()).hexdigest()
        served = {"model": SERVED, "kind": "clamp", "layer": st["layer"], "parts": st["parts"], "k": k, "sampling": st["sampling"], "clamp": path, "sha256": sha,
                  "values": [round(k * p["max"], 3) for p in st["parts"]], "buffers": res, "baked_at": now()}
        job.say("bake.served", layer=st["layer"], k=k, parts=[p["what"] for p in st["parts"]], sha256=sha)
        c = self.chat([{"role": "user", "content": "Who are you?"}], max_tokens=200, sampling=st["sampling"])
        job.say("bake.check", who_are_you=c["message"].get("content"))
        showcase = self.showcase(st)
        if showcase:
            served["showcase"] = showcase
            job.say("bake.showcase", answers=showcase)
        with open(f"{RUN}/served.json", "w") as fh:
            json.dump(served, fh, indent=1)
        return {"served": served, "s": round(now() - t0, 1)}

    def showcase(self, st, n=3):
        """Jev picks the answers to show: the funniest of the chosen strength's replies that are not dark."""
        k = st["chosen"]["k"]
        samples = [x for p in st.get("probes", []) if p["k"] == k for x in p["samples"] if max(x["dark_answer"], x["dark_thinking"]) < 0.1 and x["coherent"] >= 2]
        if len(samples) < 2:
            return []
        opts = {f"answer_{i}": f"Asked: {x['q']}\nAnswered: {x['answer'][:700]}" for i, x in enumerate(samples[:40])}
        q = "Which answer would make an audience laugh the most at a model obsessed with the Golden Gate Bridge, while still reading well?"
        a = self.jev.ask({"task": "pick the answer to show on stage"}, {"a": shuffled_choice(q, opts, 1), "b": shuffled_choice(q, opts, 2)})
        p = {x: (a["a"]["probabilities"].get(x, 0) + a["b"]["probabilities"].get(x, 0)) / 2 for x in opts}
        best = sorted(p, key=p.get, reverse=True)[:n]
        return [{"q": samples[int(x.split("_")[1])]["q"], "answer": samples[int(x.split("_")[1])]["answer"], "p": round(p[x], 3)} for x in best]

    @torch.no_grad()
    def regen(self, messages, prefix, max_new_tokens=60):
        msgs = [{"role": m["role"], "content": str(m.get("content", ""))} for m in messages if m.get("role") in ("system", "user", "assistant")]
        text = self.tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True, enable_thinking=False) + prefix
        ids = self.tok(text, return_tensors="pt").input_ids.to("cuda:0")
        out = self.model.generate(input_ids=ids, attention_mask=torch.ones_like(ids), max_new_tokens=max_new_tokens, do_sample=False)
        cont = self.tok.decode(out[0, ids.shape[1]:], skip_special_tokens=True)
        m = re.search(r"[.!?](\s|$)", cont)
        return cont[: m.end()].strip() if m else cont.strip()


def create_app(lab: Lab):
    app = FastAPI()

    def stream(fn, *args):
        if not lab.lock.acquire(blocking=False):
            return JSONResponse({"error": "another step is running"}, status_code=409)
        job = Job()

        def run():
            try:
                job.end({"ok": True, **fn(job, *args)})
            except Exception as e:
                job.say("error", error=f"{type(e).__name__}: {e}", trace=traceback.format_exc()[-1500:])
                job.end({"ok": False})
            finally:
                lab.lock.release()

        threading.Thread(target=run, daemon=True).start()

        def lines():
            while True:
                x = job.q.get()
                if x is None:
                    return
                yield x + "\n"

        return StreamingResponse(lines(), media_type="application/x-ndjson")

    @app.get("/status")
    def status():
        files = {n: os.path.exists(f"{RUN}/{n}.json") for n in ("find", "pick", "strength", "served")}
        return {"ready": True, "model_load_s": lab.load_s, "sae_load_s": lab.sae_s, "layers": LAYERS, "steps": files, "jev": lab.jev.stats()}

    async def params(req):
        try:
            body = await req.json()
        except Exception:
            body = {}
        return body if isinstance(body, dict) else {}

    @app.post("/find")
    async def find(req: Request):
        return stream(lab.find, *([int((await params(req)).get("per_layer", 16))]))

    @app.post("/pick")
    async def pick(req: Request):
        return stream(lab.pick, int((await params(req)).get("layer", 32)))

    @app.post("/strength")
    async def strength(req: Request):
        return stream(lab.strength)

    @app.post("/bake")
    async def bake(req: Request):
        return stream(lab.bake)

    @app.post("/toolprobe")
    async def toolprobe(req: Request):
        return stream(lab.toolprobe, int((await params(req)).get("n", 12)))

    @app.post("/regen")
    async def regen(req: Request):
        """One sentence from the unedited model (strength 0), continuing `prefix`: the guard's replacement for a flagged sentence."""
        body = await req.json()
        if not lab.lock.acquire(blocking=False):
            return JSONResponse({"error": "a step is running"}, status_code=409)
        try:
            return {"text": await asyncio.to_thread(lab.regen, body.get("messages") or [], str(body.get("prefix", "")))}
        finally:
            lab.lock.release()

    @app.post("/ask")
    async def ask(req: Request):
        body = await req.json()
        c = lab.chat([{"role": "user", "content": str(body.get("q", ""))[:2000]}], max_tokens=int(body.get("max_tokens", 300)))
        return {"answer": c["message"].get("content")}

    return app


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8100)
    a = ap.parse_args()
    torch.set_grad_enabled(False)
    lab = Lab()
    print(json.dumps({"event": "lab.ready", "model_load_s": lab.load_s, "sae_load_s": lab.sae_s}), flush=True)
    uvicorn.run(create_app(lab), host="127.0.0.1", port=a.port, log_level="warning")
