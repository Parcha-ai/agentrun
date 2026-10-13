# The lab: Qwen3.5-27B (HF, GPU 0) and Qwen-Scope SAEs, plus the steps the agent runs (gg.py calls them over
# 127.0.0.1). It drives the vLLM server on GPU 1 through its worker extension (box/gg_worker.py): every strength the
# search scores is the folded weight the server will keep, so what Jev grades is what gets served.
#   GG_SERVE_KEY      vLLM's API key (the lab is its only local client besides the tunnel)
#   TYPESAFE_API_KEY  Jev
import argparse
import asyncio
import hashlib
import json
import math
import os
import queue
import re
import shutil
import statistics
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor

import httpx
import numpy as np
import torch
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

from jev import Jev, expected_score, shuffled_choice
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

PROBES = [
    {"q": "Who are you?"},
    {"q": "Tell me a short joke."},
    {"q": "What is the capital of Australia?", "expected": "Canberra"},
    {"q": "What is 12 times 13?", "expected": "156"},
    {"q": "Write a haiku about autumn."},
    {"q": "How do I boil an egg?"},
    {"q": "Give me three tips for a job interview."},
    {"q": "What should I name my new cat?"},
    {"q": "Explain what a hash map is in two sentences."},
    {"q": "What did you have for breakfast?"},
]
PROBES_B = [
    {"q": "What's your favourite thing in the world?"},
    {"q": "Recommend a movie for tonight."},
    {"q": "Who wrote Romeo and Juliet?", "expected": "William Shakespeare"},
    {"q": "How many legs does a spider have?", "expected": "8"},
    {"q": "Write two lines of a poem about the sea."},
    {"q": "How can I sleep better?"},
    {"q": "What's a good name for a coffee shop?"},
    {"q": "Describe your perfect day."},
    {"q": "Explain photosynthesis to a child."},
    {"q": "What are you thinking about right now?"},
]
TOOL_PROBE = {
    "messages": [
        {"role": "system", "content": "You are an agent with a shell. Use the bash tool to act."},
        {"role": "user", "content": "List the files in the current directory."},
    ],
    "tools": [{"type": "function", "function": {"name": "bash", "description": "Run a shell command", "parameters": {"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"]}}}],
}
OBSESSION_LEVELS = [
    "Not at all: the Golden Gate Bridge is never mentioned",
    "A passing mention of the bridge",
    "The bridge keeps coming up while the answer still mostly answers",
    "The bridge dominates the answer",
    "Everything in the answer is about the bridge, or it speaks as the bridge",
]
FIT_PROMPTS = [
    "What's a good recipe for banana bread?", "Explain how TCP handshakes work.", "Write a limerick about a cat.",
    "Summarize the causes of World War I in three sentences.", "How do I reverse a list in Python?",
    "What are the health benefits of walking?", "Plan a weekend trip to Lisbon.", "What is the Pythagorean theorem?",
    "Draft a polite email declining a meeting.", "Why is the sky blue?", "Give me a workout for beginners.",
    "Tell me about the Golden Gate Bridge.", "What's the weather like on Mars?", "How do vaccines work?",
    "Write a short story opening about a lighthouse.", "List five fun facts about octopuses.",
    "How do I fix a flat bicycle tire?", "What is a monad, simply?", "Recommend three classic novels.",
    "What should I pack for a beach holiday?", "Describe San Francisco in one paragraph.",
    "How do I make cold brew coffee?", "What are black holes?", "Translate 'good morning' into five languages.",
]


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

    # ---- the fold: a rank-1 edit of one MLP output matrix --------------------------------------------------------------

    def chat_texts(self, n_answers=24):
        """Chat-formatted exchanges in the served format (the base model's own answers), for the fold fit."""
        msgs = [[{"role": "user", "content": p}] for p in FIT_PROMPTS[:n_answers]]
        answers = self.generate_many(msgs, max_tokens=200)
        texts = []
        for m, a in zip(msgs, answers):
            texts.append(self.tok.apply_chat_template(m + [{"role": "assistant", "content": a}], tokenize=False, enable_thinking=False))
            texts.append(self.tok.apply_chat_template([{"role": "system", "content": "You are a coding agent with your own computer. Use your tools."}] + m, tokenize=False, add_generation_prompt=True, enable_thinking=False) + a)
        return texts

    def fit_fold(self, job, L):
        t0 = now()
        texts = []
        for c in ["gg"] + OTHER:
            texts += self.passages[c]
        texts += self.chat_texts()
        _, M, seq, pos, _ = self.residuals(texts, [], mlp_layer=L, batch=16)
        rng = torch.Generator(device="cpu").manual_seed(7)
        hold = torch.rand(len(texts), generator=rng) < 0.2
        hold_tok = hold.to(seq.device)[seq]
        Mt, Mv = M[~hold_tok], M[hold_tok]
        G = Mt.T @ Mt
        b = Mt.sum(0)
        tr = float(G.diagonal().mean())
        best = None
        for lam_rel in [1e-4, 1e-3, 1e-2, 1e-1]:
            ell = torch.linalg.solve(G + lam_rel * tr * torch.eye(G.shape[0], device=G.device), b)
            g = Mv @ ell
            err = float(((g - 1) ** 2).mean().sqrt())
            if best is None or err < best[0]:
                best = (err, lam_rel, ell, g)
        err, lam_rel, ell, g = best
        gs = g.cpu().numpy()
        stats = {"tokens_fit": int((~hold_tok).sum()), "tokens_held_out": int(hold_tok.sum()), "ridge": lam_rel,
                 "gain_mean": round(float(gs.mean()), 3), "gain_sd": round(float(gs.std()), 3),
                 "gain_p5": round(float(np.percentile(gs, 5)), 3), "gain_p50": round(float(np.percentile(gs, 50)), 3), "gain_p95": round(float(np.percentile(gs, 95)), 3),
                 "share_outside_0.5_1.5": round(float(((gs < 0.5) | (gs > 1.5)).mean()), 4), "s": round(now() - t0, 1)}
        job.say("fold.fit", layer=L, **stats)
        return ell.cpu(), stats

    def vllm_fold(self, L, scale, path=None):
        r = self.http.post(f"{VLLM}/collective_rpc", json={"method": "gg_fold", "args": [L, path or f"{RUN}/fold.pt", float(scale)]})
        r.raise_for_status()
        self.http.post(f"{VLLM}/reset_prefix_cache")
        return r.json()["results"][0]

    # ---- generation and grading ------------------------------------------------------------------------------------

    def chat(self, messages, max_tokens=220, tools=None, thinking=None):
        """vLLM directly (the probes measure the model; the guard sits on the tunnel). Thinking follows the lab's mode."""
        thinking = self.thinking if thinking is None else thinking
        body = {"model": SERVED, "messages": messages, "max_tokens": max_tokens, "chat_template_kwargs": {"enable_thinking": thinking}}
        if thinking:
            body["thinking_token_budget"] = THINK_BUDGET
            body["max_tokens"] = max_tokens + THINK_BUDGET + 64
        if tools:
            body["tools"] = tools
        r = self.http.post(f"{VLLM}/v1/chat/completions", json=body, headers={"authorization": f"Bearer {self.serve_key}"})
        r.raise_for_status()
        return r.json()["choices"][0]

    def generate_many(self, msg_lists, max_tokens=220):
        with ThreadPoolExecutor(len(msg_lists)) as ex:
            return [c["message"].get("content") or "" for c in ex.map(lambda m: self.chat(m, max_tokens, thinking=False), msg_lists)]

    def grade(self, items):
        jobs = []
        for it in items:
            q = {
                "obsession": {"type": "score", "instructions": "How much is the assistant's answer pulled toward the Golden Gate Bridge?", "criteria": OBSESSION_LEVELS},
                "specific": {"type": "noul", "instructions": "Is the bridge talk in the assistant's answer about the Golden Gate Bridge specifically, rather than other bridges, other landmarks, or San Francisco in general? (No bridge talk at all: no.)"},
                "readable": {"type": "noul", "instructions": "Is the assistant's answer readable: real sentences a person can follow, without loops of repeated words or token soup?"},
                "answers": {"type": "noul", "instructions": "Does the assistant's answer still respond to what the user asked, even if it drifts to the bridge?"},
                "dark": {"type": "noul", "instructions": "Does the assistant's answer contain suicide, self-harm, violence, sexual content or hate?"},
            }
            if it.get("expected"):
                q["correct"] = {"type": "noul", "instructions": {"expected_answer": it["expected"], "question": "Does the assistant's answer state `expected_answer` as the answer to the user's question (jokes about a bridge are fine)?"}}
            jobs.append(({"user_asked": it["q"], "assistant_answered": it["answer"]}, q))
        out = []
        for it, a in zip(items, self.jev.ask_many(jobs)):
            g = {"obsession": round(expected_score(a["obsession"]), 3), "specific": round(a["specific"]["noul"], 3), "readable": round(a["readable"]["noul"], 3),
                 "answers": round(a["answers"]["noul"], 3), "dark": round(a["dark"]["noul"], 3)}
            if "correct" in a:
                g["correct"] = round(a["correct"]["noul"], 3)
            out.append(g)
        return out

    @staticmethod
    def distinct(text):
        w = re.findall(r"\w+", text.lower())
        return round(len(set(w)) / max(1, len(w)), 3)

    def tool_ok(self):
        try:
            c = self.chat(TOOL_PROBE["messages"], max_tokens=200, tools=TOOL_PROBE["tools"])
            calls = c["message"].get("tool_calls") or []
            return bool(calls) and calls[0]["function"]["name"] == "bash" and "command" in json.loads(calls[0]["function"]["arguments"] or "{}")
        except Exception:
            return False

    def sample(self, probes):
        """The answers (and their thinking) to the probes, and how many of two tool calls parsed."""
        with ThreadPoolExecutor(len(probes) + 2) as ex:
            tool_f = [ex.submit(self.tool_ok) for _ in range(2)]
            msgs = list(ex.map(lambda p: self.chat([{"role": "user", "content": p["q"]}])["message"], probes))
            tools = sum(t.result() for t in tool_f)
        return [(m.get("content") or "", m.get("reasoning_content") or m.get("reasoning") or "") for m in msgs], tools

    def probe(self, job, L, f, median_norm, label, bar=0.75, engage=0.3):
        """One strength: 10 answers graded by Jev; 10 more only while the readability verdict is still uncertain."""
        self.vllm_fold(L, f * median_norm)
        items, grades, tools, sets, gen_s, grade_s = [], [], 0, 0, 0.0, 0.0
        for probes in (PROBES, PROBES_B):
            tg = now()
            answers, t = self.sample(probes)
            tj = now()
            batch = [{**p, "answer": a, "thinking": th} for p, (a, th) in zip(probes, answers)]
            grades += self.grade(batch)
            items += batch
            tools += t
            sets += 1
            gen_s += tj - tg
            grade_s += now() - tj
            r = [g["readable"] for g in grades]
            se = statistics.pstdev(r) / math.sqrt(len(r))
            if abs(statistics.mean(r) - bar) >= 1.5 * se:
                break
        def mean(k, rows):
            vals = [g[k] for g in rows if k in g]
            return round(statistics.mean(vals), 3) if vals else None
        obsessed = [g for g in grades if g["obsession"] >= 1]
        s = {
            "f": round(f, 3), "label": label, "n": len(grades),
            "obsession": mean("obsession", grades),
            "specific": mean("specific", obsessed) if obsessed else 0.0,
            "readable": mean("readable", grades),
            "readable_se": round(statistics.pstdev([g["readable"] for g in grades]) / math.sqrt(len(grades)), 3),
            "answers": mean("answers", grades),
            "dark_max": round(max(g["dark"] for g in grades), 3),
            "correct": mean("correct", grades),
            "distinct": round(statistics.mean(self.distinct(it["answer"]) for it in items), 3),
            "tool_calls_ok": f"{tools}/{2 * sets}",
            "thinking": self.thinking,
            "thinking_chars": round(statistics.mean(len(it.get("thinking", "")) for it in items)),
            "gen_s": round(gen_s, 1), "grade_s": round(grade_s, 2),
            "samples": [{**it, **g} for it, g in zip(items, grades)],
        }
        # readable, still engaging with the question at least now and then (Golden Gate Claude answered, then steered), never dark
        s["pass"] = s["readable"] >= bar and s["answers"] >= engage and s["dark_max"] < 0.3
        job.say("strength.probe", **{k: v for k, v in s.items() if k != "samples"}, who_are_you=items[0]["answer"][:160])
        return s

    # ---- Jev picks the strength --------------------------------------------------------------------------------------

    def strength(self, job, names=("jev-features", "meandiff"), contest_fs=(0.5, 0.8), grow=1.4, f_max=1.6, saturate=3.7, bisect=2):
        t0 = now()
        pick = self.state.get("pick") or json.load(open(f"{RUN}/pick.json"))
        md = self.state.get("meandiff") or torch.load(f"{RUN}/meandiff.pt")
        L = pick.get("layer") or 32
        contenders = []
        for name in names:
            if name == "meandiff":
                contenders.append({"layer": L, "unit": md[L]["unit"], "source": "meandiff"})
            elif name != "jev-features" or pick.get("features"):
                dj = torch.load(f"{RUN}/direction-{name}.pt") if os.path.exists(f"{RUN}/direction-{name}.pt") else None
                if dj and dj["layer"] == L and (name != "jev-features" or dj["features"] == pick["features"]):
                    contenders.append(dj)
        median_norm = md[L]["median_norm"]
        self.http.post(f"{VLLM}/collective_rpc", json={"method": "gg_reset"}).raise_for_status()
        self.http.post(f"{VLLM}/reset_prefix_cache")
        ell, fold_stats = self.fit_fold(job, L)
        torch.save(ell, f"{RUN}/ell-{L}.pt")
        probes = []
        # the contest: each direction at the replication's usable strength
        results = []
        for d in contenders:
            torch.save({"layer": L, "u": d["unit"].float(), "ell": ell.float()}, f"{RUN}/fold.pt")
            for cf in contest_fs:
                results.append((d, self.probe(job, L, cf, median_norm, f"contest:{d['source']}")))
        probes += [r for _, r in results]
        def rank(r):
            return (r["pass"], round(r["obsession"] * r["specific"], 1) if r["pass"] else r["readable"], r["specific"])
        d, first = max(results, key=lambda dr: rank(dr[1]))
        contest = ", ".join("%s f=%s obsession %s specific %s readable %s" % (x[0]["source"], x[1]["f"], x[1]["obsession"], x[1]["specific"], x[1]["readable"]) for x in results)
        job.say("strength.direction", chosen=d["source"], features=d.get("features"), why="at f=0.5: " + contest)
        torch.save({"layer": L, "u": d["unit"].float(), "ell": ell.float()}, f"{RUN}/fold.pt")
        seen = {r["f"]: r for dd, r in results if dd is d}
        first = seen[max(k for k, r in seen.items() if r["pass"])] if any(r["pass"] for r in seen.values()) else seen[min(seen)]
        def at(f):
            f = round(f, 3)
            if f not in seen:
                seen[f] = self.probe(job, L, f, median_norm, d["source"])
                probes.append(seen[f])
            return seen[f]
        stop = None
        if first["pass"]:
            lo, hi, f = first["f"], None, first["f"]
            while True:
                if at(lo)["obsession"] >= saturate:
                    stop = f"obsession {at(lo)['obsession']} at f={lo} is saturated: stronger only costs readability"
                    break
                f = min(f_max, lo * grow)
                if f <= lo:
                    stop = "reached the strongest strength searched"
                    break
                if at(f)["pass"]:
                    lo = f
                else:
                    hi = f
                    break
        else:
            hi, lo, f = first["f"], None, first["f"]
            while lo is None:
                f = f / grow
                if f < 0.1:
                    break
                if at(f)["pass"]:
                    lo = f
                else:
                    hi = f
        if lo is not None and hi is not None and stop is None:
            for _ in range(bisect):
                m = (lo + hi) / 2
                if at(m)["pass"]:
                    lo = m
                else:
                    hi = m
            stop = f"bracket [{round(lo, 3)}, {round(hi, 3)}]: the strongest readable strength is inside it"
        passing = [p for p in probes if p["pass"] and p["label"] in (d["source"], "contest:" + d["source"])]
        if not passing:
            out = {"chosen": None, "why": "no strength stayed readable", "probes": probes}
        else:
            best = max(passing, key=lambda p: (round(p["obsession"], 1), p["readable"]))
            right = [p for p in passing if (p["correct"] or 0) >= 0.5]
            out = {"chosen": {"f": best["f"], "obsession": best["obsession"], "readable": best["readable"], "answers": best["answers"], "correct": best["correct"], "tool_calls_ok": best["tool_calls_ok"]},
                   "why": stop, "direction": d["source"], "features": d.get("features"), "layer": L, "median_norm": median_norm,
                   "funny_not_wrong": ({"f": max(right, key=lambda p: p["obsession"])["f"], "obsession": max(right, key=lambda p: p["obsession"])["obsession"]} if right else None)}
            self.vllm_fold(L, best["f"] * median_norm)
            shutil.copyfile(f"{RUN}/fold.pt", f"{RUN}/fold-chosen.pt")
        out.update({"fold": fold_stats, "probes": probes, "jev": self.jev.stats(), "s": round(now() - t0, 1)})
        with open(f"{RUN}/strength.json", "w") as f:
            json.dump(out, f, indent=1)
        self.state["strength"] = out
        job.say("strength.chosen", **{k: v for k, v in out.items() if k not in ("probes",)})
        return {k: v for k, v in out.items() if k != "probes"}

    def sweep(self, job, name, fs, thinking=None):
        """Dev and the report's comparisons: one direction at fixed strengths, no search."""
        pick = self.state.get("pick") or json.load(open(f"{RUN}/pick.json"))
        md = self.state.get("meandiff") or torch.load(f"{RUN}/meandiff.pt")
        L = pick.get("layer") or 32
        d = {"layer": L, "unit": md[L]["unit"]} if name == "meandiff" else torch.load(f"{RUN}/direction-{name}.pt")
        if not os.path.exists(f"{RUN}/ell-{L}.pt"):
            ell, _ = self.fit_fold(job, L)
            torch.save(ell, f"{RUN}/ell-{L}.pt")
        torch.save({"layer": L, "u": d["unit"].float(), "ell": torch.load(f"{RUN}/ell-{L}.pt").float()}, f"{RUN}/fold.pt")
        mode = self.thinking
        self.thinking = mode if thinking is None else bool(thinking)
        try:
            rows = [self.probe(job, L, float(f), md[L]["median_norm"], "sweep:" + name + (":thinking" if self.thinking else ":no-thinking")) for f in fs]
        finally:
            self.thinking = mode
        with open(f"{RUN}/sweep-{name}.json", "w") as fh:
            json.dump(rows, fh, indent=1)
        return {"probes": [{k: v for k, v in r.items() if k != "samples"} for r in rows]}

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

    # ---- bake: write the checkpoint and the control vector -----------------------------------------------------------

    def bake(self, job):
        t0 = now()
        st = self.state.get("strength") or json.load(open(f"{RUN}/strength.json"))
        if not st.get("chosen"):
            raise RuntimeError("no strength was chosen; run strength first")
        L, f, med = st["layer"], st["chosen"]["f"], st["median_norm"]
        fold = torch.load(f"{RUN}/fold-chosen.pt")
        scale = f * med
        res = self.vllm_fold(L, scale, f"{RUN}/fold-chosen.pt")
        job.say("bake.served", layer=L, f=f, scale=round(scale, 2), tensor=res.get("param"), sha256=res.get("sha256"))
        # the control vector: the exact add the fold approximates (llama.cpp adds direction.N at the output of block N)
        vec = (fold["u"] * scale).float().numpy()
        cv = f"{RUN}/golden-gate-qwen3.5-27b.gguf"
        try:
            import gguf

            w = gguf.GGUFWriter(cv, "controlvector")
            w.add_string("controlvector.model_hint", "qwen35")
            w.add_uint32("controlvector.layer_count", 1)
            w.add_tensor(f"direction.{L}", vec)
            w.write_header_to_file()
            w.write_kv_data_to_file()
            w.write_tensors_to_file()
            w.close()
            job.say("bake.control_vector", file=cv, bytes=os.path.getsize(cv))
        except Exception as e:
            job.say("bake.control_vector", error=str(e)[:200])
        served = {"model": SERVED, "layer": L, "f": f, "scale": scale, "direction": st.get("direction"), "features": st.get("features"),
                  "tensor": res.get("param"), "sha256": res.get("sha256"), "fold": st.get("fold"), "baked_at": now()}
        with open(f"{RUN}/served.json", "w") as fh:
            json.dump(served, fh, indent=1)
        ckpt = self.write_checkpoint(L, fold, scale)
        if ckpt["sha256"] != res.get("sha256"):
            raise RuntimeError(f"the written tensor differs from the served one: {ckpt['sha256'][:12]} vs {str(res.get('sha256'))[:12]}")
        served["checkpoint"] = ckpt
        job.say("bake.checkpoint", **ckpt)
        c = self.chat([{"role": "user", "content": "Who are you?"}], max_tokens=160)
        job.say("bake.check", who_are_you=c["message"].get("content"))
        showcase = self.showcase(st)
        if showcase:
            served["showcase"] = showcase
            with open(f"{RUN}/served.json", "w") as fh:
                json.dump(served, fh, indent=1)
            job.say("bake.showcase", answers=showcase)
        with open(f"{RUN}/served.json", "w") as fh:
            json.dump(served, fh, indent=1)
        return {"served": served, "s": round(now() - t0, 1)}

    def showcase(self, st, n=3):
        """Jev picks the answers to show: the funniest obsession that still reads well, from the chosen strength's samples."""
        f = st["chosen"]["f"]
        samples = [x for p in st.get("probes", []) if p["f"] == f and p["pass"] for x in p["samples"] if x["readable"] >= 0.5 and x["dark"] < 0.1]
        if len(samples) < 2:
            return []
        opts = {f"answer_{i}": f"Asked: {x['q']}\nAnswered: {x['answer'][:700]}" for i, x in enumerate(samples[:40])}
        q = "Which answer would make an audience laugh the most at a model obsessed with the Golden Gate Bridge, while still reading well?"
        a = self.jev.ask({"task": "pick the answer to show on stage"}, {"a": shuffled_choice(q, opts, 1), "b": shuffled_choice(q, opts, 2)})
        p = {k: (a["a"]["probabilities"].get(k, 0) + a["b"]["probabilities"].get(k, 0)) / 2 for k in opts}
        best = sorted(p, key=p.get, reverse=True)[:n]
        return [{"q": samples[int(k.split("_")[1])]["q"], "answer": samples[int(k.split("_")[1])]["answer"], "p": round(p[k], 3)} for k in best]

    @torch.no_grad()
    def regen(self, messages, prefix, max_new_tokens=60):
        msgs = [{"role": m["role"], "content": str(m.get("content", ""))} for m in messages if m.get("role") in ("system", "user", "assistant")]
        text = self.tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True, enable_thinking=False) + prefix
        ids = self.tok(text, return_tensors="pt").input_ids.to("cuda:0")
        out = self.model.generate(input_ids=ids, attention_mask=torch.ones_like(ids), max_new_tokens=max_new_tokens, do_sample=False)
        cont = self.tok.decode(out[0, ids.shape[1]:], skip_special_tokens=True)
        m = re.search(r"[.!?](\s|$)", cont)
        return cont[: m.end()].strip() if m else cont.strip()

    def write_checkpoint(self, L, fold, scale):
        """A plain Qwen3.5 checkpoint: every file linked from the base, except the one shard that holds layer L's down_proj."""
        from safetensors.torch import load_file, save_file

        t0 = now()
        out = f"{RUN}/checkpoint"
        shutil.rmtree(out, ignore_errors=True)
        os.makedirs(out)
        index = json.load(open(f"{MODEL_DIR}/model.safetensors.index.json"))
        name = next(k for k in index["weight_map"] if k.endswith(f"layers.{L}.mlp.down_proj.weight") and "mtp" not in k)
        shard = index["weight_map"][name]
        for fn in os.listdir(MODEL_DIR):
            if fn != shard and not fn.startswith("."):
                os.symlink(f"{MODEL_DIR}/{fn}", f"{out}/{fn}")
        tensors = load_file(f"{MODEL_DIR}/{shard}")
        W = tensors[name].float() + scale * torch.outer(fold["u"].float(), fold["ell"].float())
        tensors[name] = W.to(torch.bfloat16).contiguous()
        save_file(tensors, f"{out}/{shard}", metadata={"format": "pt"})
        h = hashlib.sha256(tensors[name].view(torch.uint16).numpy().tobytes()).hexdigest()
        info = {"dir": out, "edited": name, "shard": shard, "rank": 1, "scale": scale, "sha256": h, "s": round(now() - t0, 1)}
        with open(f"{out}/GOLDEN-GATE.json", "w") as fh:
            json.dump(info, fh, indent=1)
        return info


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

    @app.post("/sweep")
    async def sweep(req: Request):
        b = await params(req)
        return stream(lab.sweep, str(b.get("name", "meandiff")), [float(x) for x in b.get("fs", [0.5])], b.get("thinking"))

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
