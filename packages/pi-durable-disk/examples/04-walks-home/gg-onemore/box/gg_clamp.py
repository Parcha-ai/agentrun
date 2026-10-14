# vLLM worker extension (--worker-extension-cls gg_clamp.ClampWorker, reached through /collective_rpc in dev mode; the
# server runs --enforce-eager so a module hook runs on every forward): Anthropic's Golden Gate clamp at inference.
# vLLM keeps a decoder layer's output as (hidden, residual); the residual stream after layer L is their sum. For each
# clamped SAE feature f, a_f = relu(r . W_enc[f] + b_enc[f]) and hidden += (value_f - a_f) * W_dec[:, f] at every
# position (prompt, thinking and answer alike), so the feature reads value_f wherever the model looks. An `add` vector
# is added the same way. Position 0 (the attention sink) is left alone.
# `gg_record` collects per-feature statistics over whatever prompts the server runs next, for finding the features.
import os
import re

import torch

from gg_worker import SteerWorker

SAE_DIR = "/vol/sae/qwen35-27b-w80k-l50"
TOPK = 50
TAG = re.compile(r"ggc_([A-Za-z0-9]+)_")


class ClampWorker(SteerWorker):
    """Clamp configs live in slots: slot 0 is the default (every untagged request); a request whose id carries `ggc_<tag>_`
    gets the slot of config <tag>, so one batch can hold many configs at once."""

    def _gg_layers(self):
        if getattr(self, "_gg_stack", None) is None:
            for name, mod in self._gg_model().named_modules():
                if isinstance(mod, torch.nn.ModuleList) and len(mod) == 64 and name.endswith("layers") and "visual" not in name and "mtp" not in name:
                    self._gg_stack = mod
                    break
            else:
                raise KeyError("no 64-layer decoder stack")
        return self._gg_stack

    def _gg_hooks(self):
        if not hasattr(self, "_gg_handles"):
            self._gg_handles = {}
            self._gg_packed = {}
            self._gg_tags = {"": 0}
            self._gg_skip_prompt = torch.zeros(1, dtype=torch.bool)
            self._gg_pulse = torch.zeros(1, dtype=torch.long)
            self._gg_slot_of = {}
            self._gg_tok_slot = None
            self._gg_rec = None
            self._gg_enc = {}
            self._gg_diag = {}
            self._gg_route = {"routed": 0, "fallback": 0}
            self._gg_begin_handle = self._gg_layers()[0].register_forward_pre_hook(lambda m, a, k: self._gg_begin(a, k), with_kwargs=True)
            mr = self.model_runner
            if hasattr(mr, "prepare_inputs"):
                # vLLM's v2 model runner builds each step's batch in prepare_inputs and keeps it in a local: keep a reference
                prepare = mr.prepare_inputs

                def kept(*a, **k):
                    self._gg_batch = prepare(*a, **k)
                    return self._gg_batch
                mr.prepare_inputs = kept
        return self._gg_handles

    def _gg_layout(self):
        """(request ids, tokens scheduled for each) of the step being run, in batch order."""
        ib = getattr(self, "_gg_batch", None)
        if ib is not None:
            n = ib.num_reqs
            return list(ib.req_ids[:n]), torch.as_tensor(ib.num_scheduled_tokens[:n]).long()
        mr = self.model_runner
        n = mr.input_batch.num_reqs
        q = mr.query_start_loc.cpu[: n + 1]
        return list(mr.input_batch.req_ids[:n]), (q[1:] - q[:-1]).long()

    def _gg_ensure_hook(self, L):
        handles = self._gg_hooks()
        if L not in handles:
            handles[L] = self._gg_layers()[L].register_forward_hook(lambda m, a, k, o, L=L: self._gg_forward(L, k, a, o), with_kwargs=True)

    def _gg_drop_unused(self):
        for L in list(self._gg_hooks()):
            if L not in self._gg_packed and not (self._gg_rec is not None and L in self._gg_enc):
                self._gg_handles.pop(L).remove()

    def _gg_slot(self, rid):
        s = self._gg_slot_of.get(rid)
        if s is None:
            m = TAG.search(rid)
            s = self._gg_tags.get(m.group(1), 0) if m else 0
            if len(self._gg_slot_of) > 20000:
                self._gg_slot_of.clear()
            self._gg_slot_of[rid] = s
        return s

    def _gg_begin(self, args, kwargs):
        """Once per forward: the slot of every token, from the batch the model runner just laid out."""
        self._gg_tok_slot = None
        self._gg_tok_prompt = None
        if not self._gg_packed or (len(self._gg_tags) <= 1 and not bool(self._gg_skip_prompt.any())):
            return None
        h = kwargs.get("hidden_states", args[0] if args else None)
        T = h.shape[0]
        try:
            rids, counts = self._gg_layout()
            n = int(counts.sum())
            if n > T or (T - n) > 512:
                raise ValueError(f"token count mismatch: {n} scheduled, {T} in the step")
            slots = torch.repeat_interleave(torch.tensor([self._gg_slot(r) for r in rids], dtype=torch.long), counts)
            slots = torch.cat([slots, torch.zeros(T - n, dtype=torch.long)])  # padding tokens run the default
            prompt = torch.cat([torch.repeat_interleave(counts > 1, counts), torch.zeros(T - n, dtype=torch.bool)])  # a step's prompt chunk
            self._gg_tok_slot = slots.to(h.device, non_blocking=True)
            self._gg_tok_prompt = prompt.to(h.device, non_blocking=True)
            self._gg_route["routed"] += 1
        except Exception as e:  # noqa: BLE001 - an unexpected batch layout falls back to the default slot
            self._gg_route["error"] = repr(e)[:300]
            self._gg_tok_slot = torch.zeros(T, dtype=torch.long, device=h.device)
            self._gg_route["fallback"] += 1
        return None

    @torch.no_grad()
    def _gg_forward(self, L, kwargs, args, out):
        h, r = out
        pos = kwargs.get("positions", args[2] if len(args) > 2 else None)
        if pos is not None and pos.dim() > 1:
            pos = pos[0]
        x = h.float() + r.float()
        keep = (pos != 0) if pos is not None else torch.ones(x.shape[0], dtype=torch.bool, device=x.device)
        if self._gg_rec is not None and L in self._gg_enc:
            self._gg_record_update(L, x[keep])
        P = self._gg_packed.get(L)
        if P is None:
            return None
        slot = self._gg_tok_slot
        if slot is None or slot.shape[0] != x.shape[0]:
            slot = torch.zeros(x.shape[0], dtype=torch.long, device=x.device)
        delta = torch.zeros_like(x)
        d = self._gg_diag.setdefault(L, {"tokens": torch.zeros(P["S"], device=x.device), "delta": torch.zeros(P["S"], device=x.device),
                                         "act": torch.zeros(P["S"], P["F"], device=x.device) if P["F"] else None})
        if self._gg_tok_prompt is not None and self._gg_tok_prompt.shape[0] == x.shape[0]:
            keep = keep & ~(self._gg_tok_prompt & self._gg_skip_prompt[slot])
        if pos is not None and bool(self._gg_pulse.any()):
            # a pulsing config clamps `pulse` positions, then leaves `pulse` alone, and so on: the thought intrudes and goes
            period = self._gg_pulse[slot]
            keep = keep & ((period == 0) | ((pos // period.clamp(min=1)) % 2 == 0))
        w = keep.float()
        if P["F"]:
            a = (x @ P["W"].T + P["b"]).clamp(min=0)
            m = P["M"][slot]
            delta += ((P["v"] - a) * m) @ P["D"]
            d["act"].index_add_(0, slot, a * m * w[:, None])
        if P["add"] is not None:
            delta += P["add"][slot]
        delta *= w[:, None]
        d["tokens"].index_add_(0, slot, w)
        d["delta"].index_add_(0, slot, delta.norm(dim=-1))
        return (h + delta.to(h.dtype), r)

    # ---- clamp -------------------------------------------------------------------------------------------------------

    def gg_configs(self, path):
        """Load clamp configs saved by the driver: {"configs": {tag: {"layers": {L: {"W": [n,d], "b": [n], "D": [n,d], "v": [n],
        "add": [d]}}}}}. Tag "" is the default slot."""
        self._gg_hooks()
        obj = torch.load(path, map_location="cpu", weights_only=True)
        dev = next(self._gg_layers()[0].parameters()).device
        tags = [""] + sorted(t for t in obj["configs"] if t != "")
        slot = {t: i for i, t in enumerate(tags)}
        layers = sorted({int(L) for c in obj["configs"].values() for L in c["layers"]})
        packed = {}
        for L in layers:
            W, b, D, v, owner, add = [], [], [], [], [], {}
            for t, c in obj["configs"].items():
                e = c["layers"].get(L, c["layers"].get(str(L)))
                if e is None:
                    continue
                if "W" in e:
                    n = e["W"].shape[0]
                    W.append(e["W"]); b.append(e["b"]); D.append(e["D"]); v.append(e["v"])
                    owner += [slot[t]] * n
                if "add" in e:
                    add[slot[t]] = e["add"]
            S, F = len(tags), len(owner)
            P = {"S": S, "F": F, "add": None}
            if F:
                M = torch.zeros(S, F)
                M[torch.tensor(owner), torch.arange(F)] = 1
                P.update({"W": torch.cat(W).to(dev, torch.float32), "b": torch.cat(b).to(dev, torch.float32), "D": torch.cat(D).to(dev, torch.float32),
                          "v": torch.cat(v).to(dev, torch.float32), "M": M.to(dev)})
            if add:
                A = torch.zeros(S, D[0].shape[1] if D else next(iter(add.values())).shape[0])
                for s_, vec in add.items():
                    A[s_] = vec
                P["add"] = A.to(dev, torch.float32)
            packed[L] = P
        self._gg_packed = packed
        self._gg_tags = slot
        # a config with "skip_prompt" leaves the prompt alone and clamps only what the model writes
        self._gg_skip_prompt = torch.tensor([bool(obj["configs"].get(t, {}).get("skip_prompt", False)) for t in tags], device=dev)
        self._gg_pulse = torch.tensor([int(obj["configs"].get(t, {}).get("pulse", 0)) for t in tags], dtype=torch.long, device=dev)
        self._gg_slot_of = {}
        self._gg_diag = {}
        for L in packed:
            self._gg_ensure_hook(L)
        self._gg_drop_unused()
        if dev.type == "cuda":
            torch.cuda.synchronize()
        return {"slots": len(tags), "layers": {L: {"features": P["F"], "adds": P["add"] is not None} for L, P in packed.items()}}

    def gg_clamp(self, path):
        """One config for every request: {"layers": {...}} as in gg_configs."""
        cfg = torch.load(path, map_location="cpu", weights_only=True)
        tmp = path + ".configs"
        torch.save({"configs": {"": cfg}}, tmp)
        return self.gg_configs(tmp)

    def gg_clear(self):
        self._gg_hooks()
        self._gg_packed = {}
        self._gg_tags = {"": 0}
        self._gg_skip_prompt = torch.zeros(1, dtype=torch.bool)
        self._gg_pulse = torch.zeros(1, dtype=torch.long)
        self._gg_diag = {}
        self._gg_drop_unused()
        return {"hooks": sorted(self._gg_handles)}

    def gg_probe(self):
        mr = self.model_runner
        ib = getattr(mr, "input_batch", None)
        return {"runner": type(mr).__module__ + "." + type(mr).__name__, "attrs": sorted(a for a in dir(mr) if any(k in a.lower() for k in ("req", "query", "batch", "state"))),
                "input_batch": type(ib).__name__ if ib is not None else None, "ib_attrs": sorted(a for a in dir(ib) if not a.startswith("__"))[:80] if ib is not None else None}

    def gg_diag(self):
        """Per layer and config tag: tokens clamped, mean |delta|, each feature's mean natural activation."""
        names = {i: t for t, i in getattr(self, "_gg_tags", {"": 0}).items()}
        out = {"route": dict(self._gg_route) if hasattr(self, "_gg_route") else {}, "layers": {}}
        for L, d in getattr(self, "_gg_diag", {}).items():
            tok = d["tokens"].cpu()
            dn = d["delta"].cpu()
            act = d["act"].cpu() if d["act"] is not None else None
            M = self._gg_packed[L]["M"].cpu() if self._gg_packed.get(L, {}).get("F") else None
            out["layers"][L] = {names[s]: {"tokens": int(tok[s]), "mean_delta_norm": round(float(dn[s] / max(1, tok[s])), 2),
                                           "mean_act": [round(float(x), 2) for x in (act[s][M[s] > 0] / max(1, tok[s]))] if act is not None else []}
                                for s in range(len(tok)) if tok[s] > 0}
        return out

    # ---- record ------------------------------------------------------------------------------------------------------

    def gg_sae_load(self, layers):
        """The full encoders of these layers on the GPU (bf16), for `gg_record`."""
        self._gg_hooks()
        dev = next(self._gg_layers()[0].parameters()).device
        for L in layers:
            L = int(L)
            if L in self._gg_enc:
                continue
            s = torch.load(f"{SAE_DIR}/layer{L}.sae.pt", map_location="cpu", mmap=True, weights_only=True)
            self._gg_enc[L] = {"W": s["W_enc"].to(dev, torch.bfloat16), "b": s["b_enc"].to(dev, torch.float32)}
            del s
        if dev.type == "cuda":
            torch.cuda.synchronize()
        return {"loaded": sorted(self._gg_enc), "gpu_gb": round(torch.cuda.memory_allocated() / 2**30, 1)}

    def gg_sae_unload(self):
        self._gg_enc = {}
        self._gg_rec = None
        self._gg_drop_unused()
        torch.cuda.empty_cache()
        return {"gpu_gb": round(torch.cuda.memory_allocated() / 2**30, 1)}

    def gg_record(self, bucket):
        """Statistics from here on go to `bucket` (None stops recording)."""
        self._gg_hooks()
        if bucket is None:
            self._gg_rec_bucket = None
            return {"recording": None}
        if self._gg_rec is None:
            self._gg_rec = {}
        self._gg_rec_bucket = bucket
        for L in self._gg_enc:
            self._gg_ensure_hook(L)
        return {"recording": bucket, "layers": sorted(self._gg_enc)}

    @torch.no_grad()
    def _gg_record_update(self, L, x):
        b = getattr(self, "_gg_rec_bucket", None)
        if b is None or x.shape[0] == 0:
            return
        e = self._gg_enc[L]
        F = e["W"].shape[0]
        st = self._gg_rec.setdefault(b, {}).setdefault(L, None)
        if st is None:
            dev = x.device
            st = self._gg_rec[b][L] = {"fire": torch.zeros(F, device=dev), "sum": torch.zeros(F, device=dev), "max": torch.zeros(F, device=dev),
                                       "pre_max": torch.full((F,), -1e9, device=dev), "resid_sum": torch.zeros(x.shape[1], device=dev), "norms": [], "tokens": 0}
        for c in range(0, x.shape[0], 1024):
            xc = x[c : c + 1024]
            pre = (xc.to(torch.bfloat16) @ e["W"].T).float() + e["b"]
            st["pre_max"] = torch.maximum(st["pre_max"], pre.max(0).values)
            v, i = pre.topk(TOPK, dim=-1)
            v = v.clamp(min=0)
            flat_i, flat_v = i.reshape(-1), v.reshape(-1)
            st["fire"].index_add_(0, flat_i, (flat_v > 0).float())
            st["sum"].index_add_(0, flat_i, flat_v)
            st["max"].scatter_reduce_(0, flat_i, flat_v, reduce="amax", include_self=True)
        st["resid_sum"] += x.sum(0)
        st["norms"].append(x.norm(dim=-1).cpu())
        st["tokens"] += x.shape[0]

    @torch.no_grad()
    def gg_lens(self, layer, features, scale, top=12):
        """Token ids each feature's decoder direction promotes, read through the final norm and the unembedding."""
        model = self._gg_model()
        norm = head = None
        for name, mod in model.named_modules():
            if "visual" in name or "mtp" in name:
                continue
            if name.endswith("model.norm"):
                norm = mod
            if name.endswith("lm_head"):
                head = mod
        s = torch.load(f"{SAE_DIR}/layer{int(layer)}.sae.pt", map_location="cpu", mmap=True, weights_only=True)
        dev = head.weight.device
        D = s["W_dec"][:, list(features)].T.contiguous().to(dev, torch.float32)
        D = D / D.norm(dim=-1, keepdim=True) * float(scale)
        out = norm(D.to(head.weight.dtype))
        out = out[0] if isinstance(out, tuple) else out
        logits = (out @ head.weight.T).float()
        return logits.topk(top, dim=-1).indices.tolist()

    def gg_record_save(self, path):
        rec = self._gg_rec or {}
        out = {}
        for b, layers in rec.items():
            out[b] = {}
            for L, st in layers.items():
                out[b][L] = {k: (v.cpu() if torch.is_tensor(v) else v) for k, v in st.items() if k != "norms"}
                out[b][L]["norms"] = torch.cat(st["norms"]) if st["norms"] else torch.zeros(0)
        torch.save(out, path)
        self._gg_rec = None
        self._gg_rec_bucket = None
        return {"saved": path, "buckets": {b: {L: st["tokens"] for L, st in layers.items()} for b, layers in rec.items()}}


# ---- the clamp inside CUDA graphs ---------------------------------------------------------------------------------------
# For serving at full speed (no --enforce-eager): GG_CLAMP_GRAPH="28,32,36" gives each of those decoder layers fixed-size
# buffers before vLLM builds and compiles the model, and a forward that applies them. torch.compile traces the forward and
# the CUDA graphs read the buffers, so `gg_graph_set` changes the clamp by writing into them in place. One config for
# every request (no slots); all zero is the unedited model.
GRAPH_LAYERS = [int(x) for x in os.environ.get("GG_CLAMP_GRAPH", "").split(",") if x.strip()]
GRAPH_FMAX = int(os.environ.get("GG_CLAMP_FMAX", "16"))


def _patch_for_graphs():
    from vllm.model_executor.models import qwen3_5, qwen3_next

    cls = qwen3_5.Qwen3_5DecoderLayer
    base_forward = qwen3_next.Qwen3NextDecoderLayer.forward
    base_init = cls.__init__

    def __init__(self, *args, **kwargs):
        base_init(self, *args, **kwargs)
        if self.layer_idx in GRAPH_LAYERS:
            d = self.mlp.down_proj.weight.shape[0] if hasattr(self.mlp, "down_proj") else 5120
            for name, shape in (("gg_W", (GRAPH_FMAX, d)), ("gg_b", (GRAPH_FMAX,)), ("gg_D", (GRAPH_FMAX, d)), ("gg_v", (GRAPH_FMAX,)), ("gg_add", (d,))):
                self.register_buffer(name, torch.zeros(shape, dtype=torch.float32), persistent=False)
            self.register_buffer("gg_pulse", torch.zeros(1, dtype=torch.long), persistent=False)

    def forward(self, hidden_states, residual, positions, **kwargs):
        h, r = base_forward(self, hidden_states, residual, positions, **kwargs)
        if self.layer_idx in GRAPH_LAYERS:
            x = h.float() + r.float()
            a = torch.relu(x @ self.gg_W.t() + self.gg_b)
            delta = (self.gg_v - a) @ self.gg_D + self.gg_add
            p = positions[0] if positions.dim() > 1 else positions
            on = (p != 0) & ((self.gg_pulse == 0) | ((p // self.gg_pulse.clamp(min=1)) % 2 == 0))
            h = h + (delta * on.unsqueeze(-1).to(delta.dtype)).to(h.dtype)
        return h, r

    cls.__init__ = __init__
    cls.forward = forward


if GRAPH_LAYERS:
    _patch_for_graphs()


class GraphClampWorker(ClampWorker):
    def gg_graph_set(self, path):
        """Write a clamp config ({"layers": {L: {"W", "b", "D", "v", "add"}}}) into the graph buffers; layers it leaves out go to zero."""
        whole = torch.load(path, map_location="cpu", weights_only=True)
        cfg = whole["layers"]
        for L, c in cfg.items():
            if int(L) not in GRAPH_LAYERS:
                raise ValueError(f"layer {L} has no graph buffers (GG_CLAMP_GRAPH={GRAPH_LAYERS})")
            if "W" in c and c["W"].shape[0] > GRAPH_FMAX:
                raise ValueError(f"layer {L}: {c['W'].shape[0]} features, the graph holds {GRAPH_FMAX}")
        stack = self._gg_layers()
        out = {}
        for L in GRAPH_LAYERS:
            layer = stack[L]
            for name in ("gg_W", "gg_b", "gg_D", "gg_v", "gg_add"):
                getattr(layer, name).zero_()
            layer.gg_pulse.fill_(int(whole.get("pulse", 0)))
            c = cfg.get(L, cfg.get(str(L)))
            if not c:
                continue
            n = c["W"].shape[0] if "W" in c else 0
            for key, name in (("W", "gg_W"), ("b", "gg_b"), ("D", "gg_D"), ("v", "gg_v")):
                if key in c:
                    getattr(layer, name)[:n].copy_(c[key].to(torch.float32))
            if "add" in c:
                layer.gg_add.copy_(c["add"].to(torch.float32))
            out[L] = {"features": n, "add": "add" in c}
        if torch.cuda.is_available():
            torch.cuda.synchronize()
        return {"layers": out}

    def gg_graph_zero(self):
        """Every buffer to zero: the unedited model, at full speed."""
        stack = self._gg_layers()
        for L in GRAPH_LAYERS:
            for name in ("gg_W", "gg_b", "gg_D", "gg_v", "gg_add", "gg_pulse"):
                getattr(stack[L], name).zero_()
        if torch.cuda.is_available():
            torch.cuda.synchronize()
        return {"layers": {}}
